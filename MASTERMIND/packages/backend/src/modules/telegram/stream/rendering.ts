/**
 * Visual rendering helpers for the streaming agent message:
 * - The pulsing cursor "▋" appended during streaming
 * - The compact tool-call footer (🔧 N · `name1`, `name2`)
 * - A tool accumulator that tracks the count and unique names seen so far
 */

import { escHtml } from '../format.js';

/** Cursor character appended to every in-progress edit, removed on finalize. */
export const STREAM_CURSOR = '▋';

export type ToolEvent = {
  type: 'start' | 'done';
  name: string;
  args: Record<string, unknown>;
  output?: string;
  durationMs?: number;
  error?: string;
};

export type ToolAccumulator = {
  handler: ((event: ToolEvent) => void) | undefined;
  getCount: () => number;
  getNames: () => string[];
};

export function makeToolAccumulator(showToolEvents: boolean): ToolAccumulator {
  let count = 0;
  const names: string[] = [];
  const handler: ToolAccumulator['handler'] = showToolEvents
    ? (event) => {
        if (event.type !== 'done') return;
        count++;
        if (!names.includes(event.name)) names.push(event.name);
      }
    : undefined;
  return { handler, getCount: () => count, getNames: () => names };
}

/**
 * Compact human-readable thinking duration: `850ms`, `2.3s`, `12s`, `1m05s`.
 * Used by the footer chip to surface how long the model spent inside <think>.
 */
export function formatThinkMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000).toString().padStart(2, '0');
  return `${mins}m${secs}s`;
}

/**
 * Append a compact tool-call (and optional thinking-time) footer to an HTML answer.
 * Used during streaming (preview) and for the final message. `thinkMs` is only
 * meant for the *final* render — passing it during the live preview would make the
 * chip flicker every flush tick. Returns the answer alone when there is nothing
 * to footer.
 */
export function buildMessageWithToolFooter(
  htmlAnswer: string,
  toolCount: number,
  toolNames: string[],
  thinkMs: number = 0,
): string {
  const parts: string[] = [];
  if (toolCount > 0) {
    const displayNames = toolNames.slice(0, 5).map(n => `<code>${escHtml(n)}</code>`).join(', ');
    const overflow = toolNames.length > 5 ? ` +${toolNames.length - 5}` : '';
    parts.push(`🔧 ${toolCount} outil${toolCount > 1 ? 's' : ''} · ${displayNames}${overflow}`);
  }
  if (thinkMs > 0) {
    parts.push(`💭 ${formatThinkMs(thinkMs)}`);
  }
  if (parts.length === 0) return htmlAnswer;
  const footer = `<i>${parts.join(' · ')}</i>`;
  return htmlAnswer.trim() ? `${htmlAnswer}\n\n${footer}` : footer;
}
