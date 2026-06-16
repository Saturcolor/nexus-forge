import { Hono } from 'hono';
import type { MastermindContext, ProviderStats } from '@mastermind/shared';
import type { ProviderModule } from '../modules/provider/index.js';
import type { ConfigModule } from '../modules/config/index.js';

export function providerRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const providerMod = ctx.modules.get<ProviderModule>('provider');
  const buildExposedModels = async (providerId?: string) => {
    const providers = providerId
      ? ctx.config.providers.filter(p => p.id === providerId)
      : ctx.config.providers;
    const exposed: Array<{ providerId: string; id: string; name: string; contextLength?: number }> = [];
    for (const provider of providers) {
      try {
        const available = await providerMod.fetchAvailableModels(provider.id);
        const hidden = new Set(provider.hiddenModelIds ?? []);
        const display = provider.modelDisplayNames ?? {};
        for (const model of available) {
          if (!model.id || hidden.has(model.id)) continue;
          exposed.push({
            providerId: provider.id,
            id: model.id,
            name: display[model.id] || model.name || model.id,
            contextLength: model.contextLength,
          });
        }
      } catch (err) {
        console.debug(`[route:providers] buildExposedModels skip provider=${provider.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return exposed;
  };

  // List providers (redact keys)
  app.get('/', (c) => {
    const providers = ctx.config.providers.map(p => ({
      ...p,
      apiKey: p.apiKey ? '***' + p.apiKey.slice(-4) : '',
      statsApiKey: p.statsApiKey ? '***' + p.statsApiKey.slice(-4) : '',
    }));
    return c.json(providers);
  });

  // List all models
  app.get('/models', (c) => {
    return c.json(providerMod.listModels());
  });

  // List exposed models across all providers (filtered + display aliases applied)
  app.get('/exposed-models', async (c) => {
    return c.json(await buildExposedModels());
  });

  // Create provider
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id: string;
      type: 'mercury' | 'openai-compat';
      baseUrl: string;
      apiKey?: string;
      statsApiKey?: string;
      chatStatsmercuryEnabled?: boolean;
      modelsUrl?: string;
      models?: Array<{ alias: string; modelId: string }>;
      hiddenModelIds?: string[];
      modelDisplayNames?: Record<string, string>;
    }>();

    if (!body.id || !body.type || !body.baseUrl) {
      return c.json({ error: 'id, type and baseUrl are required' }, 400);
    }
    if (ctx.config.providers.find(p => p.id === body.id)) {
      return c.json({ error: `Provider "${body.id}" already exists` }, 409);
    }

    console.log(`[route:providers] create provider=${body.id} type=${body.type} baseUrl=${body.baseUrl}`);

    const provider: any = {
      id: body.id,
      type: body.type,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey || '',
      statsApiKey: body.statsApiKey || '',
      chatStatsmercuryEnabled: body.chatStatsmercuryEnabled ?? true,
      models: body.models || [],
      hiddenModelIds: body.hiddenModelIds || [],
      modelDisplayNames: body.modelDisplayNames || {},
    };
    if (body.modelsUrl) provider.modelsUrl = body.modelsUrl;

    ctx.config.providers.push(provider);
    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();
    providerMod.addProvider(provider);

    return c.json({ ok: true }, 201);
  });

  // Fetch live stats from middleware (llamacpp/ollama) via statsUrl
  app.get('/:id/stats', async (c) => {
    const id = c.req.param('id');
    const model = c.req.query('model') ?? '';
    console.debug(`[route:providers] stats provider=${id} model=${model}`);
    const provider = ctx.config.providers.find(p => p.id === id);
    if (!provider) return c.json({ error: 'Provider not found' }, 404);
    if (!provider.statsUrl) return c.json({ error: 'No statsUrl configured for this provider' }, 404);

    // Strip provider prefix (e.g. "llamacpp/qwen3.5-7b" → "qwen3.5-7b")
    const slashIdx = model.indexOf('/');
    const modelKey = slashIdx !== -1 ? model.slice(slashIdx + 1) : model;
    const prefix = slashIdx !== -1 ? model.slice(0, slashIdx).toLowerCase() : '';

    let adminPath: string;
    // vllm partage le brain-daemon avec llamacpp → mêmes routes admin
    // (slots vides côté vLLM, mais proxy_metrics sourcé d'un store partagé)
    if (prefix === 'llamacpp' || prefix === 'vllm') {
      adminPath = `/admin/llamacpp/session/${modelKey}`;
    } else if (prefix === 'ollama') {
      adminPath = `/admin/ollama/session/${modelKey}`;
    } else if (prefix === 'lm-studio' || prefix === 'lmstudio') {
      adminPath = `/admin/lm-studio/session/${encodeURIComponent(modelKey)}`;
    } else {
      return c.json({ error: `Cannot infer backend type from model "${model}". Prefix model with llamacpp/, vllm/, ollama/, or lm-studio/.` }, 400);
    }

    try {
      const headers: Record<string, string> = {};
      const statsToken = provider.statsApiKey || provider.apiKey;
      if (statsToken) headers['Authorization'] = `Bearer ${statsToken}`;
      const res = await fetch(`${provider.statsUrl}${adminPath}`, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) return c.json({ error: `Middleware returned ${res.status}` }, 502);
      const raw = await res.json() as Record<string, unknown>;

      // Normalize across backends
      const pm = (raw.proxy_metrics ?? {}) as Record<string, unknown>;
      const stats: ProviderStats = {
        ts: (raw.ts as string) ?? new Date().toISOString(),
        tokensPerSecond: (pm.last_generation_tokens_per_second as number) ?? undefined,
        promptTokens: (pm.last_prompt_tokens as number) ?? undefined,
        outputTokens: (pm.last_generation_tokens as number) ?? undefined,
      };

      // ctx max
      if (typeof raw.n_ctx_max === 'number') stats.ctxMax = raw.n_ctx_max;
      else if (typeof raw.context_length === 'number') stats.ctxMax = raw.context_length;

      // ctx used (llamacpp: from first active slot)
      const slots = raw.slots as Array<Record<string, unknown>> | undefined;
      if (slots?.length) {
        const active = slots.find(s => s.is_processing) ?? slots[0];
        if (typeof active.n_ctx === 'number') stats.ctxMax = active.n_ctx;
        if (typeof active.n_past === 'number') stats.ctxUsed = active.n_past;
      }

      return c.json(stats);
    } catch (err: any) {
      console.warn(`[route:providers] stats fetch error provider=${id}: ${err.message}`);
      return c.json({ error: err.message }, 502);
    }
  });

  // Test middleware connectivity (ping statsUrl via /admin/version)
  app.get('/:id/test-stats', async (c) => {
    const id = c.req.param('id');
    const provider = ctx.config.providers.find(p => p.id === id);
    if (!provider) return c.json({ error: 'Provider not found' }, 404);
    if (!provider.statsUrl) return c.json({ error: 'No statsUrl configured' }, 400);
    try {
      const headers: Record<string, string> = {};
      const statsToken = provider.statsApiKey || provider.apiKey;
      if (statsToken) headers['Authorization'] = `Bearer ${statsToken}`;
      const res = await fetch(`${provider.statsUrl}/admin/version`, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) return c.json({ ok: false, status: res.status, error: `HTTP ${res.status}` });
      const body = await res.json().catch(() => ({}));
      return c.json({ ok: true, version: (body as any).version ?? 'unknown' });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message });
    }
  });

  // Fetch live models from provider's API
  app.get('/:id/available-models', async (c) => {
    const id = c.req.param('id');
    if (!ctx.config.providers.find(p => p.id === id)) {
      return c.json({ error: 'Provider not found' }, 404);
    }
    console.debug(`[route:providers] fetch available models provider=${id}`);
    try {
      const models = await providerMod.fetchAvailableModels(id);
      console.debug(`[route:providers] available models provider=${id} count=${models.length}`);
      return c.json(models);
    } catch (err: any) {
      console.warn(`[route:providers] fetch models error provider=${id}: ${err.message}`);
      return c.json({ error: err.message }, 502);
    }
  });

  // List exposed models for one provider
  app.get('/:id/exposed-models', async (c) => {
    const id = c.req.param('id');
    if (!ctx.config.providers.find(p => p.id === id)) {
      return c.json({ error: 'Provider not found' }, 404);
    }
    return c.json(await buildExposedModels(id));
  });

  // Proxy to Mercury's GET /v1/embeddings/chain — exposes the embedding chain to UI.
  // Used by MemoryConfigTab to display the active chain (priority, dim, backend) read-only.
  // Pas de check de type : la déclaration "provider = broker embeddings" se fait via embeddingFallbackEnabled.
  app.get('/:id/embedding-chain', async (c) => {
    const id = c.req.param('id');
    const provider = ctx.config.providers.find(p => p.id === id);
    if (!provider) return c.json({ error: 'Provider not found' }, 404);
    const base = (provider.statsUrl || provider.baseUrl).replace(/\/$/, '');
    const url = base.endsWith('/v1') ? `${base}/embeddings/chain` : `${base}/v1/embeddings/chain`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const body = await r.json();
      return c.json(body, r.status as 200 | 502);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Mercury unreachable at ${url}: ${msg}` }, 502);
    }
  });

  // Update provider (baseUrl, apiKey)
  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const provider = ctx.config.providers.find(p => p.id === id);
    if (!provider) return c.json({ error: 'Provider not found' }, 404);

    console.log(`[route:providers] update provider=${id}`);

    const body = await c.req.json<{
      baseUrl?: string;
      apiKey?: string;
      statsApiKey?: string;
      chatStatsmercuryEnabled?: boolean;
      visionFallbackEnabled?: boolean;
      embeddingFallbackEnabled?: boolean;
      modelsUrl?: string;
      statsUrl?: string;
      statsEnabled?: boolean;
      hiddenModelIds?: string[];
      modelDisplayNames?: Record<string, string>;
    }>();

    if (body.baseUrl !== undefined) provider.baseUrl = body.baseUrl;
    if (body.modelsUrl !== undefined) provider.modelsUrl = body.modelsUrl || undefined;
    if (body.statsUrl !== undefined) provider.statsUrl = body.statsUrl || undefined;
    if (body.statsEnabled !== undefined) provider.statsEnabled = body.statsEnabled;
    if (body.hiddenModelIds !== undefined) provider.hiddenModelIds = body.hiddenModelIds;
    if (body.modelDisplayNames !== undefined) provider.modelDisplayNames = body.modelDisplayNames;
    if (body.chatStatsmercuryEnabled !== undefined) provider.chatStatsmercuryEnabled = body.chatStatsmercuryEnabled;
    if (body.visionFallbackEnabled !== undefined) provider.visionFallbackEnabled = body.visionFallbackEnabled;
    if (body.embeddingFallbackEnabled !== undefined) provider.embeddingFallbackEnabled = body.embeddingFallbackEnabled;
    if (
      body.statsApiKey !== undefined &&
      body.statsApiKey !== '' &&
      body.statsApiKey !== '***' + (provider.statsApiKey ?? '').slice(-4)
    ) {
      provider.statsApiKey = body.statsApiKey;
    }
    // Empty string = "do not change" (matches ProvidersPage edit form). Omit Bearer to middleware only when truly no key stored.
    if (
      body.apiKey !== undefined &&
      body.apiKey !== '' &&
      body.apiKey !== '***' + (provider.apiKey ?? '').slice(-4)
    ) {
      provider.apiKey = body.apiKey;
    }

    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();
    providerMod.reloadProvider(provider as any);

    return c.json({ ok: true });
  });

  // Delete provider
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const idx = ctx.config.providers.findIndex(p => p.id === id);
    if (idx === -1) return c.json({ error: 'Provider not found' }, 404);
    console.log(`[route:providers] delete provider=${id}`);

    ctx.config.providers.splice(idx, 1);
    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();
    providerMod.removeProvider(id);

    return c.json({ ok: true });
  });

  // Add model to provider
  app.post('/:id/models', async (c) => {
    const id = c.req.param('id');
    const provider = ctx.config.providers.find(p => p.id === id);
    if (!provider) return c.json({ error: 'Provider not found' }, 404);

    const body = await c.req.json<{ alias: string; modelId: string }>();
    if (!body.alias || !body.modelId) {
      return c.json({ error: 'alias and modelId are required' }, 400);
    }

    if (!provider.models) provider.models = [];
    if (provider.models.find(m => m.alias === body.alias)) {
      return c.json({ error: `Model alias "${body.alias}" already exists` }, 409);
    }

    console.log(`[route:providers] add model provider=${id} alias=${body.alias} modelId=${body.modelId}`);
    provider.models.push({ alias: body.alias, modelId: body.modelId });
    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();

    return c.json({ ok: true }, 201);
  });

  // Remove model from provider
  app.delete('/:id/models/:alias', (c) => {
    const id = c.req.param('id');
    const alias = c.req.param('alias');
    const provider = ctx.config.providers.find(p => p.id === id);
    if (!provider) return c.json({ error: 'Provider not found' }, 404);

    const idx = provider.models?.findIndex(m => m.alias === alias) ?? -1;
    if (idx === -1) return c.json({ error: 'Model not found' }, 404);

    console.log(`[route:providers] remove model provider=${id} alias=${alias}`);
    provider.models!.splice(idx, 1);
    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();

    return c.json({ ok: true });
  });

  return app;
}
