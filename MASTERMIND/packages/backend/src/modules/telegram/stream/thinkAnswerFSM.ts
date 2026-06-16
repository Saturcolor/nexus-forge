/**
 * <think>...</think> / answer state machine for streaming chunks.
 *
 * Routes incoming chunks into either a "currently displayed think" buffer
 * (live reasoning) or an accumulating "answer" buffer. Handles tag boundaries
 * that fall across chunk boundaries (the classic split-tag pitfall) by retaining
 * a small `chunkOverflow` between calls.
 *
 * Semantics:
 *   - Multiple <think>...</think> blocks per response are supported (interleaved
 *     reasoning) — every closed think block is dropped from the live display
 *     once </think> arrives. Only the *current* open think block is shown live.
 *   - Text outside think blocks accumulates into `answerContent`.
 *   - When a new chunk arrives mid-tag (e.g. it ends with "<thi"), we hold the
 *     last few bytes back as `chunkOverflow` and resume on the next chunk.
 *
 * This is a near-verbatim factoring of the FSM from the original bridge.ts text
 * stream handler, generalised for both single-think and multi-think variants.
 */

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const DEFAULT_BUFFER_CAP = 20_000;

export type ThinkAnswerFSM = {
  /** Push a raw chunk through the FSM. */
  pushChunk: (chunk: string) => void;
  /** Whether the FSM is currently inside a <think> block. */
  isInThink: () => boolean;
  /** Live content of the currently-open think block (cleared on </think>). */
  getCurrentThink: () => string;
  /** Accumulated answer text (everything outside think blocks). */
  getAnswer: () => string;
  /** Raw concatenation of every chunk seen, capped at bufferCap. */
  getRawBuffer: () => string;
  /** ms timestamp when the current <think> block opened, or null when not in a think block. */
  getCurrentThinkStartedAt: () => number | null;
  /**
   * Total elapsed time (ms) spent inside <think> blocks. Sums all closed blocks plus,
   * if currently inside a block, the elapsed time since it opened.
   */
  getThinkTotalMs: () => number;
};

export function createThinkAnswerFSM(bufferCap: number = DEFAULT_BUFFER_CAP): ThinkAnswerFSM {
  let inThinkBlock = false;
  let currentThinkContent = '';
  let answerContent = '';
  let chunkOverflow = '';
  let fullBuffer = '';
  // Timing — accumulator across all closed blocks + the currently-open one.
  let thinkStartedAt: number | null = null;
  let thinkTotalMs = 0;

  const pushChunk = (chunk: string): void => {
    if (fullBuffer.length < bufferCap) fullBuffer += chunk;

    let scan = chunkOverflow + chunk;
    chunkOverflow = '';

    while (scan.length > 0) {
      if (inThinkBlock) {
        const endIdx = scan.indexOf(THINK_CLOSE);
        if (endIdx !== -1) {
          currentThinkContent += scan.slice(0, endIdx);
          inThinkBlock = false;
          if (thinkStartedAt !== null) thinkTotalMs += Date.now() - thinkStartedAt;
          thinkStartedAt = null;
          // Discard the closed think block from the live display — it was shown
          // streaming. The full reasoning is preserved in fullBuffer for any
          // post-run processing.
          currentThinkContent = '';
          scan = scan.slice(endIdx + THINK_CLOSE.length).replace(/^\s+/, '');
        } else {
          // Hold back the last (THINK_CLOSE.length - 1) chars in case the tag
          // is split across chunks — e.g. chunk ends with "</thi".
          const safe = scan.length > THINK_CLOSE.length - 1
            ? scan.slice(0, -(THINK_CLOSE.length - 1))
            : '';
          currentThinkContent += safe;
          if (currentThinkContent.length > bufferCap) {
            currentThinkContent = currentThinkContent.slice(-bufferCap);
          }
          chunkOverflow = scan.length > THINK_CLOSE.length - 1
            ? scan.slice(-(THINK_CLOSE.length - 1))
            : scan;
          scan = '';
        }
      } else {
        const startIdx = scan.indexOf(THINK_OPEN);
        if (startIdx !== -1) {
          if (answerContent.length < bufferCap) answerContent += scan.slice(0, startIdx);
          inThinkBlock = true;
          thinkStartedAt = Date.now();
          scan = scan.slice(startIdx + THINK_OPEN.length);
        } else {
          const safe = scan.length > THINK_OPEN.length - 1
            ? scan.slice(0, -(THINK_OPEN.length - 1))
            : '';
          if (answerContent.length < bufferCap) answerContent += safe;
          chunkOverflow = scan.length > THINK_OPEN.length - 1
            ? scan.slice(-(THINK_OPEN.length - 1))
            : scan;
          scan = '';
        }
      }
    }
  };

  return {
    pushChunk,
    isInThink: () => inThinkBlock,
    getCurrentThink: () => currentThinkContent,
    getAnswer: () => answerContent,
    getRawBuffer: () => fullBuffer,
    getCurrentThinkStartedAt: () => thinkStartedAt,
    getThinkTotalMs: () => thinkTotalMs + (inThinkBlock && thinkStartedAt !== null ? Date.now() - thinkStartedAt : 0),
  };
}

/**
 * Strip <tool_call>...</tool_call> blocks from a partial answer text.
 * Both closed blocks and an unclosed trailing block (still being streamed) are
 * removed — tool calls are surfaced separately via onToolCall events.
 */
export function stripToolCallBlocks(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_call>[\s\S]*$/i, '');
}

/**
 * Split a final raw response into reasoning + answer parts.
 * Used at the end of a non-streaming run to optionally surface reasoning as a
 * Telegram spoiler. Tolerates an unclosed trailing <think> block.
 */
export function splitThinkAndAnswer(text: string): { reasoning: string; answer: string } {
  const cleaned = stripToolCallBlocks(text);

  const reasoningParts: string[] = [];
  const answer = cleaned.replace(/<think>([\s\S]*?)<\/think>/gi, (_, content) => {
    reasoningParts.push((content as string).trim());
    return '';
  });
  const unclosed = answer.match(/<think>([\s\S]*)$/i);
  if (unclosed) {
    reasoningParts.push(unclosed[1].trim());
    return {
      reasoning: reasoningParts.join('\n\n'),
      answer: answer.slice(0, unclosed.index!).trim(),
    };
  }
  if (reasoningParts.length > 0) {
    return { reasoning: reasoningParts.join('\n\n'), answer: answer.trim() };
  }
  return { reasoning: '', answer: cleaned.trim() || text };
}
