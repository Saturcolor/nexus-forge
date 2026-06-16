import { scenarios } from '../mockScenarios'
import { errorJson } from '../http-helpers'
import { openAiSseStream, ollamaChatNdjsonStream, anthropicLikeNdjsonStream } from '../stream-utils'

const SLOT_RETRY = 60

function slotReservedResponse(): Response {
  const endsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  return errorJson(503, {
    message: 'Exclusive slot active (deepwork)',
    type: 'slot_reserved',
    retryAfter: SLOT_RETRY,
    endsAt,
  })
}

function requireKeyResponse(): Response {
  return errorJson(401, { message: 'API key required', type: 'require_api_key' })
}

function isInferencePath(pathname: string): boolean {
  return (
    pathname === '/v1/chat/completions'
    || pathname === '/api/chat'
    || pathname === '/v1/responses'
    || pathname.startsWith('/v1/audio/')
    || pathname === '/admin/benchmark/chat-stream'
  )
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}

function handleChatStream(signal: AbortSignal | undefined): Response {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
    JSON.stringify({ choices: [{ delta: { content: ' from' } }] }),
    JSON.stringify({ choices: [{ delta: { content: ' Mercury' } }] }),
    JSON.stringify({ choices: [{ delta: { content: ' mock' } }] }),
    JSON.stringify({ choices: [{ delta: { content: ' stream.' } }] }),
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } }),
  ]
  return new Response(openAiSseStream(signal, chunks, true), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  })
}

function handleV1ChatCompletions(body: unknown, signal: AbortSignal | undefined): Response {
  const streamRequested =
    typeof body === 'object' && body !== null && (body as { stream?: boolean }).stream === true
  if (streamRequested) {
    if (scenarios.anthropicStreamError) {
      return new Response(anthropicLikeNdjsonStream(signal, true), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    }
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: 'Chunk' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' one.' } }] }),
    ]
    return new Response(openAiSseStream(signal, chunks, true), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    })
  }
  return jsonOk({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: 'Mock non-stream response.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
  })
}

/** Inférence mock : streaming + erreurs scénarisées */
export function tryInference(
  pathname: string,
  method: string,
  body: unknown,
  signal: AbortSignal | undefined,
  headers: Headers,
): Response | null {
  if (!isInferencePath(pathname)) return null
  if (method !== 'POST') return null

  if (scenarios.requireApiKey) {
    const auth = headers.get('Authorization') ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    const tok = m?.[1] ?? ''
    const adminMockOk = pathname === '/admin/benchmark/chat-stream' && tok === 'mock'
    if (!adminMockOk && !tok.startsWith('sk-mock-') && !tok.startsWith('sk-')) {
      return requireKeyResponse()
    }
  }

  if (scenarios.slotActive) {
    const consumer = headers.get('X-Mock-Consumer') ?? ''
    if (!consumer || consumer !== scenarios.slotOwner) {
      return slotReservedResponse()
    }
  }

  if (pathname === '/admin/benchmark/chat-stream') {
    return handleChatStream(signal)
  }

  if (pathname === '/v1/chat/completions') {
    return handleV1ChatCompletions(body, signal)
  }

  if (pathname === '/api/chat') {
    return new Response(ollamaChatNdjsonStream(signal, ['Hello', ' from', ' mock', ' Ollama', '.']), {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    })
  }

  if (pathname === '/v1/responses') {
    if (scenarios.lmStudioResponses400) {
      return errorJson(400, {
        message: 'LM Studio template error: missing variable in jinja',
        type: 'lm_studio_error',
      })
    }
    return jsonOk({ id: 'resp_mock_1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Mock response.' }] }] })
  }

  if (pathname.startsWith('/v1/audio/')) {
    if (pathname.includes('transcriptions')) {
      return jsonOk({ text: 'mock transcription' })
    }
    if (pathname.includes('speech')) {
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })
    }
    return errorJson(404, { message: 'Unknown audio route', legacyDetail: true })
  }

  return null
}
