import type { ProviderConfig, CompletionRequest, CompletionChunk, AvailableModel, RichCompletion, ToolCall } from '@mastermind/shared';
import { Agent } from 'undici';
import { parseSSEStream } from './stream.js';
import { parseTextToolCalls, stripToolCallBlocks } from './parseTextToolCalls.js';
import { fetchWithRetry } from './utils.js';
import { repairToolCallArguments } from './repairToolCall.js';

// Dispatcher for LLM completion calls (streaming AND non-streaming) with 30-min idle
// timeouts. The undici default bodyTimeout (300s) silently kills /chat/completions when
// Mercury does a long cold prefill (no bytes sent until first token) — it finishes the
// prefill server-side but our reader already EOF'd. This affects EVERY completion path,
// not just streaming: the non-streaming complete/completeRich (the latter is the sub-agent
// path) hit the same long prefill. So all four use this 30-min dispatcher — finite (a
// genuinely stalled socket still aborts after 30 min, no infinite hang) but tolerant of
// realistic prefills.
//
// Only fetchAvailableModels (a quick metadata call) keeps undici's finite defaults.
// (openai-compat used to disable these timeouts process-wide via setGlobalDispatcher, which
// silently neutralised the body timeout here too; that override is now scoped to its own
// streaming dispatcher.)
const llmDispatcher = new Agent({
  bodyTimeout: 30 * 60_000,
  headersTimeout: 30 * 60_000,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
});

export function closeMercuryStreamingDispatcher(): Promise<void> {
  return llmDispatcher.close();
}

interface RawToolCall { id: string; function: { name: string; arguments: string } }

function parseToolCalls(raw: RawToolCall[] | undefined): ToolCall[] | undefined {
  if (!raw?.length) return undefined;
  const calls = raw
    .filter(tc => tc.function?.name)  // skip tool calls with empty/missing name
    .map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: repairToolCallArguments(tc.function.arguments, tc.function.name),
    }));
  return calls.length ? calls : undefined;
}

/**
 * Normalise un bloc `usage` OpenAI-compat (forwardé tel quel par Mercury depuis
 * OpenRouter / llamacpp / ollama qui forcent tous `stream_options.include_usage=true`)
 * en `RichCompletion.usage`. Renvoie undefined quand aucun token n'est connu.
 *  - `cached_tokens === 0` → undefined (évite "Cache hit: 0" parasite côté UI)
 *  - `cache_read_input_tokens` : Anthropic via OpenRouter — format différent d'OpenAI.
 *    OR le passe-through tel quel, on lit les deux champs avec fallback.
 *  - `tokens_per_second` : llamacpp expose ça via `timings.predicted_per_second`
 *    (Mercury normalise dans `_normalize_usage`, providers/llamacpp/backend.py)
 */
function extractUsage(raw: unknown): { promptTokens: number; outputTokens: number; cachedTokens?: number; tokensPerSecond?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as {
    prompt_tokens?: number; completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;  // Anthropic via OpenRouter
    tokens_per_second?: number;
  };
  if (u.prompt_tokens == null) return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens;
  return {
    promptTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens ?? 0,
    ...(cached && cached > 0 ? { cachedTokens: cached } : {}),
    ...(typeof u.tokens_per_second === 'number' ? { tokensPerSecond: u.tokens_per_second } : {}),
  };
}

interface ToolCallAccum { id: string; name: string; arguments: string }
function finishToolCalls(buf: ToolCallAccum[]): ToolCall[] | undefined {
  if (!buf.length) return undefined;
  const calls: ToolCall[] = [];
  // Keep the buffer index (i) stable for id synthesis: tcBuf is indexed by delta.tool_calls
  // index, so i is a deterministic per-turn ordinal. Iterate (not filter→map) so we can
  // reference i for the fallback id below.
  buf.forEach((tc, i) => {
    if (!tc?.name) return;  // skip tool calls with empty/missing name
    calls.push({
      // Some OpenAI-compatible backends (certain llama.cpp/vLLM builds, esp. a single tool
      // call) stream the name+arguments delta but never send an `id`. Left as '' it is falsy
      // end-to-end: run.ts persists both the assistant tool_call AND the tool_result with
      // tool_call_id='' → toAiMessage omits it on rebuild and stripOrphanedToolCalls disables
      // orphan-cleanup, while native providers (Anthropic/OpenAI) reject an empty id (400).
      // Synthesize a stable, non-empty id keyed on the buffer index, mirroring the text-fallback
      // path's `tc-text-N`. Distinct `tc-stream-` prefix so this native path does NOT trip
      // run.ts's `tc-text-` content-drop discriminator (no inline <tool_call> markup here).
      id: tc.id || `tc-stream-${i}`,
      name: tc.name,
      arguments: repairToolCallArguments(tc.arguments, tc.name),
    });
  });
  return calls.length ? calls : undefined;
}

/** Normalize OpenAI or Ollama /api/tags model list response */
export function parseModelsResponse(data: unknown): AvailableModel[] {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    // OpenAI format: { data: [{ id, name, context_length }] }
    if (Array.isArray(d['data'])) {
      return (d['data'] as any[]).map(m => ({
        id: m.id as string,
        name: (m.name ?? m.id) as string,
        contextLength: m.context_length as number | undefined,
      }));
    }
    // Ollama /api/tags format: { models: [{ name }] }
    if (Array.isArray(d['models'])) {
      return (d['models'] as any[]).map(m => ({
        id: m.name as string,
        name: m.name as string,
      }));
    }
  }
  return [];
}

export class mercuryAdapter {
  constructor(private config: ProviderConfig) {}

  /** Non-streaming completion */
  async complete(request: CompletionRequest): Promise<string> {
    console.debug(`[mercury] complete model=${request.model} msgs=${(request.messages as unknown[])?.length ?? 0}`);
    const res = await fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': 'https://mastermind.local',
        'X-Title': 'Mastermind',
      },
      // cache_prompt: true — same rationale as streamRich/stream. Lets llama.cpp keep the
      // prefix slot warm even on one-shot summary calls, in case a later streamRich on the
      // same session reuses the system prompt + tools list. Override-safe.
      body: JSON.stringify({ cache_prompt: true, ...request, stream: false }),
      // Non-streaming, but a one-shot summary on a big context still triggers a long cold
      // prefill → needs the 30-min dispatcher, not undici's 300s default. See llmDispatcher.
      dispatcher: llmDispatcher,
    } as RequestInit & { dispatcher: Agent });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`mercury error ${res.status}: ${err}`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }

  /** Fetch available models from the provider */
  async fetchAvailableModels(): Promise<AvailableModel[]> {
    const url = this.config.modelsUrl ?? `${this.config.baseUrl}/models`;
    const res = await fetchWithRetry(url, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': 'https://mastermind.local',
        'X-Title': 'Mastermind',
      },
    });
    if (!res.ok) throw new Error(`mercury models error ${res.status}: ${await res.text()}`);
    return parseModelsResponse(await res.json());
  }

  /** Non-streaming completion that returns content + optional tool calls */
  async completeRich(request: CompletionRequest): Promise<RichCompletion> {
    console.debug(`[mercury] completeRich model=${request.model} tools=${request.tools?.length ?? 0}`);
    // cache_prompt: true — consistent with the other three entry points (streamRich, stream,
    // complete). Override-safe via request.cache_prompt.
    const body: Record<string, unknown> = { cache_prompt: true, ...request, stream: false };
    if (request.tools?.length) {
      body['tools'] = request.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }

    const res = await fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': 'https://mastermind.local',
        'X-Title': 'Mastermind',
      },
      body: JSON.stringify(body),
      // Sub-agent path: large task prompts / contexts trigger long cold prefills → needs
      // the 30-min dispatcher, not undici's 300s default (which would kill them). See llmDispatcher.
      dispatcher: llmDispatcher,
    } as RequestInit & { dispatcher: Agent });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`mercury error ${res.status}: ${err}`);
    }

    const data = await res.json() as {
      choices: Array<{
        message: { content?: string; tool_calls?: RawToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; tokens_per_second?: number };
    };

    const choice = data.choices[0];
    const usage = extractUsage(data.usage);
    return {
      content: choice?.message?.content ?? undefined,
      toolCalls: parseToolCalls(choice?.message?.tool_calls),
      finishReason: choice?.finish_reason ?? 'stop',
      ...(usage ? { usage } : {}),
    };
  }

  /** Single streaming call that forwards text chunks via callback AND accumulates tool calls inline. */
  async streamRich(
    request: CompletionRequest,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<RichCompletion> {
    console.debug(`[mercury] streamRich model=${request.model} tools=${request.tools?.length ?? 0}`);
    // cache_prompt: true mirrors the openai-compat adapter — it's the explicit hint to
    // llama.cpp (via Mercury proxy) to keep the prefix-cache slot warm between calls.
    // Without it, behaviour depends on Mercury's default which we don't want to bet on,
    // and the two adapters diverge for no reason. Override-safe: caller can still pass
    // cache_prompt: false in the request if needed for debugging.
    const body: Record<string, unknown> = { cache_prompt: true, ...request, stream: true };
    if (request.tools?.length) {
      body['tools'] = request.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }

    const res = await fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': 'https://mastermind.local',
        'X-Title': 'Mastermind',
      },
      body: JSON.stringify(body),
      signal,
      dispatcher: llmDispatcher,
    } as RequestInit & { dispatcher: Agent });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`mercury error ${res.status}: ${err}`);
    }

    let textContent = '';
    let finishReason = 'stop';
    const tcBuf: ToolCallAccum[] = [];
    // Track reasoning (mercury non-standard field: delta.reasoning)
    let inReasoning = false;
    // Mercury force `stream_options.include_usage=true` côté Python pour les 3 backends
    // (openrouter / llamacpp / ollama) et passthrough le SSE tel quel. Le dernier event
    // contient donc `{usage:{...}, choices:[]}` — on le capture pour alimenter le gauge.
    let capturedUsage: ReturnType<typeof extractUsage>;
    // Mid-stream structured error (Mercury forwards OpenRouter/llama.cpp errors as an SSE
    // chunk `{error:{...}, choices:[]}`: rate-limit, billing, upstream process death,
    // timeout after partial generation). Captured here and thrown AFTER the loop — throwing
    // inside the per-chunk try would be swallowed by its own catch (which only logs parse
    // errors), so the truncated partial would be returned as a complete `stop` turn. See
    // openai-compat.streamRich for the error-shape rationale.
    let streamError: Error | undefined;

    for await (const event of parseSSEStream(res)) {
      try {
        const chunk = JSON.parse(event.data) as {
          error?: { type?: string; message?: string; code?: number; category?: string };
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; tokens_per_second?: number };
          choices: Array<{
            delta?: {
              content?: string;
              reasoning?: string;          // mercury
              reasoning_content?: string;  // llama.cpp native (Qwen3, DeepSeek-R1)
              tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string | null;
          }>;
        };
        if (chunk.usage?.prompt_tokens != null) {
          capturedUsage = extractUsage(chunk.usage);
        }
        // Older shape {error:{type,message}} (llama.cpp daemon), newer shape
        // {error:{message,code,category}} (Mercury OpenRouter backend). Accept any non-null
        // error object carrying a usable field; break out and throw after the loop.
        if (chunk.error && (chunk.error.type || chunk.error.message || chunk.error.category)) {
          const label = chunk.error.category ?? chunk.error.type ?? `code=${chunk.error.code ?? '?'}`;
          streamError = new Error(`LLM backend error (${label}): ${chunk.error.message ?? 'unknown error'}`);
          break;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        // Reasoning delta: delta.reasoning (mercury) or delta.reasoning_content (llama.cpp)
        // Wrap in <think>…</think> so the frontend parser handles it identically
        const reasoningContent = delta.reasoning_content ?? delta.reasoning;
        if (reasoningContent) {
          if (!inReasoning) {
            inReasoning = true;
            textContent += '<think>';
            onChunk('<think>');
          }
          textContent += reasoningContent;
          onChunk(reasoningContent);
        }

        // Content delta — close <think> block first if we were in reasoning
        if (delta.content) {
          if (inReasoning) {
            inReasoning = false;
            textContent += '</think>';
            onChunk('</think>');
          }
          textContent += delta.content;
          onChunk(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcBuf[tc.index]) tcBuf[tc.index] = { id: '', name: '', arguments: '' };
            if (tc.id) tcBuf[tc.index].id = tc.id;
            if (tc.function?.name) tcBuf[tc.index].name += tc.function.name;
            if (tc.function?.arguments) tcBuf[tc.index].arguments += tc.function.arguments;
          }
        }
      } catch (err) {
        console.debug(`[mercury] streamRich chunk parse error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Surface a mid-stream structured error AFTER the loop so it propagates to run.ts
    // (do not balance <think>/return a truncated partial as a successful turn). The
    // 'LLM backend error' prefix also routes this through run.ts crash-recovery.
    if (streamError) {
      console.warn(`[mercury] streamRich aborting on backend error: ${streamError.message}`);
      throw streamError;
    }

    // Close any unclosed <think> blocks at end of stream.
    // Two distinct cases this handles:
    //  1. Mercury wrap left open: the model emitted only delta.reasoning_content (no final
    //     delta.content), so the wrap added by Mercury never got its closing </think>.
    //     `inReasoning` flag tracks this case.
    //  2. Model wrote literal <think> in delta.content but got interrupted by a tool_call
    //     before writing the matching </think>. `inReasoning` is false here (it tracks the
    //     native field, not literal text), so we count opens vs closes in textContent instead.
    // Each stream is one model turn — we never need to wait across streams. Whatever <think>
    // is opened in this stream MUST close in this stream, otherwise the parser breaks and
    // the entire post-think content gets classified as reasoning.
    if (inReasoning) {
      inReasoning = false;
      textContent += '</think>';
      onChunk('</think>');
    }
    // Now balance any literal <think> tags emitted by the model in delta.content
    const openCount = (textContent.match(/<think>/gi) || []).length;
    const closeCount = (textContent.match(/<\/think>/gi) || []).length;
    const missing = openCount - closeCount;
    if (missing > 0) {
      const closes = '</think>'.repeat(missing);
      textContent += closes;
      onChunk(closes);
      console.debug(`[mercury] streamRich balanced ${missing} unclosed <think> tag(s) at end of stream`);
    }

    const nativeToolCalls = finishToolCalls(tcBuf);

    // Fallback: some models (Hermes, Qwen hermes-style) emit tool calls as XML text
    // instead of structured delta.tool_calls — parse them out if native parsing found nothing
    if (!nativeToolCalls && textContent.includes('<tool_call>')) {
      const parsed = parseTextToolCalls(textContent);
      if (parsed.length > 0) {
        console.debug(`[mercury] streamRich text-fallback tool calls detected: ${parsed.length} calls (${parsed.map(t => t.name).join(', ')})`);
        return {
          content: stripToolCallBlocks(textContent) || undefined,
          toolCalls: parsed,
          finishReason: 'tool_calls',
          ...(capturedUsage ? { usage: capturedUsage } : {}),
        };
      }
    }

    console.debug(`[mercury] streamRich done finish=${finishReason} textLen=${textContent.length} toolCalls=${nativeToolCalls?.length ?? 0}${nativeToolCalls ? ` (${nativeToolCalls.map(t => t.name).join(', ')})` : ''}${capturedUsage ? ` usage=${capturedUsage.promptTokens}in/${capturedUsage.outputTokens}out${capturedUsage.cachedTokens ? ` cached=${capturedUsage.cachedTokens}` : ''}${capturedUsage.tokensPerSecond ? ` tps=${capturedUsage.tokensPerSecond}` : ''}` : ' usage=<absent>'}`);

    return {
      content: textContent || undefined,
      toolCalls: nativeToolCalls,
      finishReason,
      ...(capturedUsage ? { usage: capturedUsage } : {}),
    };
  }

  /** Streaming completion - yields content deltas */
  async *stream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    console.debug(`[mercury] stream model=${request.model}`);
    const res = await fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': 'https://mastermind.local',
        'X-Title': 'Mastermind',
      },
      // cache_prompt: true — same rationale as streamRich. Keeps Mercury and openai-compat
      // adapters consistent on KV-cache hinting; caller can override via request.cache_prompt.
      body: JSON.stringify({ cache_prompt: true, ...request, stream: true }),
      signal,
      dispatcher: llmDispatcher,
    } as RequestInit & { dispatcher: Agent });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`mercury error ${res.status}: ${err}`);
    }

    let inReasoning = false;
    // Track all chunks yielded so we can balance literal <think> tags at end of stream
    let yieldedContent = '';
    // Mid-stream structured error — see streamRich for the full rationale. Captured and
    // thrown after the loop so it propagates instead of being swallowed by the parse-catch.
    let streamError: Error | undefined;

    for await (const event of parseSSEStream(res)) {
      try {
        const chunk = JSON.parse(event.data) as CompletionChunk & {
          error?: { type?: string; message?: string; code?: number; category?: string };
          choices: Array<{ delta?: { reasoning?: string; reasoning_content?: string } }>;
        };
        if (chunk.error && (chunk.error.type || chunk.error.message || chunk.error.category)) {
          const label = chunk.error.category ?? chunk.error.type ?? `code=${chunk.error.code ?? '?'}`;
          streamError = new Error(`LLM backend error (${label}): ${chunk.error.message ?? 'unknown error'}`);
          break;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Reasoning delta: delta.reasoning_content (llama.cpp) or delta.reasoning (mercury)
        const d = delta as { reasoning_content?: string; reasoning?: string };
        const rc = d.reasoning_content ?? d.reasoning;
        if (rc) {
          if (!inReasoning) {
            inReasoning = true;
            yieldedContent += '<think>';
            yield '<think>';
          }
          yieldedContent += rc;
          yield rc;
        }

        if (delta.content) {
          if (inReasoning) {
            inReasoning = false;
            yieldedContent += '</think>';
            yield '</think>';
          }
          yieldedContent += delta.content;
          yield delta.content;
        }
      } catch (err) {
        console.debug(`[mercury] stream chunk parse error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Surface a mid-stream structured error after the loop (see streamRich rationale).
    if (streamError) {
      console.warn(`[mercury] stream aborting on backend error: ${streamError.message}`);
      throw streamError;
    }

    // Close any unclosed <think> blocks at end of stream (see streamRich for full rationale).
    // Case 1: Mercury wrap left open (only reasoning_content, no final content delta).
    if (inReasoning) {
      inReasoning = false;
      yieldedContent += '</think>';
      yield '</think>';
    }
    // Case 2: literal <think> tags emitted by the model in delta.content, unbalanced.
    const openCount = (yieldedContent.match(/<think>/gi) || []).length;
    const closeCount = (yieldedContent.match(/<\/think>/gi) || []).length;
    const missing = openCount - closeCount;
    if (missing > 0) {
      const closes = '</think>'.repeat(missing);
      yield closes;
      console.debug(`[mercury] stream balanced ${missing} unclosed <think> tag(s) at end of stream`);
    }
  }
}
