/**
 * Telegram message chunking — split long messages while respecting HTML tag boundaries
 * and entity references.
 *
 * Inspired by OpenClaw's draft-chunking, simplified for our HTML-only output.
 * Always filters empty/whitespace-only chunks (prevents "phantom empty message"
 * appearing under the agent's reply).
 */

export const TELEGRAM_HARD_LIMIT = 4096;
export const TELEGRAM_SAFE_LIMIT = 4000;

/**
 * Split a Telegram-HTML string into chunks of at most `maxLen` characters.
 * Prefers splitting on:
 *   1. Newlines (paragraph breaks)
 *   2. HTML tag boundaries (avoid mid-tag splits)
 *   3. HTML entity boundaries (avoid mid-entity splits)
 * Empty / whitespace-only chunks are dropped.
 */
export function splitMessage(text: string, maxLen: number = TELEGRAM_SAFE_LIMIT): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen / 2) splitIdx = maxLen;

    const candidate = remaining.slice(0, splitIdx);
    const lastLt = candidate.lastIndexOf('<');
    const lastGt = candidate.lastIndexOf('>');
    if (lastLt > lastGt && lastLt > maxLen / 2) {
      splitIdx = lastLt;
    }

    const entityCandidate = remaining.slice(0, splitIdx);
    const lastAmp = entityCandidate.lastIndexOf('&');
    const lastSemi = entityCandidate.lastIndexOf(';');
    if (lastAmp > lastSemi && lastAmp > maxLen / 2) {
      splitIdx = lastAmp;
    }

    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  // Filter empty/whitespace-only chunks. Without this, splitMessage occasionally
  // emits a trailing empty fragment when content ends near a chunk boundary,
  // which then gets sent via ctx.reply('') and produces a visible "ghost message"
  // beneath the agent reply.
  return chunks.filter(c => c.trim().length > 0);
}
