/**
 * Repair malformed tool-call argument JSON before it gets silently dropped.
 *
 * Local models (Qwen3.x / Gemma via llama.cpp) routinely emit *almost*-valid JSON in
 * `tool_calls[].function.arguments`: trailing commas, a literal tab/newline inside a string,
 * an unclosed brace when the completion is truncated. The previous behaviour was
 * `JSON.parse(args) catch → {}` at four call sites — a SILENT drop: the agent then calls the
 * tool with empty args, gets a cryptic error, and nothing is logged. This module is the repair
 * layer.
 *
 * `repairToolCallArguments` is ONLY reached after a strict parse already failed, so every
 * transformation here can only improve on the old `→ {}` behaviour. Passes (each followed by a
 * parse attempt), cheapest first:
 *   1. strict parse (fast path — no-op for well-formed args)
 *   2. strip trailing commas before `}` / `]`
 *   3. escape stray control chars (0x00-0x1F) inside quoted strings
 *   4. close unbalanced `{` / `[` (and a dangling string), bounded
 *   5. give up → `{}` BUT log a WARN with the tool name + snippet (kills the silent drop)
 */

/** Parse `s`; return the object only if it is a non-array object (tool args are always a map). */
function tryParseObject(s: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Escape control chars that appear *inside* a JSON string (literal newline/tab/etc). */
function escapeControlCharsInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    if (inStr) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (code < 0x20) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/**
 * Remove trailing commas before `}`/`]` — but ONLY outside string literals. A naive
 * `replace(/,(\s*[}\]])/g, '$1')` would corrupt a string VALUE that legitimately contains the
 * sequence `,}` or `,]` (e.g. a bash command `grep 'foo,}'`). Uses the same inStr/escaped state
 * machine as the other passes so only structural commas are dropped.
 */
function stripTrailingCommas(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      out += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (j < s.length && (s[j] === '}' || s[j] === ']')) continue; // structural trailing comma → drop
    }
    out += ch;
  }
  return out;
}

/** Close any unterminated string + unbalanced `{`/`[` (truncated completions). Bounded to 50. */
function closeUnbalanced(s: string): string {
  let inStr = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  // Truncated mid-escape (string ended on a lone backslash): drop the bogus backslash, else the
  // closing quote we append becomes an escaped quote `\"` and the string stays open.
  if (inStr && escaped) out = out.slice(0, -1);
  if (inStr) out += '"';
  let closers = 0;
  while (stack.length && closers < 50) { out += stack.pop(); closers++; }
  return out;
}

function snippet(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
}

function warnRepaired(pass: string, toolName: string | undefined, raw: string): void {
  console.warn(`[provider] tool-call args repaired (${pass})${toolName ? ` for "${toolName}"` : ''}: ${snippet(raw)}`);
}

/**
 * Best-effort parse of a tool-call `arguments` string. Always returns an object — never throws.
 * @param raw the raw `arguments` value from the provider (string, or already-parsed object).
 * @param toolName the tool name, for logging only.
 */
export function repairToolCallArguments(raw: unknown, toolName?: string): Record<string, unknown> {
  if (raw == null) return {};
  // Defensive: some providers hand back an already-parsed object.
  if (typeof raw === 'object') {
    return Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
  }
  const str = String(raw);
  const trimmed = str.trim();
  if (!trimmed) return {};

  // 1. fast path — well-formed args incur exactly one JSON.parse, no overhead.
  const direct = tryParseObject(trimmed);
  if (direct !== undefined) return direct;

  // 2. trailing commas (string-context-aware — never touches commas inside string values)
  let candidate = stripTrailingCommas(trimmed);
  let r = tryParseObject(candidate);
  if (r !== undefined) { warnRepaired('trailing-comma', toolName, str); return r; }

  // 3. control chars inside strings
  candidate = escapeControlCharsInStrings(candidate);
  r = tryParseObject(candidate);
  if (r !== undefined) { warnRepaired('control-chars', toolName, str); return r; }

  // 4. unbalanced brackets / dangling string (truncation)
  candidate = closeUnbalanced(candidate);
  r = tryParseObject(candidate);
  if (r !== undefined) { warnRepaired('unbalanced', toolName, str); return r; }

  // 5. give up — but never silently. Distinguish "valid JSON but not an object" (an array/scalar
  //    a cloud passthrough could relay) from genuinely malformed JSON, so the WARN isn't lying.
  try {
    const v: unknown = JSON.parse(trimmed);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      console.warn(`[provider] tool-call args${toolName ? ` for "${toolName}"` : ''} are valid JSON but not an object (${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v}) — using {}`);
      return {};
    }
  } catch { /* truly malformed — fall through to the UNPARSEABLE warn */ }
  console.warn(`[provider] tool-call args UNPARSEABLE${toolName ? ` for "${toolName}"` : ''} — using {}. snippet: ${snippet(str)}`);
  return {};
}
