import fs from 'node:fs';
import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../modules/agent/index.js';
import type { ConfigModule } from '../modules/config/index.js';
import type { MemoryStoreModule } from '../modules/memory-store/index.js';
import { getConfigStateMtimeMsFromPath } from '../modules/config/stateMtime.js';
import type { MemoryModule } from '../modules/memory/index.js';
import type { ProviderModule } from '../modules/provider/index.js';
import type { TelegramModule } from '../modules/telegram/index.js';
import type { PushModule } from '../modules/push/index.js';
import { applyLoggingFromConfig } from '../modules/logger.js';
import { codebaseSearchPatchSchema, loggingConfigSchema, loggingPatchSchema, consolidationPatchSchema, openingHoursPatchSchema, subagentDefaultsPatchSchema } from '../modules/config/schema.js';
import { rescheduleCodebaseEmbedCron } from '../modules/codebase-search/embedCron.js';
import { invalidateTelegramPromptCache } from '../modules/agent/run.js';

export function configRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const configMod = ctx.modules.get<ConfigModule>('config');
  const memoryMod = ctx.modules.get<MemoryModule>('memory');
  const providerMod = ctx.modules.get<ProviderModule>('provider');
  const agentMod = ctx.modules.get<AgentModule>('agent');
  const telegramMod = ctx.modules.get<TelegramModule>('telegram');
  const pushMod = ctx.modules.get<PushModule>('push');

  let lastConfigMtimeMs = -1;
  let reloadInFlight: Promise<{ ok: true; skipped: boolean; mtimeMs: number }> | null = null;

  // Get config (redact secrets)
  app.get('/', (c) => {
    console.debug('[route:config] get redacted config');
    const config = ctx.config;
    // Embeddings sont broker par un provider Mercury (capability embeddingFallbackEnabled).
    // Plus de clé/url legacy à redact côté codebaseSearch.
    const safe = {
      ...config,
      database: { ...config.database, password: '***' },
      telegram: {
        bots: config.telegram.bots.map(b => ({
          ...b,
          token: b.token ? '***' + b.token.slice(-4) : '',
        })),
      },
      providers: config.providers.map(p => ({
        ...p,
        apiKey: p.apiKey ? '***' + p.apiKey.slice(-4) : '',
        statsApiKey: p.statsApiKey ? '***' + p.statsApiKey.slice(-4) : '',
      })),
      // Indicate if Brave key is configured without exposing it
      search: {
        braveApiKey: config.search?.braveApiKey
          ? '***' + config.search.braveApiKey.slice(-4)
          : '',
      },
      // Canal push : ne JAMAIS exposer la clé .p8 inline (juste un marqueur de présence).
      push: config.push
        ? {
            ...config.push,
            apns: config.push.apns
              ? { ...config.push.apns, keyP8: config.push.apns.keyP8 ? '***' : undefined }
              : undefined,
          }
        : undefined,
    };
    return c.json(safe);
  });

  // Reload config from disk
  app.post('/reload', async (c) => {
    const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
    const force = !!body.force;

    const mtimeMs = getConfigStateMtimeMsFromPath(configMod.getConfigPath());
    if (!force && lastConfigMtimeMs >= 0 && mtimeMs === lastConfigMtimeMs) {
      console.debug(`[route:config] reload skipped unchanged mtimeMs=${mtimeMs}`);
      return c.json({ ok: true, skipped: true, mtimeMs });
    }

    if (reloadInFlight) {
      console.debug('[route:config] reload joined existing in-flight reload');
      return c.json(await reloadInFlight);
    }

    console.log(`[route:config] reload force=${force} mtimeMs=${mtimeMs}`);
    reloadInFlight = (async () => {
      console.debug(`[route:config] reload step=configMod.reload`);
      configMod.reload();
      console.debug(`[route:config] reload step=memoryMod.init`);
      await memoryMod.init(ctx);
      console.debug(`[route:config] reload step=agentMod.reloadAllAgentsFromConfig`);
      await agentMod.reloadAllAgentsFromConfig();
      console.debug(`[route:config] reload step=providerMod.syncProvidersFromConfig`);
      providerMod.syncProvidersFromConfig();
      console.debug(`[route:config] reload step=telegramMod.restartAll`);
      await telegramMod.restartAll();
      console.debug(`[route:config] reload step=pushMod.reload`);
      pushMod.reload();

      lastConfigMtimeMs = mtimeMs;
      rescheduleCodebaseEmbedCron(ctx);
      console.log(`[route:config] reload complete`);
      return { ok: true as const, skipped: false, mtimeMs };
    })();

    try {
      return c.json(await reloadInFlight);
    } finally {
      reloadInFlight = null;
    }
  });

  // Save config sections (paths, defaults, server)
  app.put('/', async (c) => {
    const body = await c.req.json<{
      server?: { host?: string; port?: number; apiKey?: string };
      paths?: { agentsDir?: string; sharedMemoryDir?: string; compactArchivesDir?: string; skillsDir?: string; userImagesDir?: string; subagentReportsDir?: string };
      defaults?: {
        model?: string;
        temperature?: number;
        maxContextTokens?: number;
        promptCacheTtl?: number;
        toolDefaults?: {
          bashTimeoutMs?: number;
          webFetchMaxChars?: number;
          maxToolTurns?: number;
          maxReasoningCalls?: number;
          maxReasoningInputChars?: number;
          maxIdenticalToolCalls?: number;
          autoAbortOnLoopGuard?: boolean;
        };
        autoWarmup?: {
          enabled?: boolean;
          globalWarmupIdleMinutes?: number;
          fileDebounceSeconds?: number;
          recentActivityHours?: number;
        };
        autoUnloadOnSwitch?: boolean;
        cacheOptimized?: boolean;
        /** @deprecated UI uses cacheOptimized; still accepted in YAML/PUT for power users. */
        stripThinkBlocks?: boolean;
      };
      search?: { braveApiKey?: string };
      codebaseSearch?: Record<string, unknown>;
      memoryStore?: {
        enabled?: boolean;
        embeddingDimensions?: number;
        enableDeduplication?: boolean;
        autoInjection?: {
          enabled?: boolean;
          topK?: number;
          threshold?: number;
          maxCharsPerChunk?: number;
          includeShared?: boolean;
        };
      };
      consolidation?: Record<string, unknown>;
      subagentDefaults?: Record<string, unknown>;
      openingHours?: Record<string, unknown>;
      logging?: {
        level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
        file?: string;
        maxFileSizeMb?: number;
        maxFiles?: number;
      };
      ncm?: { baseUrl?: string };
      ui?: { theme?: string };
    }>();

    console.log(`[route:config] update sections=${Object.keys(body).join(',')}`);

    if (body.server) Object.assign(ctx.config.server, body.server);
    if (body.paths) {
      Object.assign(ctx.config.paths, body.paths);
      const p = ctx.config.paths;
      if (p.skillsDir !== undefined && String(p.skillsDir).trim() === '') {
        delete p.skillsDir;
      }
      if (p.subagentReportsDir !== undefined && String(p.subagentReportsDir).trim() === '') {
        delete p.subagentReportsDir;
      }
    }
    if (body.defaults) Object.assign(ctx.config.defaults, body.defaults);
    if (body.search !== undefined) {
      if (!ctx.config.search) ctx.config.search = {};
      Object.assign(ctx.config.search, body.search);
    }

    if (body.codebaseSearch !== undefined) {
      const parsed = codebaseSearchPatchSchema.safeParse(body.codebaseSearch);
      if (!parsed.success) {
        console.warn('[route:config] invalid codebaseSearch patch');
        return c.json(
          { error: 'Invalid codebaseSearch', details: parsed.error.flatten() },
          400,
        );
      }
      if (!ctx.config.codebaseSearch) ctx.config.codebaseSearch = {};
      Object.assign(ctx.config.codebaseSearch, parsed.data);
    }

    if (body.memoryStore !== undefined) {
      if (!ctx.config.memoryStore) {
        ctx.config.memoryStore = { enabled: false };
      }
      Object.assign(ctx.config.memoryStore, body.memoryStore);
      // Si on vient d'activer le module, initialiser à chaud sans redémarrage
      if (body.memoryStore.enabled === true) {
        const msmod = ctx.modules.tryGet<MemoryStoreModule>('memory-store');
        if (msmod) await msmod.reinit().catch(e => console.error('[memory-store] reinit error:', e));
      }
    }

    if (body.openingHours !== undefined) {
      const parsed = openingHoursPatchSchema.safeParse(body.openingHours);
      if (!parsed.success) {
        console.warn('[route:config] invalid openingHours patch');
        return c.json(
          { error: 'Invalid openingHours', details: parsed.error.flatten() },
          400,
        );
      }
      if (!ctx.config.openingHours) ctx.config.openingHours = { closedStart: 2, closedEnd: 4 };
      Object.assign(ctx.config.openingHours, parsed.data);
    }

    if (body.consolidation !== undefined) {
      const parsed = consolidationPatchSchema.safeParse(body.consolidation);
      if (!parsed.success) {
        console.warn('[route:config] invalid consolidation patch');
        return c.json(
          { error: 'Invalid consolidation', details: parsed.error.flatten() },
          400,
        );
      }
      if (!ctx.config.consolidation) ctx.config.consolidation = {};
      if (parsed.data.chat) {
        if (!ctx.config.consolidation.chat) ctx.config.consolidation.chat = {};
        Object.assign(ctx.config.consolidation.chat, parsed.data.chat);
      }
      if (parsed.data.memory) {
        if (!ctx.config.consolidation.memory) ctx.config.consolidation.memory = {};
        Object.assign(ctx.config.consolidation.memory, parsed.data.memory);
      }
    }

    if (body.subagentDefaults !== undefined) {
      const parsed = subagentDefaultsPatchSchema.safeParse(body.subagentDefaults);
      if (!parsed.success) {
        console.warn('[route:config] invalid subagentDefaults patch');
        return c.json({ error: 'Invalid subagentDefaults', details: parsed.error.flatten() }, 400);
      }
      if (!ctx.config.subagentDefaults) ctx.config.subagentDefaults = {};
      // Merge `caps` comme sous-objet (sinon un PUT {caps:{maxIterations:N}} écraserait les autres
      // caps existants via un Object.assign superficiel).
      const { caps: capsPatch, ...topLevel } = parsed.data;
      Object.assign(ctx.config.subagentDefaults, topLevel);
      if (capsPatch !== undefined) {
        if (!ctx.config.subagentDefaults.caps) ctx.config.subagentDefaults.caps = {};
        Object.assign(ctx.config.subagentDefaults.caps, capsPatch);
      }
    }

    if (body.logging !== undefined) {
      const parsed = loggingPatchSchema.safeParse(body.logging);
      if (!parsed.success) {
        console.warn('[route:config] invalid logging patch');
        return c.json(
          { error: 'Invalid logging', details: parsed.error.flatten() },
          400,
        );
      }
      if (!ctx.config.logging) ctx.config.logging = loggingConfigSchema.parse({});
      Object.assign(ctx.config.logging, parsed.data);
      console.log(`[route:config] logging updated keys=${Object.keys(parsed.data).join(',')} level=${ctx.config.logging.level}`);
      if (parsed.data.file !== undefined && String(parsed.data.file).trim() === '') {
        delete ctx.config.logging.file;
      }
      applyLoggingFromConfig(configMod.getConfigPath(), ctx.config.logging);
    }

    if (body.ncm !== undefined) {
      if (!ctx.config.ncm) ctx.config.ncm = { baseUrl: '' };
      Object.assign(ctx.config.ncm, body.ncm);
    }

    if (body.ui !== undefined) {
      if (!ctx.config.ui) ctx.config.ui = {};
      Object.assign(ctx.config.ui, body.ui);
    }

    configMod.save();
    console.log(`[route:config] update saved sections=${Object.keys(body).join(',')}`);
    if (body.defaults?.autoWarmup !== undefined || body.defaults?.promptCacheTtl !== undefined) {
      // Notifier l'AgentModule pour mettre à jour l'auto-warmup à chaud
      agentMod.updateAutoWarmupConfig(ctx.config.defaults.autoWarmup ?? {});
    }
    if (body.codebaseSearch !== undefined) {
      rescheduleCodebaseEmbedCron(ctx);
      // Invalidate cached Telegram system prompts — codebaseSearchInPrompt may have changed
      invalidateTelegramPromptCache();
    }
    return c.json({ ok: true });
  });

  // Test NCM connectivity from the server side (avoids browser CORS issues)
  app.get('/ncm/test', async (c) => {
    const baseUrl = ctx.config.ncm?.baseUrl?.replace(/\/+$/, '');
    if (!baseUrl) {
      console.warn('[route:config] ncm test requested but baseUrl missing');
      return c.json({ ok: false, message: 'NCM baseUrl non configurée' });
    }
    try {
      const startedAt = Date.now();
      console.debug(`[route:config] ncm test baseUrl=${baseUrl}`);
      const res = await fetch(`${baseUrl}/api/ncm/version`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.warn(`[route:config] ncm test failed status=${res.status} ms=${Date.now() - startedAt}`);
        return c.json({ ok: false, message: `HTTP ${res.status}` });
      }
      const data = await res.json() as { version?: string; agents_enabled?: number };
      console.log(`[route:config] ncm test ok version=${data.version ?? '?'} agents=${data.agents_enabled ?? 0} ms=${Date.now() - startedAt}`);
      return c.json({
        ok: true,
        message: `NCM v${data.version ?? '?'} — ${data.agents_enabled ?? 0} agent(s) activé(s)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'NCM injoignable';
      console.warn(`[route:config] ncm test error: ${msg}`);
      return c.json({ ok: false, message: msg });
    }
  });

  return app;
}
