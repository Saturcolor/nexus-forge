/**
 * Erreur API Mercury typée — préserve le payload structuré renvoyé par le back
 * pour permettre aux callers d'afficher autre chose qu'un message générique.
 *
 * Le back renvoie deux enveloppes selon la route :
 *   - Nouvelle (préférée) : `{"error": {"message": "...", "type": "...", "retry_after": N, "ends_at": "..."}}`
 *     Utilisée par slot_reserved, healthz degraded, embedding fallback,
 *     anthropic stream error, etc.
 *   - Legacy : `{"detail": "..."}` (FastAPI HTTPException par défaut).
 *
 * parseErrorResponse() unifie les deux et expose les champs structurés.
 */

export class ApiError extends Error {
  readonly status: number
  readonly statusText: string
  /** Type d'erreur back (ex. "slot_reserved", "lm_studio_error"). undefined si legacy. */
  readonly errorType?: string
  /** Secondes avant retry (slot_reserved, rate limit). */
  readonly retryAfter?: number
  /** ISO timestamp de fin de slot, si applicable. */
  readonly endsAt?: string
  /** Body brut tel que renvoyé par le back, ou undefined si JSON invalide. */
  readonly rawBody?: unknown

  constructor(
    status: number,
    statusText: string,
    message: string,
    extras: {
      errorType?: string
      retryAfter?: number
      endsAt?: string
      rawBody?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.statusText = statusText
    this.errorType = extras.errorType
    this.retryAfter = extras.retryAfter
    this.endsAt = extras.endsAt
    this.rawBody = extras.rawBody
  }
}

/**
 * Parse une Response non-OK et retourne une ApiError prête à throw.
 * Lit le body JSON si possible et extrait le message le plus précis disponible
 * (nouvelle enveloppe `error.message` > legacy `detail` > statusText).
 */
export async function parseErrorResponse(r: Response): Promise<ApiError> {
  let body: any = undefined
  try {
    body = await r.json()
  } catch {
    // body reste undefined
  }

  let message: string
  let errorType: string | undefined
  let retryAfter: number | undefined
  let endsAt: string | undefined

  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    // Nouvelle enveloppe structurée
    const err = body.error as Record<string, unknown>
    message = typeof err.message === 'string' && err.message
      ? `${r.status} ${err.message}`
      : `${r.status} ${r.statusText}`
    if (typeof err.type === 'string') errorType = err.type
    if (typeof err.retry_after === 'number') retryAfter = err.retry_after
    if (typeof err.ends_at === 'string') endsAt = err.ends_at
  } else if (body && typeof body === 'object' && typeof body.detail === 'string') {
    // Legacy FastAPI HTTPException
    message = `${r.status} ${body.detail}`
  } else {
    message = `${r.status} ${r.statusText}`
  }

  return new ApiError(r.status, r.statusText, message, {
    errorType,
    retryAfter,
    endsAt,
    rawBody: body,
  })
}
