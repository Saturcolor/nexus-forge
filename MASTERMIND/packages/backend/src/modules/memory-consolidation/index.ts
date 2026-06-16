import type { Module, MastermindContext, WsServerMessage } from '@mastermind/shared';
import type { AgentModule } from '../agent/index.js';
import type { MemoryStoreModule } from '../memory-store/index.js';
import type { ProviderModule } from '../provider/index.js';
import { scoreMemories } from './scorer.js';
import { archiveStaleMemories, unarchiveMemory } from './archiver.js';
import { findClusters } from './clusterer.js';
import { mergeClusters } from './merger.js';
import type { ConsolidationRun, ConsolidationRunStats, MemoryHealthStats } from './types.js';

export type { ConsolidationRun, ConsolidationRunStats, MemoryHealthStats } from './types.js';

export class MemoryConsolidationModule implements Module {
  name = 'memory-consolidation';
  private ctx!: MastermindContext;
  private cronTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mis à true par destroy() : empêche le cron chaîné de se ré-armer après un run en vol. */
  private destroyed = false;

  /** Résout la config mémoire : consolidation.memory > memoryConsolidation (backward compat) */
  private get memoryCfg() {
    return this.ctx.config.consolidation?.memory ?? this.ctx.config.memoryConsolidation;
  }

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;

    const memoryStore = ctx.modules.tryGet<MemoryStoreModule>('memory-store');
    if (!memoryStore?.isEnabled) {
      console.log('[memory-consolidation] Désactivé (memory-store non actif)');
      return;
    }

    if (this.memoryCfg?.enabled === false) {
      console.log('[memory-consolidation] Désactivé (consolidation.memory.enabled: false)');
      return;
    }

    // Ensure schema for consolidation runs table
    await this.ensureSchema();

    this.scheduleCron();
    console.log('[memory-consolidation] Initialisé — cron programmé');
  }

  async destroy(): Promise<void> {
    // L9: marquer détruit AVANT de clear, pour que le callback du cron chaîné
    // (qui peut être en vol pendant `await runAll()`) ne se ré-arme pas après
    // résolution. clearTimeout est un no-op si le timer a déjà firé ; sans ce
    // flag, scheduleCron() recréerait un timer qu'aucun destroy ne nettoierait.
    this.destroyed = true;
    if (this.cronTimer) {
      clearTimeout(this.cronTimer);
      this.cronTimer = null;
      console.log('[memory-consolidation] Cron timer cleared');
    }
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  private async ensureSchema(): Promise<void> {
    await this.ctx.db.query(`
      CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id   TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status     TEXT NOT NULL DEFAULT 'running',
        stats      JSONB DEFAULT '{}',
        error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_consolidation_runs_agent
        ON memory_consolidation_runs (agent_id, started_at DESC);
    `);

    // M11 dedup — MUST run before creating the partial unique index below.
    // On an existing prod DB where the old racy code ran, there may already be ≥2
    // 'running' zombie rows per agent bucket (backend crashed mid-run before
    // finalising). CREATE UNIQUE INDEX would then fail on the *existing data*
    // (IF NOT EXISTS does NOT cover a uniqueness violation on build), and since
    // ensureSchema() is awaited in the unguarded module init loop (index.ts), the
    // whole backend boot would abort with exit 1. Defuse first: keep the most
    // recent 'running' row per COALESCE(agent_id,'__shared__') bucket, flip the
    // rest to 'error' so the index can build cleanly. Idempotent: after the first
    // run at most one 'running' row remains per bucket, so the WHERE matches nothing.
    await this.ctx.db.query(`
      UPDATE memory_consolidation_runs
         SET status = 'error',
             error = 'startup dedup (M11 unique index)',
             finished_at = NOW()
       WHERE status = 'running'
         AND id NOT IN (
           SELECT DISTINCT ON (COALESCE(agent_id, '__shared__')) id
             FROM memory_consolidation_runs
            WHERE status = 'running'
            ORDER BY COALESCE(agent_id, '__shared__'), started_at DESC
         );
    `);

    // At-most-one 'running' row per agent (shared = NULL bucketed via COALESCE).
    // Makes the anti-overlap guard atomic: a concurrent second INSERT fails with
    // 23505 instead of slipping through the TOCTOU window between SELECT and INSERT.
    await this.ctx.db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_consolidation_runs_one_running
        ON memory_consolidation_runs (COALESCE(agent_id, '__shared__'))
        WHERE status = 'running';
    `);
    console.log('[memory-consolidation] Schema memory_consolidation_runs OK');
  }

  // ── Cron ────────────────────────────────────────────────────────────────

  private scheduleCron(): void {
    // L9: ne jamais (re)programmer un timer si le module est détruit. Couvre le cas
    // où le callback chaîné franchit destroy() pendant `await runAll()`.
    if (this.destroyed) return;
    const schedule = this.memoryCfg?.cronSchedule ?? 'weekly';
    const hour = this.memoryCfg?.cronHour ?? 3;
    const msUntil = schedule === 'daily'
      ? this.msUntilHour(hour)
      : this.msUntilNextSunday(hour);

    console.log(`[memory-consolidation] Prochain run dans ${Math.round(msUntil / 3_600_000)}h (${schedule}, ${hour}h)`);

    this.cronTimer = setTimeout(async () => {
      console.log('[memory-consolidation] Cron déclenché');
      try {
        await this.runAll();
      } catch (err) {
        console.error('[memory-consolidation] Cron error:', err);
      }
      this.scheduleCron();
    }, msUntil);
  }

  private msUntilHour(hour: number): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  private msUntilNextSunday(hour: number): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    next.setDate(now.getDate() + daysUntilSunday);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7);
    return next.getTime() - now.getTime();
  }

  // ── Exécution ───────────────────────────────────────────────────────────

  /** Exécute la consolidation pour tous les agents. */
  async runAll(): Promise<void> {
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const agents = agentMod.listAgents();

    console.log(`[memory-consolidation] runAll: ${agents.length} agents`);

    for (const agent of agents) {
      try {
        await this.runForAgent(agent.identity.id);
      } catch (err) {
        console.error(`[memory-consolidation] Failed for ${agent.identity.id}:`, err);
      }
    }

    // Consolidation des mémoires shared (agent_id IS NULL)
    try {
      await this.runForAgent(null);
    } catch (err) {
      console.error('[memory-consolidation] Failed for shared memories:', err);
    }
  }

  /** Exécute la consolidation pour un agent (ou null pour shared). */
  async runForAgent(agentId: string | null): Promise<ConsolidationRunStats> {
    const pool = this.ctx.db;
    const cfg = this.memoryCfg;
    const providerMod = this.ctx.modules.get<ProviderModule>('provider');
    const memoryStoreMod = this.ctx.modules.tryGet<MemoryStoreModule>('memory-store');
    const store = memoryStoreMod?.isEnabled ? memoryStoreMod.store : undefined;

    // Check for running consolidation (prevent overlap)
    const running = await pool.query<{ id: string; started_at: Date }>(
      `SELECT id, started_at FROM memory_consolidation_runs
       WHERE agent_id ${agentId != null ? '= $1' : 'IS NULL'} AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      agentId != null ? [agentId] : [],
    );
    if (running.rows.length > 0) {
      const age = Date.now() - running.rows[0]!.started_at.getTime();
      if (age < 3_600_000) {
        console.log(`[memory-consolidation] Skip agent=${agentId ?? 'shared'} — run already in progress`);
        return { scored: 0, clustersFound: 0, merged: 0, archived: 0, errors: 0 };
      }
      // Zombie cleanup
      console.warn(`[memory-consolidation] Zombie cleanup: marking stale run ${running.rows[0]!.id} as error`);
      await pool.query(
        `UPDATE memory_consolidation_runs SET status = 'error', error = 'Zombie cleanup', finished_at = NOW() WHERE id = $1`,
        [running.rows[0]!.id],
      );
    }

    // Create run entry. The partial unique index uq_consolidation_runs_one_running
    // enforces at-most-one 'running' row per agent atomically: if a concurrent run
    // slipped past the SELECT above and inserted first, this INSERT fails with 23505
    // (unique_violation) and we skip instead of double-consolidating.
    let runId: string;
    try {
      const runRes = await pool.query<{ id: string }>(
        `INSERT INTO memory_consolidation_runs (agent_id) VALUES ($1) RETURNING id`,
        [agentId],
      );
      runId = runRes.rows[0]!.id;
    } catch (err) {
      if (err != null && typeof err === 'object' && (err as { code?: string }).code === '23505') {
        console.log(`[memory-consolidation] Skip agent=${agentId ?? 'shared'} — run already in progress (concurrent insert)`);
        return { scored: 0, clustersFound: 0, merged: 0, archived: 0, errors: 0 };
      }
      throw err;
    }
    console.log(`[memory-consolidation] Starting run ${runId} for agent=${agentId ?? 'shared'}`);

    const stats: ConsolidationRunStats = { scored: 0, clustersFound: 0, merged: 0, archived: 0, errors: 0 };
    const ws = this.ctx.ws;

    const broadcast = (step: 'scoring' | 'clustering' | 'merging' | 'archiving', stepNumber: number, detail?: string) => {
      ws.broadcastAll({
        type: 'consolidation.progress', runId, agentId, step, stepNumber, totalSteps: 4, detail,
      } satisfies WsServerMessage);
    };

    try {
      // 1. SCORE
      console.log(`[memory-consolidation] [${agentId ?? 'shared'}] Step 1/4: SCORE`);
      broadcast('scoring', 1, 'Calcul des scores...');
      stats.scored = await scoreMemories(pool, agentId, cfg);
      broadcast('scoring', 1, `${stats.scored} memoires scorees`);

      // 2. CLUSTER
      console.log(`[memory-consolidation] [${agentId ?? 'shared'}] Step 2/4: CLUSTER`);
      broadcast('clustering', 2, 'Recherche de clusters similaires...');
      const clusters = await findClusters(pool, agentId, cfg);
      stats.clustersFound = clusters.length;
      broadcast('clustering', 2, `${clusters.length} clusters trouves`);

      // 3. MERGE
      console.log(`[memory-consolidation] [${agentId ?? 'shared'}] Step 3/4: MERGE (${clusters.length} clusters)`);
      broadcast('merging', 3, `Fusion de ${clusters.length} clusters...`);
      if (clusters.length > 0) {
        const mergeModel = cfg?.mergeModel ?? this.ctx.config.defaults.model;
        const mergeResult = await mergeClusters(pool, clusters, providerMod, mergeModel, cfg, (i, total) => {
          broadcast('merging', 3, `Merge ${i}/${total}...`);
        }, store);
        stats.merged = mergeResult.merged;
        stats.errors += mergeResult.errors;
      }
      broadcast('merging', 3, `${stats.merged} fusionnees`);

      // 4. ARCHIVE
      console.log(`[memory-consolidation] [${agentId ?? 'shared'}] Step 4/4: ARCHIVE`);
      broadcast('archiving', 4, 'Archivage des memoires stale...');
      stats.archived = await archiveStaleMemories(pool, agentId, cfg);
      broadcast('archiving', 4, `${stats.archived} archivees`);

      // 5. Update run
      await pool.query(
        `UPDATE memory_consolidation_runs SET status = 'completed', finished_at = NOW(), stats = $1 WHERE id = $2`,
        [JSON.stringify(stats), runId],
      );

      ws.broadcastAll({
        type: 'consolidation.done', runId, agentId, stats,
      } satisfies WsServerMessage);

      console.log(
        `[memory-consolidation] agent=${agentId ?? 'shared'} done: scored=${stats.scored} clusters=${stats.clustersFound} merged=${stats.merged} archived=${stats.archived} errors=${stats.errors}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[memory-consolidation] Run ${runId} failed for agent=${agentId ?? 'shared'}: ${msg}`);
      ws.broadcastAll({
        type: 'consolidation.error', runId, agentId, error: msg,
      } satisfies WsServerMessage);
      await pool.query(
        `UPDATE memory_consolidation_runs SET status = 'error', finished_at = NOW(), error = $1, stats = $2 WHERE id = $3`,
        [msg, JSON.stringify(stats), runId],
      ).catch(dbErr => console.error('[memory-consolidation] Failed to update run status in DB:', dbErr));
      throw err;
    }

    return stats;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** Historique des runs de consolidation. */
  async getRunHistory(agentId?: string, limit = 10): Promise<ConsolidationRun[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    if (agentId !== undefined) {
      conditions.push(`agent_id = $${pi}`);
      params.push(agentId);
      pi++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const result = await this.ctx.db.query(
      `SELECT id, agent_id, started_at, finished_at, status, stats, error
       FROM memory_consolidation_runs ${where}
       ORDER BY started_at DESC LIMIT $${pi}`,
      params,
    );

    return result.rows.map(r => ({
      id: String(r['id']),
      agentId: (r['agent_id'] as string | null) ?? null,
      startedAt: r['started_at'] instanceof Date ? r['started_at'].toISOString() : String(r['started_at']),
      finishedAt: r['finished_at'] instanceof Date ? r['finished_at'].toISOString() : (r['finished_at'] as string | null) ?? null,
      status: String(r['status']) as ConsolidationRun['status'],
      stats: (r['stats'] as ConsolidationRunStats) ?? { scored: 0, clustersFound: 0, merged: 0, archived: 0, errors: 0 },
      error: (r['error'] as string | null) ?? null,
    }));
  }

  /** Stats de santé mémoire pour un agent. */
  async getHealthStats(agentId?: string): Promise<MemoryHealthStats> {
    const pool = this.ctx.db;
    const agentFilter = agentId
      ? `agent_id = $1`
      : `1=1`;
    const params = agentId ? [agentId] : [];

    const [counts, lastRun] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE archived = FALSE) AS active,
           COUNT(*) FILTER (WHERE archived = TRUE) AS archived,
           COUNT(*) FILTER (WHERE access_count = 0 AND archived = FALSE) AS never_accessed,
           AVG(score) FILTER (WHERE score IS NOT NULL AND archived = FALSE) AS avg_score,
           MIN(created_at) AS oldest
         FROM agent_memories WHERE ${agentFilter}`,
        params,
      ),
      this.getRunHistory(agentId, 1),
    ]);

    const row = counts.rows[0]!;
    return {
      total: Number(row['total']),
      active: Number(row['active']),
      archived: Number(row['archived']),
      neverAccessed: Number(row['never_accessed']),
      avgScore: row['avg_score'] != null ? Math.round(Number(row['avg_score']) * 1000) / 1000 : null,
      oldestMemory: row['oldest'] instanceof Date ? row['oldest'].toISOString() : null,
      lastConsolidationRun: lastRun[0] ?? null,
    };
  }

  /** Désarchive une mémoire. */
  async unarchive(id: string): Promise<void> {
    return unarchiveMemory(this.ctx.db, id);
  }
}
