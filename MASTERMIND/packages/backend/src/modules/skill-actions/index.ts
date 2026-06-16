import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { execBash } from '../agent/tools/bash.js';
import type { ToolDefinition, MastermindContext, Module } from '@mastermind/shared';
import type { ConfigModule } from '../config/index.js';
import type { AsyncJobsModule } from '../async-jobs/index.js';

/** Context threaded into execute() so async skills know which agent/session to attach to. */
export interface SkillExecContext {
  agentId: string;
  sessionId: string;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillActionParam {
  type: string;
  description?: string;
  default?: unknown;
  enum?: string[];
}

export interface SkillActionExecute {
  command: string;
  timeout_ms?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SkillActionUI {
  primary?: boolean;
  label?: string;
  confirm?: boolean;
}

export interface SkillActionDef {
  id: string;
  name: string;
  description: string;
  parameters?: {
    type: 'object';
    properties?: Record<string, SkillActionParam>;
    required?: string[];
  };
  execute: SkillActionExecute;
  ui?: SkillActionUI;
  /**
   * When true, the action is dispatched to the AsyncJobsModule instead of being
   * executed synchronously. The agent receives a "queued" response immediately and
   * the actual result is delivered later as a new session message + optional Telegram
   * push. Intended for long-running generations (Sora Pro video, Veo 3, image gen).
   */
  async?: boolean;
  /**
   * Glob pattern (relative to the skill cwd) used to collect output files after an
   * async execution completes. Files whose mtime is >= started_at are packaged as
   * attachments and delivered to the user. Defaults to `outputs/**` when omitted.
   * Ignored if `output_from_arg` is set.
   */
  outputs_glob?: string;
  /**
   * Name of an argument that carries the output file path. When set, the async worker
   * uses `args[output_from_arg]` directly as the output path (absolute or relative to
   * the skill cwd), instead of walking the cwd with `outputs_glob`. Use this when the
   * skill writes to a path provided by the caller (e.g. shared memory, agent workspace).
   */
  output_from_arg?: string;
  /** Optional caption prepended to the completion message (e.g. "🎬 Vidéo prête !"). */
  on_complete_caption?: string;
  /**
   * Timeout (ms) for async exec. Overrides `execute.timeout_ms` when set; if neither is
   * set, async jobs default to 1 hour so Sora Pro / long Veo runs don't get killed.
   */
  async_timeout_ms?: number;
}

export interface SkillActionsFile {
  version: number;
  skill?: {
    name?: string;
    emoji?: string;
    description?: string;
  };
  actions: SkillActionDef[];
}

export interface LoadedSkillAction {
  skillDir: string;
  skillName: string;
  skillEmoji: string;
  skillDescription: string;
  action: SkillActionDef;
  /** Resolved tool name: skill_<skillDir>_<actionId> */
  toolName: string;
  /** Resolved skill directory absolute path */
  skillPath: string;
}

/** Shape returned by getAllActionsForUI() */
export interface SkillActionForUI {
  skillDir: string;
  skillName: string;
  skillEmoji: string;
  actionId: string;
  name: string;
  description: string;
  toolName: string;
  parameters?: {
    type: 'object';
    properties?: Record<string, SkillActionParam>;
    required?: string[];
  };
  ui: SkillActionUI;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Escape a string for safe embedding in a single-quoted shell argument. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Resolve env vars in command env map: ${VAR} → process.env.VAR */
function resolveEnvVars(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] ?? '');
  }
  return out;
}

/**
 * Interpolate command template with Mustache-like syntax.
 * - `{{var}}` → value (strings shell-escaped, numbers/booleans raw, undefined → empty).
 * - `{{#var}}...{{/var}}` → block kept only when var is truthy (non-empty string,
 *   true, or non-zero number). Inner `{{var}}` are interpolated. Empty string,
 *   null, undefined, false, 0 all count as falsy.
 * - `{{^var}}...{{/var}}` → inverted: block kept only when var is falsy.
 */
function interpolateCommand(
  template: string,
  params: Record<string, unknown>,
  defaults?: Record<string, unknown>,
): string {
  const resolve = (key: string): unknown => {
    const v = params[key];
    if (v === undefined && defaults?.[key] !== undefined) return defaults[key];
    return v;
  };
  const isTruthy = (v: unknown): boolean => {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.length > 0;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'boolean') return v;
    return Boolean(v);
  };

  // First pass: resolve sections (handles nesting via repeated regex pass).
  let prev: string;
  let out = template;
  do {
    prev = out;
    out = out.replace(
      /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
      (_match, marker: string, key: string, body: string) => {
        const truthy = isTruthy(resolve(key));
        const keep = marker === '#' ? truthy : !truthy;
        return keep ? body : '';
      },
    );
  } while (out !== prev);

  // Second pass: simple {{var}} substitution.
  return out.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = resolve(key);
    if (val === undefined || val === null) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    return shellEscape(String(val));
  });
}

/** Build a ToolDefinition from a loaded skill action. */
function actionToToolDef(loaded: LoadedSkillAction): ToolDefinition {
  const params = loaded.action.parameters ?? {
    type: 'object' as const,
    properties: {},
    required: [],
  };

  return {
    name: loaded.toolName,
    description: `[${loaded.skillEmoji || '🔧'} ${loaded.skillName}] ${loaded.action.description}`,
    parameters: params,
  };
}

/** Derive a tool name from skill directory name + action id. */
function makeToolName(skillDir: string, actionId: string): string {
  return `skill_${skillDir}_${actionId}`;
}

/** Validate a single action definition. Returns errors or empty array. */
function validateAction(action: SkillActionDef, skillDir: string): string[] {
  const errors: string[] = [];
  if (!action.id || typeof action.id !== 'string') {
    errors.push(`${skillDir}: action missing 'id'`);
  }
  if (!action.execute?.command) {
    errors.push(`${skillDir}/${action.id}: missing 'execute.command'`);
  }
  if (action.id && !/^[\w-]+$/.test(action.id)) {
    errors.push(`${skillDir}/${action.id}: id must be alphanumeric/dash/underscore`);
  }
  if (action.async !== undefined && typeof action.async !== 'boolean') {
    errors.push(`${skillDir}/${action.id}: 'async' must be a boolean`);
  }
  if (action.outputs_glob !== undefined && typeof action.outputs_glob !== 'string') {
    errors.push(`${skillDir}/${action.id}: 'outputs_glob' must be a string`);
  }
  if (action.output_from_arg !== undefined && typeof action.output_from_arg !== 'string') {
    errors.push(`${skillDir}/${action.id}: 'output_from_arg' must be a string`);
  }
  if (action.on_complete_caption !== undefined && typeof action.on_complete_caption !== 'string') {
    errors.push(`${skillDir}/${action.id}: 'on_complete_caption' must be a string`);
  }
  if (action.async_timeout_ms !== undefined && (typeof action.async_timeout_ms !== 'number' || action.async_timeout_ms <= 0)) {
    errors.push(`${skillDir}/${action.id}: 'async_timeout_ms' must be a positive number`);
  }
  return errors;
}

// ── Module ───────────────────────────────────────────────────────────────────

export class SkillActionsModule implements Module {
  readonly name = 'skill-actions';

  private skillsDir: string | null = null;
  private loaded: LoadedSkillAction[] = [];
  private toolDefCache: ToolDefinition[] = [];
  private byToolName = new Map<string, LoadedSkillAction>();
  private ctx!: MastermindContext;

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    const raw = ctx.config.paths.skillsDir;
    if (!raw) {
      console.log('[skill-actions] skillsDir not configured — module inactive');
      return;
    }
    // Resolve relative to config or use absolute
    const configMod = ctx.modules.tryGet<ConfigModule>('config');
    this.skillsDir = configMod ? configMod.resolvePath(raw) : path.resolve(raw);
    await this.reload();
  }

  /** (Re)load all actions.yml files from skillsDir. */
  async reload(): Promise<void> {
    if (!this.skillsDir) return;

    this.loaded = [];
    this.byToolName.clear();

    let entries: string[];
    try {
      const dirents = await fs.readdir(this.skillsDir, { withFileTypes: true });
      entries = dirents.filter(d => d.isDirectory()).map(d => d.name).sort();
    } catch (err) {
      console.warn(`[skill-actions] cannot read skillsDir: ${err instanceof Error ? err.message : err}`);
      return;
    }

    const allErrors: string[] = [];

    for (const skillDir of entries) {
      const actionsFile = path.join(this.skillsDir, skillDir, 'actions.yml');
      try {
        const raw = await fs.readFile(actionsFile, 'utf-8');
        const parsed = yaml.load(raw) as SkillActionsFile;

        if (!parsed?.actions?.length) continue;

        const skillPath = path.join(this.skillsDir, skillDir);
        const skillName = parsed.skill?.name ?? skillDir;
        const skillEmoji = parsed.skill?.emoji ?? '';
        const skillDescription = parsed.skill?.description ?? '';

        for (const action of parsed.actions) {
          const errors = validateAction(action, skillDir);
          if (errors.length) {
            allErrors.push(...errors);
            continue;
          }

          const toolName = makeToolName(skillDir, action.id);

          // Check for duplicates
          if (this.byToolName.has(toolName)) {
            allErrors.push(`Duplicate tool name: ${toolName}`);
            continue;
          }

          const loaded: LoadedSkillAction = {
            skillDir,
            skillName,
            skillEmoji,
            skillDescription,
            action,
            toolName,
            skillPath,
          };

          this.loaded.push(loaded);
          this.byToolName.set(toolName, loaded);
        }
      } catch {
        // No actions.yml — skip silently
      }
    }

    // Rebuild tool definition cache
    this.toolDefCache = this.loaded.map(actionToToolDef);

    if (allErrors.length) {
      console.warn(`[skill-actions] validation errors:\n  ${allErrors.join('\n  ')}`);
    }

    console.log(
      `[skill-actions] loaded ${this.loaded.length} actions from ${new Set(this.loaded.map(l => l.skillDir)).size} skills`,
    );
  }

  /** Get ToolDefinition[] for all loaded actions (for getToolsForAgent). */
  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefCache;
  }

  /**
   * Get tool definitions only for actions belonging to specified skill directories.
   * Used to filter to starred skills only.
   */
  getToolDefinitionsForSkills(skillDirs: string[]): ToolDefinition[] {
    const set = new Set(skillDirs);
    return this.loaded
      .filter(l => set.has(l.skillDir))
      .map(actionToToolDef);
  }

  /**
   * One-line summary per loaded skill — used by lazy-skill mode to advertise the surface in
   * the system prompt without injecting full action schemas. Each summary carries the skill
   * name+emoji+description and the list of action ids+toolNames so the agent knows what to
   * `inspect_skill('<id>')` for.
   *
   * `filterSkillDirs` restricts the result to those skill dirs (used when bypassUnifiedCache
   * is also active and we only want starred skills surfaced).
   */
  getSkillSummaries(filterSkillDirs?: string[]): Array<{
    skillDir: string;
    skillName: string;
    skillEmoji: string;
    skillDescription: string;
    actions: Array<{ id: string; name: string; toolName: string; description: string }>;
  }> {
    const filterSet = filterSkillDirs ? new Set(filterSkillDirs) : null;
    const bySkill = new Map<string, ReturnType<typeof this.getSkillSummaries>[number]>();
    for (const l of this.loaded) {
      if (filterSet && !filterSet.has(l.skillDir)) continue;
      let entry = bySkill.get(l.skillDir);
      if (!entry) {
        entry = {
          skillDir: l.skillDir,
          skillName: l.skillName,
          skillEmoji: l.skillEmoji,
          skillDescription: l.skillDescription,
          actions: [],
        };
        bySkill.set(l.skillDir, entry);
      }
      entry.actions.push({
        id: l.action.id,
        name: l.action.name,
        toolName: l.toolName,
        description: l.action.description,
      });
    }
    // Stable ordering — by skillDir alphabetically — so the system prompt is byte-stable
    // across rebuilds (no jitter from Map insertion order if loadAll changes its scan order).
    return [...bySkill.values()].sort((a, b) => a.skillDir.localeCompare(b.skillDir));
  }

  /**
   * Lazy-mode counterpart of getToolDefinitionsForSkills, but returning the full per-action
   * definitions formatted as text for `inspect_skill` tool result. Includes the skill header
   * (name + description) and each action with description + parameter schema rendered as
   * a compact JSON line. Returns null when the skillDir is not loaded.
   */
  renderSkillInspection(skillDir: string): string | null {
    const summary = this.getSkillSummaries([skillDir])[0];
    if (!summary) return null;
    const lines: string[] = [];
    lines.push(`Skill: ${summary.skillEmoji ? summary.skillEmoji + ' ' : ''}${summary.skillName} (id: ${summary.skillDir})`);
    if (summary.skillDescription) lines.push(`Description: ${summary.skillDescription}`);
    lines.push(`Actions (${summary.actions.length}) — call by toolName, args follow JSON schema:`);
    for (const l of this.loaded.filter(la => la.skillDir === skillDir)) {
      const params = l.action.parameters ?? { type: 'object' as const };
      // Render params compactly: required keys flagged, types and short descs inline.
      const props = (params.properties ?? {}) as Record<string, SkillActionParam>;
      const required = new Set(params.required ?? []);
      const paramLines: string[] = [];
      for (const [key, p] of Object.entries(props)) {
        const tag = required.has(key) ? '(required)' : '(optional)';
        const enumPart = Array.isArray(p.enum) && p.enum.length > 0 ? ` enum=[${p.enum.join('|')}]` : '';
        const defPart = p.default !== undefined ? ` default=${JSON.stringify(p.default)}` : '';
        const descPart = p.description ? ` — ${p.description}` : '';
        paramLines.push(`    - ${key}: ${p.type}${enumPart}${defPart} ${tag}${descPart}`);
      }
      lines.push('');
      lines.push(`  • toolName: ${l.toolName}`);
      lines.push(`    description: ${l.action.description}`);
      if (paramLines.length > 0) {
        lines.push(`    params:`);
        lines.push(...paramLines);
      } else {
        lines.push(`    params: (none)`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Resolve a skill_<dir>_<action> tool name back to its owning skillDir.
   * Returns undefined if the tool name is not a loaded skill action.
   * Used by per-agent exec gate to check whether the skill is starred for the calling agent.
   */
  getSkillDirForTool(toolName: string): string | undefined {
    return this.byToolName.get(toolName)?.skillDir;
  }

  /** Execute a skill action by tool name, or create a skill via '__create__'. */
  async execute(toolName: string, args: Record<string, unknown>, ctx?: SkillExecContext): Promise<string> {
    // Special convention: '__create__' triggers skill creation
    if (toolName === '__create__') {
      return this.createSkill(
        String(args['skill_name'] ?? ''),
        String(args['actions_yml'] ?? ''),
        typeof args['skill_md'] === 'string' ? args['skill_md'] : undefined,
      );
    }

    const loaded = this.byToolName.get(toolName);
    if (!loaded) {
      throw new Error(`Unknown skill action: ${toolName}`);
    }

    const { action, skillPath } = loaded;
    const exec = action.execute;

    // Build defaults map from parameter definitions
    const defaults: Record<string, unknown> = {};
    if (action.parameters?.properties) {
      for (const [k, v] of Object.entries(action.parameters.properties)) {
        if (v.default !== undefined) defaults[k] = v.default;
      }
    }

    // Interpolate command
    const cmd = interpolateCommand(exec.command, args, defaults);
    const cwd = exec.cwd ?? skillPath;
    const resolvedEnv = exec.env ? resolveEnvVars(exec.env) : undefined;

    // ── Async path: dispatch to AsyncJobsModule, return immediately ────────
    if (action.async) {
      if (!ctx?.agentId || !ctx?.sessionId) {
        return 'skill error: async skills require agent/session context (internal wiring issue).';
      }
      const asyncJobsMod = this.ctx.modules.tryGet<AsyncJobsModule>('async-jobs');
      if (!asyncJobsMod) {
        return 'skill error: async-jobs module not loaded';
      }
      const timeoutMs = action.async_timeout_ms ?? exec.timeout_ms ?? 3_600_000; // 1h default for async
      const outputsGlob = action.outputs_glob ?? 'outputs/**';
      const caption = action.on_complete_caption ?? 'Résultat prêt';
      const { jobId } = await asyncJobsMod.enqueue({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        toolName,
        args,
        command: cmd,
        cwd,
        ...(resolvedEnv ? { env: resolvedEnv } : {}),
        timeoutMs,
        outputsGlob,
        ...(action.output_from_arg ? { outputFromArg: action.output_from_arg } : {}),
        caption,
      });
      console.log(`[skill-actions] async ${toolName} → job ${jobId}`);
      return (
        `Async job ${jobId} queued. The user will receive the result via send_to_user when complete. ` +
        `Tell the user you're running it and give a rough ETA (Sora/Veo: 3-10 min, image gen: ~30s-2min). ` +
        `End your turn — the result arrives as a new message; do not block waiting.`
      );
    }

    // ── Sync path (original behavior) ──────────────────────────────────────
    const timeout = exec.timeout_ms ?? 30_000;

    // Merge env vars if defined
    if (resolvedEnv) {
      for (const [k, v] of Object.entries(resolvedEnv)) {
        process.env[k] = v;
      }
    }

    console.log(`[skill-actions] exec ${toolName} → ${cmd.slice(0, 120)}`);
    return execBash(cmd, cwd, timeout);
  }

  /** Get all actions with UI metadata (for frontend buttons). */
  getAllActionsForUI(): SkillActionForUI[] {
    return this.loaded.map(l => ({
      skillDir: l.skillDir,
      skillName: l.skillName,
      skillEmoji: l.skillEmoji,
      actionId: l.action.id,
      name: l.action.name,
      description: l.action.description,
      toolName: l.toolName,
      parameters: l.action.parameters,
      ui: l.action.ui ?? { primary: false, label: l.action.name, confirm: false },
    }));
  }

  /**
   * Create or update a skill from agent code.
   * Writes actions.yml (and optional SKILL.md) then hot-reloads.
   */
  async createSkill(skillName: string, actionsYml: string, skillMd?: string): Promise<string> {
    if (!this.skillsDir) {
      throw new Error('skillsDir not configured');
    }

    // Validate name
    if (!/^[\w-]+$/.test(skillName)) {
      throw new Error(`Invalid skill name: ${skillName} (use kebab-case, alphanumeric/dash/underscore)`);
    }

    // Validate YAML before writing
    let parsed: SkillActionsFile;
    try {
      parsed = yaml.load(actionsYml) as SkillActionsFile;
    } catch (err) {
      throw new Error(`Invalid YAML: ${err instanceof Error ? err.message : err}`);
    }

    if (!parsed?.actions?.length) {
      throw new Error('actions.yml must define at least one action');
    }

    const errors: string[] = [];
    for (const action of parsed.actions) {
      errors.push(...validateAction(action, skillName));
    }
    if (errors.length) {
      throw new Error(`Validation errors:\n${errors.join('\n')}`);
    }

    // Write files
    const skillPath = path.join(this.skillsDir, skillName);
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'actions.yml'), actionsYml, 'utf-8');
    console.log(`[skill-actions] creating skill "${skillName}" at ${skillPath} (${parsed.actions.length} actions)`);

    if (skillMd) {
      await fs.writeFile(path.join(skillPath, 'SKILL.md'), skillMd, 'utf-8');
    }

    // Hot-reload
    await this.reload();

    const count = this.loaded.filter(l => l.skillDir === skillName).length;
    console.log(`[skill-actions] skill "${skillName}" ready — ${count} tools registered`);
    return `Skill "${skillName}" created/updated with ${count} actions. Tools available immediately.`;
  }

  /** Check if the module has any loaded actions. */
  get isActive(): boolean {
    return this.loaded.length > 0;
  }

  /** List of skill directories that have actions.yml */
  get skillDirsWithActions(): Set<string> {
    return new Set(this.loaded.map(l => l.skillDir));
  }
}
