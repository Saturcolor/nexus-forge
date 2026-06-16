import { Hono } from 'hono';
import fs from 'node:fs';
import type { MastermindContext, ProviderStats } from '@mastermind/shared';
import type { AgentModule } from '../modules/agent/index.js';
import type { MemoryModule } from '../modules/memory/index.js';
import type { ConfigModule } from '../modules/config/index.js';
import type { ProviderModule } from '../modules/provider/index.js';
import { unloadMercuryModel } from '../modules/agent/mercuryStats.js';
import { buildSystemPrompt, resolveEnvironmentPaths } from '../modules/agent/prompt.js';
import { buildCodebaseSearchToolNote } from '../modules/codebase-search/promptNote.js';
import { resolveCodebaseSearchDbPaths } from '../modules/codebase-search/paths.js';
import { normalizePromptPath } from '../utils/paths.js';
import { TOOL_DEFINITIONS, buildAgentToolsForRender } from '../modules/agent/tools/index.js';
import type { SkillActionsModule } from '../modules/skill-actions/index.js';
import type { MemoryStoreModule } from '../modules/memory-store/index.js';
import type { SchedulerModule } from '../modules/scheduler/index.js';
import type { BoardModule } from '../modules/board/index.js';
import type { AsyncJobsModule } from '../modules/async-jobs/index.js';
import type { PromptTemplatesModule } from '../modules/prompt-templates/index.js';
import type { SessionModule } from '../modules/session/index.js';
import { unifiedSessionId, primaryTelegramChatId } from '../modules/agent/sessionResolve.js';
import { normalizeDeliveryPolicy } from '../modules/delivery/index.js';

export function agentRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const agentMod = ctx.modules.get<AgentModule>('agent');
  const memoryMod = ctx.modules.get<MemoryModule>('memory');
  const providerMod = ctx.modules.get<ProviderModule>('provider');
  // Verrou per-agent anti double-merge concurrent sur POST /:id/unify-sessions (le check
  // alreadySeeded + le seed ne sont pas atomiques ; deux requêtes simultanées sinon insèrent
  // deux résumés et déclenchent deux appels LLM).
  const unifyInProgress = new Set<string>();

  // List all agents (with raw workspaceDir from config). Optional filter ?kind=agent|subagent.
  app.get('/', (c) => {
    const kindFilter = c.req.query('kind');
    let list = agentMod.listAgents();
    if (kindFilter === 'agent' || kindFilter === undefined) {
      // No filter or kind=agent → main agents only by default for the legacy list.
      // To include sub-agents pass ?kind=all or ?kind=subagent explicitly.
      if (kindFilter === 'agent') list = list.filter(a => a.kind !== 'subagent');
    } else if (kindFilter === 'subagent') {
      list = list.filter(a => a.kind === 'subagent');
    } else if (kindFilter !== 'all') {
      console.warn(`[route:agents] list invalid kind filter=${kindFilter} (expected agent|subagent|all)`);
      return c.json({ error: 'kind filter must be one of: agent, subagent, all' }, 400);
    }
    const agents = list.map(a => ({
      ...a,
      workspaceDir: ctx.config.agents[a.identity.id]?.workspaceDir,
      state: agentMod.getState(a.identity.id),
    }));
    console.debug(`[route:agents] list kind=${kindFilter ?? 'agent(default)'} count=${agents.length}`);
    return c.json(agents);
  });

  // Scan agentsDir for workspace directories
  app.get('/workspace/scan', (c) => {
    const configMod = ctx.modules.get<ConfigModule>('config');
    const agentsDir = configMod.resolvePath(ctx.config.paths.agentsDir);
    console.debug(`[route:agents] workspace scan dir=${agentsDir}`);
    try {
      if (!fs.existsSync(agentsDir)) return c.json([]);
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
      console.debug(`[route:agents] workspace scan found ${dirs.length} dirs`);
      return c.json(dirs);
    } catch (err) {
      console.warn(`[route:agents] workspace scan error: ${err instanceof Error ? err.message : err}`);
      return c.json([]);
    }
  });

  // UI preferences (last selected agent, sidebar state…) — must be before /:id routes
  app.get('/ui-prefs', async (c) => {
    const row = await ctx.db.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM user_preferences WHERE key = 'ui-prefs'`,
    );
    console.debug(`[route:agents] get ui-prefs found=${row.rows.length > 0}`);
    return c.json(row.rows[0]?.value ?? {});
  });
  app.put('/ui-prefs', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    console.log(`[route:agents] update ui-prefs keys=${Object.keys(body).join(',')}`);
    await ctx.db.query(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES ('ui-prefs', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = user_preferences.value || $1, updated_at = NOW()`,
      [JSON.stringify(body)],
    );
    return c.json({ ok: true });
  });

  // Get single agent
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const agent = agentMod.getAgent(id);
    if (!agent) {
      console.warn(`[route:agents] get agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    console.debug(`[route:agents] get agent=${id} state=${agentMod.getState(id)}`);
    return c.json({
      ...agent,
      workspaceDir: ctx.config.agents[id]?.workspaceDir,
      state: agentMod.getState(id),
    });
  });

  // Prompt size estimate (web + telegram variants)
  app.get('/:id/prompt-size', async (c) => {
    const id = c.req.param('id');
    const agent = agentMod.getAgent(id);
    if (!agent) {
      console.warn(`[route:agents] prompt-size agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    console.debug(`[route:agents] prompt-size start agent=${id}`);
    const configMod = ctx.modules.get<ConfigModule>('config');
    const environmentPaths = resolveEnvironmentPaths(
      configMod,
      ctx.config.paths,
      agent,
      id,
      memoryMod.shared.dir,
    );
    const codebaseSearchToolNote = buildCodebaseSearchToolNote(
      ctx.config,
      (p) => configMod.resolvePath(p),
      agent,
      id,
    );
    const webBuild = await buildSystemPrompt(memoryMod, {
      agentConfig: agent,
      sessionId: `${id}-web-estimate`,
      isMainSession: true,
      environmentPaths,
      codebaseSearchToolNote,
    });
    const telegramBuild = await buildSystemPrompt(memoryMod, {
      agentConfig: agent,
      sessionId: `${id}-tg-estimate`,
      isMainSession: false,
      environmentPaths,
      codebaseSearchToolNote,
    });
    console.debug(`[route:agents] prompt-size done agent=${id} webChars=${webBuild.prompt.length} telegramChars=${telegramBuild.prompt.length}`);
    // Strip per-section `content` to keep this lightweight endpoint identical to its
    // pre-Prompt-Builder shape. Consumers needing the raw content call /prompt-render.
    const stripContent = (s: typeof webBuild.sections[number]) => ({
      key: s.key,
      chars: s.chars,
      estimatedTokens: s.estimatedTokens,
    });
    return c.json({
      web: {
        chars: webBuild.prompt.length,
        estimatedTokens: Math.max(1, Math.round(webBuild.prompt.length / 4)),
        sections: webBuild.sections.map(stripContent),
      },
      telegram: {
        chars: telegramBuild.prompt.length,
        estimatedTokens: Math.max(1, Math.round(telegramBuild.prompt.length / 4)),
        sections: telegramBuild.sections.map(stripContent),
      },
    });
  });

  // Full prompt render for the Prompt Builder UI (Advanced tab).
  // Returns the assembled system prompt + per-section content for inspection.
  // Variants: 'web' (isMainSession=true, default) | 'telegram' (isMainSession=false).
  //
  // Ephemeral overrides (read-only — NOT persisted to YAML):
  //   ?lazySkills=on|off|config         — force lazy mode preview (default: config)
  //   ?bypassUnifiedCache=on|off|config — force bypass preview (default: config)
  //   ?skillCallMode=stub|wildcard      — preview wildcard dispatch (default: stub)
  //
  // These let the operator preview "what if I toggled X" without editing the agent
  // config. The on-disk YAML is untouched. Per-skill / per-tool toggles come in V2.
  app.get('/:id/prompt-render', async (c) => {
    const startedAt = Date.now();
    const id = c.req.param('id');
    const variantRaw = c.req.query('variant') ?? 'web';
    const variant: 'web' | 'telegram' = variantRaw === 'telegram' ? 'telegram' : 'web';
    const lazyOverrideRaw = c.req.query('lazySkills');
    const bypassOverrideRaw = c.req.query('bypassUnifiedCache');
    const skillCallModeRaw = c.req.query('skillCallMode');
    const parseTriState = (v: string | undefined): boolean | null => {
      if (v === 'on' || v === 'true' || v === '1') return true;
      if (v === 'off' || v === 'false' || v === '0') return false;
      return null;
    };
    const lazyOverride = parseTriState(lazyOverrideRaw);
    const bypassOverride = parseTriState(bypassOverrideRaw);
    // skillCallMode override — layered ON TOP of agentConfig.skillCallMode (V2 YAML).
    //   'stub' / 'wildcard' from query  → explicit preview override
    //   absent from query               → fall back to agentConfig.skillCallMode (default 'stub')
    const skillCallModeOverride: 'stub' | 'wildcard' | null =
      skillCallModeRaw === 'wildcard' ? 'wildcard'
      : skillCallModeRaw === 'stub' ? 'stub'
      : null;

    const baseAgent = agentMod.getAgent(id);
    if (!baseAgent) {
      console.warn(`[route:agents] prompt-render agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    // Apply overrides via shallow clone — never mutate the loaded config.
    const agent: typeof baseAgent = (lazyOverride !== null || bypassOverride !== null || skillCallModeOverride !== null)
      ? {
          ...baseAgent,
          ...(lazyOverride !== null ? { lazySkills: lazyOverride } : {}),
          ...(bypassOverride !== null ? { bypassUnifiedCache: bypassOverride } : {}),
          ...(skillCallModeOverride !== null ? { skillCallMode: skillCallModeOverride } : {}),
        }
      : baseAgent;
    // Effective skillCallMode for the render (after override stack).
    const skillCallMode: 'stub' | 'wildcard' = agent.skillCallMode ?? 'stub';
    console.debug(`[route:agents] prompt-render start agent=${id} variant=${variant} lazyOverride=${lazyOverride} bypassOverride=${bypassOverride} skillCallMode=${skillCallMode}`);
    const configMod = ctx.modules.get<ConfigModule>('config');
    const environmentPaths = resolveEnvironmentPaths(
      configMod,
      ctx.config.paths,
      agent,
      id,
      memoryMod.shared.dir,
    );
    const codebaseSearchToolNote = buildCodebaseSearchToolNote(
      ctx.config,
      (p) => configMod.resolvePath(p),
      agent,
      id,
    );
    const agentsList = agentMod.listAgents();
    // Templates module — must be passed to buildSystemPrompt AND buildAgentToolsForRender
    // so the Prompt Builder UI reflects the user's overrides (audit V3 bug #1: without
    // this, /prompt-render renders DEFAULTS while prod runs see overrides → WYSIWYG broken).
    const templatesMod = ctx.modules.tryGet<PromptTemplatesModule>('prompt-templates');
    const build = await buildSystemPrompt(memoryMod, {
      agentConfig: agent,
      sessionId: `${id}-${variant}-render`,
      isMainSession: variant === 'web',
      environmentPaths,
      codebaseSearchToolNote,
      agentsList,
      templatesMod,
    });

    // Tools + skills — mirror of buildLlmPayload assembly so the UI shows the EXACT
    // tool list the LLM would receive for this agent in this variant.
    const skillActionsMod = ctx.modules.tryGet<SkillActionsModule>('skill-actions');
    const memoryStoreMod = ctx.modules.tryGet<MemoryStoreModule>('memory-store');
    const schedulerMod = ctx.modules.tryGet<SchedulerModule>('scheduler');
    const boardMod = ctx.modules.tryGet<BoardModule>('board');
    const asyncJobsMod = ctx.modules.tryGet<AsyncJobsModule>('async-jobs');
    // Mirror run.ts:536-545 exactly: true if any enabled agent in the fleet has indices
    // resolvable on disk. This is the global flag that controls codebase_search visibility
    // uniformly across the fleet in `getAllTools`.
    const csResolvePath = (p: string) => configMod.resolvePath(p);
    const codebaseSearchEverAvailable = agentsList.some(a =>
      a.enabled !== false
      && resolveCodebaseSearchDbPaths(ctx.config, csResolvePath, a.identity.id).length > 0,
    );
    const toolsRender = buildAgentToolsForRender({
      agentConfig: agent,
      agentsList,
      skillActionsMod,
      memoryStoreEnabled: !!memoryStoreMod?.isEnabled,
      schedulerAvailable: !!schedulerMod,
      boardAvailable: !!boardMod,
      asyncJobsAvailable: !!asyncJobsMod,
      codebaseSearchEverAvailable,
      // For a render outside of a live run we don't have a reasoning provider; conservative false.
      // If the agent's thinkBudget != 'off' this could under-report `extended_reasoning` —
      // documented limitation, will refine in V2.
      reasoningAvailable: false,
      braveApiKey: ctx.config.search?.braveApiKey,
      // 'web' = regular interactive run path (not sandbox/subagent). Matches the route's
      // primary use-case: inspecting what a live web/telegram chat session would receive.
      source: variant,
      skillCallMode,
      templatesMod,
    });

    // Shape each tool as a serializable entry the UI can display in a "Tools & Skills" group.
    // Pretty-printed JSON schema gives a faithful preview of what the LLM sees.
    const toolEntries = toolsRender.tools.map(t => {
      const pretty = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }, null, 2);
      return {
        name: t.name,
        kind: t.name.startsWith('skill_') ? ('skill' as const) : ('builtin' as const),
        description: t.description,
        schema: pretty,
        chars: pretty.length,
        estimatedTokens: Math.max(1, Math.round(pretty.length / 4)),
      };
    });
    const toolsChars = toolEntries.reduce((acc, t) => acc + t.chars, 0);

    const chars = build.prompt.length;
    const estimatedTokens = Math.max(1, Math.round(chars / 4));
    const lazySummary = toolsRender.lazySkillSummary;
    const lazySummaryChars = lazySummary?.length ?? 0;

    // Effective config — exactly what's being applied to this render (after overrides).
    // The UI uses this to show "you are inspecting agent X with lazy=on (overridden) /
    // bypassUnified=off (from config) / starredSkills=[...]". Empty arrays = explicitly none.
    // `skillCallMode` est persisté en YAML (V2). Le query param du PromptBuilder le
    // layer par-dessus pour preview, mais la valeur d'origine vient de `agentConfig.skillCallMode`
    // (lue par buildLlmPayload au runtime).
    const effectiveConfig = {
      kind: agent.kind ?? 'agent',
      lazySkills: agent.lazySkills === true,
      bypassUnifiedCache: agent.bypassUnifiedCache === true,
      memoryStoreEnabled: !!memoryStoreMod?.isEnabled,
      starredSkills: agent.promptInjection?.starredSkills ?? [],
      sharedStarredFiles: agent.promptInjection?.sharedStarredFiles ?? [],
      disabledTools: agent.tools?.disabled ?? [],
      allowOnly: agent.tools?.allowOnly ?? [],
      skillCallMode: toolsRender.skillCallMode,
      // Overrides metadata (so the UI shows "from config" vs "overridden" badges).
      overrides: {
        lazySkills: lazyOverride !== null ? { active: true, value: lazyOverride, configValue: baseAgent.lazySkills === true } : { active: false },
        bypassUnifiedCache: bypassOverride !== null ? { active: true, value: bypassOverride, configValue: baseAgent.bypassUnifiedCache === true } : { active: false },
        // skillCallMode: V2 — query override layered on top of the YAML value.
        // configValue reflects what's actually persisted in mastermind.yml.
        skillCallMode: skillCallModeOverride !== null
          ? { active: true, value: skillCallModeOverride, configValue: baseAgent.skillCallMode ?? 'stub' }
          : { active: false, configValue: baseAgent.skillCallMode ?? 'stub' },
      },
    };

    console.debug(
      `[route:agents] prompt-render done agent=${id} variant=${variant} promptChars=${chars} promptTokens=${estimatedTokens} sections=${build.sections.length} tools=${toolEntries.length} toolsChars=${toolsChars} lazySkills=${toolsRender.lazySkillsActive} lazySummary=${lazySummaryChars}c bypass=${toolsRender.bypassUnified} ms=${Date.now() - startedAt}`,
    );
    return c.json({
      agentId: id,
      variant,
      prompt: build.prompt,
      chars,
      estimatedTokens,
      sections: build.sections,
      tools: toolEntries,
      toolsMeta: {
        count: toolEntries.length,
        chars: toolsChars,
        estimatedTokens: Math.max(1, Math.round(toolsChars / 4)),
        lazySkillsActive: toolsRender.lazySkillsActive,
        bypassUnified: toolsRender.bypassUnified,
        skillCount: toolsRender.skillCount,
      },
      lazySkillSummary: lazySummary,
      lazySkillSummaryMeta: lazySummary
        ? { chars: lazySummaryChars, estimatedTokens: Math.max(1, Math.round(lazySummaryChars / 4)) }
        : null,
      effectiveConfig,
    });
  });

  // Create new agent (or sub-agent via kind='subagent')
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id: string;
      workspaceDir: string;
      model?: string;
      maxContextTokens?: number;
      maxCompletionTokens?: number;
      contextMessages?: number;
      autoCompactThreshold?: number;
      promptCacheTtl?: number;
      telegram?: { enabled: boolean; chatIds: number[]; botId?: string; streaming?: boolean };
      kind?: 'agent' | 'subagent';
      allowedCallers?: string[];
      caps?: { maxIterations?: number; maxToolCalls?: number; maxOutputTokens?: number; timeoutSeconds?: number };
    }>();

    if (!body.id || !body.workspaceDir) {
      console.warn('[route:agents] create rejected missing id/workspaceDir');
      return c.json({ error: 'id and workspaceDir are required' }, 400);
    }
    if (ctx.config.agents[body.id]) {
      console.warn(`[route:agents] create rejected duplicate agent=${body.id}`);
      return c.json({ error: `Agent "${body.id}" already exists` }, 409);
    }

    const kind = body.kind ?? 'agent';
    console.log(`[route:agents] create kind=${kind} agent=${body.id} workspace=${body.workspaceDir} model=${body.model ?? 'default'}`);

    const agentYaml = {
      workspaceDir: body.workspaceDir,
      model: body.model || ctx.config.defaults.model,
      maxContextTokens: body.maxContextTokens,
      maxCompletionTokens: body.maxCompletionTokens,
      contextMessages: body.contextMessages,
      autoCompactThreshold: body.autoCompactThreshold,
      promptCacheTtl: body.promptCacheTtl,
      // Sub-agents : telegram silencieusement ignoré (pas de chat direct).
      ...(kind === 'subagent' ? {} : { telegram: body.telegram }),
      kind,
      ...(kind === 'subagent' && body.allowedCallers ? { allowedCallers: body.allowedCallers } : {}),
      ...(kind === 'subagent' && body.caps ? { caps: body.caps } : {}),
    };

    ctx.config.agents[body.id] = agentYaml as any;
    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();

    await agentMod.addAgent(body.id, agentYaml as any);
    return c.json({ ok: true, id: body.id }, 201);
  });

  // Update agent config (model, telegram, workspaceDir…)
  app.put('/:id/config', async (c) => {
    const id = c.req.param('id');
    if (!agentMod.getAgent(id)) {
      console.warn(`[route:agents] update config agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }

    console.log(`[route:agents] update config agent=${id}`);

    const body = await c.req.json<{
      model?: string;
      enabled?: boolean;
      temperature?: number;
      maxContextTokens?: number;
      maxCompletionTokens?: number;
      contextMessages?: number;
      autoCompactThreshold?: number;
      dailyCompact?: {
        enabled: boolean;
        time?: string;
        skipWarmup?: boolean;
        loraShuffle?: {
          enabled: boolean;
          ranges?: Array<{ index: number; min: number; max: number; step?: number }>;
        };
      } | null;
      captureReasoningTraces?: boolean;
      promptCacheTtl?: number;
      thinkBudget?: 'off' | 'low' | 'medium' | 'high' | null;
      workspaceDir?: string;
      telegram?: { enabled: boolean; chatIds: number[]; botId?: string; streaming?: boolean };
      tools?: {
        disabled?: string[];
        allowOnly?: string[];
        systemAccess?: boolean;
        codebaseSearchIndex?: string;
        codebaseSearchIndices?: string[];
        codebaseSearchInPrompt?: boolean;
      };
      promptInjection?: { sharedStarredFiles?: string[]; workspaceStarredFiles?: string[]; starredSkills?: string[] };
      bypassUnifiedCache?: boolean;
      lazySkills?: boolean;
      skillCallMode?: 'stub' | 'wildcard';
      excludeSharedMemory?: boolean;
      // Accepte l'ANCIEN format plat (wake/telegram-string/presenceDedup) ET le v3
      // (mobile/telegram-objet/liveActivity/proactiveAlerts) — normalisé via
      // normalizeDeliveryPolicy avant persistance. null = reset à la policy legacy.
      delivery?: {
        // ── ancien plat ──
        wake?: Array<'mobile' | 'telegram'>;
        presenceDedup?: boolean;
        // ── v3 (telegram peut aussi être la string legacy) ──
        mobile?: { triggers?: Array<'interactive' | 'proactive' | 'task' | 'sandbox'>; presenceDedup?: boolean };
        telegram?:
          | 'on' | 'fallback' | 'off'
          | { mode?: 'on' | 'fallback' | 'off'; triggers?: Array<'interactive' | 'proactive' | 'task' | 'sandbox'> };
        liveActivity?: 'all' | 'user' | 'off';
        proactiveAlerts?: 'all' | 'quiet' | 'off';
      } | null;
      unifiedSession?: boolean;
      loraScales?: number[] | null;
      kind?: 'agent' | 'subagent';
      allowedCallers?: string[];
      caps?: { maxIterations?: number; maxToolCalls?: number; maxOutputTokens?: number; timeoutSeconds?: number };
    }>();

    const agentYaml = ctx.config.agents[id];
    if (body.enabled !== undefined) agentYaml.enabled = body.enabled;
    if (body.model !== undefined) agentYaml.model = body.model;
    if (body.temperature !== undefined) (agentYaml as any).temperature = body.temperature;
    if (body.maxContextTokens !== undefined) agentYaml.maxContextTokens = body.maxContextTokens;
    if (body.maxCompletionTokens !== undefined) agentYaml.maxCompletionTokens = body.maxCompletionTokens;
    if (body.contextMessages !== undefined) agentYaml.contextMessages = body.contextMessages;
    if (body.autoCompactThreshold !== undefined) agentYaml.autoCompactThreshold = body.autoCompactThreshold;
    if (body.dailyCompact !== undefined) {
      if (body.dailyCompact === null) {
        delete agentYaml.dailyCompact;
      } else {
        const enabled = !!body.dailyCompact.enabled;
        const time = typeof body.dailyCompact.time === 'string' ? body.dailyCompact.time.trim() : undefined;
        // Valide le format HH:mm — on accepte l'absence (défaut 06:00 côté runtime)
        if (time && !/^\d{1,2}:\d{2}$/.test(time)) {
          console.warn(`[route:agents] update config agent=${id} invalid dailyCompact.time=${time}`);
          return c.json({ error: 'dailyCompact.time must be HH:mm (24h)' }, 400);
        }
        const dc: NonNullable<typeof agentYaml.dailyCompact> = { enabled };
        if (time) dc.time = time;
        if (typeof body.dailyCompact.skipWarmup === 'boolean') dc.skipWarmup = body.dailyCompact.skipWarmup;
        // loraShuffle : valide chaque plage (index entier ≥ 0, min/max ∈ [0,5], step > 0 optionnel).
        // Plages invalides droppées + warn (cohérent avec le strip silencieux de tools.disabled) —
        // l'UI contraint déjà les entrées, mais on durcit pour ne pas persister un YAML qui
        // ferait planter le zod au prochain boot.
        if (body.dailyCompact.loraShuffle !== undefined) {
          const ls = body.dailyCompact.loraShuffle;
          const ranges: NonNullable<NonNullable<typeof dc.loraShuffle>['ranges']> = [];
          for (const r of (Array.isArray(ls?.ranges) ? ls.ranges : [])) {
            const index = Number(r?.index);
            const min = Number(r?.min);
            const max = Number(r?.max);
            if (!Number.isInteger(index) || index < 0) {
              console.warn(`[route:agents] update config agent=${id} loraShuffle skip range: index invalide (${r?.index})`);
              continue;
            }
            if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || min > 5 || max < 0 || max > 5) {
              console.warn(`[route:agents] update config agent=${id} loraShuffle skip range index=${index}: min/max hors [0,5] (min=${r?.min} max=${r?.max})`);
              continue;
            }
            const range: { index: number; min: number; max: number; step?: number } = { index, min, max };
            const step = Number(r?.step);
            if (Number.isFinite(step) && step > 0 && step <= 5) range.step = step;
            ranges.push(range);
          }
          dc.loraShuffle = ranges.length > 0
            ? { enabled: !!ls?.enabled, ranges }
            : { enabled: !!ls?.enabled };
        }
        agentYaml.dailyCompact = dc;
        // Réinjecte la version sanitizée dans body → updateAgentConfig met à jour l'objet
        // runtime avec exactement ce qui est persisté en YAML (même pattern que body.tools
        // plus bas), sinon le runtime garderait des plages/flags non normalisés jusqu'au reload.
        body.dailyCompact = dc;
      }
    }
    if (body.captureReasoningTraces !== undefined) (agentYaml as any).captureReasoningTraces = body.captureReasoningTraces;
    if (body.promptCacheTtl !== undefined) (agentYaml as any).promptCacheTtl = body.promptCacheTtl;
    if (body.thinkBudget !== undefined) {
      if (body.thinkBudget === null || body.thinkBudget === 'off') {
        delete agentYaml.thinkBudget;
      } else {
        agentYaml.thinkBudget = body.thinkBudget;
      }
    }
    if (body.workspaceDir !== undefined) agentYaml.workspaceDir = body.workspaceDir;
    if (body.telegram !== undefined) agentYaml.telegram = body.telegram;
    if (body.tools !== undefined) {
      const validCoreToolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
      const isValidToolRef = (name: string) =>
        validCoreToolNames.has(name) || name.startsWith('skill_');
      if (body.tools.disabled?.length) {
        const invalid = body.tools.disabled.filter(name => !validCoreToolNames.has(name));
        if (invalid.length) {
          // Strip silently rather than reject 400. Reason: the disabled list can carry stale
          // tool names from older builds (e.g. `notify_user` before the rename to `send_to_user`)
          // — rejecting the whole PUT means the user can NEVER toggle anything on that agent
          // until they manually clean the YAML. Silent drop + warn lets the next save self-heal:
          // the cleaned list is what gets persisted, the obsolete name disappears for good.
          // Dropped names are still logged so a real frontend bug (typo in a new tool name) is
          // visible in ops logs.
          console.warn(`[route:agents] update config agent=${id} stripping unknown tool names from disabled: ${invalid.join(',')} (likely stale from a previous build)`);
          body.tools.disabled = body.tools.disabled.filter(name => validCoreToolNames.has(name));
        }
      }
      if (body.tools.allowOnly?.length) {
        const invalid = body.tools.allowOnly.filter(name => !isValidToolRef(name));
        if (invalid.length) {
          console.warn(`[route:agents] update config agent=${id} stripping unknown allowOnly entries: ${invalid.join(',')}`);
          body.tools.allowOnly = body.tools.allowOnly.filter(isValidToolRef);
        }
      }
      agentYaml.tools = { ...(agentYaml.tools ?? {}), ...body.tools };
      if (
        agentYaml.tools.codebaseSearchIndex !== undefined
        && !String(agentYaml.tools.codebaseSearchIndex).trim()
      ) {
        delete agentYaml.tools.codebaseSearchIndex;
      }
      if (Array.isArray(agentYaml.tools.codebaseSearchIndices) && agentYaml.tools.codebaseSearchIndices.length === 0) {
        delete agentYaml.tools.codebaseSearchIndices;
      }
      if (Array.isArray(agentYaml.tools.allowOnly) && agentYaml.tools.allowOnly.length === 0) {
        delete agentYaml.tools.allowOnly;
      }
      body.tools = { ...agentYaml.tools };
    }
    if (body.promptInjection !== undefined) {
      const sharedStarredFiles = (body.promptInjection.sharedStarredFiles ?? [])
        .map(p => normalizePromptPath(String(p)))
        .filter((p): p is string => !!p);
      const workspaceStarredFiles = (body.promptInjection.workspaceStarredFiles ?? [])
        .map(p => normalizePromptPath(String(p)))
        .filter((p): p is string => !!p);
      const starredSkills = (body.promptInjection.starredSkills ?? [])
        .map(s => String(s).trim())
        .filter(s => s && !s.includes('..') && !s.includes('/'));
      agentYaml.promptInjection = {
        sharedStarredFiles: [...new Set(sharedStarredFiles)].sort((a, b) => a.localeCompare(b)),
        workspaceStarredFiles: [...new Set(workspaceStarredFiles)].sort((a, b) => a.localeCompare(b)),
        starredSkills: [...new Set(starredSkills)].sort((a, b) => a.localeCompare(b)),
      };
    }
    if (body.bypassUnifiedCache !== undefined) {
      // Persist explicitly so flipping back to the unified cache (false) actually
      // writes the false (vs leaving the previous true in YAML, which would silently
      // ignore the toggle on next reload).
      (agentYaml as any).bypassUnifiedCache = body.bypassUnifiedCache;
    }
    if (body.lazySkills !== undefined) {
      // Same as bypassUnifiedCache — persist explicitly to allow flipping back to false.
      (agentYaml as any).lazySkills = body.lazySkills;
    }
    if (body.skillCallMode !== undefined) {
      // Validate explicitly (Zod will catch invalid values on reload, but reject here
      // for clearer error). 'stub' is the documented default — write it out only when
      // explicitly set so we can tell apart "default" from "explicit stub" if needed.
      if (body.skillCallMode !== 'stub' && body.skillCallMode !== 'wildcard') {
        console.warn(`[route:agents] update config agent=${id} invalid skillCallMode=${body.skillCallMode}`);
        return c.json({ error: 'skillCallMode must be "stub" or "wildcard"' }, 400);
      }
      (agentYaml as any).skillCallMode = body.skillCallMode;
    }
    if (body.excludeSharedMemory !== undefined) {
      // Same as the cache toggles — persist explicitly so flipping back to false
      // overwrites a previous true in YAML instead of being silently ignored on reload.
      (agentYaml as any).excludeSharedMemory = body.excludeSharedMemory;
    }
    if (body.unifiedSession !== undefined) {
      // Persist explicite (idem toggles cache) : repasser à false doit écraser un true
      // précédent en YAML. Le merge+compaction one-shot à l'activation est géré par
      // l'endpoint dédié POST /:id/unify-sessions ; ici on ne fait que persister le flag.
      (agentYaml as any).unifiedSession = body.unifiedSession;
    }
    if (body.delivery !== undefined) {
      // null = reset complet à la policy legacy ; objet = replace (pas de merge partiel,
      // l'UI envoie toujours la policy entière — évite les états mixtes YAML/runtime).
      // On NORMALISE en v3 canonique (accepte aussi l'ancien plat) AVANT de persister, pour que
      // YAML + runtime + wsPatch portent exactement la même policy v3 (et `undefined` pour une
      // policy vide — sinon le scheduler verrait `delivery !== undefined` à tort, cf. fix
      // unifiedTelegramFallback). Idempotent : re-PUT d'une policy v3 = identité.
      const normalized = body.delivery === null ? undefined : normalizeDeliveryPolicy(body.delivery);
      if (normalized === undefined) {
        delete (agentYaml as any).delivery;
      } else {
        (agentYaml as any).delivery = normalized;
      }
      // Réinjecte la version normalisée dans body → updateAgentConfig + wsPatch lisent exactement
      // ce qui est persisté (même pattern que body.tools/body.dailyCompact). `null` conservé pour
      // le reset (survit à JSON.stringify côté wsPatch).
      (body as any).delivery = normalized ?? null;
    }
    if (body.loraScales !== undefined) {
      // null ou [] = clear ; array non-vide = persist. Purge la clé legacy `loraScale`
      // (scalaire) en même temps pour que le YAML ne porte plus qu'une source de vérité.
      const next = body.loraScales;
      if (next === null || !Array.isArray(next) || next.length === 0) {
        delete (agentYaml as any).loraScales;
      } else {
        (agentYaml as any).loraScales = next;
      }
      delete (agentYaml as any).loraScale;
    }
    // Sub-agent fields. `kind` change is allowed but the convention is to set it at create time.
    if (body.kind !== undefined) (agentYaml as any).kind = body.kind;
    if (body.allowedCallers !== undefined) (agentYaml as any).allowedCallers = body.allowedCallers;
    if (body.caps !== undefined) (agentYaml as any).caps = body.caps;

    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();

    agentMod.updateAgentConfig(id, body as Parameters<typeof agentMod.updateAgentConfig>[1]);

    // Propage les champs runtime-mutables aux autres clients WS (autres onglets, autre device).
    const wsPatch: import('@mastermind/shared').AgentConfigPatch = {};
    if (body.thinkBudget !== undefined) {
      wsPatch.thinkBudget = body.thinkBudget === null || body.thinkBudget === 'off'
        ? 'off'
        : body.thinkBudget;
    }
    if (body.model !== undefined) wsPatch.model = body.model;
    if (body.temperature !== undefined) wsPatch.temperature = body.temperature;
    if (body.enabled !== undefined) wsPatch.enabled = body.enabled;
    // V2 — propage les toggles "card Modèle" pour que multi-onglets reste sync sans refresh.
    if (body.lazySkills !== undefined) wsPatch.lazySkills = body.lazySkills;
    if (body.bypassUnifiedCache !== undefined) wsPatch.bypassUnifiedCache = body.bypassUnifiedCache;
    if (body.skillCallMode !== undefined) wsPatch.skillCallMode = body.skillCallMode;
    if (body.excludeSharedMemory !== undefined) wsPatch.excludeSharedMemory = body.excludeSharedMemory;
    // delivery : propage la version NETTOYÉE persistée en YAML (pas le body brut),
    // null explicite pour le reset (survit à JSON.stringify, cf. loraScales ci-dessous).
    if (body.delivery !== undefined) wsPatch.delivery = body.delivery === null ? null : (agentYaml.delivery ?? null);
    if (body.unifiedSession !== undefined) wsPatch.unifiedSession = body.unifiedSession;
    if (body.loraScales !== undefined) {
      // Clear → on envoie [] (pas undefined), sinon JSON.stringify drop la clé du
      // patch broadcast et le spread `{...a, ...msg.patch}` côté autres onglets
      // laisse l'ancienne valeur en place — d'où une UI désynchro tant qu'on n'a
      // pas re-fetch. `[]` est interprété pareillement que undefined par les
      // consumers (length 0 = off) mais survit à la sérialisation.
      wsPatch.loraScales = Array.isArray(body.loraScales) && body.loraScales.length > 0
        ? body.loraScales
        : [];
    }
    if (body.dailyCompact !== undefined) {
      // Propage l'objet normalisé complet (enabled/time/skipWarmup/loraShuffle) — replace, pas merge,
      // côté front. null (suppression) → {enabled:false} pour que les autres onglets affichent "off".
      wsPatch.dailyCompact = body.dailyCompact === null ? { enabled: false } : agentYaml.dailyCompact;
    }
    if (Object.keys(wsPatch).length > 0) agentMod.broadcastAgentConfigPatch(id, wsPatch);

    return c.json({ ok: true });
  });

  // Active le mode session unifiée (cross-plateforme) : merge + compaction one-shot des
  // historiques web/mobile/Telegram(owner) dans `{agent}-unified`, puis flip le flag
  // `unifiedSession`. Non destructif : les sessions sources restent consultables (read-only),
  // l'unifiée est seedée d'UN résumé consolidé. Idempotent : ne re-seed pas si déjà peuplée.
  // Appelé par le popup de confirmation du toggle dans AgentConfigTab.
  app.post('/:id/unify-sessions', async (c) => {
    const id = c.req.param('id');
    const agent = agentMod.getAgent(id);
    if (!agent) {
      console.warn(`[route:agents] unify-sessions agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }

    if (unifyInProgress.has(id)) {
      console.warn(`[route:agents] unify-sessions agent=${id} already in progress → 409`);
      return c.json({ error: 'Unification already in progress for this agent' }, 409);
    }
    unifyInProgress.add(id);
    try {
      const sessionMod = ctx.modules.get<SessionModule>('session');
      const unifiedId = unifiedSessionId(id);
      const primaryChat = primaryTelegramChatId(agent);

      // Sources fusionnées : web + mobile + DM Telegram owner. Les groupes Telegram
      // (chatIds non-primaires) ne sont PAS fusionnés (contextes distincts).
      const sourceIds = [
        `${id}-web`,
        `${id}-mobile`,
        ...(primaryChat !== undefined ? [`${id}-tg-${primaryChat}`] : []),
      ].filter(s => s !== unifiedId);

      await sessionMod.getOrCreate(unifiedId, id);
      await sessionMod.setTitle(unifiedId, 'Cross-plateforme');

      // Seed unique : si l'unifiée porte déjà des messages live, on ne re-merge pas.
      const alreadySeeded = (await sessionMod.getMessages(unifiedId, 1)).length > 0;
      let messagesMerged = 0;
      let summarized = false;
      let truncated = false;

      if (!alreadySeeded) {
        const PER_SOURCE_LIMIT = 1000;
        const merged: Array<{ role: string; content: string; createdAt: string | Date }> = [];
        for (const sid of sourceIds) {
          // excludeProactive : on ne fusionne PAS le bruit interne (watchers proactifs + runs
          // sandbox), seulement la vraie conversation user-visible.
          const msgs = await sessionMod.getMessages(sid, PER_SOURCE_LIMIT, undefined, { excludeProactive: true });
          if (msgs.length >= PER_SOURCE_LIMIT) {
            console.warn(`[route:agents] unify-sessions agent=${id} source=${sid} hit ${PER_SOURCE_LIMIT}-msg cap — older history not merged into summary`);
          }
          for (const m of msgs) merged.push({ role: m.role, content: m.content, createdAt: m.createdAt });
        }
        merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        messagesMerged = merged.length;

        if (merged.length > 0) {
          // Tronque au budget caractères en gardant les messages ENTIERS les plus récents
          // (jamais au milieu d'un message — sinon le résumé part d'un fragment corrompu).
          const CHAR_BUDGET = 30_000;
          const kept: typeof merged = [];
          let chars = 0;
          for (let i = merged.length - 1; i >= 0; i--) {
            const m = merged[i];
            const cost = m.content.length + m.role.length + 6;
            if (chars + cost > CHAR_BUDGET && kept.length > 0) { truncated = true; break; }
            chars += cost;
            kept.unshift(m);
          }
          const compactInput = kept.map(m => `[${m.role}] ${m.content}`).join('\n\n');
          const summaryPrompt = `Résume de façon concise mais complète la conversation suivante (issue de plusieurs canaux — web, mobile, Telegram — fusionnés). Conserve les décisions importantes, les résultats d'actions, et le contexte nécessaire pour continuer la conversation. Réponds uniquement avec le résumé, sans commentaire.\n\n---\n\n${compactInput}`;
          let summary: string;
          try {
            summary = await providerMod.complete(agent.model, { messages: [{ role: 'user', content: summaryPrompt }] });
            summarized = true;
          } catch (err) {
            console.warn(`[route:agents] unify-sessions summary failed agent=${id}: ${err instanceof Error ? err.message : err}`);
            summary = `[Erreur résumé auto — historiques sources conservés]\n\nDerniers échanges:\n${compactInput.slice(-3000)}`;
          }
          await sessionMod.addMessage(
            unifiedId,
            'user',
            `[Contexte consolidé — sessions web/mobile/Telegram fusionnées]\n\n${summary}`,
            'web',
            { unifiedMerge: true, mergedFrom: sourceIds, mergedCount: messagesMerged, truncated },
          );
        }
      } else {
        // Ré-activation (OFF→ON) : la session unifiée existe déjà. On NE re-merge PAS, donc les
        // messages éventuellement écrits dans les sources pendant la période OFF ne sont pas
        // ré-injectés. Rendu observable (réponse + log) plutôt que silencieux.
        console.warn(`[route:agents] unify-sessions agent=${id} session ${unifiedId} already seeded — merge skipped (re-activation: messages added to sources during an OFF window are NOT re-merged)`);
      }

      // Active le flag (persist YAML + runtime + broadcast multi-clients), comme PUT /config.
      const agentYaml = ctx.config.agents[id];
      (agentYaml as any).unifiedSession = true;
      const configMod = ctx.modules.get<ConfigModule>('config');
      configMod.save();
      agentMod.updateAgentConfig(id, { unifiedSession: true });
      agentMod.broadcastAgentConfigPatch(id, { unifiedSession: true });

      console.log(`[route:agents] unify-sessions agent=${id} → ${unifiedId} merged=${messagesMerged} summarized=${summarized} truncated=${truncated} alreadySeeded=${alreadySeeded}`);
      return c.json({ ok: true, unifiedSessionId: unifiedId, messagesMerged, summarized, truncated, alreadySeeded, mergedFrom: sourceIds });
    } finally {
      unifyInProgress.delete(id);
    }
  });

  // Get tab order for an agent (persisted UI preference)
  app.get('/:id/tab-order', async (c) => {
    const id = c.req.param('id');
    if (!agentMod.getAgent(id)) {
      console.warn(`[route:agents] get tab-order agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    const row = await ctx.db.query<{ value: string[] }>(
      `SELECT value FROM user_preferences WHERE key = $1`,
      [`tab-order-${id}`],
    );
    const value = row.rows[0]?.value ?? [];
    console.debug(`[route:agents] get tab-order agent=${id} items=${value.length}`);
    return c.json(value);
  });

  // Save tab order for an agent
  app.put('/:id/tab-order', async (c) => {
    const id = c.req.param('id');
    if (!agentMod.getAgent(id)) {
      console.warn(`[route:agents] put tab-order agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    const body = await c.req.json<string[]>();
    if (!Array.isArray(body)) {
      console.warn(`[route:agents] put tab-order agent=${id} invalid body`);
      return c.json({ error: 'Expected string[]' }, 400);
    }
    console.log(`[route:agents] put tab-order agent=${id} items=${body.length}`);
    await ctx.db.query(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [`tab-order-${id}`, JSON.stringify(body)],
    );
    return c.json({ ok: true });
  });


  // Reload agent identity from workspace files (re-parse IDENTITY.md)
  app.post('/:id/reload', async (c) => {
    const id = c.req.param('id');
    if (!agentMod.getAgent(id)) {
      console.warn(`[route:agents] reload identity agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    console.debug(`[route:agents] reload identity agent=${id}`);
    await agentMod.reloadIdentity(id);
    const agent = agentMod.getAgent(id)!;
    return c.json({ ok: true, identity: agent.identity });
  });

  // Stop agent's current run (abort in-flight request)
  app.post('/:id/stop', (c) => {
    const id = c.req.param('id');
    if (!agentMod.getAgent(id)) {
      console.warn(`[route:agents] stop agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    console.log(`[route:agents] stop/abort agent=${id}`);
    agentMod.abort(id);
    return c.json({ ok: true, agentId: id });
  });

  // Delete agent
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!agentMod.getAgent(id)) {
      console.warn(`[route:agents] delete agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    console.log(`[route:agents] delete agent=${id}`);

    delete ctx.config.agents[id];
    const configMod = ctx.modules.get<ConfigModule>('config');
    configMod.save();

    agentMod.removeAgent(id);
    return c.json({ ok: true });
  });

  // List agent workspace files
  app.get('/:id/files', async (c) => {
    const id = c.req.param('id');
    const agent = agentMod.getAgent(id);
    if (!agent) {
      console.warn(`[route:agents] list files agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    const exists = await memoryMod.workspace.workspaceExists(agent.workspacePath);
    if (!exists) {
      const resolvedPath = memoryMod.workspace.getWorkspacePath(agent.workspacePath);
      const hint = 'Create the folder under agentsDir or fix workspaceDir in agent config.';
      console.warn(`[route:agents] list files agent=${id} workspace missing path=${resolvedPath}`);
      return c.json({
        error: `Workspace directory not found. Path: ${resolvedPath}. ${hint}`,
        workspaceDir: agent.workspacePath,
        resolvedPath,
        hint,
      }, 404);
    }
    const files = await memoryMod.workspace.listFiles(agent.workspacePath);
    console.debug(`[route:agents] list files agent=${id} count=${files.length}`);
    return c.json(files);
  });

  // Read agent workspace file
  app.get('/:id/files/:filename', async (c) => {
    const id = c.req.param('id');
    const filename = c.req.param('filename');
    const agent = agentMod.getAgent(id);
    if (!agent) {
      console.warn(`[route:agents] read file agent=${id} not found file=${filename}`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    const content = await memoryMod.workspace.readFile(agent.workspacePath, filename);
    if (content === null) {
      console.warn(`[route:agents] read file agent=${id} file=${filename} not found`);
      return c.json({ error: 'File not found' }, 404);
    }
    console.debug(`[route:agents] read file agent=${id} file=${filename} len=${content.length}`);
    return c.json({ filename: c.req.param('filename'), content });
  });

  // Write agent workspace file
  app.put('/:id/files/:filename', async (c) => {
    const id = c.req.param('id');
    const agent = agentMod.getAgent(id);
    if (!agent) {
      console.warn(`[route:agents] write file agent=${id} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }
    const fileName = c.req.param('filename');
    const body = await c.req.json<{ content: string }>();
    console.log(`[route:agents] write file agent=${id} file=${fileName} len=${body.content.length}`);
    await memoryMod.workspace.writeFile(agent.workspacePath, fileName, body.content);
    // Do NOT invalidate the prompt cache here — the TTL controls when the prompt is rebuilt.
    // Immediate invalidation on file writes bypasses the TTL entirely.
    return c.json({ ok: true });
  });

  // Live stats from middleware — resolves agent model → provider → statsUrl automatically
  app.get('/:id/stats', async (c) => {
    const agent = agentMod.getAgent(c.req.param('id'));
    if (!agent) {
      console.warn(`[route:agents] stats agent=${c.req.param('id')} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }

    // Optional model override (e.g. when session has a different model)
    const modelRef = c.req.query('model') || agent.model;
    console.debug(`[route:agents] stats agent=${c.req.param('id')} model=${modelRef}`);

    let providerId: string;
    let modelId: string;
    try {
      ({ providerId, modelId } = providerMod.resolveModel(modelRef));
    } catch (err) {
      console.warn(`[route:agents] stats cannot resolve model=${modelRef}: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: `Cannot resolve model "${modelRef}"` }, 400);
    }

    let provider = ctx.config.providers.find(p => p.id === providerId);
    if (!provider?.statsUrl || !provider.statsEnabled || provider.chatStatsmercuryEnabled === false) {
      // Fallback: when a non-stats provider (e.g. mercury web fallback) is resolved first,
      // still use any provider explicitly configured for chat stats.
      provider = ctx.config.providers.find(p =>
        !!p.statsUrl &&
        p.statsEnabled === true &&
        p.chatStatsmercuryEnabled !== false
      );
    }
    if (!provider?.statsUrl || !provider.statsEnabled || provider.chatStatsmercuryEnabled === false) {
      console.warn(`[route:agents] stats not enabled agent=${c.req.param('id')} provider=${provider?.id ?? 'none'}`);
      return c.json({ error: 'Stats not enabled for this provider' }, 404);
    }

    // Determine backend type from the resolved model ID prefix (llamacpp/..., ollama/..., lm-studio/...)
    const slashIdx = modelId.indexOf('/');
    const prefix = slashIdx !== -1 ? modelId.slice(0, slashIdx).toLowerCase() : '';
    const key = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;

    let adminPath: string;
    // vllm partage les routes /admin/llamacpp/... du brain-daemon
    if (prefix === 'llamacpp' || prefix === 'vllm') adminPath = `/admin/llamacpp/session/${key}`;
    else if (prefix === 'ollama') adminPath = `/admin/ollama/session/${key}`;
    else if (prefix === 'lm-studio' || prefix === 'lmstudio') adminPath = `/admin/lm-studio/session/${encodeURIComponent(key)}`;
    else {
      // Cloud backends (anthropic, openai, …) n'exposent pas de live stats —
      // 204 plutôt que 400 : c'est un état normal, pas une erreur. Le frontend
      // arrête le polling sur null pour ne pas spammer.
      console.debug(`[route:agents] stats unavailable for backend agent=${c.req.param('id')} prefix=${prefix}`);
      return c.body(null, 204);
    }

    try {
      const headers: Record<string, string> = {};
      const statsToken = provider.statsApiKey || provider.apiKey;
      if (statsToken) headers['Authorization'] = `Bearer ${statsToken}`;
      const res = await fetch(`${provider.statsUrl}${adminPath}`, { headers, signal: AbortSignal.timeout(4000) });
      if (res.status === 404) {
        // Modèle pas (encore) chargé dans le brain — état soft, pas une panne.
        // Mercury renvoie 200 + `inferencing:true` quand un proxy chat est en cours,
        // donc 404 ici = vraiment "pas en VRAM". On renvoie 204 (même contrat que
        // les cloud backends sans live stats) pour que le frontend arrête de poll
        // sans escalader en warn dans la log ingest.
        console.debug(`[route:agents] stats middleware 404 (model not loaded) agent=${c.req.param('id')}`);
        return c.body(null, 204);
      }
      if (!res.ok) {
        // Vrais 5xx (daemon down, etc.) — on garde le warn pour les voir.
        console.warn(`[route:agents] stats middleware returned ${res.status} agent=${c.req.param('id')}`);
        return c.json({ error: `Middleware returned ${res.status}` }, 502);
      }
      const raw = await res.json() as Record<string, unknown>;

      const pm = (raw.proxy_metrics ?? {}) as Record<string, unknown>;
      const stats: ProviderStats = {
        ts: (raw.ts as string) ?? new Date().toISOString(),
        tokensPerSecond: (pm.last_generation_tokens_per_second as number) ?? undefined,
        promptTokens: (pm.last_prompt_tokens as number) ?? undefined,
        outputTokens: (pm.last_generation_tokens as number) ?? undefined,
      };
      if (typeof raw.n_ctx_max === 'number') stats.ctxMax = raw.n_ctx_max;
      else if (typeof raw.context_length === 'number') stats.ctxMax = raw.context_length;

      const slots = raw.slots as Array<Record<string, unknown>> | undefined;
      if (slots?.length) {
        const active = slots.find(s => s.is_processing) ?? slots[0];
        if (typeof active.n_ctx === 'number') stats.ctxMax = active.n_ctx;
        if (typeof active.n_past === 'number') stats.ctxUsed = active.n_past;
      }

      return c.json(stats);
    } catch (err: any) {
      console.warn(`[route:agents] stats fetch error agent=${c.req.param('id')}: ${err.message}`);
      return c.json({ error: err.message }, 502);
    }
  });

  // Unload current model from Mercury middleware (best-effort, same resolution as stats).
  // Server-side gate on defaults.autoUnloadOnSwitch so the behavior stays consistent whether
  // the caller is the web UI, Telegram, or any other client.
  app.post('/:id/unload', async (c) => {
    const agent = agentMod.getAgent(c.req.param('id'));
    if (!agent) {
      console.warn(`[route:agents] unload agent=${c.req.param('id')} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }

    if (ctx.config.defaults.autoUnloadOnSwitch === false) {
      console.log(`[route:agents] unload skipped — defaults.autoUnloadOnSwitch=false`);
      return c.json({ ok: true, skipped: 'autoUnloadOnSwitch disabled' });
    }

    const modelRef = c.req.query('model') || agent.model;
    console.log(`[route:agents] unload model agent=${c.req.param('id')} model=${modelRef}`);

    let providerId: string;
    let modelId: string;
    try {
      ({ providerId, modelId } = providerMod.resolveModel(modelRef));
    } catch (err) {
      console.warn(`[route:agents] unload cannot resolve model=${modelRef}: ${err instanceof Error ? err.message : err}`);
      return c.json({ ok: true, skipped: `Cannot resolve model "${modelRef}"` });
    }

    let provider = ctx.config.providers.find(p => p.id === providerId);
    if (!provider?.statsUrl) {
      provider = ctx.config.providers.find(p => !!p.statsUrl && p.statsEnabled === true);
    }
    if (!provider?.statsUrl) {
      console.warn(`[route:agents] unload skipped no statsUrl agent=${c.req.param('id')} model=${modelRef}`);
      return c.json({ ok: true, skipped: 'no statsUrl configured' });
    }

    await unloadMercuryModel(provider, modelId);
    return c.json({ ok: true });
  });

  return app;
}
