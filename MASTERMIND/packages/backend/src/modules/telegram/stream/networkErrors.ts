/**
 * Telegram Bot API network-error helpers.
 *
 * Inspired by OpenClaw's `network-errors.ts`, kept minimal: we only need
 * 429 retry-after parsing for now. The previous `withTelegramRetry` lived
 * inline in `bridge.ts` — moved here so the streaming module owns its own
 * retry policy.
 */

/**
 * Parse a Telegram API error and return the suggested retry delay in seconds,
 * or null if the error is not a 429 rate-limit.
 */
export function parseRetryAfter(err: unknown): number | null {
  const e = err as { parameters?: { retry_after?: number }; description?: string; message?: string };
  const fromParams = e?.parameters?.retry_after;
  if (typeof fromParams === 'number' && fromParams > 0) return fromParams;
  const desc = String(e?.description ?? e?.message ?? '');
  const match = desc.match(/retry after (\d+)/i);
  if (match) {
    const parsed = parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Run an async Telegram API call. On 429 (rate limit), wait the indicated
 * retry-after delay (+1s buffer) and retry **once**. Other errors propagate.
 */
export async function withTelegramRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const retryAfter = parseRetryAfter(err);
    if (retryAfter !== null) {
      const waitMs = (retryAfter + 1) * 1000;
      console.warn(`[telegram] 429 rate limit — retrying after ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      return await fn();
    }
    throw err;
  }
}
