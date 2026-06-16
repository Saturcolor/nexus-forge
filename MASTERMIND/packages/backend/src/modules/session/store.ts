import type pg from 'pg';
import { nanoid } from 'nanoid';
import type { Session, ChatMessage, MessageRole, MessageSource } from '@mastermind/shared';
import type { SessionOptions } from '../agent/directives.js';

/** Un résultat de recherche plein-texte sur l'historique (cf. searchMessages / tool session_search). */
export interface SessionSearchHit {
  id: string;
  sessionId: string;
  role: MessageRole;
  createdAt: string;
  /** Extrait avec les termes surlignés (ts_headline). */
  snippet: string;
  rank: number;
}

export class SessionStore {
  constructor(private pool: pg.Pool) {}

  async getOrCreate(id: string, agentId: string): Promise<Session> {
    // Try to get existing
    const existing = await this.pool.query<Session>(
      'SELECT id, agent_id AS "agentId", title, created_at AS "createdAt", updated_at AS "updatedAt" FROM sessions WHERE id = $1',
      [id],
    );
    if (existing.rows[0]) {
      console.debug(`[session-store] getOrCreate id=${id} agent=${agentId} exists=true`);
      return existing.rows[0];
    }

    // Create new
    console.debug(`[session-store] getOrCreate id=${id} agent=${agentId} exists=false → creating`);
    const result = await this.pool.query<Session>(
      `INSERT INTO sessions (id, agent_id) VALUES ($1, $2)
       RETURNING id, agent_id AS "agentId", title, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, agentId],
    );
    return result.rows[0];
  }

  /** Set a session's display title (used e.g. pour nommer la session unifiée "Cross-plateforme"). */
  async setTitle(sessionId: string, title: string): Promise<void> {
    console.debug(`[session-store] setTitle session=${sessionId} title="${title}"`);
    await this.pool.query(
      'UPDATE sessions SET title = $1, updated_at = NOW() WHERE id = $2',
      [title, sessionId],
    );
  }

  async listByAgent(agentId: string): Promise<Session[]> {
    const result = await this.pool.query<Session>(
      `SELECT id, agent_id AS "agentId", title, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM sessions WHERE agent_id = $1 ORDER BY updated_at DESC`,
      [agentId],
    );
    console.debug(`[session-store] listByAgent agent=${agentId} rows=${result.rows.length}`);
    return result.rows;
  }

  async listAll(): Promise<Session[]> {
    const result = await this.pool.query<Session>(
      `SELECT id, agent_id AS "agentId", title, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM sessions ORDER BY updated_at DESC`,
    );
    console.debug(`[session-store] listAll rows=${result.rows.length}`);
    return result.rows;
  }

  async delete(id: string): Promise<void> {
    console.debug(`[session-store] delete session=${id}`);
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
  }

  /** Clear all messages from a session without deleting the session itself. */
  async clearMessages(sessionId: string): Promise<number> {
    const res = await this.pool.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
    const count = res.rowCount ?? 0;
    console.debug(`[session-store] clearMessages session=${sessionId} deleted=${count}`);
    return count;
  }

  async saveOptions(sessionId: string, options: SessionOptions): Promise<void> {
    console.debug(`[session-store] saveOptions session=${sessionId} keys=${Object.keys(options).join(',')}`);
    await this.pool.query(
      'UPDATE sessions SET options = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(options), sessionId],
    );
  }

  async loadOptions(sessionId: string): Promise<SessionOptions> {
    const result = await this.pool.query<{ options: SessionOptions | null }>(
      'SELECT options FROM sessions WHERE id = $1',
      [sessionId],
    );
    const options = (result.rows[0]?.options as SessionOptions) ?? {};
    console.debug(`[session-store] loadOptions session=${sessionId} found=${result.rows.length > 0} keys=${Object.keys(options).join(',')}`);
    return options;
  }

  async addMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    source: MessageSource = 'web',
    metadata?: Record<string, unknown>,
  ): Promise<ChatMessage> {
    const id = nanoid();
    console.debug(`[session-store] addMessage session=${sessionId} role=${role} source=${source} len=${content.length}`);
    const result = await this.pool.query<ChatMessage>(
      `INSERT INTO messages (id, session_id, role, content, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, session_id AS "sessionId", role, content, source, created_at AS "createdAt", metadata`,
      [id, sessionId, role, content, source, metadata ? JSON.stringify(metadata) : null],
    );

    // Touch session updated_at
    await this.pool.query('UPDATE sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);

    return result.rows[0];
  }

  /**
   * Merge fields into a message's metadata JSON. Used post-build to persist the exact
   * injected prefix (memory/board/date block) that was prepended to a user message at
   * prompt-build time — so subsequent turns reconstruct byte-identical tokens at that
   * position and llama.cpp's KV cache hits instead of invalidating.
   *
   * Uses Postgres JSONB merge (`||`) so callers only need to pass the delta.
   */
  async updateMessageMetadata(messageId: string, patch: Record<string, unknown>): Promise<void> {
    if (!messageId || Object.keys(patch).length === 0) return;
    const res = await this.pool.query(
      `UPDATE messages
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [messageId, JSON.stringify(patch)],
    );
    console.debug(`[session-store] updateMessageMetadata message=${messageId} keys=${Object.keys(patch).join(',')} updated=${res.rowCount ?? 0}`);
  }

  /**
   * Récupère les messages d'un agent pour une date donnée.
   * @param includeCompacted  Si true, inclut les messages soft-deleted par auto-compact
   *                          et exclut les résumés auto_compact eux-mêmes.
   *                          Utilisé par la consolidation daily pour avoir le transcript original.
   */
  async getMessagesByAgentAndDate(agentId: string, dateStr: string, includeCompacted = false): Promise<ChatMessage[]> {
    const compactFilter = includeCompacted
      // Pour la consolidation : tous les messages originaux, PAS les résumés auto_compact
      ? `AND (m.metadata IS NULL OR m.metadata->>'type' != 'auto_compact')`
      // Normal : seulement les messages actifs (non-compactés)
      : `AND m.compacted_at IS NULL`;

    const result = await this.pool.query<ChatMessage>(
      `SELECT m.id, m.session_id AS "sessionId", m.role, m.content, m.source,
              m.created_at AS "createdAt", m.metadata
       FROM messages m
       JOIN sessions s ON m.session_id = s.id
       WHERE s.agent_id = $1
         AND m.created_at >= $2::date
         AND m.created_at < ($2::date + interval '1 day')
         ${compactFilter}
       ORDER BY m.created_at ASC`,
      [agentId, dateStr],
    );
    return result.rows;
  }

  /**
   * Replace a set of old messages with a single compact summary message.
   * The summary is inserted with a timestamp just before the first kept message
   * so chronological ordering is preserved.
   */
  async replaceWithCompact(
    sessionId: string,
    idsToDelete: string[],
    content: string,
    source: MessageSource,
    metadata: Record<string, unknown>,
    insertBefore: Date,
  ): Promise<ChatMessage> {
    console.debug(`[session-store] replaceWithCompact session=${sessionId} compacting=${idsToDelete.length} msgs summaryLen=${content.length}`);
    // 1 second before the first kept message so ordering is stable
    const ts = new Date(insertBefore.getTime() - 1000);
    const id = nanoid();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '30s'");
      if (idsToDelete.length > 0) {
        // Soft-delete : marque les messages comme compactés au lieu de les supprimer
        await client.query(
          `UPDATE messages SET compacted_at = NOW() WHERE id = ANY($1::text[])`,
          [idsToDelete],
        );
      }
      const result = await client.query<ChatMessage>(
        `INSERT INTO messages (id, session_id, role, content, source, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, session_id AS "sessionId", role, content, source, created_at AS "createdAt", metadata`,
        [id, sessionId, 'user', content, source, JSON.stringify(metadata), ts.toISOString()],
      );
      await client.query('UPDATE sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
      await client.query('COMMIT');
      console.log(`[session-store] replaceWithCompact ok session=${sessionId} compacted=${idsToDelete.length} summary=${id}`);
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn(`[session-store] replaceWithCompact rollback session=${sessionId}: ${err instanceof Error ? err.message : err}`);
      throw err;
    } finally {
      client.release();
    }
  }

  async getMessages(
    sessionId: string,
    limit: number = 50,
    before?: string,
    options?: { excludeProactive?: boolean },
  ): Promise<ChatMessage[]> {
    let query = `SELECT id, session_id AS "sessionId", role, content, source, created_at AS "createdAt", metadata
                 FROM messages WHERE session_id = $1 AND compacted_at IS NULL`;
    const params: unknown[] = [sessionId];

    if (options?.excludeProactive) {
      // Hidden sources: 'proactive' (scheduler/escalation) and 'sandbox' (agent-initiated
      // background runs). Both are persisted for KV-cache continuity but filtered from
      // the user-visible chat history.
      query += ` AND source NOT IN ('proactive', 'sandbox')`;
    }

    if (before) {
      query += ` AND created_at < (SELECT created_at FROM messages WHERE id = $${params.length + 1})`;
      params.push(before);
    }

    // Tie-break by id DESC: with sequential awaits the `created_at = NOW()` calls usually
    // produce monotonically increasing timestamps, but Postgres NOW() resolves to statement
    // start time within a transaction and parallel inserts (proactive runs, async-jobs,
    // multi-bot Telegram bridge) can yield identical timestamps. Without a tie-break the
    // row order on collision is implementation-dependent → the rebuilt history can flip
    // between two consecutive turns, invalidating the KV-cache prefix from the collision
    // point forward. id is a nanoid string — fine as a stable secondary key.
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.pool.query<ChatMessage>(query, params);
    console.debug(`[session-store] getMessages session=${sessionId} limit=${limit} before=${before ?? 'none'} excludeProactive=${options?.excludeProactive ?? false} rows=${result.rows.length}`);
    return result.rows.reverse(); // Return in chronological order
  }

  /**
   * List messages for a session within a time range, optionally filtered by source.
   * Used by the async-jobs audit endpoint to replay a sandbox run's messages.
   */
  async listMessagesInTimeRange(
    sessionId: string,
    source: string,
    fromIso: string,
    toIso: string,
  ): Promise<ChatMessage[]> {
    const query = `SELECT id, session_id AS "sessionId", role, content, source, created_at AS "createdAt", metadata
                   FROM messages
                   WHERE session_id = $1 AND source = $2
                     AND created_at >= $3 AND created_at <= $4
                     AND compacted_at IS NULL
                   ORDER BY created_at ASC`;
    const result = await this.pool.query<ChatMessage>(query, [sessionId, source, fromIso, toIso]);
    console.debug(`[session-store] listMessagesInTimeRange session=${sessionId} source=${source} rows=${result.rows.length}`);
    return result.rows;
  }

  /**
   * Recherche plein-texte (français) sur le contenu des messages — la capacité de rappel
   * cross-session qui manquait (on savait chercher le code et la mémoire vectorielle, pas
   * "ce qu'on s'est dit"). `websearch_to_tsquery` est injection-safe par construction (parse
   * une syntaxe type moteur de recherche, ne throw jamais sur une requête mal formée).
   * Append-only : n'impacte aucune requête existante.
   */
  async searchMessages(
    query: string,
    opts?: { agentId?: string; limit?: number },
  ): Promise<SessionSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const limit = Math.min(50, Math.max(1, opts?.limit ?? 10));
    const params: unknown[] = [q];
    let agentClause = '';
    if (opts?.agentId) {
      params.push(opts.agentId);
      agentClause = `AND s.agent_id = $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;

    const result = await this.pool.query<SessionSearchHit>(
      // tsquery parsé UNE fois (CTE) ; le WHERE garde l'expression nue pour matcher l'index GIN.
      // Filtres alignés sur les autres lectures : compacted_at IS NULL (pas de soft-deleted post
      // auto-compact) + sources internes proactive/sandbox exclues. rank::float8 → number côté
      // driver pg (float4/OID700 sinon rendu en string) ; created_at en ISO 8601 ("T" séparateur).
      `WITH q AS (SELECT websearch_to_tsquery('french', $1) AS tsq)
       SELECT m.id, m.session_id AS "sessionId", m.role,
              to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
              ts_headline('french', m.content, q.tsq,
                'StartSel=«,StopSel=»,MaxFragments=2,MaxWords=20,MinWords=6,FragmentDelimiter= … ') AS snippet,
              ts_rank(to_tsvector('french', m.content), q.tsq)::float8 AS rank
       FROM messages m
       JOIN sessions s ON m.session_id = s.id
       CROSS JOIN q
       WHERE to_tsvector('french', m.content) @@ q.tsq
         AND m.compacted_at IS NULL
         AND m.source NOT IN ('proactive', 'sandbox')
         ${agentClause}
       ORDER BY rank DESC, m.created_at DESC
       LIMIT $${limitIdx}`,
      params,
    );
    console.debug(`[session-store] searchMessages q="${q.slice(0, 40)}" agent=${opts?.agentId ?? 'all'} hits=${result.rows.length}`);
    return result.rows;
  }
}
