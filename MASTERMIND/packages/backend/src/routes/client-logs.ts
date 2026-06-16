import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';

type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ClientLogEntry {
  level?: ClientLogLevel;
  tag?: string;
  message?: string;
  ts?: string;
  url?: string;
  route?: string;
  sessionId?: string;
  agentId?: string;
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 50;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_DATA_CHARS = 2_000;

function sanitizeText(value: unknown, max = MAX_MESSAGE_CHARS): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeData(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  try {
    return JSON.stringify(data).slice(0, MAX_DATA_CHARS);
  } catch {
    return '[unserializable]';
  }
}

export function clientLogRoutes(_ctx: MastermindContext): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    let body: { entries?: ClientLogEntry[] };
    try {
      body = await c.req.json();
    } catch (err) {
      console.warn(`[frontend] log ingest invalid json: ${err instanceof Error ? err.message : err}`);
      return c.json({ ok: false, error: 'Invalid JSON' }, 400);
    }

    const entries = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
    if (entries.length === 0) {
      console.warn('[frontend] log ingest empty payload');
      return c.json({ ok: false, error: 'No entries' }, 400);
    }

    for (const entry of entries) {
      const level = entry.level === 'error' || entry.level === 'warn' || entry.level === 'info' || entry.level === 'debug'
        ? entry.level
        : 'info';
      const tag = sanitizeText(entry.tag || 'client', 80);
      const message = sanitizeText(entry.message);
      const data = sanitizeData(entry.data);
      const meta = [
        entry.ts ? `clientTs=${sanitizeText(entry.ts, 80)}` : '',
        entry.url ? `url=${sanitizeText(entry.url, 240)}` : '',
        entry.route ? `route=${sanitizeText(entry.route, 160)}` : '',
        entry.agentId ? `agent=${sanitizeText(entry.agentId, 80)}` : '',
        entry.sessionId ? `session=${sanitizeText(entry.sessionId, 120)}` : '',
        data ? `data=${data}` : '',
      ].filter(Boolean).join(' ');
      const line = `[frontend:${tag}] ${message}${meta ? ` ${meta}` : ''}`;

      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else if (level === 'debug') console.debug(line);
      else console.log(line);
    }

    return c.json({ ok: true, accepted: entries.length });
  });

  return app;
}
