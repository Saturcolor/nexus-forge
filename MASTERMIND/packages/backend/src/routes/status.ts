import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MastermindContext } from '@mastermind/shared';
import type { TelegramModule } from '../modules/telegram/index.js';
import type { ProviderModule } from '../modules/provider/index.js';
import type { AgentModule } from '../modules/agent/index.js';
import type { MemoryStoreModule } from '../modules/memory-store/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));
    return pkg.version ?? null;
  } catch { return null; }
})();

export function statusRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const startedAt = Date.now();
    console.debug('[route:status] health snapshot start');
    const telegramMod  = ctx.modules.get<TelegramModule>('telegram');
    const providerMod  = ctx.modules.get<ProviderModule>('provider');
    const agentMod     = ctx.modules.get<AgentModule>('agent');
    const msmod        = ctx.modules.tryGet<MemoryStoreModule>('memory-store');

    // Telegram bots status
    const telegramBots = telegramMod.getStatus().map(b => ({
      id: b.id,
      enabled: b.enabled,
      running: b.running,

    }));

    // Providers: check reachability by pinging /models or base URL
    const providerStatuses = await Promise.all(
      ctx.config.providers.map(async p => {
        const pingUrl = p.modelsUrl ?? `${p.baseUrl}/models`;
        let reachable = false;
        try {
          const providerStartedAt = Date.now();
          const res = await fetch(pingUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(3000),
            headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
          });
          reachable = res.ok || res.status === 401; // 401 = reached but not authorized = provider alive
          console.debug(`[route:status] provider ping id=${p.id} status=${res.status} reachable=${reachable} ms=${Date.now() - providerStartedAt}`);
        } catch (err) {
          console.warn(`[route:status] provider ping failed id=${p.id}: ${err instanceof Error ? err.message : err}`);
          reachable = false;
        }
        return { id: p.id, type: p.type, baseUrl: p.baseUrl, reachable };
      })
    );

    // Agents with their provider binding
    const agents = agentMod.listAgents().map(a => {
      const cfg = ctx.config.agents[a.identity.id];
      const model = cfg?.model ?? '';
      // Infer provider from model (mercury models contain '/')
      const providerId = model.includes('/') ? 'mercury' : (ctx.config.providers[0]?.id ?? 'unknown');
      return {
        id: a.identity.id,
        model,
        providerId,
        state: agentMod.getState(a.identity.id),
        telegram: cfg?.telegram,
      };
    });

    // Database ping + table counts
    let dbOk = false;
    let dbStats: {
      sessions?: number;
      messages?: number;
      messagesCompacted?: number;
      reasoningTraces?: number;
      memories?: number;
      scheduledTasks?: number;
      activeJobs?: number;
      dbSize?: string | null;
      lastMessageAt?: string | null;
      lastSessionAt?: string | null;
    } = {};
    try {
      // Tables de base + tables MANDATAIRES (scheduled_tasks, async_jobs — toutes créées par
      // ensureSchema) : toute erreur remonte au catch externe (dbOk=false + log), pas de masquage.
      // Seuls agent_memories (OPTIONNEL — nécessite pgvector + memory-store) et pg_database_size
      // sont en .catch → 0/null si indispo, sans casser le reste.
      const zeroCount = (): { rows: Array<{ count: number }> } => ({ rows: [{ count: 0 }] });
      const [coreRow, memRow, schedRow, jobsRow, sizeRow] = await Promise.all([
        ctx.db.query<{ sessions: number; last_session: string | null; messages: number; compacted: number; last_message: string | null; traces: number }>(
          `SELECT
             (SELECT COUNT(*)::int FROM sessions)                                  AS sessions,
             (SELECT MAX(created_at) FROM sessions)                                AS last_session,
             (SELECT COUNT(*)::int FROM messages)                                 AS messages,
             (SELECT COUNT(*)::int FROM messages WHERE compacted_at IS NOT NULL)  AS compacted,
             (SELECT MAX(created_at) FROM messages)                               AS last_message,
             (SELECT COUNT(*)::int FROM reasoning_traces)                         AS traces`
        ),
        ctx.db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM agent_memories WHERE archived = FALSE`).catch(zeroCount),
        ctx.db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM scheduled_tasks WHERE deleted_at IS NULL AND enabled = TRUE`),
        ctx.db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM async_jobs WHERE status IN ('queued','running')`),
        ctx.db.query<{ size: string | null }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`).catch(() => ({ rows: [{ size: null }] })),
      ]);
      dbOk = true;
      const c = coreRow.rows[0];
      dbStats = {
        sessions: Number(c?.sessions ?? 0),
        messages: Number(c?.messages ?? 0),
        messagesCompacted: Number(c?.compacted ?? 0),
        reasoningTraces: Number(c?.traces ?? 0),
        memories: Number(memRow.rows[0]?.count ?? 0),
        scheduledTasks: Number(schedRow.rows[0]?.count ?? 0),
        activeJobs: Number(jobsRow.rows[0]?.count ?? 0),
        dbSize: sizeRow.rows[0]?.size ?? null,
        lastMessageAt: c?.last_message ?? null,
        lastSessionAt: c?.last_session ?? null,
      };
    } catch (err) {
      console.warn(`[route:status] database stats failed: ${err instanceof Error ? err.message : err}`);
      dbOk = false;
    }

    // Memory store stats (non-blocking — best-effort)
    let memoryStore: {
      enabled: boolean;
      total?: number;
      perAgent?: Record<string, number>;
      perScope?: Record<string, number>;
      perDomain?: Record<string, number>;
      lastEntryAt?: string | null;
      embeddingDimensions?: number;
    } = { enabled: false };

    if (msmod?.isEnabled) {
      try {
        const [stats, lastRow] = await Promise.all([
          msmod.stats(),
          ctx.db.query<{ last: string | null }>('SELECT MAX(created_at) AS last FROM agent_memories'),
        ]);
        memoryStore = {
          enabled: true,
          total: stats.total,
          perAgent: stats.perAgent,
          perScope: stats.perScope,
          perDomain: stats.perDomain,
          lastEntryAt: lastRow.rows[0]?.last ?? null,
          embeddingDimensions: ctx.config.memoryStore?.embeddingDimensions ?? 4096,
        };
      } catch (err) {
        console.warn(`[route:status] memory-store stats failed: ${err instanceof Error ? err.message : err}`);
        memoryStore = { enabled: true };
      }
    } else if (ctx.config.memoryStore?.enabled) {
      // Configured but not yet initialised (reinit pending)
      memoryStore = { enabled: false };
    }

    console.debug(`[route:status] health snapshot done providers=${providerStatuses.length} agents=${agents.length} dbOk=${dbOk} memoryStore=${memoryStore.enabled} ms=${Date.now() - startedAt}`);
    return c.json({
      version: PKG_VERSION,
      uptime: process.uptime(),
      database: { ok: dbOk, ...dbStats },
      providers: providerStatuses,
      telegram: telegramBots,
      agents,
      memoryStore,
    });
  });

  return app;
}
