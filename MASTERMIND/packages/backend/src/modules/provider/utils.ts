export interface FetchWithRetryOptions {
  maxRetries?: number;
  retryOn?: (status: number) => boolean;
}

const RATE_LIMIT_BACKOFF_MS = [500, 1_000, 2_000];
const SERVER_ERROR_BACKOFF_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function getRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function isAbortFromCaller(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name !== 'TimeoutError';
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string; cause?: { code?: string } }).code
    ?? (err as Error & { cause?: { code?: string } }).cause?.code;
  return code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || err.name === 'TimeoutError'
    || err.message.includes('ETIMEDOUT')
    || err.message.includes('ECONNRESET');
}

function retryPlan(status: number, attempt: number, maxRetries: number, retryOn?: (status: number) => boolean): number | undefined {
  if (retryOn) {
    return retryOn(status) && attempt < maxRetries ? SERVER_ERROR_BACKOFF_MS : undefined;
  }
  if (status === 429 && attempt < maxRetries) {
    return RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
  }
  if (status >= 500 && status <= 599 && attempt < Math.min(maxRetries, 1)) {
    return SERVER_ERROR_BACKOFF_MS;
  }
  return undefined;
}

export async function fetchWithRetry(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(input, init);
      const plannedDelay = retryPlan(res.status, attempt, maxRetries, opts.retryOn);
      if (!res.ok && plannedDelay !== undefined) {
        await res.body?.cancel().catch(() => {});
        const retryAfterMs = res.status === 429 ? getRetryAfterMs(res) : undefined;
        const delay = retryAfterMs ?? jitter(plannedDelay);
        console.warn(`[provider] HTTP ${res.status} — retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      if (isAbortFromCaller(init.signal as AbortSignal | null | undefined)) {
        throw err;
      }
      if (attempt < 1 && isRetryableNetworkError(err)) {
        console.warn(`[provider] Network error — retry ${attempt + 1}/1 in ${SERVER_ERROR_BACKOFF_MS}ms: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(SERVER_ERROR_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
}
