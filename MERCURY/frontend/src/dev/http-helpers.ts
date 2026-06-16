/** Réponses JSON compatibles avec parseErrorResponse (src/api/errors.ts). */

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers((init as { headers?: HeadersInit }).headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function errorJson(
  status: number,
  opts: { message: string; type?: string; retryAfter?: number; endsAt?: string; legacyDetail?: boolean } = { message: 'Error' },
): Response {
  const headers = new Headers()
  if (opts.retryAfter != null) headers.set('Retry-After', String(opts.retryAfter))
  if (opts.legacyDetail) {
    return json({ detail: opts.message }, { status, statusText: 'Error', headers } as ResponseInit)
  }
  return json(
    {
      error: {
        message: opts.message,
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.retryAfter != null ? { retry_after: opts.retryAfter } : {}),
        ...(opts.endsAt ? { ends_at: opts.endsAt } : {}),
      },
    },
    { status, statusText: 'Error', headers } as ResponseInit,
  )
}

export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

/** Retourne true si annulé pendant l’attente. */
export async function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    await sleep(ms, signal)
    return false
  } catch {
    return true
  }
}
