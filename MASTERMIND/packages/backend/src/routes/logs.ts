import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import { getLogger } from '../modules/logger.js';
import type { LogLevel } from '../modules/logger.js';

export function logRoutes(_ctx: MastermindContext): Hono {
  const app = new Hono();

  /** GET /api/logs?tail=500&level=WARN&search=error&tag=memory-store&exclude=http,ws */
  app.get('/', (c) => {
    const tail     = Number(c.req.query('tail')   ?? 500);
    const minLevel = (c.req.query('level') as LogLevel | undefined);
    const search   = c.req.query('search') ?? undefined;
    const tag      = c.req.query('tag') ?? undefined;
    const exclude  = c.req.query('exclude') ?? undefined;
    const excludeTags = exclude ? exclude.split(',').map(t => t.trim()).filter(Boolean) : undefined;

    console.debug(`[route:logs] get tail=${tail} level=${minLevel ?? 'any'} tag=${tag ?? 'any'} search=${search ? 'yes' : 'no'} exclude=${excludeTags?.join(',') ?? 'none'}`);
    const entries = getLogger().getEntries({ tail, minLevel, search, tag, excludeTags });
    console.debug(`[route:logs] result entries=${entries.length}`);
    return c.json(entries);
  });

  return app;
}
