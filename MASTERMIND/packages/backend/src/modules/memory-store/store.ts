/**
 * MemoryStore — CRUD + recherche vectorielle sur PostgreSQL + pgvector.
 *
 * Schema SQL requis (à exécuter une fois) :
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE agent_memories (
 *     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     text TEXT NOT NULL,
 *     embedding VECTOR(4096),
 *     agent_id TEXT,
 *     scope TEXT NOT NULL DEFAULT 'agent',
 *     tags TEXT[] DEFAULT '{}',
 *     domain TEXT,
 *     source TEXT NOT NULL,
 *     created_at TIMESTAMPTZ DEFAULT NOW(),
 *     updated_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   CREATE INDEX ON agent_memories USING hnsw (embedding vector_cosine_ops);
 *   CREATE INDEX ON agent_memories (agent_id);
 *   CREATE INDEX ON agent_memories (scope);
 */
import type pg from 'pg';
import { embedText, type EmbedConfig } from './embedder.js';

export type MemoryScope = 'agent' | 'shared';

export interface MemoryEntry {
  id: string;
  text: string;
  agentId: string | null;
  scope: MemoryScope;
  tags: string[];
  domain: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  /** Dernière fois que cette mémoire a été récupérée par auto-injection ou recherche */
  lastAccessedAt: string | null;
  /** Nombre de fois que cette mémoire a été récupérée */
  accessCount: number;
  /** Score de pertinence calculé par la consolidation (0-1) */
  score: number | null;
  /** Mémoire archivée (soft-delete) */
  archived: boolean;
  /** UUID de la mémoire fusionnée qui remplace celle-ci */
  mergedInto: string | null;
  /** UUIDs des mémoires originales fusionnées dans celle-ci */
  mergeSourceIds: string[];
}

export interface MemoryEntryInput {
  text: string;
  agentId?: string | null;
  scope?: MemoryScope;
  tags?: string[];
  domain?: string | null;
  source: string;
}

export interface MemoryHit {
  entry: MemoryEntry;
  similarity: number;
}

export interface SearchOptions {
  agentId?: string;
  scopes?: MemoryScope[];
  domain?: string;
  topK?: number;
  threshold?: number;
}

export interface ListFilters {
  agentId?: string;
  scope?: MemoryScope;
  domain?: string;
  search?: string;
  /** Filtrer par état d'archivage. Défaut : false (non-archivées seulement) */
  archived?: boolean;
}

export interface MemoryStats {
  total: number;
  perAgent: Record<string, number>;
  perScope: Record<string, number>;
  perDomain: Record<string, number>;
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  const lastAccessed = row['last_accessed_at'];
  return {
    id: String(row['id']),
    text: String(row['text']),
    agentId: (row['agent_id'] as string | null) ?? null,
    scope: (row['scope'] as MemoryScope) ?? 'agent',
    tags: Array.isArray(row['tags']) ? row['tags'] as string[] : [],
    domain: (row['domain'] as string | null) ?? null,
    source: String(row['source']),
    createdAt: row['created_at'] instanceof Date
      ? row['created_at'].toISOString()
      : String(row['created_at']),
    updatedAt: row['updated_at'] instanceof Date
      ? row['updated_at'].toISOString()
      : String(row['updated_at']),
    lastAccessedAt: lastAccessed instanceof Date
      ? lastAccessed.toISOString()
      : (lastAccessed as string | null) ?? null,
    accessCount: Number(row['access_count'] ?? 0),
    score: row['score'] != null ? Number(row['score']) : null,
    archived: row['archived'] === true || row['archived'] === 't',
    mergedInto: (row['merged_into'] as string | null) ?? null,
    mergeSourceIds: Array.isArray(row['merge_source_ids']) ? row['merge_source_ids'] as string[] : [],
  };
}

export class MemoryStore {
  constructor(
    private pool: pg.Pool,
    private embedCfg: EmbedConfig,
  ) {}

  /** Crée les tables si elles n'existent pas encore. */
  async ensureSchema(dimensions = 4096): Promise<void> {
    // L'extension vector doit être activée en amont (db-setup.sh ou onboard).
    // On ne l'active pas ici : l'utilisateur applicatif n'a pas les droits superuser.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        text TEXT NOT NULL,
        embedding VECTOR(${dimensions}),
        agent_id TEXT,
        scope TEXT NOT NULL DEFAULT 'agent',
        tags TEXT[] DEFAULT '{}',
        domain TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Colonnes de consolidation mémoire (idempotent via ADD COLUMN IF NOT EXISTS).
    // L7 : pas de .catch() silencieux. `IF NOT EXISTS` gère déjà le cas "colonne déjà là" ;
    // un .catch(() => {}) ne masquerait donc que de VRAIS échecs DDL (droits insuffisants,
    // type incompatible, table absente…) → on booterait sur un schéma cassé. On laisse
    // l'erreur remonter pour échouer franchement à l'init plutôt que silencieusement.
    console.debug('[memory-store] Ensuring consolidation columns…');
    for (const alter of [
      `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`,
      `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS score REAL`,
      `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS merged_into UUID`,
      `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS merge_source_ids UUID[] DEFAULT ARRAY[]::UUID[]`,
    ]) {
      await this.pool.query(alter);
    }

    // The btree indexes below keep L7's fail-loud behavior (a genuine failure there = broken
    // schema, surface it). The HNSW vector index is the EXCEPTION: it is a PERFORMANCE
    // optimization only — search stays correct without it via the exact `<=>` seqscan — and
    // pgvector caps hnsw at 2000 dims while our embedder is often 4096 (cloud), so the index is
    // simply impossible to build at that size. The ANN index is therefore NON-FATAL: skipped
    // over the dim cap, and never allowed to crash boot.
    // NB: removing the silent .catch() here in L7 turned this known 4096-dim impossibility into
    // a FATAL boot error (caught at deploy — AUDIT-2026-06-01 L7 regression). To re-enable an
    // ANN index at 4096 dims: use an embedder <=2000 dims, or pgvector halfvec (>=0.7) with a
    // halfvec-cast index + matching query.
    const HNSW_MAX_DIMS = 2000;
    if (dimensions <= HNSW_MAX_DIMS) {
      try {
        await this.pool.query(`CREATE INDEX IF NOT EXISTS agent_memories_hnsw ON agent_memories USING hnsw (embedding vector_cosine_ops)`);
      } catch (err) {
        console.warn(`[memory-store] HNSW index creation failed (non-fatal; vector search falls back to exact seqscan): ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.warn(`[memory-store] HNSW index SKIPPED: embedding dim=${dimensions} > ${HNSW_MAX_DIMS} (pgvector hnsw limit). Vector search uses an exact seqscan — correct, just unindexed.`);
    }
    for (const ddl of [
      `CREATE INDEX IF NOT EXISTS agent_memories_agent_id ON agent_memories (agent_id)`,
      `CREATE INDEX IF NOT EXISTS agent_memories_scope ON agent_memories (scope)`,
      `CREATE INDEX IF NOT EXISTS agent_memories_domain ON agent_memories (domain)`,
      `CREATE INDEX IF NOT EXISTS agent_memories_created_at ON agent_memories (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_archived ON agent_memories (archived)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_score ON agent_memories (score DESC NULLS LAST)`,
    ]) {
      await this.pool.query(ddl);
    }
    console.log(`[memory-store] Schema OK (vector dim=${dimensions}, HNSW cosine, consolidation columns)`);
  }

  /** Ajoute une entrée et retourne son UUID. */
  async add(input: MemoryEntryInput): Promise<string> {
    console.debug(
      `[memory-store] add embed textLen=${input.text.length} agent=${input.agentId ?? '∅'} scope=${input.scope ?? 'agent'} domain=${input.domain ?? '∅'} tags=${(input.tags ?? []).length} source=${input.source}`,
    );
    const embedding = await embedText(input.text, this.embedCfg);
    const vectorLiteral = `[${embedding.join(',')}]`;

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_memories (text, embedding, agent_id, scope, tags, domain, source)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.text,
        vectorLiteral,
        input.agentId ?? null,
        input.scope ?? 'agent',
        input.tags ?? [],
        input.domain ?? null,
        input.source,
      ],
    );
    const id = result.rows[0]!.id;
    console.log(`[memory-store] add ok id=${id} dim=${embedding.length}`);
    return id;
  }

  /** Recherche sémantique avec filtres optionnels. */
  async search(query: string, opts: SearchOptions = {}): Promise<MemoryHit[]> {
    const { agentId, scopes, domain, topK = 5, threshold = 0.45 } = opts;

    const qPreview = query.length > 120 ? `${query.slice(0, 120)}…` : query;
    console.debug(
      `[memory-store] search queryLen=${query.length} topK=${topK} threshold=${threshold} agentId=${agentId ?? '∅'} scopes=${scopes?.join(',') ?? 'auto'} domain=${domain ?? '∅'} preview="${qPreview.replace(/"/g, "'")}"`,
    );

    let embedding: number[];
    try {
      embedding = await embedText(query, this.embedCfg);
    } catch (err) {
      console.warn('[memory-store] search: embedding failed, returning empty', err);
      return [];
    }

    const vectorLiteral = `[${embedding.join(',')}]`;
    const conditions: string[] = [
      `(1 - (embedding <=> '${vectorLiteral}'::vector)) > $1`,
      `archived = FALSE`,
    ];
    const params: unknown[] = [threshold];
    let pi = 2;

    // Filtrage scope/agent — chaque agent ne voit que ses propres entrées + le shared
    if (agentId && scopes && scopes.length > 0) {
      const includeShared = scopes.includes('shared');
      const includeAgent  = scopes.includes('agent');
      if (includeAgent && includeShared) {
        // (scope = 'agent' AND agent_id = $X) OR scope = 'shared'
        conditions.push(`((scope = 'agent' AND agent_id = $${pi}) OR scope = 'shared')`);
        params.push(agentId);
        pi++;
      } else if (includeAgent) {
        // Uniquement les entrées de cet agent
        conditions.push(`(scope = 'agent' AND agent_id = $${pi})`);
        params.push(agentId);
        pi++;
      } else if (includeShared) {
        // Uniquement le shared (pas d'agent spécifique)
        conditions.push(`scope = 'shared'`);
      }
    } else if (agentId) {
      // Pas de scopes précisés : agent + shared par défaut
      conditions.push(`((scope = 'agent' AND agent_id = $${pi}) OR scope = 'shared')`);
      params.push(agentId);
      pi++;
    } else if (scopes && scopes.length > 0) {
      const scopePlaceholders = scopes.map((_, i) => `$${pi + i}`).join(', ');
      conditions.push(`scope IN (${scopePlaceholders})`);
      params.push(...scopes);
      pi += scopes.length;
    }

    if (domain) {
      conditions.push(`domain = $${pi}`);
      params.push(domain);
      pi++;
    }

    const where = conditions.join(' AND ');
    // Tie-break by id ASC: pgvector's `<=>` distance can produce ties (or near-ties at the
    // float precision boundary) for two rows with very similar embeddings. Without an explicit
    // tie-break the row order is implementation-dependent and may flip between runs, which
    // shifts the memory block injected into the prompt prefix → KV-cache invalidation on the
    // currently-built user message. `id` is a stable nanoid string, fine as a deterministic
    // secondary key.
    const sql = `
      SELECT id, text, agent_id, scope, tags, domain, source, created_at, updated_at,
             last_accessed_at, access_count, score, archived, merged_into, merge_source_ids,
             (1 - (embedding <=> '${vectorLiteral}'::vector)) AS similarity
      FROM agent_memories
      WHERE ${where}
      ORDER BY embedding <=> '${vectorLiteral}'::vector, id ASC
      LIMIT $${pi}
    `;
    params.push(topK);

    const result = await this.pool.query(sql, params);
    const hits = result.rows.map(row => ({
      entry: rowToEntry(row),
      similarity: Number(row['similarity']),
    }));
    if (hits.length > 0) {
      const sims = hits.slice(0, 5).map(h => `${(h.similarity * 100).toFixed(1)}%`).join(', ');
      console.debug(`[memory-store] search hits=${hits.length} sim[0..] (${sims})`);
    } else {
      console.debug('[memory-store] search hits=0');
    }
    return hits;
  }

  /** Met à jour le texte (et recalcule l'embedding) et/ou les métadonnées d'une entrée. */
  async update(id: string, patch: { text?: string; tags?: string[]; domain?: string }): Promise<void> {
    console.debug(
      `[memory-store] update id=${id} text=${patch.text !== undefined ? `yes(${patch.text.length}c)` : 'no'} tags=${patch.tags !== undefined ? 'yes' : 'no'} domain=${patch.domain !== undefined ? 'yes' : 'no'}`,
    );
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let pi = 1;

    if (patch.text !== undefined) {
      const embedding = await embedText(patch.text, this.embedCfg);
      const vectorLiteral = `[${embedding.join(',')}]`;
      sets.push(`text = $${pi}`, `embedding = $${pi + 1}::vector`);
      params.push(patch.text, vectorLiteral);
      pi += 2;
    }
    if (patch.tags !== undefined) {
      sets.push(`tags = $${pi}`);
      params.push(patch.tags);
      pi++;
    }
    if (patch.domain !== undefined) {
      sets.push(`domain = $${pi}`);
      params.push(patch.domain);
      pi++;
    }

    params.push(id);
    await this.pool.query(`UPDATE agent_memories SET ${sets.join(', ')} WHERE id = $${pi}`, params);
    console.log(`[memory-store] update ok id=${id}`);
  }

  /** Supprime une entrée par son UUID. */
  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_memories WHERE id = $1', [id]);
    console.log(`[memory-store] delete id=${id}`);
  }

  /** Liste paginée avec filtres scalaires. */
  async list(
    filters: ListFilters = {},
    page = 1,
    limit = 20,
  ): Promise<{ entries: MemoryEntry[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    // Par défaut, on ne montre que les non-archivées
    const showArchived = filters.archived === true;
    conditions.push(`archived = $${pi}`);
    params.push(showArchived);
    pi++;

    if (filters.agentId) {
      conditions.push(`agent_id = $${pi}`);
      params.push(filters.agentId);
      pi++;
    }
    if (filters.scope) {
      conditions.push(`scope = $${pi}`);
      params.push(filters.scope);
      pi++;
    }
    if (filters.domain) {
      conditions.push(`domain = $${pi}`);
      params.push(filters.domain);
      pi++;
    }
    if (filters.search) {
      conditions.push(`text ILIKE $${pi}`);
      params.push(`%${filters.search}%`);
      pi++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [countRes, dataRes] = await Promise.all([
      this.pool.query(`SELECT COUNT(*) AS total FROM agent_memories ${where}`, params),
      this.pool.query(
        `SELECT id, text, agent_id, scope, tags, domain, source, created_at, updated_at,
                last_accessed_at, access_count, score, archived, merged_into, merge_source_ids
         FROM agent_memories ${where}
         ORDER BY created_at DESC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset],
      ),
    ]);

    const total = Number(countRes.rows[0]?.['total'] ?? 0);
    console.debug(`[memory-store] list page=${page} limit=${limit} total=${total} filters=${JSON.stringify(filters)}`);
    return {
      entries: dataRes.rows.map(rowToEntry),
      total,
    };
  }

  /** Liste toutes les entrées sans pagination, pour export. Exclut l'embedding. */
  async listAll(options: { includeArchived?: boolean } = {}): Promise<MemoryEntry[]> {
    const includeArchived = options.includeArchived === true;
    const where = includeArchived ? '' : 'WHERE archived = FALSE';
    const res = await this.pool.query(
      `SELECT id, text, agent_id, scope, tags, domain, source, created_at, updated_at,
              last_accessed_at, access_count, score, archived, merged_into, merge_source_ids
       FROM agent_memories ${where}
       ORDER BY scope DESC, agent_id NULLS FIRST, created_at ASC`,
    );
    console.debug(`[memory-store] listAll rows=${res.rows.length} includeArchived=${includeArchived}`);
    return res.rows.map(rowToEntry);
  }

  /** Re-génère les embeddings pour toutes les entrées qui n'en ont pas (embedding IS NULL). */
  async reembedMissing(onProgress?: (done: number, total: number) => void): Promise<number> {
    const result = await this.pool.query<{ id: string; text: string }>(
      `SELECT id, text FROM agent_memories WHERE embedding IS NULL AND archived = FALSE ORDER BY created_at ASC`,
    );
    const rows = result.rows;
    if (rows.length === 0) return 0;

    console.log(`[memory-store] reembedMissing: ${rows.length} entries without embedding`);
    let done = 0;

    for (const row of rows) {
      try {
        const embedding = await embedText(row.text, this.embedCfg);
        const vectorLiteral = `[${embedding.join(',')}]`;
        await this.pool.query(
          `UPDATE agent_memories SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
          [vectorLiteral, row.id],
        );
        done++;
        onProgress?.(done, rows.length);
      } catch (err) {
        console.warn(`[memory-store] reembedMissing failed for id=${row.id}:`, err);
      }
    }

    console.log(`[memory-store] reembedMissing done: ${done}/${rows.length}`);
    return done;
  }

  /** Statistiques agrégées. */
  async stats(): Promise<MemoryStats> {
    const [total, perAgent, perScope, perDomain] = await Promise.all([
      this.pool.query<{ total: string }>('SELECT COUNT(*) AS total FROM agent_memories'),
      this.pool.query<{ agent_id: string | null; count: string }>(
        'SELECT agent_id, COUNT(*) AS count FROM agent_memories GROUP BY agent_id',
      ),
      this.pool.query<{ scope: string; count: string }>(
        'SELECT scope, COUNT(*) AS count FROM agent_memories GROUP BY scope',
      ),
      this.pool.query<{ domain: string | null; count: string }>(
        'SELECT domain, COUNT(*) AS count FROM agent_memories GROUP BY domain',
      ),
    ]);

    const out: MemoryStats = {
      total: Number(total.rows[0]?.total ?? 0),
      perAgent: Object.fromEntries(
        perAgent.rows.map(r => [r['agent_id'] ?? 'shared', Number(r['count'])]),
      ),
      perScope: Object.fromEntries(perScope.rows.map(r => [r['scope'], Number(r['count'])])),
      perDomain: Object.fromEntries(
        perDomain.rows.map(r => [r['domain'] ?? 'none', Number(r['count'])]),
      ),
    };
    console.debug(`[memory-store] stats total=${out.total} agents=${Object.keys(out.perAgent).length} scopes=${JSON.stringify(out.perScope)}`);
    return out;
  }
}
