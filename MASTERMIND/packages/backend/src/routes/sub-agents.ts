/**
 * Routes dédiées sub-agents — listings + stats par preset.
 *
 * Côté CRUD agent (création / édition / suppression sub-agent), les routes
 * passent par `/api/agents` (pattern unifié — un sub-agent = un agent avec
 * `kind: 'subagent'`). Ce fichier expose uniquement les endpoints spécifiques :
 *
 *  - GET  /api/sub-agents/runs          — liste tous les runs (async_jobs WHERE kind='sub_agent')
 *  - GET  /api/sub-agents/:id/runs      — runs d'un preset précis
 *  - GET  /api/sub-agents/:id/stats     — count par status sur 30j (UI page sub-agent)
 *  - GET  /api/sub-agents/by-parent-session/:sessionId — runs spawnés depuis une session parente
 *    (pour le drill-down côté conv parente)
 */

import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';

export function subAgentsRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  /** GET /runs — list all sub-agent runs, optional ?status=, ?limit= */
  app.get('/runs', async (c) => {
    const statusRaw = c.req.query('status');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 100;
    const status = statusRaw ? statusRaw.split(',').filter(s => ['queued', 'running', 'done', 'error', 'cancelled'].includes(s)) : null;

    let where = `WHERE kind = 'sub_agent'`;
    const params: unknown[] = [];
    if (status && status.length > 0) {
      params.push(status);
      where += ` AND status = ANY($${params.length})`;
    }
    params.push(limit);
    const sql = `SELECT * FROM async_jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`;
    const res = await ctx.db.query(sql, params);
    console.debug(`[route:sub-agents] runs status=${status?.join(',') ?? 'all'} limit=${limit} rows=${res.rows.length}`);
    return c.json(res.rows);
  });

  /** GET /:id/runs — runs for a specific sub-agent preset */
  app.get('/:id/runs', async (c) => {
    const subAgentId = c.req.param('id');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 50;
    const res = await ctx.db.query(
      `SELECT * FROM async_jobs
         WHERE kind = 'sub_agent' AND sub_agent_id = $1
         ORDER BY created_at DESC LIMIT $2`,
      [subAgentId, limit],
    );
    console.debug(`[route:sub-agents] runs preset=${subAgentId} limit=${limit} rows=${res.rows.length}`);
    return c.json(res.rows);
  });

  /** GET /:id/stats — counts per status over a window (default 30 days) */
  app.get('/:id/stats', async (c) => {
    const subAgentId = c.req.param('id');
    const daysRaw = c.req.query('days');
    const days = daysRaw ? Math.max(1, Math.min(365, parseInt(daysRaw, 10))) : 30;
    const res = await ctx.db.query(
      `SELECT status,
              COUNT(*)::int AS count,
              AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::int AS avg_duration_ms,
              MAX(created_at)                                                 AS last_run_at
         FROM async_jobs
        WHERE kind = 'sub_agent'
          AND sub_agent_id = $1
          AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY status`,
      [subAgentId, String(days)],
    );
    const total = res.rows.reduce((acc, r) => acc + Number(r['count'] ?? 0), 0);
    console.debug(`[route:sub-agents] stats preset=${subAgentId} days=${days} total=${total} groups=${res.rows.length}`);
    return c.json({
      subAgentId,
      windowDays: days,
      total,
      byStatus: res.rows.map(r => ({
        status: r['status'],
        count: Number(r['count'] ?? 0),
        avgDurationMs: r['avg_duration_ms'] !== null ? Number(r['avg_duration_ms']) : null,
        lastRunAt: r['last_run_at'] ?? null,
      })),
    });
  });

  /** GET /by-parent-session/:sessionId — list sub-agent runs spawned from a parent session */
  app.get('/by-parent-session/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 50;
    const res = await ctx.db.query(
      `SELECT * FROM async_jobs
         WHERE kind = 'sub_agent' AND parent_session_id = $1
         ORDER BY created_at DESC LIMIT $2`,
      [sessionId, limit],
    );
    console.debug(`[route:sub-agents] runs by-parent session=${sessionId} rows=${res.rows.length}`);
    return c.json(res.rows);
  });

  return app;
}
