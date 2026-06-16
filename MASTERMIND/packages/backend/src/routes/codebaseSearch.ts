import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { ConfigModule } from '../modules/config/index.js';
import {
  listResolvedIndices,
  resolveCodebaseSearchPath,
} from '../modules/codebase-search/paths.js';
import {
  runCodebaseSearchQuery,
  runCodebaseSearchStats,
  runCodebaseSearchReadFile,
  runCodebaseSearchListDir,
} from '../modules/codebase-search/service.js';
import { listEmbedJobs, runAllEmbedJobs } from '../modules/codebase-search/embedRunner.js';

export function codebaseSearchRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const configMod = ctx.modules.get<ConfigModule>('config');
  const resolvePath = (p: string) => configMod.resolvePath(p);

  app.get('/status', (c) => {
    const cs = ctx.config.codebaseSearch;
    const enabled = Boolean(cs?.enabled);
    const resolvedIndices = enabled ? listResolvedIndices(ctx.config, resolvePath) : {};
    let resolvedDefault: string | undefined;
    if (enabled && cs?.defaultDbPath) {
      resolvedDefault = resolveCodebaseSearchPath(cs.defaultDbPath, resolvePath);
    }
    let resolvedConfigPath: string | undefined;
    if (enabled && cs?.configPath) {
      resolvedConfigPath = resolveCodebaseSearchPath(cs.configPath, resolvePath);
    }

    const embedSources = cs?.embedSources ?? {};
    const resolvedEmbedSources: Record<string, string> = {};
    if (enabled) {
      for (const [k, v] of Object.entries(embedSources)) {
        resolvedEmbedSources[k] = resolveCodebaseSearchPath(v, resolvePath);
      }
    }

    const embeddingBrokerActive = (ctx.config.providers ?? []).some(
      p => p.embeddingFallbackEnabled === true,
    );

    const embedJobs = enabled ? listEmbedJobs(ctx, resolvePath) : [];

    return c.json({
      enabled,
      configPath: cs?.configPath,
      defaultDbPath: cs?.defaultDbPath,
      indices: cs?.indices ?? {},
      resolvedIndices,
      resolvedDefaultDbPath: resolvedDefault,
      resolvedConfigPath,
      embedSources,
      resolvedEmbedSources,
      lastEmbedRuns: cs?.lastEmbedRuns ?? {},
      embedCronEnabled: cs?.embedCronEnabled,
      embedCronHourUtc: cs?.embedCronHourUtc,
      embedCronMode: cs?.embedCronMode ?? 'full',
      embedCronCloudOnly: cs?.embedCronCloudOnly ?? false,
      embeddingForceCloud: cs?.embeddingForceCloud ?? false,
      allowUiIndex: cs?.allowUiIndex,
      embeddingBrokerActive,
      embedJobCount: embedJobs.length,
    });
  });

  app.get('/stats', async (c) => {
    if (!ctx.config.codebaseSearch?.enabled) {
      return c.json({ error: 'codebaseSearch is disabled' }, 400);
    }
    const indexKey = c.req.query('index') ?? 'default';
    try {
      const stats = await runCodebaseSearchStats({
        config: ctx.config,
        resolvePath,
        indexKey,
      });
      return c.json({
        index: indexKey,
        dbPath: stats.dbPath,
        totalChunks: stats.totalChunks,
        extensions: stats.extensions,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/search', async (c) => {
    if (!ctx.config.codebaseSearch?.enabled) {
      return c.json({ error: 'codebaseSearch is disabled' }, 400);
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const query = typeof body['query'] === 'string' ? body['query'] : '';
    const index = typeof body['index'] === 'string' ? body['index'] : undefined;
    const limit = body['limit'];
    const type = body['type'] === 'hybrid' ? 'hybrid' : 'vector';
    const filePattern = typeof body['filePattern'] === 'string' ? body['filePattern'] : undefined;
    const exactSymbol = Boolean(body['exactSymbol']);
    const fileNameWeight =
      typeof body['fileNameWeight'] === 'number' ? body['fileNameWeight'] : undefined;
    let extensions: string[] | undefined;
    if (Array.isArray(body['extensions'])) {
      extensions = body['extensions'].filter((x): x is string => typeof x === 'string');
    }

    console.debug(`[route:codebase] search query="${query.slice(0, 60)}" type=${type} index=${index ?? 'default'}`);
    try {
      const { dbPath, indexKey, hits } = await runCodebaseSearchQuery({
        config: ctx.config,
        resolvePath,
        query,
        limit,
        type,
        extensions,
        filePattern,
        index,
        fileNameWeight,
        exactSymbol,
      });
      console.debug(`[route:codebase] search results=${hits.length} index=${indexKey}`);
      return c.json({
        query,
        index: indexKey,
        dbPath,
        hits,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[route:codebase] search error: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  app.get('/file', async (c) => {
    if (!ctx.config.codebaseSearch?.enabled) {
      return c.json({ error: 'codebaseSearch is disabled' }, 400);
    }
    const index = c.req.query('index') ?? '';
    const path = c.req.query('path') ?? '';
    const lines = c.req.query('lines') || undefined;
    const offsetRaw = c.req.query('offset');
    const limitRaw = c.req.query('limit');
    const offset = offsetRaw && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : undefined;
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : undefined;

    console.debug(`[route:codebase] file index=${index} path="${path.slice(0, 120)}" lines=${lines ?? 'all'}`);
    try {
      const { indexKey, sourceRoot, content } = await runCodebaseSearchReadFile({
        config: ctx.config,
        resolvePath,
        index,
        path,
        lines,
        offset,
        limit,
      });
      return c.json({ index: indexKey, sourceRoot, path, content });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[route:codebase] file error: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  app.get('/list', async (c) => {
    if (!ctx.config.codebaseSearch?.enabled) {
      return c.json({ error: 'codebaseSearch is disabled' }, 400);
    }
    const index = c.req.query('index') ?? '';
    const path = c.req.query('path');

    console.debug(`[route:codebase] list index=${index} path=${path ?? '.'}`);
    try {
      const { indexKey, sourceRoot, path: resolvedPath, entries } = await runCodebaseSearchListDir({
        config: ctx.config,
        resolvePath,
        index,
        path,
      });
      return c.json({ index: indexKey, sourceRoot, path: resolvedPath, entries });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[route:codebase] list error: ${msg}`);
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/embed', async (c) => {
    const cs = ctx.config.codebaseSearch;
    if (!cs?.enabled) {
      return c.json({ error: 'codebaseSearch is disabled' }, 400);
    }
    if (cs.allowUiIndex === false) {
      return c.json({ error: 'UI embed disabled (codebaseSearch.allowUiIndex: false)' }, 403);
    }
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body */
    }
    const index = typeof body['index'] === 'string' ? body['index'] : undefined;
    const mode = body['mode'] === 'incremental' ? 'incremental' : 'full';

    console.log(`[route:codebase] embed index=${index ?? 'all'} mode=${mode}`);
    // Fire-and-forget: a full reindex on a large source can take 20+ minutes. Holding the
    // HTTP connection open that long invariably trips an intermediate proxy timeout (Caddy,
    // Tailscale, browser) and the client sees "Failed to fetch" — even though the embed
    // job itself is still running fine on the backend. The frontend polls
    // `/api/codebase-search/status` (lastEmbedRuns) to track progress + completion, so
    // we just kick the job off and return immediately.
    runAllEmbedJobs(ctx, 'manual', index, mode)
      .then(({ results }) => console.log(`[route:codebase] embed done jobs=${results.length}`))
      .catch((e) => console.error(`[route:codebase] embed error: ${e instanceof Error ? e.message : e}`));
    return c.json({ ok: true, started: true });
  });

  return app;
}
