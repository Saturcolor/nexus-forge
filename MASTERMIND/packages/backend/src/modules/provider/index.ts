import type { Module, MastermindContext, ProviderConfig, CompletionRequest, AvailableModel, RichCompletion } from '@mastermind/shared';
import { closeMercuryStreamingDispatcher, mercuryAdapter } from './mercury.js';
import { closeOpenAICompatDispatcher, OpenAICompatAdapter } from './openai-compat.js';

type ProviderAdapter = mercuryAdapter | OpenAICompatAdapter;

export class ProviderModule implements Module {
  name = 'provider';
  private adapters = new Map<string, ProviderAdapter>();
  private config!: MastermindContext['config'];

  async init(ctx: MastermindContext): Promise<void> {
    this.config = ctx.config;

    for (const provider of ctx.config.providers) {
      this.registerProvider(provider);
    }

    console.log(`[provider] Registered ${this.adapters.size} provider(s)`);
  }

  async destroy(): Promise<void> {
    this.adapters.clear();
    await Promise.all([
      closeMercuryStreamingDispatcher(),
      closeOpenAICompatDispatcher(),
    ]);
  }

  /** Fully sync providers: add/update existing adapters, remove stale ones. */
  syncProvidersFromConfig(): void {
    const desiredIds = new Set(this.config.providers.map(p => p.id));

    // Remove adapters no longer present in config.
    for (const id of [...this.adapters.keys()]) {
      if (!desiredIds.has(id)) this.adapters.delete(id);
    }

    // Register/replace providers from config.
    for (const provider of this.config.providers) {
      this.registerProvider(provider);
    }

    console.log(`[provider] Synced ${this.adapters.size} provider(s)`);
  }

  private registerProvider(config: ProviderConfig): void {
    const adapter = config.type === 'mercury'
      ? new mercuryAdapter(config)
      : new OpenAICompatAdapter(config);
    this.adapters.set(config.id, adapter);
    console.debug(`[provider] registered id=${config.id} type=${config.type} models=${config.models?.length ?? 0} baseUrl=${config.baseUrl}`);
  }

  addProvider(config: ProviderConfig): void {
    this.registerProvider(config);
    console.log(`[provider] Added: ${config.id}`);
  }

  reloadProvider(config: ProviderConfig): void {
    this.registerProvider(config); // replaces existing
    console.log(`[provider] Reloaded: ${config.id}`);
  }

  removeProvider(id: string): void {
    this.adapters.delete(id);
    console.log(`[provider] Removed: ${id}`);
  }

  /** Return the provider type ('mercury' | 'openai-compat') for a model reference */
  getProviderType(modelRef: string): string {
    try {
      const { providerId } = this.resolveModel(modelRef);
      const type = this.config.providers.find(p => p.id === providerId)?.type ?? 'openai-compat';
      return type;
    } catch {
      console.debug(`[provider] getProviderType fallback to openai-compat for model=${modelRef}`);
      return 'openai-compat';
    }
  }

  /** Resolve model alias to full model ID */
  resolveModel(modelRef: string): { providerId: string; modelId: string } {
    for (const provider of this.config.providers) {
      const alias = provider.models?.find(m => m.alias === modelRef);
      if (alias) {
        return { providerId: provider.id, modelId: alias.modelId };
      }
    }

    if (modelRef.includes('/')) {
      const firstProvider = this.config.providers[0];
      if (firstProvider) {
        return { providerId: firstProvider.id, modelId: modelRef };
      }
    }

    console.warn(`[provider] resolveModel failed: no match for "${modelRef}"`);
    throw new Error(`Cannot resolve model: ${modelRef}`);
  }

  getAdapter(providerId: string): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Provider "${providerId}" not found`);
    return adapter;
  }

  async *stream(
    modelRef: string,
    request: Omit<CompletionRequest, 'model' | 'stream'>,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const { providerId, modelId } = this.resolveModel(modelRef);
    const startedAt = Date.now();
    let chunks = 0;
    let chars = 0;
    console.debug(`[provider] stream start provider=${providerId} model=${modelId}`);
    const adapter = this.getAdapter(providerId);
    try {
      for await (const chunk of adapter.stream({ ...request, model: modelId, stream: true }, signal)) {
        chunks++;
        chars += chunk.length;
        yield chunk;
      }
      console.debug(`[provider] stream done provider=${providerId} model=${modelId} chunks=${chunks} chars=${chars} ms=${Date.now() - startedAt}`);
    } catch (err) {
      console.warn(`[provider] stream failed provider=${providerId} model=${modelId} chunks=${chunks} chars=${chars} ms=${Date.now() - startedAt}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  async complete(
    modelRef: string,
    request: Omit<CompletionRequest, 'model' | 'stream'>,
  ): Promise<string> {
    const { providerId, modelId } = this.resolveModel(modelRef);
    const startedAt = Date.now();
    console.debug(`[provider] complete start provider=${providerId} model=${modelId}`);
    const adapter = this.getAdapter(providerId);
    try {
      const result = await adapter.complete({ ...request, model: modelId, stream: false });
      console.debug(`[provider] complete done provider=${providerId} model=${modelId} chars=${result.length} ms=${Date.now() - startedAt}`);
      return result;
    } catch (err) {
      console.warn(`[provider] complete failed provider=${providerId} model=${modelId} ms=${Date.now() - startedAt}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  async completeRich(
    modelRef: string,
    request: Omit<CompletionRequest, 'model' | 'stream'>,
  ): Promise<RichCompletion> {
    const { providerId, modelId } = this.resolveModel(modelRef);
    const startedAt = Date.now();
    console.debug(`[provider] completeRich start provider=${providerId} model=${modelId} tools=${request.tools?.length ?? 0}`);
    const adapter = this.getAdapter(providerId);
    try {
      const result = await adapter.completeRich({ ...request, model: modelId, stream: false });
      console.debug(`[provider] completeRich done provider=${providerId} model=${modelId} chars=${result.content?.length ?? 0} toolCalls=${result.toolCalls?.length ?? 0} finish=${result.finishReason} ms=${Date.now() - startedAt}`);
      return result;
    } catch (err) {
      console.warn(`[provider] completeRich failed provider=${providerId} model=${modelId} ms=${Date.now() - startedAt}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  /**
   * Single streaming call: forwards text chunks via onChunk callback (live),
   * accumulates tool calls inline, returns RichCompletion when done.
   * Replaces the completeRich→stream double-call pattern.
   */
  async streamRich(
    modelRef: string,
    request: Omit<CompletionRequest, 'model' | 'stream'>,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<RichCompletion> {
    const { providerId, modelId } = this.resolveModel(modelRef);
    const nTools = request.tools?.length ?? 0;
    const startedAt = Date.now();
    let chunks = 0;
    let chars = 0;
    console.debug(`[provider] streamRich start provider=${providerId} model=${modelId} tools=${nTools}`);
    const adapter = this.getAdapter(providerId);
    try {
      const result = await adapter.streamRich({ ...request, model: modelId, stream: true }, (chunk) => {
        chunks++;
        chars += chunk.length;
        onChunk(chunk);
      }, signal);
      console.debug(`[provider] streamRich done provider=${providerId} model=${modelId} chunks=${chunks} chars=${chars} toolCalls=${result.toolCalls?.length ?? 0} finish=${result.finishReason} ms=${Date.now() - startedAt}`);
      return result;
    } catch (err) {
      console.warn(`[provider] streamRich failed provider=${providerId} model=${modelId} chunks=${chunks} chars=${chars} ms=${Date.now() - startedAt}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  async fetchAvailableModels(providerId: string): Promise<AvailableModel[]> {
    const startedAt = Date.now();
    const adapter = this.getAdapter(providerId);
    try {
      const models = await adapter.fetchAvailableModels();
      console.debug(`[provider] fetchAvailableModels done provider=${providerId} count=${models.length} ms=${Date.now() - startedAt}`);
      return models;
    } catch (err) {
      console.warn(`[provider] fetchAvailableModels failed provider=${providerId} ms=${Date.now() - startedAt}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  listModels(): Array<{ providerId: string; alias: string; modelId: string }> {
    const models: Array<{ providerId: string; alias: string; modelId: string }> = [];
    for (const provider of this.config.providers) {
      for (const model of provider.models ?? []) {
        models.push({ providerId: provider.id, alias: model.alias, modelId: model.modelId });
      }
    }
    return models;
  }
}
