export interface ModelAlias {
  alias: string;
  modelId: string;
  description?: string;
}

export interface ProviderConfig {
  id: string;
  type: 'mercury' | 'openai-compat';
  baseUrl: string;
  apiKey: string;
  /** Optional token dedicated to middleware /admin stats endpoints. Falls back to apiKey when empty. */
  statsApiKey?: string;
  models?: ModelAlias[];
  /** Models hidden from UI selectors (Telegram/web model menus). Empty/undefined = all exposed. */
  hiddenModelIds?: string[];
  /** Optional per-model display aliases (key = modelId). */
  modelDisplayNames?: Record<string, string>;
  /** URL for model discovery (overrides default {baseUrl}/models). Supports Ollama /api/tags format. */
  modelsUrl?: string;
  /** Base URL of the Mercury/local middleware admin API (e.g. http://192.168.1.x:17890).
   *  When set, MASTERMIND can fetch live stats (ctx, tok/s) for llamacpp and ollama models. */
  statsUrl?: string;
  /** Whether live stats polling is active. Requires statsUrl to be configured. */
  statsEnabled?: boolean;
  /** Chat-only toggle: allows using middleware mercury stats in Chat UI and /status. */
  chatStatsmercuryEnabled?: boolean;
  /**
   * Enable vision fallback: when images are attached and the main model doesn't support vision,
   * Mastermind calls Mercury's /admin/vision/describe to get a text description first.
   * Requires statsUrl to point at a Mercury instance with openrouter_vision_model configured.
   */
  visionFallbackEnabled?: boolean;
  /**
   * Enable embeddings via Mercury: when set on a Mercury provider, Mastermind routes ALL
   * embedding calls (memory-store + codebase-search) through Mercury's /v1/embeddings broker.
   * Mercury handles the chain (local brain-daemon + cloud OpenRouter fallback) and auth.
   * Requires statsUrl to point at a Mercury instance with embedding_chain configured
   * (local_embedding_models and/or openrouter_embedding_model).
   */
  embeddingFallbackEnabled?: boolean;
}

/** Single entry of Mercury's embedding chain (returned by GET /v1/embeddings/chain). */
export interface EmbeddingChainEntry {
  id: string;
  model: string;
  backend: 'llamacpp' | 'openrouter';
  priority: number;
  dim?: number | null;
}

/** Normalized live stats returned by GET /api/providers/:id/stats */
export interface ProviderStats {
  ts: string;
  /** Max context window (tokens) */
  ctxMax?: number;
  /** Tokens currently used in context (from slot or proxy_metrics) */
  ctxUsed?: number;
  /** Tokens/s for last generation */
  tokensPerSecond?: number;
  /** Prompt tokens in last request */
  promptTokens?: number;
  /** Output tokens in last request */
  outputTokens?: number;
  /** Cached (reused) prompt tokens in last request — populated for cloud providers (OpenRouter) */
  cachedTokens?: number;
  /** Model is currently loading into VRAM */
  isLoading?: boolean;
  /** Model is in prefill/prompt-processing phase (before first generated token) */
  isPromptProcessing?: boolean;
  /** Prompt processing progress 0-100 (n_past / n_prompt_tokens * 100) */
  promptProcessingProgress?: number;
  /** n_past tokens processed so far during prefill */
  promptProcessingTokens?: number;
}

export interface AvailableModel {
  id: string;
  name: string;
  contextLength?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RichCompletion {
  content?: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  /**
   * Token usage reported by the provider (Mercury force `stream_options.include_usage=true`
   * pour ses 3 backends openrouter/llamacpp/ollama et passthrough le SSE → on récupère les
   * vraies tokens cloud ET locales sans avoir à estimer côté Mastermind).
   *  - `cachedTokens` : OpenRouter `prompt_tokens_details.cached_tokens`. Absent si 0.
   *  - `tokensPerSecond` : llamacpp expose ça via `timings.predicted_per_second` (Mercury normalise).
   */
  usage?: { promptTokens: number; outputTokens: number; cachedTokens?: number; tokensPerSecond?: number };
}

export interface CompletionRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream: boolean;
  max_completion_tokens?: number;
  tools?: ToolDefinition[];
  /** Standard OpenAI reasoning effort — sent as top-level field, works for all providers (mercury, llama.cpp, etc.) */
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** Disable reasoning/thinking for models that support it (llama.cpp, mercury). Defaults to provider config. */
  reasoning?: boolean;
  /** Per-request LoRA scale override — forwarded to llama.cpp via brain-daemon. */
  lora?: Array<{ id: number; scale: number }>;
}

export interface CompletionChoice {
  delta?: { content?: string };
  message?: { content: string };
  finish_reason?: string | null;
}

export interface CompletionChunk {
  id: string;
  choices: CompletionChoice[];
}
