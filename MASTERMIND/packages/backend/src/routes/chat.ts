import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../modules/agent/index.js';
import { NcmClient } from '../modules/ncm/client.js';
import { resolveSessionId } from '../modules/agent/sessionResolve.js';

export function chatRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const agentMod = ctx.modules.get<AgentModule>('agent');
  const ncmBaseUrl = ctx.config.ncm?.baseUrl;
  const ncmClient = ncmBaseUrl ? new NcmClient(ncmBaseUrl) : null;

  // Send message to agent (REST fallback - primary is WebSocket)
  app.post('/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const body = await c.req.json<{ sessionId?: string; content: string }>();
    // Session unifiée : canonicalise vers `{agent}-unified` si l'agent est en mode unifié.
    const agentCfg = agentMod.getAgent(agentId);
    const requestedSessionId = body.sessionId ?? `${agentId}-web`;
    const sessionId = agentCfg ? resolveSessionId(agentId, requestedSessionId, agentCfg) : requestedSessionId;
    console.log(`[route:chat] REST POST agent=${agentId} session=${sessionId} contentLen=${body.content.length}`);

    try {
      const response = await agentMod.run(agentId, sessionId, body.content, 'web');
      console.debug(`[route:chat] REST response agent=${agentId} len=${response.length}`);
      return c.json({ ok: true, response, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[route:chat] REST error agent=${agentId}: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  // Transcribe audio via NCM (same backend as Telegram voice) → text.
  // Frontend uploads a browser MediaRecorder blob (webm/opus by default) and
  // inserts the resulting transcript into the input bar.
  app.post('/:agentId/audio', async (c) => {
    if (!ncmClient) {
      return c.json({ error: 'NCM not configured' }, 503);
    }
    const agentId = c.req.param('agentId');
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'missing file field' }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const filename = file.name || 'voice.webm';
    console.log(`[route:chat] audio agent=${agentId} bytes=${buf.length} name=${filename}`);
    try {
      const { text, sttMs } = await ncmClient.transcribe(buf, agentId, filename);
      console.debug(`[route:chat] audio transcribed agent=${agentId} stt_ms=${sttMs} len=${text.length}`);
      return c.json({ ok: true, text, sttMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[route:chat] audio error agent=${agentId}: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
