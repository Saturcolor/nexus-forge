// Slim Bootstrap Hook
// Trims AGENTS.md, BOOTSTRAP.md, and MEMORY.md to reduce prompt token weight.
// Strategy: section-based stripping (removes known boilerplate), not hardcoded replacement.
// Custom content (tools, project notes, agent-specific rules) is preserved.

type BootstrapFile = {
  name: string;
  content?: string;
  missing?: boolean;
  [key: string]: unknown;
};

// Section titles (partial match) that are pure generic boilerplate — safe to remove from any AGENTS.md
const AGENTS_SKIP_SECTIONS: string[] = [
  "Group Chats",
  "Know When to Speak",
  "React Like a Human",
  "Make It Yours",
  "External vs Internal", // duplicates Safety section
  "Heartbeat vs Cron",    // sub-section inside Heartbeats: keep the header, drop the internals
  "Things to check",
  "When to reach out",
  "When to stay quiet",
  "Track your checks",
  "Memory Maintenance",   // verbose heartbeat memory maintenance sub-section
];

// What to inject at the end of the trimmed AGENTS.md (compact reminders for stripped sections)
const AGENTS_COMPACT_FOOTER = `
## Reminders (stripped)
- Group chats: don't share private context | quality > quantity | one response
- Heartbeats: batch checks, respect quiet hours (23h-8h), use cron for exact timing
- Memory search: use \`memory_search\` — don't scan files manually
`;

/**
 * Strip known boilerplate sections from AGENTS.md while preserving custom content.
 * Sections are identified by their markdown header (## / ###) matching AGENTS_SKIP_SECTIONS.
 */
function slimAgentsMd(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let skipDepth: number | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,4})\s+(.*)/);

    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2];

      // If we were skipping and hit a section at same or higher level → stop skipping
      if (skipDepth !== null && level <= skipDepth) {
        skipDepth = null;
      }

      // Check if this section should be skipped
      const shouldSkip = AGENTS_SKIP_SECTIONS.some((s) =>
        title.includes(s)
      );
      if (shouldSkip) {
        skipDepth = level;
        continue;
      }
    }

    if (skipDepth !== null) continue;
    result.push(line);
  }

  // Clean up excessive blank lines and append compact footer
  const trimmed = result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return trimmed + AGENTS_COMPACT_FOOTER;
}

/**
 * Slim BOOTSTRAP.md down to its essential identity block + HARDRULE pointer.
 * Keeps "🎯 Rappel" / identity section and any critical one-liner reminders.
 * Drops: verbose structure trees, duplicated step-by-step that AGENTS.md already covers.
 */
function slimBootstrapMd(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];

  // Keep the HARDRULE pointer if present
  const hardruleLine = lines.find(
    (l) => l.includes("HARDRULE") && (l.startsWith(">") || l.startsWith("-") || l.startsWith("*"))
  );
  if (hardruleLine) {
    result.push(hardruleLine);
    result.push("");
  }

  // Keep only the agent identity block (🎯 section or similar) — skip everything else
  let inIdentity = false;
  let identityDepth: number | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,4})\s+(.*)/);

    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2];

      // Detect identity/recap section
      if (
        title.includes("Rappel") ||
        title.includes("Agent") ||
        title.includes("Identity") ||
        title.includes("Persona") ||
        title.includes("🎯")
      ) {
        inIdentity = true;
        identityDepth = level;
        result.push(line);
        continue;
      }

      // Stop identity section if we hit same/higher level header
      if (inIdentity && identityDepth !== null && level <= identityDepth) {
        inIdentity = false;
        identityDepth = null;
      }
    }

    if (inIdentity) {
      result.push(line);
    }
  }

  const slimmed = result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return slimmed.length > 50 ? slimmed : content; // fallback: return original if we couldn't parse it
}

/**
 * Cap MEMORY.md at maxChars by keeping head + tail with a truncation notice in the middle.
 * Recent entries (tail) are more valuable so we keep more of them.
 */
function slimMemoryMd(content: string, maxChars = 3500): string {
  if (content.length <= maxChars) return content;

  const headChars = Math.floor(maxChars * 0.35); // 35% head (headers, old important facts)
  const tailChars = Math.floor(maxChars * 0.65); // 65% tail (recent entries)

  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);

  const omitted = content.length - headChars - tailChars;
  const notice = `\n\n[...~${Math.round(omitted / 4)} tokens omitted by slim-bootstrap — use \`memory_search\` for full history...]\n\n`;

  return head + notice + tail;
}

const handler = async (event: {
  type: string;
  action: string;
  context: Record<string, unknown>;
}) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const ctx = event.context;
  if (!Array.isArray(ctx.bootstrapFiles)) return;

  ctx.bootstrapFiles = (ctx.bootstrapFiles as BootstrapFile[]).map((file) => {
    if (file.missing || !file.content) return file;

    switch (file.name) {
      case "AGENTS.md":
        return { ...file, content: slimAgentsMd(file.content) };

      case "BOOTSTRAP.md":
        return { ...file, content: slimBootstrapMd(file.content) };

      case "MEMORY.md":
      case "memory.md":
        return { ...file, content: slimMemoryMd(file.content) };

      default:
        return file;
    }
  });
};

export default handler;
