/**
 * Telegram draft stream — the core of progressive message streaming.
 *
 * Inspired by OpenClaw's `extensions/telegram/src/draft-stream.ts`, adapted to
 * grammY and our HTML-only formatting pipeline. Differences from the original
 * Mastermind streaming code (in `bridge.ts` pre-refactor):
 *
 *   - `MIN_INITIAL_CHARS` debounce on the first send. Avoids the symptom where
 *     a fast LLM crams several KB into the first 1s tick, causing Telegram to
 *     render the initial message as an "expanded card" pre-formed instead of
 *     animating progressively.
 *   - No dependency on `sendMessageDraft` (the non-public Telegram API method
 *     that pushed text into the chat compose area). That path produced the
 *     "pinned-preview" and "ghost message" symptoms on recent Telegram clients
 *     and is removed entirely.
 *   - Single source of truth for throttling, mutex, 429 handling, and the
 *     "▋" cursor — used by all three handlers (text / photo / voice).
 *
 * Lifecycle:
 *   const stream = createDraftStream({ ctx, chatId });
 *   stream.start();                // begin throttle timer
 *   stream.update(currentText);    // call from inside onChunk
 *   await stream.finalize(text);   // edit final, drop cursor, return msgId
 *   stream.cancel();               // stop the timer (always call in finally)
 */

import type { Context } from 'grammy';
import { STREAM_CURSOR } from './rendering.js';

// Tuning notes — DO NOT lower EDIT_INTERVAL_MS below 1000.
// Historical context: shorter intervals (600-800ms) trigger Telegram 429 rate
// limits on `editMessageText` for the same chat. 1000ms was the empirically
// safe value found during the original implementation — burned through
// rate-limit incidents to settle on it. Revisit only with prod telemetry.
//
// MIN_INITIAL_CHARS is the only knob we get to play with for "felt latency":
// 50 chars makes the first message appear within ~half a second on a fast LLM
// (vs 200 which felt like a noticeable gap), without re-introducing the
// "expanded preview card" symptom. The cap on initial size matters; the edit
// cadence does not (it's bounded by Telegram, period).
const DEFAULT_EDIT_INTERVAL_MS = 1000;
const DEFAULT_MIN_INITIAL_CHARS = 50;

export type DraftStreamOptions = {
  ctx: Context;
  chatId: number;
  /** Throttle between consecutive editMessageText calls, in ms. */
  editIntervalMs?: number;
  /**
   * Minimum rendered length before the *first* sendMessage fires. While the
   * preview is below this threshold, flushes are skipped. Once the first
   * message is sent, this gate no longer applies and edits stream normally.
   * Set to 0 to disable.
   */
  minInitialChars?: number;
};

export type DraftStream = {
  /** Begin the throttle timer. Idempotent. */
  start: () => void;
  /**
   * Provide the current full preview text (already rendered to Telegram HTML).
   * The next throttled tick will send/edit with this text + cursor.
   * Identical content as the previous edit is silently skipped.
   */
  update: (renderedHtml: string) => void;
  /** True if a sendMessage has succeeded and we have a real message_id to edit. */
  hasMessage: () => boolean;
  /** Telegram message_id of the streaming message, or null before first send. */
  messageId: () => number | null;
  /**
   * Edit the message one last time with `finalHtml` (no cursor) and return its
   * message_id so the caller can append additional chunks if the answer
   * exceeds 4096 chars. If no message has been sent yet, returns null and the
   * caller must send the final text directly.
   *
   * After finalize the stream is dead — calling update() is a no-op.
   */
  finalize: (finalHtml: string) => Promise<number | null>;
  /**
   * Stop the timer AND wait (bounded, ≤5 s) for any in-flight send/edit to
   * settle. Use when discarding the stream WITHOUT a final edit (e.g.
   * deleteMessage-then-resend) — guarantees no in-flight `ctx.api.*` call
   * lands AFTER your next API action. Idempotent. Distinct from `cancel()`
   * which only stops the timer (in-flight calls may still resolve later).
   */
  drain: () => Promise<void>;
  /** Stop the throttle timer. Always call in a finally block. */
  cancel: () => void;
};

export function createDraftStream(options: DraftStreamOptions): DraftStream {
  const { ctx, chatId } = options;
  const editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
  const minInitialChars = options.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS;

  let msgId: number | null = null;
  let pendingText = '';
  let lastSentText = '';
  let lastEditTime = 0;
  let editInFlight = false;
  let sending = false;
  let editPaused = false;
  let finished = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const handleRetryAfter = (err: unknown): void => {
    const e = err as { parameters?: { retry_after?: number }; description?: string; message?: string };
    const retryAfter =
      e?.parameters?.retry_after ??
      parseInt(String(e?.description ?? e?.message ?? '').match(/retry after (\d+)/i)?.[1] ?? '');
    if (retryAfter > 0) {
      editPaused = true;
      setTimeout(() => { editPaused = false; }, (retryAfter + 1) * 1000);
    }
  };

  const flush = async (): Promise<void> => {
    if (finished) return;
    if (editInFlight) return;
    if (editPaused) return;

    const now = Date.now();
    if (now - lastEditTime < editIntervalMs) return;

    const text = pendingText;
    if (!text.trim()) return;
    if (text === lastSentText && msgId !== null) return;

    if (msgId === null) {
      // Pre-first-send: enforce the minInitialChars debounce. Below the
      // threshold, defer the send so Telegram can render the initial message
      // as a small bubble that grows progressively, instead of a long pre-
      // formed card.
      if (text.length < minInitialChars) return;
      if (sending) return;

      sending = true;
      try {
        const sent = await ctx.reply(text + ' ' + STREAM_CURSOR, { parse_mode: 'HTML' })
          .catch(() => null);
        msgId = sent?.message_id ?? null;
        lastSentText = text;
        lastEditTime = Date.now();
      } finally {
        sending = false;
      }
      return;
    }

    editInFlight = true;
    try {
      await ctx.api.editMessageText(chatId, msgId, text + ' ' + STREAM_CURSOR, { parse_mode: 'HTML' });
      lastSentText = text;
      lastEditTime = Date.now();
    } catch (err) {
      handleRetryAfter(err);
      // Non-429 errors silently dropped — losing a streaming frame is acceptable.
    } finally {
      editInFlight = false;
    }
  };

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => { flush().catch(() => {}); }, editIntervalMs);
    },
    update(renderedHtml: string) {
      if (finished) return;
      pendingText = renderedHtml;
    },
    hasMessage: () => msgId !== null,
    messageId: () => msgId,
    async finalize(finalHtml: string): Promise<number | null> {
      finished = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // Wait for any in-flight edit to settle so we don't race with the final
      // editMessageText call. Bounded wait — a pathological hung HTTP request
      // must not hold the user-facing handler indefinitely. After the timeout
      // we proceed with the final edit anyway: at worst Telegram will reject
      // it (race) and the previous frame remains visible.
      const FINALIZE_WAIT_TIMEOUT_MS = 5000;
      const FINALIZE_WAIT_INTERVAL_MS = 50;
      let waited = 0;
      while ((editInFlight || sending) && waited < FINALIZE_WAIT_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, FINALIZE_WAIT_INTERVAL_MS));
        waited += FINALIZE_WAIT_INTERVAL_MS;
      }
      if (msgId === null) return null;
      if (!finalHtml.trim()) return msgId;
      const id = msgId;
      // Attempt the final edit even when editPaused is set: by the time we
      // reach finalize, the original 429 retry-after may have already lapsed
      // on Telegram's side. If the call still 429s, we just keep the previous
      // frame (which carries the cursor — known minor visual quirk that's
      // strictly better than skipping the attempt entirely).
      try {
        await ctx.api.editMessageText(chatId, id, finalHtml, { parse_mode: 'HTML' });
      } catch {
        // Final edit failure is tolerated — the previous in-flight content
        // remains visible. The caller may still send overflow chunks.
      }
      return id;
    },
    async drain(): Promise<void> {
      // Same primitive finalize() uses: stop the timer first so no NEW edits
      // are scheduled, then wait for any in-flight call to settle. The bound
      // matches finalize() — a pathological hung HTTP request must not block
      // the caller indefinitely.
      finished = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      const DRAIN_WAIT_TIMEOUT_MS = 5000;
      const DRAIN_WAIT_INTERVAL_MS = 50;
      let waited = 0;
      while ((editInFlight || sending) && waited < DRAIN_WAIT_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, DRAIN_WAIT_INTERVAL_MS));
        waited += DRAIN_WAIT_INTERVAL_MS;
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
