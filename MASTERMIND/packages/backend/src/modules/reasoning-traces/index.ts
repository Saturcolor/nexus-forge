/**
 * Stockage des traces de raisonnement (<think> blocks) en PostgreSQL.
 * Module léger — pas de module Mastermind complet, juste un store passé via MastermindContext.
 *
 * Table : reasoning_traces (créée par db/schema.ts)
 * Nettoyage auto : entrées > retentionDays jours supprimées au démarrage.
 */
import type { Pool } from 'pg';

export interface ReasoningTrace {
  id: string;
  sessionId: string;
  agentId: string;
  query?: string;
  reasoning?: string;
  conclusion?: string;
  createdAt: string;
}

export class ReasoningTraceStore {
  constructor(private readonly db: Pool) {
    console.debug('[reasoning-traces] store initialized');
  }

  /**
   * Insert non-bloquant — les erreurs sont loggées mais non propagées
   * pour ne jamais impacter la réponse agent.
   */
  insertNonBlocking(data: {
    sessionId: string;
    agentId: string;
    query?: string;
    reasoning?: string;
    conclusion?: string;
  }): void {
    console.debug(`[reasoning-traces] insert queued agent=${data.agentId} session=${data.sessionId} queryLen=${data.query?.length ?? 0} reasoningLen=${data.reasoning?.length ?? 0}`);
    this.db
      .query(
        `INSERT INTO reasoning_traces (session_id, agent_id, query, reasoning, conclusion)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          data.sessionId,
          data.agentId,
          data.query?.slice(0, 500) ?? null,
          data.reasoning?.slice(0, 8_000) ?? null,
          data.conclusion?.slice(0, 500) ?? null,
        ],
      )
      .then(res => {
        console.debug(`[reasoning-traces] insert ok agent=${data.agentId} session=${data.sessionId} rows=${res.rowCount ?? 0}`);
      })
      .catch(err => {
        console.warn('[reasoning-traces] insert failed (non-fatal):', err instanceof Error ? err.message : err);
      });
  }

  async list(
    agentId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ traces: ReasoningTrace[]; total: number }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = Math.max(0, opts.offset ?? 0);
    const startedAt = Date.now();
    console.debug(`[reasoning-traces] list agent=${agentId} limit=${limit} offset=${offset}`);

    const [rows, countRow] = await Promise.all([
      this.db.query<{
        id: string;
        session_id: string;
        agent_id: string;
        query: string | null;
        reasoning: string | null;
        conclusion: string | null;
        created_at: string;
      }>(
        `SELECT id, session_id, agent_id, query, reasoning, conclusion, created_at
         FROM reasoning_traces
         WHERE agent_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [agentId, limit, offset],
      ),
      this.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM reasoning_traces WHERE agent_id = $1`,
        [agentId],
      ),
    ]);

    const total = parseInt(countRow.rows[0]?.count ?? '0', 10);
    console.debug(`[reasoning-traces] list result agent=${agentId} rows=${rows.rows.length} total=${total} ms=${Date.now() - startedAt}`);
    return {
      traces: rows.rows.map(r => ({
        id: r.id,
        sessionId: r.session_id,
        agentId: r.agent_id,
        query: r.query ?? undefined,
        reasoning: r.reasoning ?? undefined,
        conclusion: r.conclusion ?? undefined,
        createdAt: r.created_at,
      })),
      total,
    };
  }

  /** Supprime les entrées plus vieilles que retentionDays jours */
  async cleanup(retentionDays = 30): Promise<number> {
    const startedAt = Date.now();
    console.debug(`[reasoning-traces] cleanup start retentionDays=${retentionDays}`);
    const res = await this.db.query(
      `DELETE FROM reasoning_traces WHERE created_at < NOW() - INTERVAL '${retentionDays} days'`,
    );
    const deleted = res.rowCount ?? 0;
    console.log(`[reasoning-traces] cleanup done deleted=${deleted} retentionDays=${retentionDays} ms=${Date.now() - startedAt}`);
    return deleted;
  }
}
