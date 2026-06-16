import type { ToolCall } from '@mastermind/shared';

/**
 * Fallback parser for models that emit tool calls as text instead of structured delta.tool_calls.
 *
 * Handles two common formats:
 *
 * 1. Hermes JSON (Nous-Hermes, Qwen3 hermes-style):
 *    <tool_call>
 *    {"name": "bash", "arguments": {"cmd": "ls"}}
 *    </tool_call>
 *
 * 2. Custom XML parameter format:
 *    <tool_call><function=bash><parameter=cmd>ls</parameter></function></tool_call>
 */
export function parseTextToolCalls(text: string): ToolCall[] {
  console.debug(`[parseTextToolCalls] attempting text-based tool call extraction from ${text.length} chars`);
  const results: ToolCall[] = [];
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(text)) !== null) {
    const inner = match[1].trim();
    const id = `tc-text-${idx++}`;

    // --- Format 1: Hermes JSON ---
    // {"name": "bash", "arguments": {"cmd": "..."}}
    // Some models use "parameters" instead of "arguments"
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown>;
      if (typeof parsed['name'] === 'string') {
        const args =
          (parsed['arguments'] as Record<string, unknown> | undefined) ??
          (parsed['parameters'] as Record<string, unknown> | undefined) ??
          {};
        results.push({ id, name: parsed['name'], arguments: args });
        continue;
      }
    } catch { /* not JSON, try XML format below */ }

    // --- Format 2: Custom XML parameters ---
    // <function=skill_mycalendar_update-event><parameter=event_id>...</parameter></function>
    // NB: tool/param names may contain hyphens and dots (skill_<app>_<verb-object>),
    // so \w+ (stops at hyphen) missed every hyphenated skill call → use [\w.-] instead.
    const funcMatch = inner.match(/^<function=([\w.-]+)>([\s\S]*?)<\/function>$/s);
    if (funcMatch) {
      const name = funcMatch[1];
      const paramsStr = funcMatch[2];
      const args: Record<string, string> = {};
      const paramRegex = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/gs;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
        args[paramMatch[1]] = paramMatch[2].trim();
      }
      results.push({ id, name, arguments: args });
    }
  }

  return results;
}

/**
 * Remove <tool_call>...</tool_call> blocks from text so they don't appear in the final response.
 */
export function stripToolCallBlocks(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}
