/**
 * Native Telegram draft stream — uses Bot API 9.3+'s `sendMessageDraft` for
 * server-side animated streaming, with `sendMessage` at finalize.
 *
 * Why this primitive (vs `draftStream.ts`):
 *   `sendMessageDraft` (publicly available since Bot API 9.5, March 2026) is
 *   purpose-built for streaming partial LLM output to Telegram. The client
 *   animates character-by-character changes natively when successive calls
 *   share the same `draft_id`, with no per-frame send/edit overhead and no
 *   editMessageText rate-limit constraint. The draft is ephemeral (~30 s)
 *   and is **automatically cleared** when a regular `sendMessage` is sent
 *   to the same chat — that's the finalize trick.
 *
 * Why this is a *separate* file from `draftStream.ts`:
 *   The two transports have different invariants (no message_id during
 *   stream, no reply_markup support, narrower API surface) and different
 *   failure modes. Keeping them isolated makes the toggle cleaner and lets
 *   us A/B in production via the `telegramDraft` session option.
 *
 * Lessons learnt from the v1 implementation that this rewrite avoids:
 *   1. **No `sendMessageDraft(text='')` at finalize.** Empty text was a hard
 *      error before Bot API 10.0 (May 2026). The correct way to clear a
 *      draft is to send the real `sendMessage` — Telegram drops the draft
 *      automatically when the persistent message arrives.
 *   2. **No "▋" cursor in the draft text.** Animation is native; appending a
 *      cursor character makes Telegram animate it as part of the content,
 *      which looks wrong (the cursor "appears" then "disappears" repeatedly).
 *   3. **Low `MIN_INITIAL_CHARS` (10).** Telegram renders an "expanded
 *      preview card" instead of the streaming animation when the very first
 *      draft call already carries hundreds of chars. We only need the
 *      smallest gate possible to avoid sending an empty first draft.
 *
 * API constraints (from `@grammyjs/types@3.25.0` `methods.d.ts:114-128`):
 *   - chat_id: number (DM/private chats only — no string usernames)
 *   - draft_id: number, must be non-zero, same id across calls = animation
 *   - text: 1-4096 characters
 *   - parse_mode and entities supported; reply_markup, link_preview_options
 *     and disable_notification are NOT supported on a draft.
 *   - Returns `true` (no Message, no message_id).
 */

import type { Context } from 'grammy';

const DEFAULT_THROTTLE_MS = 1000;
const DEFAULT_MIN_INITIAL_CHARS = 10;
const TELEGRAM_DRAFT_MAX_CHARS = 4096;
const DRAFT_PREVIEW_CAP = 4000; // safety margin under the 4096 hard limit

let nextDraftId = 0;
function allocateDraftId(): number {
  nextDraftId = nextDraftId >= 2_147_483_647 ? 1 : nextDraftId + 1;
  return nextDraftId;
}

export type NativeDraftStreamOptions = {
  ctx: Context;
  chatId: number;
  /** Throttle between consecutive sendMessageDraft calls, in ms. */
  throttleMs?: number;
  /**
   * Minimum text length before the very first draft call fires. Below this
   * threshold we hold the draft empty so Telegram's "expanded preview card"
   * heuristic does not kick in for the first frame.
   */
  minInitialChars?: number;
};

export type NativeDraftStream = {
  /** Begin the throttle timer. Idempotent. */
  start: () => void;
  /** Provide the current full preview text (already rendered to Telegram HTML). */
  update: (renderedHtml: string) => void;
  /** Whether at least one sendMessageDraft call has succeeded. */
  hasDraft: () => boolean;
  /**
   * Send the final persistent message via `sendMessage`. Telegram clears the
   * draft automatically. Returns the message_id of the persistent message
   * (so the caller can attach overflow chunks if the answer is > 4096 chars).
   * Returns null if `sendMessage` itself failed.
   *
   * After finalize the stream is dead — calling update() is a no-op.
   */
  finalize: (finalHtml: string) => Promise<number | null>;
  /** Stop the throttle timer. Always call in a finally block. */
  cancel: () => void;
};

export function createNativeDraftStream(options: NativeDraftStreamOptions): NativeDraftStream {
  const { ctx, chatId } = options;
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const minInitialChars = options.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS;
  const draftId = allocateDraftId();

  let pendingText = '';
  let lastSentText = '';
  let lastSentTime = 0;
  let inFlight = false;
  let finished = false;
  let everSent = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = async (): Promise<void> => {
    if (finished) return;
    if (inFlight) return;

    const now = Date.now();
    if (now - lastSentTime < throttleMs) return;

    const text = pendingText;
    if (!text.trim()) return;
    if (!everSent && text.length < minInitialChars) return;

    // Hard-cap to Telegram's 4096-char limit. The full final answer goes via
    // sendMessage at finalize and may be split across multiple messages.
    const draftText = text.length > DRAFT_PREVIEW_CAP
      ? text.slice(0, DRAFT_PREVIEW_CAP)
      : text;

    // Dedup against the actual *payload* sent to the API, not the source
    // text. Once the source grows past DRAFT_PREVIEW_CAP, two distinct full
    // texts may yield the same truncated draft; skipping that duplicate edit
    // saves a useless API round-trip.
    if (draftText === lastSentText) return;

    inFlight = true;
    try {
      await ctx.api.sendMessageDraft(chatId, draftId, draftText, { parse_mode: 'HTML' });
      lastSentText = draftText;
      lastSentTime = Date.now();
      everSent = true;
    } catch (err) {
      // Best-effort — losing a streaming frame is acceptable. Common reasons:
      //   - Bot API server doesn't support sendMessageDraft (older self-host).
      //     The caller's capability check should prevent this, but if it
      //     slips through we just stop quietly.
      //   - 429 rate limit. sendMessageDraft has its own bucket separate
      //     from editMessageText; observed limits are looser but not zero.
      //   - HTML parse error on a partial chunk (incomplete tag). Drop and
      //     retry on the next tick with more text.
      // Detect "server does not speak this method" and hard-stop the timer.
      // We accept several signals so a localised error string or a different
      // grammY wrapper variant doesn't keep the timer noisily retrying:
      //   - error_code === 404 (the standard Bot API "method not found")
      //   - description / message containing "method not found", "method is
      //     not", or "no such method" (current and likely future variants)
      //   - error_code === 400 with an explicit "method" mention (some Bot
      //     API server forks return 400 instead of 404)
      const errObj = err as {
        error_code?: number;
        description?: string;
        message?: string;
      };
      const description = String(errObj?.description ?? errObj?.message ?? '');
      const methodMissing =
        errObj?.error_code === 404 ||
        /method (?:not found|is not|does not exist)|no such method|unknown method/i.test(description) ||
        (errObj?.error_code === 400 && /\bmethod\b/i.test(description));
      if (methodMissing) {
        finished = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => { flush().catch(() => {}); }, throttleMs);
    },
    update(renderedHtml: string) {
      if (finished) return;
      pendingText = renderedHtml;
    },
    hasDraft: () => everSent,
    async finalize(finalHtml: string): Promise<number | null> {
      finished = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // Bounded wait for any in-flight draft call to settle so the final
      // sendMessage doesn't race a still-pending draft frame.
      const FINALIZE_WAIT_TIMEOUT_MS = 5000;
      const FINALIZE_WAIT_INTERVAL_MS = 50;
      let waited = 0;
      while (inFlight && waited < FINALIZE_WAIT_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, FINALIZE_WAIT_INTERVAL_MS));
        waited += FINALIZE_WAIT_INTERVAL_MS;
      }

      const text = finalHtml.trim() ? finalHtml : '<i>(no response)</i>';
      // Cap to the hard 4096 limit; the caller is responsible for sending
      // overflow chunks separately via the returned message_id.
      const firstChunk = text.length > TELEGRAM_DRAFT_MAX_CHARS
        ? text.slice(0, TELEGRAM_DRAFT_MAX_CHARS)
        : text;

      try {
        const sent = await ctx.api.sendMessage(chatId, firstChunk, { parse_mode: 'HTML' });
        return sent.message_id;
      } catch (htmlErr) {
        // Try once more without parse_mode in case partial HTML breaks parsing
        // on the final commit (very rare — the FSM should produce closed tags
        // by this point — but a safety net costs nothing).
        try {
          const sent = await ctx.api.sendMessage(chatId, firstChunk);
          return sent.message_id;
        } catch (plainErr) {
          // Log BOTH failures so the production diagnostic is complete.
          // The HTML attempt usually fails on entity errors; the plain
          // attempt usually fails on auth/network/quota — they're rarely
          // the same root cause, so seeing only one is a debugging trap.
          const htmlMsg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
          const plainMsg = plainErr instanceof Error ? plainErr.message : String(plainErr);
          console.error(
            `[telegram:nativeDraft] finalize sendMessage failed for chat ${chatId} ` +
            `(html: ${htmlMsg}; plain: ${plainMsg})`,
          );
          return null;
        }
      }
    },
    cancel() {
      finished = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
