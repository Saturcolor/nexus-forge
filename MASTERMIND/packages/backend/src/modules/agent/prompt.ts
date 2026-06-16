import path from 'node:path';
import type { AgentConfig, PathsConfig } from '@mastermind/shared';
import type { MemoryModule } from '../memory/index.js';
import type { ConfigModule } from '../config/index.js';
import type { PromptTemplatesModule } from '../prompt-templates/index.js';
import { DEFAULTS } from '../prompt-templates/defaults.js';
import { formatAgentRosterLine, formatIdentityMarkdownBullets } from './workspace.js';

/** Resolved absolute paths injected in the # Environment section of the system prompt */
export interface EnvironmentPaths {
  agentsRoot: string;
  workspace: string;
  sharedMemory: string;
  compactArchives: string;
  skillsDir?: string;
  /** Where user-uploaded chat images are dumped each turn for tool use.
   * Always resolved (defaults to `<sharedMemory>/user-images/` if config left empty). */
  userImagesDir: string;
}

/** Resolve absolute paths (agents, workspace, shared memory, compact archives, skills). */
export function resolveEnvironmentPaths(
  configMod: ConfigModule,
  paths: PathsConfig,
  agentConfig: AgentConfig,
  agentId: string,
  sharedMemoryAbsolute: string,
): EnvironmentPaths {
  const agentsRoot = configMod.resolvePath(paths.agentsDir);
  const workspace = agentConfig.workspacePath;
  const compactArchives = paths.compactArchivesDir
    ? path.join(configMod.resolvePath(paths.compactArchivesDir), agentId)
    : path.join(workspace, 'archives');
  const skillsDir = paths.skillsDir ? configMod.resolvePath(paths.skillsDir) : undefined;
  // userImagesDir defaults under sharedMemory so the path is always absolute and
  // visible to all agents (chat-uploaded images aren't agent-scoped).
  const userImagesDir = paths.userImagesDir
    ? configMod.resolvePath(paths.userImagesDir)
    : path.join(sharedMemoryAbsolute, 'user-images');
  return { agentsRoot, workspace, sharedMemory: sharedMemoryAbsolute, compactArchives, skillsDir, userImagesDir };
}

export interface PromptContext {
  agentConfig: AgentConfig;
  sessionId: string;
  isMainSession: boolean;
  environmentPaths: EnvironmentPaths;
  /** Optional codebase_search tool note (when enabled for the agent) */
  codebaseSearchToolNote?: string;
  /** Whether the extended_reasoning tool is available (Mercury + configured model) */
  reasoningAvailable?: boolean;
  /** Whether the inspect_image tool is available (Mercury statsUrl) — emits the vision trigger. */
  visionDescribeAvailable?: boolean;
  /** When true, MEMORY.md is not injected (memory lives in PostgreSQL) */
  memoryStoreEnabled?: boolean;
  /** Whether the scheduler module is available (scheduled tasks) */
  schedulerAvailable?: boolean;
  /** All known agents — for "Other agents" section in platform context */
  agentsList?: AgentConfig[];
  /**
   * Sub-agent harness (remplace le bloc plateforme Mastermind pour `kind: subagent`).
   * Liste d’outils alignée sur le payload LLM réel.
   */
  subAgentHarness?: {
    jobId: string;
    parentAgentId: string;
    allowedToolNames: string[];
    capsSummary: string;
  };
  /**
   * Prompt templates module — used to render editable sections (platform / environment /
   * subagent-harness / memory-stub / lazy-skills-summary).
   * Optional for backward-compat: when undefined, we fall back to the hardcoded DEFAULTS
   * exported from `prompt-templates/defaults.ts` (same content as the user-visible default
   * in the templates UI). Real prod runs ALWAYS pass it (registered as a module at boot).
   */
  templatesMod?: PromptTemplatesModule;
  /**
   * Human-readable name of the user (injected into the platform template as {{userName}}).
   * Defaults to 'User' when not provided. Override via the platform prompt template in the UI.
   */
  userName?: string;
  /**
   * Locale code of the user (injected into the platform template as {{userLocale}}).
   * Defaults to 'EN' when not provided. Override via the platform prompt template in the UI.
   */
  userLocale?: string;
}

/**
 * Build the "## Fleet roster" block that gets injected as the {{fleetRosterBlock}}
 * variable in the platform template. Returns an empty string if no fleet provided
 * (so the template renders without the section, no orphan markdown headers).
 */
function buildFleetRosterBlock(agentsList: AgentConfig[] | undefined): string {
  if (!agentsList || agentsList.length === 0) return '';
  const enabled = agentsList
    .filter(a => a.enabled !== false)
    .slice()
    .sort((a, b) => a.identity.id.localeCompare(b.identity.id));
  const mainAgents = enabled.filter(a => a.kind !== 'subagent');
  const subAgents = enabled.filter(a => a.kind === 'subagent');
  const lines = [
    ``,
    `## Fleet roster (who is who)`,
    ``,
    `There are two kinds of registered agents — do not confuse them:`,
    `- **Standard agents** — interactive personas with a workspace, chat sessions (web/Telegram), Board, escalation, and scheduler. They speak to the end user directly.`,
    `- **Sub-agent presets** — one-shot cloud workers with their own workspace. **They never see the user's chat.** When you need a self-contained heavy task, call \`spawn_subagent(preset, prompt)\` from a standard session. The preset runs asynchronously, then hands you a Markdown report; **you** read it, synthesize, and usually notify the user via \`send_to_user\`. Always call \`list_subagents\` first if you are unsure which \`preset\` id exists, who may spawn it (\`allowedCallers\`), and its caps/model.`,
    ``,
    `### Standard agents`,
    mainAgents.length > 0
      ? mainAgents.map(a => formatAgentRosterLine(a, 'standard')).join('\n')
      : `_(none enabled)_`,
    ``,
    `### Sub-agent presets (spawnable)`,
    subAgents.length > 0
      ? subAgents.map(a => formatAgentRosterLine(a, 'subagent')).join('\n')
      : `_(none configured — \`spawn_subagent\` / \`list_subagents\` stay unavailable until an operator adds presets.)_`,
    ``,
    `Escalation / Board / war rooms apply between **standard** agents. Sub-agents are tools you **spawn**, not peers you escalate to.`,
  ];
  return lines.join('\n');
}

/**
 * Render an editable section through the templates module if available, else fall back
 * to the hardcoded default with the same variable replacement logic. Used so both code
 * paths (with or without the module wired) produce byte-identical output for the same
 * vars — important for caches and for tests.
 */
function renderTemplate(
  key: string,
  vars: Record<string, string>,
  templatesMod: PromptTemplatesModule | undefined,
): string {
  if (templatesMod) return templatesMod.render(key, vars);
  // Fallback: same regex replace as the module's applyVars (no templating engine deps)
  const tpl = DEFAULTS[key] ?? '';
  return tpl.replace(/\{\{([\w.]+)\}\}/g, (match, name) => {
    return vars[name] !== undefined ? vars[name] : match;
  });
}

export interface PromptSectionStat {
  key: string;
  chars: number;
  estimatedTokens: number;
  /**
   * Raw section content (always populated by `addSection`). Lightweight callers
   * (e.g. `/prompt-size`) strip it before serializing; the Prompt Builder UI
   * consumes it via `/prompt-render`.
   */
  content: string;
}

export interface PromptBuildResult {
  prompt: string;
  sections: PromptSectionStat[];
}

function normalizePromptPath(p: string): string | null {
  const normalized = p.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.includes(':')) return null;
  return normalized;
}

/** Normalized, deduplicated set of shared-starred paths declared by an agent config. */
function normalizeStarredSet(cfg: AgentConfig): Set<string> {
  return new Set(
    (cfg.promptInjection?.sharedStarredFiles ?? [])
      .map(p => normalizePromptPath(p))
      .filter((p): p is string => !!p),
  );
}

/**
 * Order an agent's shared starred files so that files starred by MORE agents come first.
 *
 * For two agents A and B, all files they both star are emitted in the same order on both
 * sides, which extends their byte-identical prefix through the starred block (the KV cache
 * can be reused up to the first file one has and the other doesn't).
 *
 * Sort keys (stable across agents):
 *   1. |signature| descending — signature = set of agent ids that star this file
 *   2. signature.join(',') ascending — tie-break when two files have same-size sets
 *   3. path ascending — final tie-break
 */
function orderedSharedStarred(
  agentConfig: AgentConfig,
  agentsList: AgentConfig[],
): string[] {
  const enabled = agentsList.filter(a => a.enabled !== false);
  const mine = [...normalizeStarredSet(agentConfig)];
  if (mine.length === 0) return [];

  // Precompute each enabled agent's starred set once.
  const allSets = enabled.map(a => ({ id: a.identity.id, set: normalizeStarredSet(a) }));

  const sigOf = new Map<string, string>();
  const sigSizeOf = new Map<string, number>();
  for (const p of mine) {
    const owners = allSets
      .filter(({ set }) => set.has(p))
      .map(({ id }) => id)
      .sort((a, b) => a.localeCompare(b));
    sigOf.set(p, owners.join(','));
    sigSizeOf.set(p, owners.length);
  }

  return mine.sort((a, b) => {
    const d = (sigSizeOf.get(b) ?? 0) - (sigSizeOf.get(a) ?? 0);
    if (d !== 0) return d;
    const s = (sigOf.get(a) ?? '').localeCompare(sigOf.get(b) ?? '');
    if (s !== 0) return s;
    return a.localeCompare(b);
  });
}

const estimateTokens = (chars: number): number => Math.max(1, Math.round(chars / 4));

function addSection(parts: string[], sections: PromptSectionStat[], key: string, content: string): void {
  parts.push(content);
  sections.push({
    key,
    chars: content.length,
    estimatedTokens: estimateTokens(content.length),
    content,
  });
}

/** Assemble the full system prompt for an agent */
export async function assembleSystemPrompt(
  memory: MemoryModule,
  ctx: PromptContext,
): Promise<string> {
  return (await buildSystemPrompt(memory, ctx)).prompt;
}

/** Assemble prompt + per-section stats (for UI estimation/debugging) */
export async function buildSystemPrompt(
  memory: MemoryModule,
  ctx: PromptContext,
): Promise<PromptBuildResult> {
  const { agentConfig } = ctx;
  const workspaceDir = agentConfig.workspacePath;
  const parts: string[] = [];
  const sections: PromptSectionStat[] = [];
  console.debug(`[prompt] buildSystemPrompt agent=${agentConfig.identity.id} session=${ctx.sessionId} isMain=${ctx.isMainSession}`);

  // 1. Mastermind Platform Context — ou harness sub-agent (one-shot, pas de chat direct)
  const ep = ctx.environmentPaths;
  if (agentConfig.kind === 'subagent') {
    const h = ctx.subAgentHarness;
    // deliveryBlock = bloc complet "## Execution budget + Tools + Delivery contract" (avec harness)
    // ou minimaliste "## Delivery" (sans harness). Construit côté TS car conditionnel à h.
    const deliveryBlock = h
      ? [
          `This run is async job \`${h.jobId}\` on behalf of parent agent \`${h.parentAgentId}\`.`,
          ``,
          `## Execution budget`,
          h.capsSummary,
          ``,
          `## Tools you may call`,
          `Only tools in your tool list are valid (enforced at execution). For clarity:`,
          h.allowedToolNames.length > 0
            ? h.allowedToolNames.map(n => `- \`${n}\``).join('\n')
            : '_(see tool list in the API payload)_',
          ``,
          `## Delivery contract`,
          `When finished, you **MUST** call \`submit_subagent_report\` **once** with your full Markdown report. The full report is forwarded to the parent agent as the input of a new run — the parent will read it, synthesize, and notify the user via \`send_to_user\`. No need for a \`## TL;DR\` section: the parent reads the whole thing. Plain assistant text after \`submit_subagent_report\` is **discarded** — make sure everything you want to convey is inside the markdown payload.`,
        ].join('\n')
      : `## Delivery\nCall \`submit_subagent_report\` once with your full Markdown report. The parent agent will receive it as input and synthesize for the user.`;
    const rendered = renderTemplate('subagent-harness', {
      presetIdentity: formatIdentityMarkdownBullets(agentConfig.identity),
      presetId: agentConfig.identity.id,
      deliveryBlock,
    }, ctx.templatesMod);
    addSection(parts, sections, 'subagent-harness', rendered);
  } else {
    // Build the fleet roster block as a variable for the template (the rest of the
    // platform context is static text editable via `prompt-templates/platform.md`).
    const fleetRosterBlock = buildFleetRosterBlock(ctx.agentsList);
    const rendered = renderTemplate('platform', {
      // Override these defaults via the platform prompt template in the UI
      // (Settings → Prompt Templates → platform) or set them in your IDENTITY.md.
      userName: ctx.userName ?? 'User',
      userLocale: ctx.userLocale ?? 'EN',
      fleetRosterBlock,
    }, ctx.templatesMod);
    addSection(parts, sections, 'platform', rendered);
  }

  // 2. Environment paths + tool call rules
  //
  // ⚠️ Prefix-cache sensitivity: this section (and everything above it) MUST stay byte-identical
  // between all agents on the same model. Agent-specific paths (`workspace`, `compactArchives`)
  // and the codebase-search hint are emitted later in `# Agent identity` (see below).
  //
  // Editable via the templates system (file: `shared/prompt-templates/environment.md`).
  // Conditional bits (memory-search trigger, scheduler triggers, skills dir line) are
  // constructed as variables — the template body itself stays static.
  const skillsDirLine = ep.skillsDir ? `\n- Skills directory: ${ep.skillsDir}` : '';
  const memoryStoreTrigger = ctx.memoryStoreEnabled
    ? `\n- Before saying "I don't know" or "I don't remember" → call \`memory_search\` first to check`
    : '';
  const schedulerTriggers = ctx.schedulerAvailable
    ? `\n- User says "remind me / schedule / tomorrow at X / in N minutes" → call \`schedule_task\` immediately\n- User asks about existing reminders or tasks → call \`list_scheduled_tasks\`\n- User says "cancel / delete reminder" → call \`list_scheduled_tasks\` then \`delete_scheduled_task\`\n- User says "alert me if / watch for / monitor" → call \`list_proactive_watchers\` then \`create_proactive_task\``
    : '';
  const visionTrigger = ctx.visionDescribeAvailable
    ? `\n- You need to SEE / read an image (user-uploaded — paths are in the message footer — or one you produced) → call \`inspect_image(path, question)\`. You do NOT retain a chat image across turns; re-inspect its saved path to look again.`
    : '';
  const renderedEnv = renderTemplate('environment', {
    agentsRoot: ep.agentsRoot,
    sharedMemory: ep.sharedMemory,
    userImagesDir: ep.userImagesDir,
    skillsDirLine,
    memoryStoreTrigger,
    schedulerTriggers,
    visionTrigger,
  }, ctx.templatesMod);
  addSection(parts, sections, 'environment', renderedEnv);

  // ───────── Common zone (byte-identical inter-agents when config allows) ─────────
  // Sections below are independent of the current agent's identity — if the config is
  // aligned they contribute to the shared KV-cache prefix.

  // memory-stub: emitted unconditionally when the vector memory store is enabled, so
  // it stays common across agents regardless of whether their workspace has a MEMORY.md.
  // Editable via `shared/prompt-templates/memory-stub.md` (no variables — 1-liner).
  if (ctx.memoryStoreEnabled) {
    addSection(parts, sections, 'memory-stub', renderTemplate('memory-stub', {}, ctx.templatesMod));
  }

  // Shared starred files — multi-tier ordering by signature-of-owners so agents that
  // star the same file emit it at the same position, maximizing prefix-cache overlap.
  const orderedStarred = orderedSharedStarred(agentConfig, ctx.agentsList ?? []);
  for (const sharedPath of orderedStarred) {
    const content = await memory.shared.readFile(sharedPath);
    if (content) {
      addSection(parts, sections, `shared-starred:${sharedPath}`, `# Shared Starred File: ${sharedPath}\n${content}`);
    }
  }

  // ───────── Agent-specific zone (divergence point for KV cache) ─────────
  // Everything below varies per agent — tools calling read_file/write_file work off
  // relative paths anyway, so placing these late costs nothing semantically.

  const identityLines = [
    `# Agent identity`,
    formatIdentityMarkdownBullets(agentConfig.identity),
    ``,
    `- Workspace: ${ep.workspace}`,
    `- Compact archives: ${ep.compactArchives}`,
  ];
  addSection(parts, sections, 'agent-identity', identityLines.join('\n'));

  // Recent daily summary — THIS agent's OWN consolidated recap only (no cross-agent digest).
  // Per-agent content → lives in the divergence zone (not the shared prefix), so the common
  // prefix cache stays intact for the rest of the fleet. Filtered by agentId in readRecent.
  const dailies = await memory.daily.readRecent(2, agentConfig.identity.id);
  if (dailies) {
    addSection(parts, sections, 'daily-recent', `# Recent Context\n${dailies}`);
  }

  if (ctx.codebaseSearchToolNote) {
    addSection(parts, sections, 'codebase-search-hint', ctx.codebaseSearchToolNote);
  }

  // Workspace markdown files — per-agent content. MEMORY.md is skipped when the vector
  // store is enabled (the memory-stub above already told the agent to use memory_search).
  const workspaceFilesRaw = await memory.workspace.listFiles(workspaceDir);
  const workspaceFiles = agentConfig.kind === 'subagent'
    ? [...workspaceFilesRaw].sort((a, b) => {
        if (a.name === 'SOUL.md') return -1;
        if (b.name === 'SOUL.md') return 1;
        return a.name.localeCompare(b.name);
      })
    : workspaceFilesRaw;
  // Workspace star filter (symmetry with sharedStarredFiles): when the agent has explicitly
  // starred ≥1 workspace file, inject ONLY those. When none are starred, fall back to
  // injecting the whole workspace (legacy behavior — avoids silently stripping context from
  // every pre-existing agent). SOUL.md (sub-agent role contract) is always kept regardless,
  // like IDENTITY.md, since it defines the agent itself rather than being user content.
  const workspaceStarred = new Set(
    (agentConfig.promptInjection?.workspaceStarredFiles ?? [])
      .map(p => normalizePromptPath(p))
      .filter((p): p is string => !!p),
  );
  const workspaceFilterActive = workspaceStarred.size > 0;
  for (const file of workspaceFiles) {
    if (ctx.memoryStoreEnabled && file.name === 'MEMORY.md') continue;
    // IDENTITY.md : champs structurés déjà injectés au-dessus (même format **Label:**).
    if (file.name === 'IDENTITY.md') continue;
    const isSoulRole = file.name === 'SOUL.md' && agentConfig.kind === 'subagent';
    // Quand le filtre est actif, on ne garde que les fichiers étoilés (+ SOUL.md du sub-agent).
    if (workspaceFilterActive && !workspaceStarred.has(file.name) && !isSoulRole) continue;
    const content = await memory.workspace.readFile(workspaceDir, file.name);
    if (!content) continue;
    const title = file.name === 'SOUL.md' && agentConfig.kind === 'subagent'
      ? `# Sub-agent role (SOUL.md)`
      : `# Workspace File: ${file.name}`;
    addSection(parts, sections, `workspace:${file.name}`, `${title}\n${content}`);
  }

  // Skills: executable skill tools are injected uniformly into the tool list for all agents
  // (see getAllTools). Per-agent allowlist is enforced at exec time via the gate in executeTool.

  // Note: date/time is injected directly into each user message in run.ts (see `datePrefix`),
  // not here — adding it to the system prompt would invalidate the KV cache on every request.

  const totalChars = sections.reduce((s, sec) => s + sec.chars, 0);
  const totalTokens = sections.reduce((s, sec) => s + sec.estimatedTokens, 0);
  console.debug(`[prompt] built ${sections.length} sections totalChars=${totalChars} ~${totalTokens} tokens: ${sections.map(s => `${s.key}(${s.estimatedTokens}t)`).join(', ')}`);

  return {
    prompt: parts.join('\n\n---\n\n'),
    sections,
  };
}
