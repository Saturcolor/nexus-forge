import { Hono } from 'hono';
import type { MastermindContext, CreateRoomInput } from '@mastermind/shared';
import type { WarRoomModule } from '../modules/war-room/index.js';

export function warRoomRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  function getMod(): WarRoomModule {
    return ctx.modules.get<WarRoomModule>('war-room');
  }

  // List all rooms (open, closed, crashed) — latest first
  app.get('/', async (c) => {
    console.debug('[route:war-room] list rooms');
    const rooms = await getMod().listRooms();
    console.debug(`[route:war-room] list rooms count=${rooms.length}`);
    return c.json(rooms);
  });

  // Get full detail (members + turn + count)
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    console.debug(`[route:war-room] get room=${id}`);
    const detail = await getMod().getRoomDetail(id);
    if (!detail) {
      console.warn(`[route:war-room] get room=${id} not found`);
      return c.json({ error: 'Room not found' }, 404);
    }
    return c.json(detail);
  });

  // Create a new room
  app.post('/', async (c) => {
    try {
      const body = await c.req.json<CreateRoomInput>();
      console.log(`[route:war-room] create room keys=${Object.keys(body as unknown as Record<string, unknown>).join(',')}`);
      const detail = await getMod().createRoom(body);
      return c.json(detail, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:war-room] create failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  // List messages (canonical chronological log)
  app.get('/:id/messages', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '500');
    const id = c.req.param('id');
    console.debug(`[route:war-room] list messages room=${id} limit=${limit}`);
    const messages = await getMod().listMessages(id, limit);
    console.debug(`[route:war-room] list messages room=${id} count=${messages.length}`);
    return c.json(messages);
  });

  // User posts a message into the room
  app.post('/:id/post', async (c) => {
    const id = c.req.param('id');
    try {
      const { content } = await c.req.json<{ content: string }>();
      console.log(`[route:war-room] post user message room=${id} len=${content.length}`);
      await getMod().postUserMessage(id, content);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:war-room] post room=${id} failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  // User skips their turn (explicit or via front-end auto-pass mode)
  app.post('/:id/skip', async (c) => {
    const id = c.req.param('id');
    try {
      console.log(`[route:war-room] skip user turn room=${id}`);
      await getMod().skipUserTurn(id);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:war-room] skip room=${id} failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  // Close the room: abort any running turn, generate summary, write archive, cleanup sessions
  app.post('/:id/close', async (c) => {
    const id = c.req.param('id');
    try {
      console.log(`[route:war-room] close room=${id}`);
      const result = await getMod().closeRoom(id, 'user');
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:war-room] close room=${id} failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  // Emergency stop — abort current turn without closing the room
  app.post('/:id/abort', async (c) => {
    const id = c.req.param('id');
    try {
      console.log(`[route:war-room] abort room=${id}`);
      await getMod().abortRoom(id);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:war-room] abort room=${id} failed: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  return app;
}
