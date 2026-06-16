import { Hono } from 'hono';
import type { MastermindContext, CreateSourceInput, UpdateSourceInput, ProactiveIngestPayload } from '@mastermind/shared';
import type { ProactiveSourceModule } from '../modules/proactive-source/index.js';
import type { SessionModule } from '../modules/session/index.js';

export function proactiveSourceRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  function getMod(): ProactiveSourceModule {
    return ctx.modules.get<ProactiveSourceModule>('proactive-source');
  }

  // ── Sources CRUD ───────────────────────────────────────────

  app.get('/sources', async (c) => {
    console.debug('[route:proactive-source] list sources');
    const sources = await getMod().listSources();
    console.debug(`[route:proactive-source] list sources count=${sources.length}`);
    return c.json(sources);
  });

  app.get('/sources/:id', async (c) => {
    const id = c.req.param('id');
    console.debug(`[route:proactive-source] get source=${id}`);
    const source = await getMod().getSource(id);
    if (!source) {
      console.warn(`[route:proactive-source] get source=${id} not found`);
      return c.json({ error: 'Source not found' }, 404);
    }
    return c.json(source);
  });

  app.post('/sources', async (c) => {
    try {
      const body = await c.req.json<CreateSourceInput>();
      console.log(`[route:proactive-source] create source name="${body.name}" agent=${body.agentId} keys=${Object.keys(body as unknown as Record<string, unknown>).join(',')}`);
      const source = await getMod().createSource(body);
      return c.json(source, 201);
    } catch (err) {
      console.warn(`[route:proactive-source] create source failed: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put('/sources/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const body = await c.req.json<UpdateSourceInput>();
      console.log(`[route:proactive-source] update source=${id} keys=${Object.keys(body).join(',')}`);
      const source = await getMod().updateSource(id, body);
      if (!source) {
        console.warn(`[route:proactive-source] update source=${id} not found`);
        return c.json({ error: 'Source not found' }, 404);
      }
      return c.json(source);
    } catch (err) {
      console.warn(`[route:proactive-source] update source=${id} failed: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete('/sources/:id', async (c) => {
    const id = c.req.param('id');
    console.log(`[route:proactive-source] delete source=${id}`);
    const ok = await getMod().deleteSource(id);
    if (!ok) {
      console.warn(`[route:proactive-source] delete source=${id} not found`);
      return c.json({ error: 'Source not found' }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/sources/:id/toggle', async (c) => {
    const id = c.req.param('id');
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    console.log(`[route:proactive-source] toggle source=${id} enabled=${enabled}`);
    const source = await getMod().toggleSource(id, enabled);
    if (!source) {
      console.warn(`[route:proactive-source] toggle source=${id} not found`);
      return c.json({ error: 'Source not found' }, 404);
    }
    return c.json(source);
  });

  // ── Alerts history ─────────────────────────────────────────

  app.get('/alerts', async (c) => {
    const sourceId = c.req.query('sourceId');
    const limit = parseInt(c.req.query('limit') ?? '50');
    console.debug(`[route:proactive-source] list alerts source=${sourceId ?? 'all'} limit=${limit}`);
    const alerts = await getMod().listAlerts(sourceId ?? undefined, limit);
    console.debug(`[route:proactive-source] list alerts count=${alerts.length}`);
    return c.json(alerts);
  });

  // Flush the assigned agent's session messages (reset context, keep session alive)
  app.post('/sources/:id/flush', async (c) => {
    const id = c.req.param('id');
    console.log(`[route:proactive-source] flush source=${id}`);
    const source = await getMod().getSource(id);
    if (!source) {
      console.warn(`[route:proactive-source] flush source=${id} not found`);
      return c.json({ error: 'Source not found' }, 404);
    }

    const sessionMod = ctx.modules.get<SessionModule>('session');
    const sessions = await sessionMod.listByAgent(source.agentId);
    let totalCleared = 0;
    for (const s of sessions) {
      totalCleared += await sessionMod.clearMessages(s.id);
    }
    console.log(`[proactive-source] flushed ${totalCleared} messages from ${sessions.length} session(s) of agent ${source.agentId}`);
    return c.json({ ok: true, agentId: source.agentId, sessionsCleared: sessions.length, messagesCleared: totalCleared });
  });

  // ── Webhook ingest endpoint ────────────────────────────────
  // Called by external apps (Nexus Monitor, Mailmind, etc.)
  // Auth is handled by the global API key middleware (same as all other routes).
  app.post('/ingest', async (c) => {
    try {
      const payload = await c.req.json<ProactiveIngestPayload>();
      if (!payload.source || !payload.title || !payload.message) {
        console.warn(`[route:proactive-source] ingest rejected missing fields source=${payload.source ?? '∅'} title=${payload.title ? 'yes' : 'no'} message=${payload.message ? 'yes' : 'no'}`);
        return c.json({ error: 'source, title, and message are required' }, 400);
      }
      console.log(`[route:proactive-source] ingest source=${payload.source} titleLen=${payload.title.length} messageLen=${payload.message.length} severity=${payload.severity ?? 'default'}`);
      const result = await getMod().ingest(payload);
      console.log(`[route:proactive-source] ingest result source=${payload.source} accepted=${result.accepted} reason=${result.reason ?? 'none'}`);
      return c.json(result, result.accepted ? 200 : 404);
    } catch (err) {
      console.warn(`[route:proactive-source] ingest failed: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
