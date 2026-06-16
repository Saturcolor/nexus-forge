import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../modules/agent/index.js';
import type { MemoryModule } from '../modules/memory/index.js';
import type { ConfigModule } from '../modules/config/index.js';
import type { SkillActionsModule } from '../modules/skill-actions/index.js';
import type { SchedulerModule } from '../modules/scheduler/index.js';
import type { BoardModule } from '../modules/board/index.js';
import type { MemoryStoreModule } from '../modules/memory-store/index.js';
import { buildSystemPrompt, resolveEnvironmentPaths } from '../modules/agent/prompt.js';
import { buildCodebaseSearchToolNote } from '../modules/codebase-search/promptNote.js';
import { resolveCodebaseSearchDbPaths } from '../modules/codebase-search/paths.js';
import { getAllTools, makeLazySkillStub } from '../modules/agent/tools/index.js';
import type { PromptTemplatesModule } from '../modules/prompt-templates/index.js';
import {
  DEFAULT_LAZY_SKILLS_SUMMARY_STUB as LAZY_STUB,
  DEFAULT_LAZY_SKILLS_SUMMARY_WILDCARD as LAZY_WC,
} from '../modules/prompt-templates/defaults.js';

/**
 * Byte-identical inter-agent prefix cache analysis.
 *
 * Builds the full tokenisable blob (tools JSON + system prompt) for every enabled agent,
 * then reports per-pair longest common prefix length and the section the divergence lands in.
 * Used to verify the prompt-cache optimisation: after the unification work, `firstDivergenceSection`
 * should be `agent-identity` (or later) for agents with aligned config.
 */
export function debugRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  // GET /api/debug/prompt-cache
  // Returns:
  //   { agents: [{ id, totalChars, ..., sections }],
  //     matrix: [{ a, b, commonChars, commonTokensEst, firstDivergenceSection }] }
  app.get('/prompt-cache', async (c) => {
    const startedAt = Date.now();
    const agentMod = ctx.modules.get<AgentModule>('agent');
    const memoryMod = ctx.modules.get<MemoryModule>('memory');
    const configMod = ctx.modules.get<ConfigModule>('config');
    const skillActionsMod = ctx.modules.tryGet<SkillActionsModule>('skill-actions');
    const schedulerMod = ctx.modules.tryGet<SchedulerModule>('scheduler');
    const boardMod = ctx.modules.tryGet<BoardModule>('board');
    const memoryStoreMod = ctx.modules.tryGet<MemoryStoreModule>('memory-store');
    const templatesMod = ctx.modules.tryGet<PromptTemplatesModule>('prompt-templates');

    const agentsList = agentMod.listAgents().filter(a => a.enabled !== false);
    console.log(`[route:debug] prompt-cache start agents=${agentsList.length}`);
    if (agentsList.length === 0) {
      console.debug('[route:debug] prompt-cache no enabled agents');
      return c.json({ agents: [], matrix: [] });
    }

    const braveApiKey = ctx.config.search?.braveApiKey;
    const resolvePath = (p: string) => configMod.resolvePath(p);

    // Global flag: exposed in unified tools if at least one agent has an index.
    const codebaseSearchEverAvailable = agentsList.some(a =>
      resolveCodebaseSearchDbPaths(ctx.config, resolvePath, a.identity.id).length > 0
    );

    // Separator between tools JSON and system prompt in the full blob. Arbitrary — just needs
    // to be the same for every agent so LCP is comparable.
    const TOOLS_HEADER = '\n---[SYSTEM]---\n';
    // Section separator used by buildSystemPrompt (parts.join).
    const SECTION_SEP = '\n\n---\n\n';

    const reports = await Promise.all(agentsList.map(async (agent) => {
      const id = agent.identity.id;
      console.debug(`[route:debug] prompt-cache build agent=${id}`);
      const environmentPaths = resolveEnvironmentPaths(
        configMod,
        ctx.config.paths,
        agent,
        id,
        memoryMod.shared.dir,
      );
      const codebaseSearchToolNote = buildCodebaseSearchToolNote(
        ctx.config,
        resolvePath,
        agent,
        id,
      );
      const build = await buildSystemPrompt(memoryMod, {
        agentConfig: agent,
        sessionId: `${id}-debug-prompt-cache`,
        isMainSession: true,
        environmentPaths,
        codebaseSearchToolNote,
        memoryStoreEnabled: memoryStoreMod?.isEnabled,
        schedulerAvailable: !!schedulerMod,
        agentsList,
        templatesMod,
      });

      // Mirror buildLlmPayload's per-agent toggle logic so the analyzer shows the REAL
      // prefix that gets streamed at runtime, not a fictional unified one. Agents that
      // bypass and/or use lazySkills will appear here as different prefixes from the
      // others — that's exactly the cache-divergence signal we want to surface.
      const bypassUnified = agent.bypassUnifiedCache === true;
      const lazySkills = agent.lazySkills === true;
      const skillCallMode: 'stub' | 'wildcard' = agent.skillCallMode ?? 'stub';
      const wildcardSkillsActive = lazySkills && skillCallMode === 'wildcard';
      const allSkillDefs = skillActionsMod?.isActive ? skillActionsMod.getToolDefinitions() : [];
      const bypassStarredFilter = bypassUnified
        ? (agent.promptInjection?.starredSkills ?? [])
        : null;

      let skillDefsForPrompt: typeof allSkillDefs;
      if (lazySkills && skillActionsMod?.isActive) {
        let baseDefs = allSkillDefs;
        if (bypassUnified) {
          baseDefs = (bypassStarredFilter && bypassStarredFilter.length > 0)
            ? skillActionsMod.getToolDefinitionsForSkills(bypassStarredFilter)
            : [];
        }
        // Wildcard mode: no skill stubs emitted in the prefix; the divergence analyzer
        // sees ONLY inspect_skill + call_skill_action for this agent's skills, which is
        // the desired signal (huge prefix shift from stub-mode peers).
        skillDefsForPrompt = wildcardSkillsActive
          ? []
          : baseDefs.map(def => makeLazySkillStub(def.name));
      } else if (bypassUnified && skillActionsMod?.isActive) {
        skillDefsForPrompt = (bypassStarredFilter && bypassStarredFilter.length > 0)
          ? skillActionsMod.getToolDefinitionsForSkills(bypassStarredFilter)
          : [];
      } else {
        skillDefsForPrompt = allSkillDefs;
      }

      let tools = getAllTools({
        braveApiKey,
        codebaseSearchEverAvailable,
        // For inter-agent comparison we want a consistent shape — these flags are global anyway.
        reasoningAvailable: false,
        memorySearchAvailable: memoryStoreMod?.isEnabled,
        skillActions: skillDefsForPrompt,
        schedulerAvailable: !!schedulerMod,
        boardAvailable: !!boardMod,
        lazySkillsActive: lazySkills && !!skillActionsMod?.isActive,
        wildcardSkillsActive,
      });
      if (bypassUnified) {
        const disabledNames = new Set(agent.tools?.disabled ?? []);
        if (disabledNames.size > 0) {
          tools = tools.filter(t => !disabledNames.has(t.name));
        }
      }

      // Append the lazy summary block to the prompt so its bytes are accounted for in the
      // analyzer (~50 tok per skill). Mirrors run.ts exactly: respects wildcard mode AND
      // uses the templates module so the analyzer reflects the operator's overrides
      // (audit V3 bug #2: this block was inline stub-only, faussant l'analyse en wildcard).
      let promptForAnalysis = build.prompt;
      if (lazySkills && skillActionsMod?.isActive) {
        const summaries = bypassStarredFilter === null
          ? skillActionsMod.getSkillSummaries()
          : skillActionsMod.getSkillSummaries(bypassStarredFilter);
        if (summaries.length === 0) {
          const reason = bypassStarredFilter !== null && bypassStarredFilter.length === 0
            ? ' / bypass mode + zero starred skills'
            : '';
          promptForAnalysis += `\n\n## Available skills (lazy mode)\n(none — no skills loaded${reason}.)\n`;
        } else {
          const skillsList = summaries.map(s => {
            const actionList = s.actions.map(a => a.id).join(', ');
            const desc = s.skillDescription ? ` — ${s.skillDescription}` : '';
            return `- **${s.skillEmoji ? s.skillEmoji + ' ' : ''}${s.skillName}** (id: \`${s.skillDir}\`)${desc}. ${s.actions.length} action(s): ${actionList}`;
          }).join('\n');
          const tplKey = wildcardSkillsActive ? 'lazy-skills-summary.wildcard' : 'lazy-skills-summary.stub';
          const body = templatesMod ? templatesMod.render(tplKey, { skillsList }) : (
            wildcardSkillsActive ? LAZY_WC.replace(/\{\{skillsList\}\}/g, skillsList) : LAZY_STUB.replace(/\{\{skillsList\}\}/g, skillsList)
          );
          promptForAnalysis += `\n\n${body}\n`;
        }
      }

      const toolsJson = JSON.stringify(tools);
      const fullText = toolsJson + TOOLS_HEADER + promptForAnalysis;
      console.debug(`[route:debug] prompt-cache built agent=${id} tools=${tools.length} toolsLen=${toolsJson.length} promptLen=${promptForAnalysis.length} bypass=${bypassUnified} lazy=${lazySkills}`);
      return {
        id,
        fullText,
        toolsLen: toolsJson.length,
        systemLen: promptForAnalysis.length,
        sections: build.sections,
      };
    }));

    /** Build labelled char-offset boundaries inside an agent's fullText. */
    function sectionBoundaries(r: typeof reports[number]): Array<{ section: string; end: number }> {
      const out: Array<{ section: string; end: number }> = [];
      out.push({ section: 'tools', end: r.toolsLen });
      let cursor = r.toolsLen + TOOLS_HEADER.length;
      for (let i = 0; i < r.sections.length; i++) {
        const sec = r.sections[i];
        cursor += sec.chars;
        out.push({ section: sec.key, end: cursor });
        if (i < r.sections.length - 1) cursor += SECTION_SEP.length;
      }
      return out;
    }

    function sectionAt(offset: number, bounds: ReturnType<typeof sectionBoundaries>): string {
      for (const b of bounds) {
        if (offset < b.end) return b.section;
      }
      return '(identical to end)';
    }

    function lcp(a: string, b: string): number {
      const max = Math.min(a.length, b.length);
      let i = 0;
      while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
      return i;
    }

    const agents = reports.map(r => ({
      id: r.id,
      totalChars: r.fullText.length,
      totalTokensEst: Math.round(r.fullText.length / 4),
      toolsChars: r.toolsLen,
      systemPromptChars: r.systemLen,
      sections: r.sections.map(s => ({ key: s.key, chars: s.chars, tokens: s.estimatedTokens })),
    }));

    const matrix: Array<{
      a: string;
      b: string;
      commonChars: number;
      commonTokensEst: number;
      firstDivergenceSection: string;
    }> = [];
    for (let i = 0; i < reports.length; i++) {
      const boundsA = sectionBoundaries(reports[i]);
      for (let j = i + 1; j < reports.length; j++) {
        const common = lcp(reports[i].fullText, reports[j].fullText);
        matrix.push({
          a: reports[i].id,
          b: reports[j].id,
          commonChars: common,
          commonTokensEst: Math.round(common / 4),
          firstDivergenceSection: sectionAt(common, boundsA),
        });
      }
    }

    console.log(`[route:debug] prompt-cache done agents=${agents.length} pairs=${matrix.length} ms=${Date.now() - startedAt}`);
    return c.json({ agents, matrix });
  });

  return app;
}
