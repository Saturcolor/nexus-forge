import { Hono } from 'hono';
import type { Context } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../modules/agent/index.js';
import type { ConfigModule } from '../modules/config/index.js';
import { resolveSafePath } from '../utils/paths.js';

/** Minimal extension → MIME map for the common output types agents produce. */
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function mimeFor(filename: string): string {
  return MIME_MAP[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Percent-decode a URL path segment. `decodeURIComponent` throws `URIError` on a
 * malformed escape (e.g. a lone `%`, `%zz`, or a truncated multi-byte sequence),
 * which would otherwise surface as an unhandled 500. Returns `null` so callers can
 * answer a clean 400 — consistent with the literal-prefix path handling below.
 */
function safeDecode(relPath: string): string | null {
  try {
    return decodeURIComponent(relPath);
  } catch {
    return null;
  }
}

/** Read a file under `baseDir` and return it with a content-type header, or a 4xx response. */
async function serveFile(c: Context, baseDir: string, relPath: string) {
  let abs: string;
  try {
    abs = resolveSafePath(baseDir, relPath);
  } catch {
    console.warn(`[route:files] invalid path rel="${relPath.slice(0, 160)}" base=${baseDir}`);
    return c.json({ error: 'Invalid path' }, 400);
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      console.warn(`[route:files] not a file rel="${relPath.slice(0, 160)}"`);
      return c.json({ error: 'Not a file' }, 404);
    }
    const buf = await fs.readFile(abs);
    console.debug(`[route:files] served rel="${relPath.slice(0, 160)}" size=${stat.size} mime=${mimeFor(abs)}`);
    return c.body(buf, 200, {
      'Content-Type': mimeFor(abs),
      'Content-Length': String(stat.size),
      'Cache-Control': 'private, max-age=300',
    });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      console.warn(`[route:files] not found rel="${relPath.slice(0, 160)}"`);
      return c.json({ error: 'Not found' }, 404);
    }
    console.error('[route:files] read error', err);
    return c.json({ error: 'Read failed' }, 500);
  }
}

export function filesRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  /** GET /agent/:agentId/*path — serve a file from the agent's workspace directory. */
  app.get('/agent/:agentId/*', async (c) => {
    const agentId = c.req.param('agentId');
    const agentMod = ctx.modules.get<AgentModule>('agent');
    const agent = agentMod.getAgent(agentId);
    if (!agent) {
      console.warn(`[route:files] agent not found agent=${agentId}`);
      return c.json({ error: 'Agent not found' }, 404);
    }

    // Hono wildcard captures everything after `/agent/:agentId/`.
    // Strip the literal mount prefix instead of building a RegExp from `agentId`:
    // an id containing a regex metachar (e.g. `agent(1)`, `a[b`) would make
    // `new RegExp(...)` throw a SyntaxError → unhandled 500. A literal slice is
    // both safe and faster.
    const prefix = `/api/files/agent/${agentId}/`;
    const relPath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    if (!relPath) {
      console.warn(`[route:files] missing path agent=${agentId}`);
      return c.json({ error: 'Missing path' }, 400);
    }

    const decoded = safeDecode(relPath);
    if (decoded === null) {
      console.warn(`[route:files] malformed encoding agent=${agentId} rel="${relPath.slice(0, 160)}"`);
      return c.json({ error: 'Invalid path encoding' }, 400);
    }

    console.debug(`[route:files] serve agent=${agentId} rel="${relPath.slice(0, 160)}"`);
    return serveFile(c, agent.workspacePath, decoded);
  });

  /** GET /shared/*path — serve a file from the shared memory directory. */
  app.get('/shared/*', async (c) => {
    const configMod = ctx.modules.get<ConfigModule>('config');
    const sharedDir = configMod.resolvePath(ctx.config.paths.sharedMemoryDir);

    const relPath = c.req.path.replace(/^\/api\/files\/shared\//, '');
    if (!relPath) {
      console.warn('[route:files] missing shared path');
      return c.json({ error: 'Missing path' }, 400);
    }

    const decoded = safeDecode(relPath);
    if (decoded === null) {
      console.warn(`[route:files] malformed encoding shared rel="${relPath.slice(0, 160)}"`);
      return c.json({ error: 'Invalid path encoding' }, 400);
    }

    console.debug(`[route:files] serve shared rel="${relPath.slice(0, 160)}"`);
    return serveFile(c, sharedDir, decoded);
  });

  return app;
}
