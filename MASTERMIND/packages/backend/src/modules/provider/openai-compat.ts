import type { ProviderConfig, CompletionRequest, CompletionChunk, AvailableModel, RichCompletion, ToolCall } from '@mastermind/shared';
import { parseSSEStream } from './stream.js';
import { parseModelsResponse } from './mercury.js';
import { parseTextToolCalls, stripToolCallBlocks } from './parseTextToolCalls.js';
import { fetchWithRetry } from './utils.js';
import { repairToolCallArguments } from './repairToolCall.js';
import { Agent } from 'undici';

// Per-instance streaming dispatcher with disabled idle timeouts (mirrors mercury.ts).
// LLM prompt processing on large models (>50k tokens) can take many minutes before
// the first response token arrives, so the streaming calls need headers/body timeouts
// disabled. We attach this dispatcher ONLY to streamRich/stream via the `dispatcher`
// option — we no longer call setGlobalDispatcher().
//
// Why not global: setGlobalDispatcher mutates undici's process-wide default, so it
// disabled body/headers timeouts for EVERY fetch() that doesn't pass its own dispatcher
// — including mercury's non-streaming complete/completeRich/fetchAvailableModels (which
// pass neither dispatcher nor abort signal). A half-closed/stalled Mercury socket on a
// sub-agent completeRich could then hang forever (no body timeout, no abort path). Scoping
// the infinite timeout to the streaming calls that actually need it restores undici's finite
// defaults for everything else and removes the process-wide blast radius.
const streamingDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function closeOpenAICompatDispatcher(): Promise<void> {
  return streamingDispatcher.close();
}

interface RawToolCall { id: string; function: { name: string; arguments: string } }

function parseToolCalls(raw: RawToolCall[] | undefined): ToolCall[] | undefined {
  if (!raw?.length) return undefined;
  const calls = raw
    .filter(tc => tc.function?.name)
    .map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: repairToolCallArguments(tc.function.arguments, tc.function.name),
    }));
  return calls.length ? calls : undefined;
}

/**
 * Normalise un bloc `usage` OpenAI-compat en `RichCompletion.usage`.
 *  - `cached_tokens === 0` (cas froid OpenRouter) → undefined (UI propre)
 *  - `cache_read_input_tokens` : Anthropic — accepté en fallback si `prompt_tokens_details`
 *    absent (OpenRouter passthrough du format Anthropic natif quand on tape un modèle claude-*)
 *  - `tokens_per_second` : llamacpp via Mercury (timings.predicted_per_second)
 * Renvoie undefined si aucun token n'est connu.
 */
function extractUsage(raw: unknown): { promptTokens: number; outputTokens: number; cachedTokens?: number; tokensPerSecond?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as {
    prompt_tokens?: number; completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
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

/** Accumulator for a streaming tool call delta */
interface ToolCallAccum { id: string; name: string; arguments: string }

/** Parse streaming tool call deltas into finished ToolCalls */
function finishToolCalls(buf: ToolCallAccum[]): ToolCall[] | undefined {
  if (!buf.length) return undefined;
  const calls: ToolCall[] = [];
  // Keep the buffer index (i) stable for id synthesis — see mercury.finishToolCalls for the
  // full rationale. tcBuf is indexed by delta.tool_calls index, so i is a deterministic
  // per-turn ordinal; iterate (not filter→map) so we can reference i for the fallback id.
  buf.forEach((tc, i) => {
    if (!tc?.name) return;  // skip tool calls with empty/missing name
    calls.push({
      // Synthesize a stable, non-empty id when the backend omits one (some llama.cpp/vLLM
      // builds). Empty id is falsy → run.ts persists tool_call_id='' on both the assistant
      // tool_call and the tool_result, toAiMessage drops it on rebuild, stripOrphanedToolCalls
      // disables orphan cleanup, and native providers reject the empty id (400). `tc-stream-`
      // prefix keeps this native path clear of run.ts's `tc-text-` content-drop discriminator.
      id: tc.id || `tc-stream-${i}`,
      name: tc.name,
      arguments: repairToolCallArguments(tc.arguments, tc.name),
    });
  });
  return calls.length ? calls : undefined;
}

/** Generic OpenAI-compatible adapter (works with any OpenAI-compatible endpoint) */
export class OpenAICompatAdapter {
  constructor(private config: ProviderConfig) {}

  /** Fetch available models — supports OpenAI /models and Ollama /api/tags formats */
  async fetchAvailableModels(): Promise<AvailableModel[]> {
    const url = this.config.modelsUrl ?? `${this.config.baseUrl}/models`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    const res = await fetchWithRetry(url, { headers });
    if (!res.ok) throw new Error(`Provider ${this.config.id} models error ${res.status}: ${await res.text()}`);
    return parseModelsResponse(await res.json());
  }

  async completeRich(request: CompletionRequest): Promise<RichCompletion> {
    console.debug(`[openai-compat] completeRich provider=${this.config.id} model=${request.model} tools=${request.tools?.length ?? 0}`);
    const body: Record<string, unknown> = { ...request, stream: false };
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
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Provider ${this.config.id} error ${res.status}: ${err}`);
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

  async complete(request: CompletionRequest): Promise<string> {
    console.debug(`[openai-compat] complete provider=${this.config.id} model=${request.model}`);
    const res = await fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ ...request, stream: false }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Provider ${this.config.id} error ${res.status}: ${err}`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }

  /**
   * Single streaming call that forwards text chunks via callback AND accumulates
   * tool calls inline. Replaces the completeRich→stream double-call pattern.
   * Preserves KV cache: one request per turn, always stream=true.
   */
  async streamRich(
    request: CompletionRequest,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<RichCompletion> {
    console.debug(`[openai-compat] streamRich provider=${this.config.id} model=${request.model} tools=${request.tools?.length ?? 0}`);
    const hasTools = !!request.tools?.length;
    const body: Record<string, unknown> = {
      ...request,
      stream: true,
      cache_prompt: true,  // llama.cpp: hint to reuse KV cache prefix across requests
      stream_options: { include_usage: true },  // OpenRouter/OpenAI: emit usage in last SSE chunk
    };
    // `think: true` is Ollama-specific for reasoning models (deepseek-r1, qwen3…).
    // Ollama does NOT support think + tools simultaneously — disable think when tools are active
    // to avoid stream corruption on tool-call turns.
    // `reasoning_effort` stays in body via ...request spread for llamacpp (Mercury passes it through).
    if (request.reasoning_effort && !hasTools) {
      body['think'] = true;  // Ollama: only when no tools
    }
    if (hasTools) {
      body['tools'] = request.tools!.map(t => ({
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
      },
      body: JSON.stringify(body),
      signal,
      dispatcher: streamingDispatcher,
    } as RequestInit & { dispatcher: Agent });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Provider ${this.config.id} error ${res.status}: ${err}`);
    }

    let textContent = '';
    let finishReason = 'stop';
    const tcBuf: ToolCallAccum[] = [];
    // Track reasoning (non-standard delta fields across providers)
    let inReasoning = false;
    let capturedUsage: ReturnType<typeof extractUsage>;
    // Mid-stream structured error (Mercury/llama.cpp forward OpenRouter/upstream errors as an
    // SSE chunk `{error:{...}, choices:[]}`: rate-limit, billing, upstream process death,
    // timeout after partial generation). Captured here and thrown AFTER the loop — throwing
    // inside the per-chunk try would be swallowed by its own catch (which only logs parse
    // errors), so the truncated partial would be returned as a complete `stop` turn.
    let streamError: Error | undefined;

    for await (const event of parseSSEStream(res)) {
      try {
        const chunk = JSON.parse(event.data) as {
          error?: { type?: string; message?: string; code?: number; category?: string };
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; tokens_per_second?: number };
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning?: string;          // mercury
              thinking?: string;           // Ollama (think: true)
              reasoning_content?: string;  // llama.cpp native (Qwen3, DeepSeek-R1)
              tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string | null;
          }>;
        };
        // Usage chunk (OpenRouter/OpenAI): final SSE event with empty choices[] + usage field.
        // Emitted when stream_options.include_usage is true.
        if (chunk.usage?.prompt_tokens != null) {
          capturedUsage = extractUsage(chunk.usage);
        }

        // Detect daemon structured errors (process died, connection error, upstream death).
        // Older shape: {error: {type, message}} from llama.cpp daemon.
        // Newer shape: {error: {message, code, category}} from Mercury OpenRouter backend
        // (no `type` field — but always has `message` and usually `category`/`code`).
        // Accept both: any non-null `error` object with a usable message. Capture and break
        // out — throwing here would be swallowed by the per-chunk catch below.
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

        // Reasoning delta — covers all providers:
        //   delta.reasoning_content : llama.cpp (Qwen3, DeepSeek-R1) ← KEY for local models
        //   delta.reasoning         : mercury
        //   delta.thinking          : Ollama
        // → wrap in <think> tags for frontend compatibility
        const reasoningChunk = (delta as Record<string, unknown>).reasoning_content as string | undefined
          ?? delta.reasoning ?? delta.thinking;
        if (reasoningChunk) {
          if (!inReasoning) {
            inReasoning = true;
            textContent += '<think>';
            onChunk('<think>');
          }
          textContent += reasoningChunk;
          onChunk(reasoningChunk);
        }

        // Text chunk → forward live (close <think> block first if needed)
        if (delta.content) {
          if (inReasoning) {
            inReasoning = false;
            textContent += '</think>';
            onChunk('</think>');
          }
          textContent += delta.content;
          onChunk(delta.content);
        }

        // Tool call delta → accumulate by index
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcBuf[tc.index]) tcBuf[tc.index] = { id: '', name: '', arguments: '' };
            if (tc.id) tcBuf[tc.index].id = tc.id;
            if (tc.function?.name) tcBuf[tc.index].name += tc.function.name;
            if (tc.function?.arguments) tcBuf[tc.index].arguments += tc.function.arguments;
          }
        }
      } catch (err) {
        console.debug(`[openai-compat] streamRich chunk parse error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Surface a mid-stream structured error AFTER the loop so it propagates to run.ts
    // (do not balance <think>/return a truncated partial as a successful turn). The
    // 'LLM backend error' prefix also routes this through run.ts crash-recovery.
    if (streamError) {
      console.warn(`[openai-compat] streamRich aborting on backend error: ${streamError.message}`);
      throw streamError;
    }

    // Close any unclosed <think> blocks at end of stream — mirrors mercury.streamRich.
    // Two distinct cases:
    //  1. Native reasoning wrap left open: the model emitted only delta.reasoning_content/
    //     reasoning/thinking (no final delta.content), so the wrap we added never got its
    //     closing </think>. `inReasoning` tracks this. Emit </think> via onChunk too for
    //     live (frontend) parity, not just in the accumulated textContent.
    //  2. The model wrote a literal <think> in delta.content but got cut off (tool_call or
    //     finish) before the matching </think>. `inReasoning` is false here (it tracks the
    //     native field, not literal text), so we count opens vs closes in textContent and
    //     append the missing closers. Without this, run.ts stripThinkBlocks/extractThinkContents
    //     (both require a closing tag) leak the raw <think>… into persisted/model-facing content
    //     and lose the reasoning. Each stream is one model turn — whatever <think> opens here
    //     MUST close here.
    if (inReasoning) {
      inReasoning = false;
      textContent += '</think>';
      onChunk('</think>');
    }
    const openCount = (textContent.match(/<think>/gi) || []).length;
    const closeCount = (textContent.match(/<\/think>/gi) || []).length;
    const missing = openCount - closeCount;
    if (missing > 0) {
      const closes = '</think>'.repeat(missing);
      textContent += closes;
      onChunk(closes);
      console.debug(`[openai-compat] streamRich balanced ${missing} unclosed <think> tag(s) at end of stream`);
    }

    const nativeToolCalls = finishToolCalls(tcBuf);

    // Fallback: some models (Hermes, Qwen hermes-style) emit tool calls as XML text
    // instead of structured delta.tool_calls — parse them out if native parsing found nothing
    if (!nativeToolCalls && textContent.includes('<tool_call>')) {
      const parsed = parseTextToolCalls(textContent);
      if (parsed.length > 0) {
        console.debug(`[openai-compat] streamRich text-fallback tool calls: ${parsed.length} calls (${parsed.map(t => t.name).join(', ')})`);
        return {
          content: stripToolCallBlocks(textContent) || undefined,
          toolCalls: parsed,
          finishReason: 'tool_calls',
          ...(capturedUsage ? { usage: capturedUsage } : {}),
        };
      }
    }

    console.debug(`[openai-compat] streamRich done finish=${finishReason} textLen=${textContent.length} toolCalls=${nativeToolCalls?.length ?? 0}${nativeToolCalls ? ` (${nativeToolCalls.map(t => t.name).join(', ')})` : ''}${capturedUsage ? ` usage=${capturedUsage.promptTokens}in/${capturedUsage.outputTokens}out cached=${capturedUsage.cachedTokens ?? 0}` : ''}`);

    return {
      content: textContent || undefined,
      toolCalls: nativeToolCalls,
      finishReason,
      ...(capturedUsage ? { usage: capturedUsage } : {}),
    };
  }

  async *stream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    console.debug(`[openai-compat] stream provider=${this.config.id} model=${request.model}`);
    const body: Record<string, unknown> = { ...request, stream: true };
    // Keep reasoning_effort — Mercury proxy passes it through to llamacpp natively.
    // Add think: true for Ollama. Do NOT add reasoning (string) — Ollama expects object → 400.
    if (request.reasoning_effort) {
      body['think'] = true;  // Ollama
      // reasoning_effort already in body via ...request spread above (for llamacpp)
    }

    const res = await fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
      dispatcher: streamingDispatcher,
    } as RequestInit & { dispatcher: Agent });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Provider ${this.config.id} error ${res.status}: ${err}`);
    }

    let inReasoning = false;
    // Track all chunks yielded so we can balance literal <think> tags at end of stream
    // (mirrors mercury.stream). Needed for case 2 below.
    let yieldedContent = '';
    // Mid-stream structured error — see streamRich for the full rationale. Captured and
    // thrown after the loop so it propagates instead of being swallowed by the parse-catch.
    let streamError: Error | undefined;

    for await (const event of parseSSEStream(res)) {
      try {
        const chunk = JSON.parse(event.data) as CompletionChunk & {
          error?: { type?: string; message?: string; code?: number; category?: string };
          choices: Array<{ delta?: { reasoning?: string; thinking?: string; reasoning_content?: string } }>;
        };
        if (chunk.error && (chunk.error.type || chunk.error.message || chunk.error.category)) {
          const label = chunk.error.category ?? chunk.error.type ?? `code=${chunk.error.code ?? '?'}`;
          streamError = new Error(`LLM backend error (${label}): ${chunk.error.message ?? 'unknown error'}`);
          break;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // llama.cpp: delta.reasoning_content, mercury: delta.reasoning, Ollama: delta.thinking
        const d = delta as { reasoning_content?: string; reasoning?: string; thinking?: string };
        const reasoningChunk = d.reasoning_content ?? d.reasoning ?? d.thinking;
        if (reasoningChunk) {
          if (!inReasoning) {
            inReasoning = true;
            yieldedContent += '<think>';
            yield '<think>';
          }
          yieldedContent += reasoningChunk;
          yield reasoningChunk;
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
        console.debug(`[openai-compat] stream chunk parse error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Surface a mid-stream structured error after the loop (see streamRich rationale).
    if (streamError) {
      console.warn(`[openai-compat] stream aborting on backend error: ${streamError.message}`);
      throw streamError;
    }

    // Close any unclosed <think> blocks at end of stream (mirrors mercury.stream).
    // Case 1: native reasoning wrap left open (only reasoning_content, no final content delta).
    if (inReasoning) {
      inReasoning = false;
      yieldedContent += '</think>';
      yield '</think>';
    }
    // Case 2: literal <think> tags emitted by the model in delta.content, unbalanced
    // (e.g. cut off by a tool_call before the matching </think>).
    const openCount = (yieldedContent.match(/<think>/gi) || []).length;
    const closeCount = (yieldedContent.match(/<\/think>/gi) || []).length;
    const missing = openCount - closeCount;
    if (missing > 0) {
      const closes = '</think>'.repeat(missing);
      yield closes;
      console.debug(`[openai-compat] stream balanced ${missing} unclosed <think> tag(s) at end of stream`);
    }
  }
}
