import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { ConsolidationModule } from '../modules/consolidation/index.js';

export function consolidationRoutes(ctx: MastermindContext) {
  const app = new Hono();

  /** POST /api/consolidation/run — trigger consolidation manually */
  app.post('/run', async (c) => {
    const startedAt = Date.now();
    const consolidationMod = ctx.modules.get<ConsolidationModule>('consolidation');

    let agentId: string | undefined;
    let date: string | undefined;

    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      agentId = typeof body['agentId'] === 'string' ? body['agentId'] : undefined;
      date = typeof body['date'] === 'string' ? body['date'] : undefined;
    } catch {
      // no body is fine
    }

    console.log(`[route:consolidation] trigger agentId=${agentId ?? 'all'} date=${date ?? 'today'}`);

    try {
      if (agentId) {
        const summary = await consolidationMod.runForAgent(agentId, date);
        const effectiveDate = date ?? new Date().toISOString().split('T')[0]!;
        console.log(`[route:consolidation] agent done agent=${agentId} date=${effectiveDate} summaryLen=${summary.length} ms=${Date.now() - startedAt}`);
        return c.json({ ok: true, agents: [agentId], date: effectiveDate, summary });
      }

      const result = await consolidationMod.runAll(date);
      console.log(`[route:consolidation] all done agents=${result.agents.length} date=${result.date} ms=${Date.now() - startedAt}`);
      return c.json({ ok: true, ...result });
    } catch (err) {
      console.error(`[route:consolidation] error after ${Date.now() - startedAt}ms:`, err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
