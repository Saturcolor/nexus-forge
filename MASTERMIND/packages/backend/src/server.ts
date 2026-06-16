import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { MastermindConfig } from '@mastermind/shared';

/** Une seule source : fichier VERSION à la racine du repo MASTERMIND (voir VERSIONING.md). */
function readMastermindVersion(): string {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const versionFile = path.join(repoRoot, 'VERSION');
  try {
    if (fs.existsSync(versionFile)) {
      const line = fs.readFileSync(versionFile, 'utf-8').trim().split(/\r?\n/)[0]?.trim();
      if (line) return line;
    }
  } catch {
    /* ignore */
  }
  try {
    const pkgPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* ignore */
  }
  return '0.0.0-dev';
}

const MASTERMIND_RUNTIME_VERSION = readMastermindVersion();
const POLLING_API_PATHS = new Set([
  '/api/logs',
  '/api/codebase-search/status',
  '/api/status',
  '/api/agents',
  '/api/agents/workspace/scan',
  '/api/async-jobs',
  '/api/memory/shared',
  '/api/providers',
  '/api/telegram',
  '/api/client-logs',
]);

function isDebugHttpPath(pathname: string): boolean {
  if (POLLING_API_PATHS.has(pathname)) return true;
  if (/^\/api\/agents\/[^/]+$/.test(pathname)) return true;
  if (/^\/api\/agents\/[^/]+\/prompt-size$/.test(pathname)) return true;
  return false;
}

export function createApp(config: MastermindConfig): Hono {
  const app = new Hono();

  // CORS
  app.use('*', cors({
    origin: ['http://localhost:5173', `http://localhost:${config.server.port}`],
    credentials: true,
  }));

  // HTTP request logging (console → fichier via logger)
  app.use('*', async (c, next) => {
    const start = Date.now();
    const reqId = c.req.header('x-request-id') ?? randomUUID().slice(0, 12);
    const p = c.req.path;
    const ua = c.req.header('user-agent');
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('cf-connecting-ip') ?? 'unknown';
    c.header('x-request-id', reqId);
    console.debug(`[http] req.start id=${reqId} method=${c.req.method} path=${p} ip=${ip}${ua ? ` ua="${ua.slice(0, 160)}"` : ''}`);
    try {
      await next();
    } catch (err) {
      const ms = Date.now() - start;
      console.error(`[http] req.error id=${reqId} method=${c.req.method} path=${p} ms=${ms}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    } finally {
      const ms = Date.now() - start;
      const line = `id=${reqId} ${c.req.method} ${p} ${c.res.status} ${ms}ms`;
      const isDebugPath = isDebugHttpPath(p);
      const isDown = c.res.status >= 400;
      if (p === '/health') {
        console.debug(`[http] ${line}`);
      } else if (isDebugPath) {
        if (isDown) console.warn(`[http] ${line}`);
        else console.debug(`[http] ${line}`);
      } else if (p.startsWith('/api/')) {
        if (isDown) console.warn(`[http] ${line}`);
        else console.debug(`[http] ${line}`);
        if (ua) console.debug(`[http] id=${reqId} ${c.req.method} ${p} user-agent=${ua.slice(0, 200)}`);
      } else {
        console.debug(`[http] ${line}`);
      }
    }
  });

  // API key auth for /api/* routes
  // Accepts Bearer header OR ?token= query param (for iframe embedding from a parent application)
  app.use('/api/*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const apiKey = authHeader?.replace('Bearer ', '') || c.req.query('token') || '';
    if (apiKey !== config.server.apiKey) {
      console.warn(`[http] unauthorized method=${c.req.method} path=${c.req.path} authHeader=${authHeader ? 'yes' : 'no'} tokenQuery=${c.req.query('token') ? 'yes' : 'no'}`);
      return c.json({ error: 'Unauthorized' }, 401);
    }
    console.debug(`[http] auth.ok method=${c.req.method} path=${c.req.path}`);
    await next();
  });

  // Health check (no auth)
  app.get('/health', (c) => {
    return c.json({ ok: true, version: MASTERMIND_RUNTIME_VERSION, uptime: process.uptime() });
  });

  // NOTE: API routes + static/SPA handler are mounted in index.ts AFTER this returns
  return app;
}

/**
 * Mount static files + SPA fallback.
 * MUST be called AFTER all app.route() API calls so the wildcard does not shadow them.
 */
export function mountStatic(app: Hono): void {
  const staticDir = path.resolve(import.meta.dirname, '../../frontend/dist');

  if (!fs.existsSync(staticDir)) return;

  console.log(`[server] Serving frontend from ${staticDir}`);

  app.get('*', async (c) => {
    const reqPath = c.req.path;

    // Serve exact file first (JS bundles, CSS, fonts, favicon...)
    const filePath = path.join(staticDir, reqPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(reqPath);
      const mime: Record<string, string> = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
      };
      console.debug(`[server] static file path=${reqPath} bytes=${content.length}`);
      return c.body(content, 200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    }

    // SPA fallback: index.html for all unknown paths
    const indexPath = path.join(staticDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      console.warn(`[server] SPA fallback missing index.html for path=${reqPath}`);
      return c.notFound();
    }
    console.debug(`[server] SPA fallback path=${reqPath}`);
    return c.html(fs.readFileSync(indexPath, 'utf-8'));
  });
}
