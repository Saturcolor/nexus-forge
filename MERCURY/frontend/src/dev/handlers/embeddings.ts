import { scenarios } from '../mockScenarios'
import { errorJson } from '../http-helpers'

function slotReservedResponse(): Response {
  const endsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  return errorJson(503, {
    message: 'Exclusive slot active (deepwork)',
    type: 'slot_reserved',
    retryAfter: 60,
    endsAt,
  })
}

export function tryEmbeddings(
  pathname: string,
  method: string,
  headers: Headers,
): Response | null {
  if (pathname !== '/v1/embeddings' || method !== 'POST') return null

  if (scenarios.requireApiKey) {
    const auth = headers.get('Authorization') ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    const tok = m?.[1] ?? ''
    if (!tok.startsWith('sk-mock-') && !tok.startsWith('sk-')) {
      return errorJson(401, { message: 'API key required', type: 'require_api_key' })
    }
  }

  if (scenarios.slotActive) {
    const consumer = headers.get('X-Mock-Consumer') ?? ''
    if (!consumer || consumer !== scenarios.slotOwner) {
      return slotReservedResponse()
    }
  }

  if (scenarios.embeddingsFailAll) {
    return errorJson(502, {
      message: 'All embedding backends failed in chain',
      type: 'embedding_chain_failed',
    })
  }

  const vec = Array.from({ length: 8 }, (_, i) => (i + 1) * 0.01)
  return new Response(
    JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', embedding: vec, index: 0 }],
      model: 'mock-embed',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}
