import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { TelegramModule } from '../modules/telegram/index.js';
import type { ConfigModule } from '../modules/config/index.js';

export function telegramRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const telegramMod = ctx.modules.get<TelegramModule>('telegram');

  // List all bots with status
  app.get('/', (c) => {
    return c.json(telegramMod.getStatus());
  });

  // Add new bot
  app.post('/', async (c) => {
    const body = await c.req.json<{ id: string; token: string; enabled?: boolean }>();
    if (!body.id || !body.token) return c.json({ error: 'id and token required' }, 400);
    if (ctx.config.telegram.bots.find(b => b.id === body.id)) {
      return c.json({ error: `Bot "${body.id}" already exists` }, 409);
    }

    console.log(`[route:telegram] create bot=${body.id} enabled=${body.enabled ?? true}`);
    const botConf = { id: body.id, token: body.token, enabled: body.enabled ?? true };
    ctx.config.telegram.bots.push(botConf);
    ctx.modules.get<ConfigModule>('config').save();

    if (botConf.enabled) await telegramMod.startBot(botConf);
    return c.json({ ok: true }, 201);
  });

  // Update bot (token, enabled)
  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const botConf = ctx.config.telegram.bots.find(b => b.id === id);
    if (!botConf) return c.json({ error: 'Bot not found' }, 404);

    const body = await c.req.json<{ token?: string; enabled?: boolean }>();
    console.log(`[route:telegram] update bot=${id} enabled=${body.enabled ?? botConf.enabled}`);
    if (body.token !== undefined && body.token !== '') botConf.token = body.token;
    if (body.enabled !== undefined) botConf.enabled = body.enabled;

    ctx.modules.get<ConfigModule>('config').save();

    // Restart with new config
    await telegramMod.restartBot(id);
    return c.json({ ok: true });
  });

  // Delete bot
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const idx = ctx.config.telegram.bots.findIndex(b => b.id === id);
    if (idx === -1) return c.json({ error: 'Bot not found' }, 404);
    console.log(`[route:telegram] delete bot=${id}`);

    await telegramMod.stopBot(id);
    ctx.config.telegram.bots.splice(idx, 1);
    ctx.modules.get<ConfigModule>('config').save();
    return c.json({ ok: true });
  });

  // Restart all bots
  app.post('/restart', async (c) => {
    console.log(`[route:telegram] restart all bots`);
    await telegramMod.restartAll();
    return c.json({ ok: true, bots: telegramMod.getStatus() });
  });

  // Restart specific bot
  app.post('/:id/restart', async (c) => {
    const id = c.req.param('id');
    console.log(`[route:telegram] restart bot=${id}`);
    if (!ctx.config.telegram.bots.find(b => b.id === id)) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    await telegramMod.restartBot(id);
    return c.json({ ok: true, bot: telegramMod.getBotStatus(id) });
  });

  return app;
}
