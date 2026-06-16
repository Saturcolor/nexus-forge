import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { MemoryConsolidationModule } from '../modules/memory-consolidation/index.js';

export function memoryConsolidationRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  function getMod(): MemoryConsolidationModule | undefined {
    return ctx.modules.tryGet<MemoryConsolidationModule>('memory-consolidation');
  }

  // ── POST /api/memory-consolidation/run ──────────────────────────────────
  // Trigger manuel de consolidation. Body optionnel : { agentId?: string }
  app.post('/run', async (c) => {
    const startedAt = Date.now();
    const mod = getMod();
    if (!mod) {
      console.warn('[memory-consolidation] API POST /run module unavailable');
      return c.json({ error: 'Module memory-consolidation non disponible' }, 503);
    }

    let body: { agentId?: string } = {};
    try {
      body = await c.req.json();
    } catch { /* no body = run all */ }

    console.log(`[memory-consolidation] API POST /run agent=${body.agentId ?? 'all'}`);

    try {
      if (body.agentId) {
        const stats = await mod.runForAgent(body.agentId);
        console.log(`[memory-consolidation] API POST /run done agent=${body.agentId} ms=${Date.now() - startedAt}`);
        return c.json({ ok: true, agentId: body.agentId, stats });
      } else {
        await mod.runAll();
        console.log(`[memory-consolidation] API POST /run done all ms=${Date.now() - startedAt}`);
        return c.json({ ok: true });
      }
    } catch (err) {
      console.error('[memory-consolidation] API POST /run error:', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── GET /api/memory-consolidation/runs ──────────────────────────────────
  // Historique des runs. Query params : agentId, limit
  app.get('/runs', async (c) => {
    const mod = getMod();
    if (!mod) {
      console.warn('[memory-consolidation] API GET /runs module unavailable');
      return c.json({ error: 'Module memory-consolidation non disponible' }, 503);
    }

    const agentId = c.req.query('agentId') || undefined;
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10)));

    console.debug(`[memory-consolidation] API GET /runs agent=${agentId ?? 'all'} limit=${limit}`);
    try {
      const runs = await mod.getRunHistory(agentId, limit);
      console.debug(`[memory-consolidation] API GET /runs result count=${runs.length}`);
      return c.json({ runs });
    } catch (err) {
      console.error('[memory-consolidation] API GET /runs error:', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── GET /api/memory-consolidation/health ────────────────────────────────
  // Stats de santé mémoire. Query param : agentId
  app.get('/health', async (c) => {
    const mod = getMod();
    if (!mod) {
      console.warn('[memory-consolidation] API GET /health module unavailable');
      return c.json({ error: 'Module memory-consolidation non disponible' }, 503);
    }

    const agentId = c.req.query('agentId') || undefined;

    console.debug(`[memory-consolidation] API GET /health agent=${agentId ?? 'all'}`);
    try {
      const health = await mod.getHealthStats(agentId);
      console.debug(`[memory-consolidation] API GET /health result agent=${agentId ?? 'all'}`);
      return c.json(health);
    } catch (err) {
      console.error('[memory-consolidation] API GET /health error:', err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── POST /api/memory-consolidation/unarchive/:id ────────────────────────
  app.post('/unarchive/:id', async (c) => {
    const mod = getMod();
    if (!mod) {
      console.warn('[memory-consolidation] API POST /unarchive module unavailable');
      return c.json({ error: 'Module memory-consolidation non disponible' }, 503);
    }

    const id = c.req.param('id');
    console.log(`[memory-consolidation] API POST /unarchive/${id.slice(0, 8)}…`);

    try {
      await mod.unarchive(id);
      console.log(`[memory-consolidation] API POST /unarchive/${id.slice(0, 8)} ok`);
      return c.json({ ok: true });
    } catch (err) {
      console.error(`[memory-consolidation] API POST /unarchive/${id.slice(0, 8)} error:`, err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
