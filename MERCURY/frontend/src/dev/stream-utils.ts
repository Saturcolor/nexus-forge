import { sleepUnlessAborted } from './http-helpers'

const enc = new TextEncoder()

/** SSE OpenAI-style pour Live Chat /v1/chat/completions ; respecte signal. */
export function openAiSseStream(
  signal: AbortSignal | undefined,
  chunks: string[],
  finalDone = true,
): ReadableStream<Uint8Array> {
  let idx = 0
  let closed = false
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted || closed) {
        closed = true
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      if (idx >= chunks.length) {
        if (finalDone) controller.enqueue(enc.encode('data: [DONE]\n\n'))
        closed = true
        controller.close()
        return
      }
      const delay = 50 + Math.floor(Math.random() * 100)
      if (await sleepUnlessAborted(delay, signal)) {
        closed = true
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      controller.enqueue(enc.encode(`data: ${chunks[idx]}\n\n`))
      idx += 1
    },
    cancel() {
      closed = true
    },
  })
}

export function sseErrorEvent(signal: AbortSignal | undefined, errObj: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      if (signal?.aborted) {
        controller.close()
        return
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: errObj })}\n\n`))
      controller.close()
    },
  })
}

/** NDJSON pour Ollama pull/create */
export function ndjsonStatusStream(
  signal: AbortSignal | undefined,
  lines: Record<string, unknown>[],
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      if (i >= lines.length) {
        controller.close()
        return
      }
      if (i > 0 && (await sleepUnlessAborted(40, signal))) {
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      controller.enqueue(enc.encode(`${JSON.stringify(lines[i])}\n`))
      i += 1
    },
  })
}

/** NDJSON /api/chat */
export function ollamaChatNdjsonStream(signal: AbortSignal | undefined, tokens: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      if (i >= tokens.length) {
        controller.enqueue(enc.encode(`${JSON.stringify({ done: true })}\n`))
        controller.close()
        return
      }
      if (await sleepUnlessAborted(60, signal)) {
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      controller.enqueue(
        enc.encode(`${JSON.stringify({ message: { content: tokens[i] }, done: false })}\n`),
      )
      i += 1
    },
  })
}

/** Anthropic-style NDJSON test: lignes normales puis done+error si scénario */
export function anthropicLikeNdjsonStream(
  signal: AbortSignal | undefined,
  injectMidStreamError: boolean,
): ReadableStream<Uint8Array> {
  const parts = injectMidStreamError
    ? [{ type: 'content', text: 'Hello ' }, { done: true, error: 'stream_reset_mock' }]
    : [{ type: 'content', text: 'Hello from mock.' }, { done: true }]
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      if (i >= parts.length) {
        controller.close()
        return
      }
      if (await sleepUnlessAborted(80, signal)) {
        try {
          controller.close()
        } catch {
          /* ignore */
        }
        return
      }
      controller.enqueue(enc.encode(`${JSON.stringify(parts[i])}\n`))
      i += 1
    },
  })
}

/**
 * SSE logs llama-server : une ligne data JSON toutes les 200 ms ; signal.aborted arrête tout.
 */
export function llamacppLogsSseStream(signal: AbortSignal | undefined, modelId: string): ReadableStream<Uint8Array> {
  let n = 0
  const timerRef: { id: ReturnType<typeof setInterval> | null } = { id: null }
  const stop = () => {
    if (timerRef.id != null) {
      clearInterval(timerRef.id)
      timerRef.id = null
    }
  }
  return new ReadableStream({
    start(controller) {
      const pushLine = () => {
        if (signal?.aborted) {
          stop()
          try {
            controller.close()
          } catch {
            /* ignore */
          }
          return
        }
        n += 1
        const iso = new Date().toISOString()
        const tok = 12 + (n % 40)
        const ms = 180 + (n % 50)
        const tps = (tok / (ms / 1000)).toFixed(1)
        const logLine = `[${iso}] [INFO] [server] slot ${modelId}: prompt done, generated ${tok} tokens in ${(ms / 1000).toFixed(2)}s (${tps} tok/s)`
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ log: logLine })}\n\n`))
        } catch {
          stop()
        }
      }
      signal?.addEventListener(
        'abort',
        () => {
          stop()
          try {
            controller.close()
          } catch {
            /* ignore */
          }
        },
        { once: true },
      )
      pushLine()
      timerRef.id = setInterval(pushLine, 200)
    },
    cancel() {
      stop()
    },
  })
}
