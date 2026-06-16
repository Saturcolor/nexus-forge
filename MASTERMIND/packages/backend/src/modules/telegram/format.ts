/**
 * Telegram HTML formatting utilities.
 * Converts LLM markdown output (CommonMark/GFM) to Telegram HTML parse_mode format.
 * No external dependencies — regex-based, handles the most common LLM output patterns.
 *
 * Telegram HTML supports: <b> <i> <u> <s> <code> <pre> <a href> <blockquote> <tg-spoiler>
 * Telegram does NOT support tables — they are rendered as <pre> ASCII blocks.
 */

import { replaceLatexSymbols } from '../../utils/latexToUnicode.js';

/** Escape HTML special characters in plain text segments. */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert a markdown string (as produced by an LLM) to Telegram HTML.
 * Safe to call on partial/incomplete markdown (e.g. during streaming) —
 * incomplete constructs are left as plain escaped text rather than generating
 * broken HTML tags.
 */
export function mdToTelegramHtml(text: string): string {
  const blocks: string[] = [];

  // Helper: push a pre-built HTML block and return its placeholder
  const placeholder = (html: string): string => {
    const idx = blocks.length;
    blocks.push(html);
    return `\x00${idx}\x00`;
  };

  let out = text;

  // 0. Replace simple LaTeX symbol commands with Unicode equivalents
  out = replaceLatexSymbols(out);

  // 1. Fenced code blocks: ```lang\ncode\n```  →  <pre><code>code</code></pre>
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code: string) =>
    placeholder(`<pre><code>${escHtml(code.replace(/^\n+|\n+$/g, ''))}</code></pre>`),
  );

  // 2. Inline code: `code`  →  <code>code</code>
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    placeholder(`<code>${escHtml(code)}</code>`),
  );

  // 3. Markdown tables: one or more lines of |...|  →  <pre>ASCII table</pre>
  //    Matches header + separator + body rows as a block.
  out = out.replace(/((?:\|[^\n]+\|\n?)+)/g, (table) => {
    // Only treat as a table if there's a separator row (|---|)
    if (!/\|[-: ]+\|/.test(table)) return table;
    return placeholder(`<pre>${escHtml(table.trim())}</pre>`);
  });

  // 4. Escape HTML special chars in remaining (non-code) text
  out = escHtml(out);

  // 5. Bold + italic combined: ***text***  →  <b><i>text</i></b>
  out = out.replace(/\*\*\*(.+?)\*\*\*/gs, '<b><i>$1</i></b>');

  // 6. Bold: **text**  →  <b>text</b>
  out = out.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');

  // 7. Italic: *text* (not adjacent to other * or word chars)
  out = out.replace(/(?<![*\w])\*(?!\s)([\s\S]+?)(?<!\s)\*(?![*\w])/g, '<i>$1</i>');

  // 8. Italic: _text_ (word boundaries, single line)
  out = out.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '<i>$1</i>');

  // 9. Strikethrough: ~~text~~  →  <s>text</s>
  out = out.replace(/~~(.+?)~~/gs, '<s>$1</s>');

  // 10. Headings: ## Title  →  <b>Title</b>
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 11. Blockquotes: > text  →  <blockquote>text</blockquote>
  //     Note: '>' was already escaped to '&gt;' in step 4
  out = out.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

  // 12. Links: [text](url)  →  <a href="url">text</a>  (http/https only)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // 13. Restore code/table placeholders
  out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => blocks[Number(i)]);

  return out;
}

/**
 * Convert a tool-call summary line to Telegram HTML.
 * Tool lines use backtick notation: 🔧 `bash` `ls -la` (123ms)
 * Backtick spans become <code>, the rest is HTML-escaped.
 */
export function toolLineToHtml(line: string): string {
  // Split on backtick-delimited spans, convert each part
  const parts = line.split(/(`[^`]+`)/);
  return parts
    .map((p) => {
      if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
        return `<code>${escHtml(p.slice(1, -1))}</code>`;
      }
      return escHtml(p);
    })
    .join('');
}
