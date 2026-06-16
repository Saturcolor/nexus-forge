import type { ProviderConfig, ProviderStats } from '@mastermind/shared';
import { Agent } from 'undici';

/**
 * Builds the SSE stream path for a given model ID prefix.
 * Returns null if the backend type is not supported.
 */
export function buildMercurySsePath(modelId: string): string | null {
  const slashIdx = modelId.indexOf('/');
  const prefix = slashIdx !== -1 ? modelId.slice(0, slashIdx).toLowerCase() : '';
  const key = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;

  // vllm partage le brain-daemon avec llamacpp et utilise les mêmes routes admin :
  // les slots renvoyés seront vides (vLLM n'a pas la notion de slots llama-server),
  // mais proxy_metrics (tokens/s, last_generation_tokens) est sourcé d'un store
  // partagé côté Mercury — affichage tok/s OK, ctxUsed/ctxMax dégradés en v1.
  if (prefix === 'llamacpp' || prefix === 'vllm') return `/admin/llamacpp/session-stream/${key}`;
  if (prefix === 'ollama') return `/admin/ollama/session-stream/${key}`;
  if (prefix === 'lm-studio' || prefix === 'lmstudio') return `/admin/lm-studio/session-stream/${encodeURIComponent(key)}`;
  return null;
}

/**
 * Parses a single SSE Mercury payload into a partial ProviderStats update.
 *
 * For llamacpp:
 * - `prompt_pct` (1-99): extracted by Mercury daemon from llama-server logs during prefill
 * - `slots`: raw slot state from llama-server (is_processing, n_past, n_ctx, etc.)
 */
function parseMercuryPayload(raw: Record<string, unknown>): Partial<ProviderStats> | null {
  const slots = raw.slots as Array<Record<string, unknown>> | undefined;

  // prompt_pct is 1-99 during prefill, 0 otherwise — authoritative from Mercury daemon logs
  const promptPct = typeof raw.prompt_pct === 'number' ? raw.prompt_pct : 0;
  const isPromptProcessing = promptPct > 0;
  // Mercury sets `inferencing: true` when it deliberately skipped /mgmt/slots because a
  // chat completion is currently being proxied for this model_id (the slots fetch would
  // block on the busy llama-server HTTP loop). Treat this as "model is busy generating",
  // NOT as "model is loading" — otherwise the gauge stays stuck on "chargement…" for the
  // entire generation. /mgmt/status was still hit, so prompt_pct is fresh.
  const inferencing = raw.inferencing === true;

  if (inferencing) {
    const pm = (raw.proxy_metrics ?? {}) as Record<string, unknown>;
    const update: Partial<ProviderStats> = {
      isLoading: false,
      isPromptProcessing,
      promptProcessingProgress: isPromptProcessing ? promptPct : undefined,
    };
    if (typeof pm.last_generation_tokens_per_second === 'number') {
      update.tokensPerSecond = pm.last_generation_tokens_per_second;
    }
    return update;
  }

  if (!slots || slots.length === 0) {
    // No slots — model may be loading or not yet ready
    if (isPromptProcessing) {
      // Daemon says prompt is being processed even before slots appear
      return {
        isLoading: false,
        isPromptProcessing: true,
        promptProcessingProgress: promptPct,
      };
    }
    return { isLoading: true, isPromptProcessing: false };
  }

  const active = slots.find(s => s.is_processing) ?? slots[0];
  const nCtx = typeof active.n_ctx === 'number' ? active.n_ctx : undefined;
  const nPast = typeof active.n_past === 'number' ? active.n_past : undefined;

  const update: Partial<ProviderStats> = {
    isLoading: false,
    isPromptProcessing,
    promptProcessingProgress: isPromptProcessing ? promptPct : undefined,
    promptProcessingTokens: isPromptProcessing && nPast !== undefined ? nPast : undefined,
  };

  if (nCtx !== undefined) update.ctxMax = nCtx;
  if (nPast !== undefined && !isPromptProcessing) update.ctxUsed = nPast;

  // proxy_metrics for tok/s
  const pm = (raw.proxy_metrics ?? {}) as Record<string, unknown>;
  if (typeof pm.last_generation_tokens_per_second === 'number') {
    update.tokensPerSecond = pm.last_generation_tokens_per_second;
  }

  return update;
}

/**
 * Calls the Mercury admin unload endpoint to eject the model from VRAM.
 * Best-effort: errors are silently swallowed. No-op if statsUrl is not configured.
 *
 * Mercury POST endpoints:
 *   llamacpp  → POST /admin/llamacpp/unload   { model_id: "<key>" }
 *   ollama    → POST /admin/ollama/unload     { model: "<key>" }
 *   lm-studio → POST /admin/lm-studio/unload  { instance_id: "<key>" }
 */
export async function unloadMercuryModel(provider: ProviderConfig, modelId: string): Promise<void> {
  if (!provider.statsUrl) return;

  const slashIdx = modelId.indexOf('/');
  const prefix = slashIdx !== -1 ? modelId.slice(0, slashIdx).toLowerCase() : '';
  const key = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;

  let adminPath: string;
  let body: Record<string, string>;

  if (prefix === 'llamacpp' || prefix === 'vllm') {
    // vllm partage les routes /admin/llamacpp/... du brain-daemon (cf buildMercurySsePath)
    adminPath = '/admin/llamacpp/unload';
    body = { model_id: key };
  } else if (prefix === 'ollama') {
    adminPath = '/admin/ollama/unload';
    body = { model: key };
  } else if (prefix === 'lm-studio' || prefix === 'lmstudio') {
    adminPath = '/admin/lm-studio/unload';
    body = { instance_id: key };
  } else {
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = provider.statsApiKey || provider.apiKey;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  console.debug(`[mercury-stats] unload model=${modelId} prefix=${prefix} url=${provider.statsUrl}${adminPath}`);
  await fetch(`${provider.statsUrl}${adminPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).then(() => {
    console.debug(`[mercury-stats] unload ok model=${modelId}`);
  }).catch((err) => {
    console.debug(`[mercury-stats] unload failed model=${modelId}: ${err instanceof Error ? err.message : err}`);
  });
}

// Long-lived SSE stats stream: it can idle for minutes between updates and used to rely on
// openai-compat's (now-removed) global setGlobalDispatcher to disable undici's idle timeouts.
// Give it a dedicated dispatcher with no idle timeout so a quiet model doesn't get the stream
// killed by undici's 300s bodyTimeout default. Best-effort (errors swallowed); keep-alive
// bounds the idle socket, so no explicit close hook is needed.
const statsStreamDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000 });

/**
 * Subscribes to a Mercury SSE stats stream for the given model.
 * Calls onStats with each parsed update until the signal is aborted.
 * Errors are swallowed silently (stats are best-effort).
 */
export async function streamMercuryStats(
  provider: ProviderConfig,
  modelId: string,
  onStats: (stats: Partial<ProviderStats>) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!provider.statsUrl) return;

  const ssePath = buildMercurySsePath(modelId);
  if (!ssePath) return;

  const url = `${provider.statsUrl}${ssePath}`;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  const statsToken = provider.statsApiKey || provider.apiKey;
  if (statsToken) headers['Authorization'] = `Bearer ${statsToken}`;

  console.debug(`[mercury-stats] SSE stream connecting url=${url}`);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal, dispatcher: statsStreamDispatcher } as RequestInit & { dispatcher: Agent });
    if (!res.ok || !res.body) {
      console.debug(`[mercury-stats] SSE stream not ok status=${res.status}`);
      return;
    }
  } catch (err) {
    console.debug(`[mercury-stats] SSE stream connect failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const raw = JSON.parse(jsonStr) as Record<string, unknown>;
          const update = parseMercuryPayload(raw);
          if (update) onStats(update);
        } catch {
          // malformed JSON — skip
        }
      }
    }
  } catch {
    // stream ended or aborted — normal
  } finally {
    reader.releaseLock();
  }
}
