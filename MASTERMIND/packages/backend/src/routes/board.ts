import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { BoardModule } from '../modules/board/index.js';

export function boardRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  function getMod(): BoardModule {
    return ctx.modules.get<BoardModule>('board');
  }

  // List all active (non-expired) notes
  app.get('/', async (c) => {
    console.debug('[route:board] list active notes');
    const notes = await getMod().listActive();
    console.debug(`[route:board] list active notes count=${notes.length}`);
    return c.json(notes);
  });

  // Delete a note by id (manual cleanup from the UI)
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    console.log(`[route:board] delete note=${id}`);
    const ok = await getMod().deleteNote(id);
    if (!ok) {
      console.warn(`[route:board] delete note=${id} not found`);
      return c.json({ error: 'Note not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Purge all expired notes (manual trigger from the UI)
  app.post('/purge', async (c) => {
    console.log('[route:board] purge expired notes requested');
    const count = await getMod().purgeExpired();
    console.log(`[route:board] purge expired notes count=${count}`);
    return c.json({ purged: count });
  });

  return app;
}
