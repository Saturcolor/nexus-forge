import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { PushModule } from '../modules/push/index.js';
import type { ConfigModule } from '../modules/config/index.js';
import { pushConfigSchema } from '../modules/config/schema.js';

/** Vue UI-safe de la config push : JAMAIS la clé .p8 inline, juste un booléen "présente". */
function redactPushConfig(p: MastermindContext['config']['push']) {
  const a = p?.apns;
  return {
    enabled: !!p?.enabled,
    apns: {
      keyId: a?.keyId ?? '',
      teamId: a?.teamId ?? '',
      topic: a?.topic ?? '',
      production: !!a?.production,
      keyPath: a?.keyPath ?? '',
      hasInlineKey: !!a?.keyP8,
    },
  };
}

/**
 * Routes du canal push mobile (APNs (mobile)). Protégées par le middleware
 * Bearer global sur /api/* (server.ts) — l'app iOS envoie le même token HUB que
 * pour le reste de l'API. Miroir léger de routes/telegram.ts.
 */
export function pushRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const pushMod = ctx.modules.get<PushModule>('push');

  // Statut du canal (enabled, configured, nb d'appareils).
  app.get('/', async (c) => {
    return c.json(await pushMod.getStatus());
  });

  // Liste des appareils enregistrés (debug / réglages).
  app.get('/devices', async (c) => {
    const devices = await pushMod.listDevices();
    // Ne jamais renvoyer le token complet — juste de quoi identifier l'appareil.
    return c.json(devices.map(d => ({
      tokenTail: d.token.slice(-8),
      platform: d.platform,
      agentId: d.agentId,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
    })));
  });

  // Enregistre / rafraîchit un device token (appelé par l'app à chaque obtention du token APNs).
  app.post('/register', async (c) => {
    let body: { token?: string; platform?: string; agentId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const token = (body.token ?? '').trim();
    if (!token) return c.json({ error: 'token required' }, 400);
    // Garde-fou : un device token APNs est de l'hex (64 car. en général, mais peut varier).
    if (!/^[0-9a-fA-F]{32,200}$/.test(token)) {
      console.warn(`[route:push] register rejected — token not hex (len=${token.length})`);
      return c.json({ error: 'token must be hex' }, 400);
    }
    try {
      await pushMod.registerDevice(token, body.platform ?? 'ios', body.agentId ?? null);
      return c.json({ ok: true });
    } catch (err) {
      console.error(`[route:push] register failed: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: 'register failed' }, 500);
    }
  });

  // Enregistre le push token d'une Live Activity (Dynamic Island) pour une session.
  // Appelé par mobile app quand ActivityKit émet/renouvelle le token (pushType:.token).
  app.post('/liveactivity/register', async (c) => {
    let body: { token?: string; sessionId?: string; agentId?: string; startedAt?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const token = (body.token ?? '').trim();
    const sessionId = (body.sessionId ?? '').trim();
    const agentId = (body.agentId ?? '').trim();
    if (!token || !sessionId || !agentId) {
      return c.json({ error: 'token, sessionId, agentId required' }, 400);
    }
    // Token Live Activity = hex (longueur variable, généralement bien plus long qu'un device token).
    if (!/^[0-9a-fA-F]{32,256}$/.test(token)) {
      console.warn(`[route:push] LA register rejected — token not hex (len=${token.length})`);
      return c.json({ error: 'token must be hex' }, 400);
    }
    const startedAt = typeof body.startedAt === 'number' ? body.startedAt : Math.floor(Date.now() / 1000);
    pushMod.registerLiveActivity(sessionId, agentId, token, startedAt);
    return c.json({ ok: true });
  });

  // Désenregistre un appareil (logout / désactivation des notifs).
  app.delete('/register/:token', async (c) => {
    const removed = await pushMod.removeDevice(c.req.param('token'));
    return c.json({ ok: true, removed });
  });

  // Config push (UI Settings) — JAMAIS la clé inline en sortie.
  app.get('/config', (c) => {
    return c.json(redactPushConfig(ctx.config.push));
  });

  // Sauvegarde la config push → écrit mastermind.yml (configMod.save) + reload le module à chaud.
  app.put('/config', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = pushConfigSchema.safeParse(body);
    if (!parsed.success) {
      console.warn(`[route:push] config rejected: ${parsed.error.message}`);
      return c.json({ error: parsed.error.message }, 400);
    }
    const next = parsed.data;
    // La clé inline n'est jamais renvoyée au front → si l'UI n'en repose pas une (et ne fournit
    // pas non plus de keyPath), on conserve celle déjà en place plutôt que de l'effacer.
    const prev = ctx.config.push;
    if (next.apns && !next.apns.keyP8?.trim() && !next.apns.keyPath?.trim() && prev?.apns?.keyP8) {
      next.apns.keyP8 = prev.apns.keyP8;
    }
    ctx.config.push = next;
    try {
      ctx.modules.get<ConfigModule>('config').save();
    } catch (err) {
      console.error(`[route:push] config save failed: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: 'config save failed' }, 500);
    }
    pushMod.reload();
    console.log(`[route:push] config saved enabled=${next.enabled} keyId=${next.apns?.keyId ?? '-'} topic=${next.apns?.topic ?? '-'} prod=${!!next.apns?.production} → reloaded (active=${pushMod.isEnabled()})`);
    return c.json({ ...redactPushConfig(ctx.config.push), active: pushMod.isEnabled() });
  });

  // Envoi d'un push de test à tous les appareils (bouton "Tester" côté réglages).
  app.post('/test', async (c) => {
    if (!pushMod.isEnabled()) {
      return c.json({ error: 'push not enabled (config.push + APNs key required)' }, 409);
    }
    const result = await pushMod.sendToAll({
      title: 'Mastermind',
      body: 'Test notification ✅',
      threadId: 'push-test',
      data: { kind: 'test' },
    });
    return c.json(result);
  });

  return app;
}
