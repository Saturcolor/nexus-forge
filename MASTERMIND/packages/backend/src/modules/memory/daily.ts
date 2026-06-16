import fs from 'node:fs/promises';
import path from 'node:path';

export class DailyMemory {
  private dailyDir: string;

  constructor(sharedDir: string) {
    this.dailyDir = path.join(sharedDir, 'daily');
    console.log(`[daily-memory] init dir=${this.dailyDir}`);
  }

  /**
   * Read the last N days of consolidated daily summaries.
   *
   * When `agentId` is provided, only THIS agent's own section is extracted from each day's
   * consolidated file (the file aggregates every agent under `### <Name> (<agentId>)` headers).
   * Keeps the injected `# Recent Context` scoped to the agent's own activity — no cross-agent
   * digest. Days where the agent produced no summary contribute nothing. When omitted, the full
   * consolidated file is returned (legacy / dashboard use).
   */
  async readRecent(days: number = 2, agentId?: string): Promise<string | null> {
    const startedAt = Date.now();
    console.debug(`[daily-memory] readRecent start days=${days} agent=${agentId ?? '∅'}`);
    const today = new Date();
    const parts: string[] = [];

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      // Try consolidated directory first
      const consolidatedPath = path.join(this.dailyDir, 'consolidated', `consolidated-${dateStr}.md`);
      // Then try date-scoped directory
      const dateScopedPath = path.join(this.dailyDir, dateStr, `consolidated-${dateStr}.md`);

      let content: string | null = null;
      try {
        content = await fs.readFile(consolidatedPath, 'utf-8');
        console.debug(`[daily-memory] readRecent hit consolidated date=${dateStr} chars=${content.length}`);
      } catch (err1) {
        console.debug(`[daily-memory] readRecent miss consolidated date=${dateStr}: ${err1 instanceof Error ? err1.message : err1}`);
        try {
          content = await fs.readFile(dateScopedPath, 'utf-8');
          console.debug(`[daily-memory] readRecent hit scoped date=${dateStr} chars=${content.length}`);
        } catch (err2) {
          console.debug(`[daily-memory] readRecent miss scoped date=${dateStr}: ${err2 instanceof Error ? err2.message : err2}`);
          // No consolidation for this date
        }
      }

      if (content) {
        const scoped = agentId ? DailyMemory.extractAgentSection(content, agentId) : content;
        if (scoped) {
          parts.push(`### ${dateStr}\n${scoped}`);
        } else if (agentId) {
          console.debug(`[daily-memory] readRecent date=${dateStr} no own section for agent=${agentId} — skipped`);
        }
      }
    }

    const result = parts.length > 0 ? parts.join('\n\n') : null;
    console.debug(`[daily-memory] readRecent done days=${days} hits=${parts.length} chars=${result?.length ?? 0} ms=${Date.now() - startedAt}`);
    return result;
  }

  /**
   * Extract a single agent's section from a consolidated daily file. Sections are written by
   * the consolidation module as `### <Name> (<agentId>)\n\n<summary>`, keyed off the stable
   * agentId. Returns the section (header + body) trimmed, or null if this agent has none.
   * Mirrors the section regex in modules/consolidation/index.ts (single match — re-consolidation
   * dedups so there is at most one section per agent per file).
   */
  private static extractAgentSection(content: string, agentId: string): string | null {
    const escapedId = agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRe = new RegExp(
      `^### .*\\(${escapedId}\\)\\s*$[\\s\\S]*?(?=\\n^### .*\\([^)]+\\)\\s*$|$(?![\\s\\S]))`,
      'm',
    );
    const m = content.match(sectionRe);
    return m ? m[0].trim() : null;
  }
}
