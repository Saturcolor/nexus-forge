import path from 'node:path';
import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { Module, MastermindContext, AgentConfig, AgentState, MessageSource, AgentYamlConfig, WsServerMessage, ProviderStats, MessageImage, AutoWarmupConfig, LoraShuffleConfig } from '@mastermind/shared';
import { parseIdentity } from './workspace.js';
import { runAgent, invalidatePromptCache } from './run.js';
import { invalidateTelegramPromptCache } from './run.js';
import { GlobalWarmupQueue } from './autoWarmup.js';
import { streamMercuryStats, unloadMercuryModel } from './mercuryStats.js';
import { assembleSystemPrompt, resolveEnvironmentPaths } from './prompt.js';
import { buildCodebaseSearchToolNote } from '../codebase-search/promptNote.js';
import { parseDirectives, applyUpdate, formatSessionOptions, type SessionOptions, type SessionUpdate } from './directives.js';
import type { MemoryModule } from '../memory/index.js';
import type { ProviderModule } from '../provider/index.js';
import type { SessionModule } from '../session/index.js';
import type { ConfigModule } from '../config/index.js';
import type { MemoryStoreModule } from '../memory-store/index.js';
import type { SkillActionsModule } from '../skill-actions/index.js';
import type { SchedulerModule } from '../scheduler/index.js';
import type { AsyncJobsModule } from '../async-jobs/index.js';
import type { TelegramModule } from '../telegram/index.js';
import type { PushModule } from '../push/index.js';
import type { BoardModule } from '../board/index.js';
import { ReasoningTraceStore } from '../reasoning-traces/index.js';
import type { WsManager } from '../../ws.js';
import { normalizePromptPath } from '../../utils/paths.js';
import type { SubAgentDeliveryContext, SubAgentDeliveryState } from './tools/submit_subagent_report.js';

/** Parse `HH:mm` (24h) avec fallback sur 06:00. Valeurs hors plage → 06:00. */
function parseDailyCompactTime(raw: string | undefined): { hours: number; minutes: number } {
  const fallback = { hours: 6, minutes: 0 };
  if (!raw || typeof raw !== 'string') return fallback;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h < 0 || h > 23 || mm < 0 || mm > 59) {
    return fallback;
  }
  return { hours: h, minutes: mm };
}

export class AgentModule implements Module {
  name = 'agent';
  private agents = new Map<string, AgentConfig>();
  private states = new Map<string, AgentState>();
  /**
   * In-flight AbortControllers per agent. Keyed by agentId → Set of controllers so that
   * concurrent runs to the SAME agentId (different sessions, or a 3-entry timing window
   * where an in-flight run plus two near-simultaneous arrivals all resume after the same
   * awaited promise) each own their own controller and never clobber a sibling's. The
   * public `abort(agentId)` contract is preserved: it aborts EVERY controller in the
   * agent's Set (i.e. all in-flight runs for that agent), matching every caller's intent
   * ("stop whatever this agent is doing"). See audit M1.
   */
  private abortControllers = new Map<string, Set<AbortController>>();
  /**
   * Per-agent serialization gate. Holds the promise of the run currently occupying the
   * agent slot (real run, warmup, or compact). A new run captures the prior gate AND
   * installs its own placeholder SYNCHRONOUSLY (before any await) so that two arrivals
   * waiting on the same predecessor chain behind each other instead of stampeding when
   * the predecessor resolves — restoring the "one non-warmup run at a time per agent"
   * invariant that `abort()@run + await oldRun` is meant to enforce. See audit M1.
   */
  private runPromises = new Map<string, Promise<void>>();
  /** Per-session option overrides (persistent until explicitly changed) */
  private sessionOptions = new Map<string, SessionOptions>();
  private ctx!: MastermindContext;
  private autoWarmup?: GlobalWarmupQueue;
  private reasoningTraceStore?: ReasoningTraceStore;
  /** Ticker 60s qui déclenche le compact quotidien planifié par agent. */
  private dailyCompactTimer: ReturnType<typeof setInterval> | null = null;
  private dailyCompactTickInProgress = false;
  /** Jour (YYYY-MM-DD local) du dernier fire par agent — empêche le double-trigger. */
  private dailyCompactLastFired = new Map<string, string>();

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    const memoryMod = ctx.modules.get<MemoryModule>('memory');

    for (const [agentId, agentYaml] of Object.entries(ctx.config.agents)) {
      const identity = await parseIdentity(
        memoryMod.workspace,
        agentYaml.workspaceDir,
        agentId,
      );

      const isSubAgent = agentYaml.kind === 'subagent';
      const agentConfig: AgentConfig = {
        identity,
        workspacePath: path.resolve(ctx.config.paths.agentsDir, agentYaml.workspaceDir),
        model: agentYaml.model || ctx.config.defaults.model,
        enabled: agentYaml.enabled !== false,
        kind: agentYaml.kind ?? 'agent',
        // Sub-agents: telegram/voice/dailyCompact silencieusement ignorés (pas de chat direct)
        maxContextTokens: agentYaml.maxContextTokens ?? ctx.config.defaults.maxContextTokens,
        maxCompletionTokens: agentYaml.maxCompletionTokens,
        contextMessages: agentYaml.contextMessages,
        autoCompactThreshold: agentYaml.autoCompactThreshold,
        dailyCompact: isSubAgent ? undefined : agentYaml.dailyCompact,
        telegram: isSubAgent ? undefined : agentYaml.telegram,
        tools: agentYaml.tools,
        promptInjection: agentYaml.promptInjection,
        captureReasoningTraces: agentYaml.captureReasoningTraces,
        thinkBudget: agentYaml.thinkBudget,
        bypassUnifiedCache: agentYaml.bypassUnifiedCache,
        lazySkills: agentYaml.lazySkills,
        skillCallMode: agentYaml.skillCallMode,
        excludeSharedMemory: agentYaml.excludeSharedMemory,
        delivery: isSubAgent ? undefined : agentYaml.delivery,
        unifiedSession: agentYaml.unifiedSession,
        loraScales: (agentYaml.loraScales && agentYaml.loraScales.length > 0)
          ? agentYaml.loraScales
          : (agentYaml.loraScale != null ? [agentYaml.loraScale] : undefined),
        allowedCallers: isSubAgent ? agentYaml.allowedCallers : undefined,
        caps: isSubAgent ? agentYaml.caps : undefined,
      };

      this.agents.set(agentId, agentConfig);
      this.states.set(agentId, 'idle');
    }

    console.log(`[agent] Loaded ${this.agents.size} agent(s): ${[...this.agents.keys()].join(', ')}`);

    // Garbage-collect stale starred entries: files referenced in promptInjection.*StarredFiles
    // (or starredSkills) that no longer exist on disk are silently retained in YAML and
    // produce a [shared-memory] readFile miss warn on every run. Prune them once at boot
    // and persist the cleaned config.
    await this.pruneStaleStarredEntries(memoryMod.shared.dir);

    // Vider le cache Telegram au démarrage pour que le nouveau prompt système s'applique immédiatement
    invalidateTelegramPromptCache();

    // Initialiser le store de traces de raisonnement + nettoyage auto
    this.reasoningTraceStore = new ReasoningTraceStore(ctx.db);
    this.reasoningTraceStore.cleanup(30).then(deleted => {
      if (deleted > 0) console.log(`[reasoning-traces] Cleaned up ${deleted} traces > 30 days`);
    }).catch(() => { /* non-fatal */ });

    // Initialiser la queue globale de warmup
    const sessionMod = ctx.modules.get<SessionModule>('session');
    const ws = ctx.ws as WsManager;
    this.autoWarmup = new GlobalWarmupQueue(
      ctx.config.defaults.autoWarmup ?? {},
      // Warmup goes through the same `run()` method as live messages — same payload
      // assembly, same modules, same broadcasts. Difference is purely the `warmup: true`
      // flag, which gates DB writes / chat broadcasts and caps generation at 1 token.
      (aid, sid) => this.run(aid, sid, '', 'web', { warmup: true }).then(() => undefined),
      (aid) => this.states.get(aid) ?? 'idle',
      (aid) => this.agents.get(aid)?.promptInjection?.sharedStarredFiles ?? [],
      (aid) => sessionMod.listByAgent(aid),
      memoryMod.shared.dir,
      (firesAt) => {
        ws.broadcastAll({ type: 'warmup.global.schedule', firesAt } satisfies WsServerMessage);
      },
      (queue, processing) => {
        ws.broadcastAll({ type: 'warmup.queue.update', queue, processing } satisfies WsServerMessage);
      },
    );
    for (const [agentId, cfg] of this.agents) {
      if (cfg.kind === 'subagent') continue; // Sub-agents : no warmup, pas d'identité à watcher
      this.autoWarmup.updateWatchedFiles(agentId);
    }

    // Ticker du compact quotidien : on vérifie chaque minute si un agent doit être compacté.
    this.dailyCompactTimer = setInterval(() => {
      this.tickDailyCompact().catch(err =>
        console.warn(`[agent] daily-compact tick failed: ${err instanceof Error ? err.message : err}`),
      );
    }, 60_000);
    // Ne pas bloquer l'exit du process sur ce timer
    if (typeof (this.dailyCompactTimer as { unref?: () => void }).unref === 'function') {
      (this.dailyCompactTimer as { unref?: () => void }).unref!();
    }
  }

  /**
   * Tick du scheduler daily-compact : pour chaque agent avec `dailyCompact.enabled`,
   * déclenche le compact de la session la plus récente si l'heure locale courante
   * tombe dans la fenêtre [target, target + FIRE_WINDOW_MIN) et que l'agent n'a
   * pas déjà été compacté aujourd'hui. La fenêtre étroite évite un misfire quand
   * l'utilisateur active le toggle dans la journée pour une heure déjà passée.
   */
  private async tickDailyCompact(): Promise<void> {
    if (this.dailyCompactTickInProgress) {
      console.debug('[agent] daily-compact tick skipped (previous tick still running)');
      return;
    }
    this.dailyCompactTickInProgress = true;
    try {
    const FIRE_WINDOW_MIN = 5;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    for (const [agentId, agentConfig] of this.agents) {
      const cfg = agentConfig.dailyCompact;
      if (!cfg?.enabled) continue;
      if (agentConfig.enabled === false) continue;

      const parsed = parseDailyCompactTime(cfg.time);
      const targetMinutes = parsed.hours * 60 + parsed.minutes;
      // Ne fire que dans la fenêtre [target, target + FIRE_WINDOW_MIN)
      if (nowMinutes < targetMinutes || nowMinutes >= targetMinutes + FIRE_WINDOW_MIN) continue;

      if (this.dailyCompactLastFired.get(agentId) === today) continue;

      // Skip si l'agent n'est pas idle — on retentera au tick suivant
      if (this.states.get(agentId) !== 'idle') continue;

      // LoRA shuffle — AVANT le compact, pour que le warmup post-compact cuise la
      // nouvelle scale dans le KV cache (pas d'invalidation en milieu de journée).
      // Tourne même s'il n'y a pas de session à compacter : la scale du jour change
      // quand même et s'applique au prochain message (aucun cache chaud à invalider).
      if (cfg.loraShuffle?.enabled) {
        try {
          this.shuffleLoraForAgent(agentId, agentConfig, cfg.loraShuffle);
        } catch (err) {
          console.warn(`[agent] daily-compact lora-shuffle failed agent=${agentId}: ${err instanceof Error ? err.message : err}`);
        }
      }

      const sessionMod = this.ctx.modules.get<SessionModule>('session');
      const sessions = await sessionMod.listByAgent(agentId);
      if (sessions.length === 0) {
        // Pas de session → on marque quand même pour ne pas rescanner toute la journée
        this.dailyCompactLastFired.set(agentId, today);
        continue;
      }
      const target = sessions[0]; // listByAgent → ORDER BY updated_at DESC

      this.dailyCompactLastFired.set(agentId, today);
      const skipWarmup = cfg.skipWarmup === true;
      console.log(`[agent] daily-compact firing agent=${agentId} session=${target.id} target=${parsed.hours}:${String(parsed.minutes).padStart(2, '0')} skipWarmup=${skipWarmup}`);

      try {
        const result = await this.compactSession(agentId, target.id, 'web', 'scheduled', { skipWarmup });
        if (!result) {
          console.log(`[agent] daily-compact noop agent=${agentId} (< 2 messages)`);
        } else {
          console.log(`[agent] daily-compact done agent=${agentId} messages=${result.messagesCompacted}`);
        }
      } catch (err) {
        console.warn(`[agent] daily-compact failed agent=${agentId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    } finally {
      this.dailyCompactTickInProgress = false;
    }
  }

  /**
   * Tire une nouvelle scale aléatoire pour chaque LoRA ciblé par `shuffleCfg.ranges`,
   * mute la config runtime ET le YAML, persiste, et diffuse le patch WS (le slider du
   * front bouge en live). Appelé par le tick daily-compact AVANT le compact, pour que
   * le warmup post-compact réutilise la nouvelle scale. Synchrone (`configMod.save()`
   * est un writeFileSync, cf. saveConfigToFile).
   *
   * Robustesse :
   *  - pas de loraScales → no-op (rien à shuffler).
   *  - index hors de loraScales → skip + warn (la longueur du tableau est figée via l'UI LoRA scales).
   *  - min/max désordonnés → réordonnés. step ≤ 0 → 0.01 (2 décimales). Résultat clampé [0, 5].
   */
  private shuffleLoraForAgent(agentId: string, agentConfig: AgentConfig, shuffleCfg: LoraShuffleConfig): void {
    const scales = agentConfig.loraScales;
    if (!scales || scales.length === 0) {
      console.warn(`[agent] lora-shuffle skip agent=${agentId}: aucun loraScales configuré`);
      return;
    }
    const ranges = shuffleCfg.ranges ?? [];
    if (ranges.length === 0) {
      console.debug(`[agent] lora-shuffle skip agent=${agentId}: aucune plage (ranges vide)`);
      return;
    }

    const next = [...scales];
    const changes: Array<{ index: number; from: number; to: number; lo: number; hi: number; step: number }> = [];

    for (const r of ranges) {
      if (!Number.isInteger(r.index) || r.index < 0 || r.index >= next.length) {
        console.warn(`[agent] lora-shuffle skip range agent=${agentId} index=${r.index}: hors de loraScales (len=${next.length})`);
        continue;
      }
      const lo = Math.min(r.min, r.max);
      const hi = Math.max(r.min, r.max);
      const step = (typeof r.step === 'number' && r.step > 0) ? r.step : 0.01;
      const raw = lo + Math.random() * (hi - lo);
      const quantized = Math.round(raw / step) * step;
      const clamped = Math.max(0, Math.min(5, quantized));
      const value = Number(clamped.toFixed(4)); // tue le bruit flottant (0.30000000004 → 0.3)
      changes.push({ index: r.index, from: next[r.index]!, to: value, lo, hi, step });
      next[r.index] = value;
    }

    if (changes.length === 0) {
      console.debug(`[agent] lora-shuffle agent=${agentId}: aucune plage applicable`);
      return;
    }

    // Mute les DEUX représentations : runtime (lue par run.ts/warmup) + YAML (persistée).
    agentConfig.loraScales = next;
    const yaml = this.ctx.config.agents[agentId];
    if (yaml) yaml.loraScales = next;
    try {
      this.ctx.modules.get<ConfigModule>('config').save();
    } catch (err) {
      console.warn(`[agent] lora-shuffle persist failed agent=${agentId}: ${err instanceof Error ? err.message : err}`);
    }
    this.broadcastAgentConfigPatch(agentId, { loraScales: next });

    for (const c of changes) {
      console.log(`[agent] lora-shuffle agent=${agentId} #${c.index}: ×${c.from.toFixed(2)} → ×${c.to.toFixed(2)} (plage [${c.lo}, ${c.hi}] step ${c.step})`);
    }
  }

  /**
   * Boot-time GC of stale starred entries in `promptInjection`. Removes references to
   * shared/workspace files or skills that no longer exist on disk, then persists the
   * cleaned config to mastermind.local.yml. Without this, every prompt build emits a
   * [shared-memory] readFile miss warn for files that were starred once and later deleted.
   *
   * Runs once at init; the YAML stays the source of truth. If the user re-creates the
   * file later, they re-add it to YAML manually (or via the UI).
   */
  private async pruneStaleStarredEntries(sharedDir: string): Promise<void> {
    const configMod = this.ctx.modules.get<ConfigModule>('config');
    const skillsDirRaw = this.ctx.config.paths?.skillsDir;
    const skillsDirResolved = skillsDirRaw ? configMod.resolvePath(skillsDirRaw) : null;

    const fileExists = async (p: string): Promise<boolean> => {
      try { await fs.access(p); return true; } catch { return false; }
    };

    let prunedAny = false;
    const droppedReport: string[] = [];

    for (const [agentId, agentConfig] of this.agents) {
      const inj = agentConfig.promptInjection;
      if (!inj) continue;
      const yamlAgent = this.ctx.config.agents[agentId];
      const yamlInj = yamlAgent?.promptInjection;

      // Helper: filter a list keeping only entries whose absolute path exists.
      const filterList = async (
        list: string[] | undefined,
        baseDir: string | null,
        label: string,
      ): Promise<string[] | undefined> => {
        if (!list || list.length === 0) return list;
        if (!baseDir) return list; // no base dir configured → can't validate, keep as-is
        const kept: string[] = [];
        const dropped: string[] = [];
        for (const rel of list) {
          if (await fileExists(path.join(baseDir, rel))) kept.push(rel);
          else dropped.push(rel);
        }
        if (dropped.length > 0) {
          droppedReport.push(`${agentId}.${label}: -${dropped.length} (${dropped.join(', ')})`);
          prunedAny = true;
          return kept;
        }
        return list;
      };

      const newShared = await filterList(inj.sharedStarredFiles, sharedDir, 'sharedStarredFiles');
      const newWorkspace = await filterList(inj.workspaceStarredFiles, agentConfig.workspacePath, 'workspaceStarredFiles');
      const newSkills = await filterList(inj.starredSkills, skillsDirResolved, 'starredSkills');

      if (newShared !== inj.sharedStarredFiles) {
        inj.sharedStarredFiles = newShared;
        if (yamlInj) yamlInj.sharedStarredFiles = newShared;
      }
      if (newWorkspace !== inj.workspaceStarredFiles) {
        inj.workspaceStarredFiles = newWorkspace;
        if (yamlInj) yamlInj.workspaceStarredFiles = newWorkspace;
      }
      if (newSkills !== inj.starredSkills) {
        inj.starredSkills = newSkills;
        if (yamlInj) yamlInj.starredSkills = newSkills;
      }
    }

    if (prunedAny) {
      console.log(`[agent] pruned stale starred entries: ${droppedReport.join(' | ')}`);
      try {
        configMod.save();
        console.log('[agent] pruned starred entries persisted to mastermind.local.yml');
      } catch (err) {
        console.warn(`[agent] failed to persist pruned starred entries: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.debug('[agent] starred entries scan: nothing stale');
    }
  }

  getAgent(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  getState(agentId: string): AgentState {
    return this.states.get(agentId) ?? 'idle';
  }

  /** Add a new agent dynamically (persisted in config by the caller) */
  async addAgent(agentId: string, agentYaml: AgentYamlConfig): Promise<void> {
    const memoryMod = this.ctx.modules.get<MemoryModule>('memory');
    const identity = await parseIdentity(
      memoryMod.workspace,
      agentYaml.workspaceDir,
      agentId,
    );

    const isSubAgent = agentYaml.kind === 'subagent';
    const agentConfig: AgentConfig = {
      identity,
      workspacePath: path.resolve(this.ctx.config.paths.agentsDir, agentYaml.workspaceDir),
      model: agentYaml.model || this.ctx.config.defaults.model,
      enabled: agentYaml.enabled !== false,
      kind: agentYaml.kind ?? 'agent',
      maxContextTokens: agentYaml.maxContextTokens ?? this.ctx.config.defaults.maxContextTokens,
      maxCompletionTokens: agentYaml.maxCompletionTokens,
      contextMessages: agentYaml.contextMessages,
      autoCompactThreshold: agentYaml.autoCompactThreshold,
      dailyCompact: isSubAgent ? undefined : agentYaml.dailyCompact,
      telegram: isSubAgent ? undefined : agentYaml.telegram,
      tools: agentYaml.tools,
      promptInjection: agentYaml.promptInjection,
      captureReasoningTraces: agentYaml.captureReasoningTraces,
      thinkBudget: agentYaml.thinkBudget,
      bypassUnifiedCache: agentYaml.bypassUnifiedCache,
      lazySkills: agentYaml.lazySkills,
      skillCallMode: agentYaml.skillCallMode,
      excludeSharedMemory: agentYaml.excludeSharedMemory,
      delivery: isSubAgent ? undefined : agentYaml.delivery,
      unifiedSession: agentYaml.unifiedSession,
      loraScales: (agentYaml.loraScales && agentYaml.loraScales.length > 0)
          ? agentYaml.loraScales
          : (agentYaml.loraScale != null ? [agentYaml.loraScale] : undefined),
      allowedCallers: isSubAgent ? agentYaml.allowedCallers : undefined,
      caps: isSubAgent ? agentYaml.caps : undefined,
    };

    this.agents.set(agentId, agentConfig);
    this.states.set(agentId, 'idle');
    console.log(`[agent] Added ${isSubAgent ? 'sub-agent' : 'agent'}: ${agentId}`);
  }

  /** Update an existing agent's config in memory */
  updateAgentConfig(agentId: string, update: Partial<AgentYamlConfig>): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    invalidateTelegramPromptCache();

    if (update.model !== undefined && update.model !== agent.model) {
      const oldModel = agent.model;
      // Best-effort unload of the old model from Mercury VRAM (gated by defaults.autoUnloadOnSwitch).
      // Default behavior is to unload; set autoUnloadOnSwitch:false when a fleet of agents
      // share the same model so a switch doesn't force a reload.
      const shouldUnload = this.ctx.config.defaults.autoUnloadOnSwitch !== false;
      if (shouldUnload) {
        try {
          const providerMod = this.ctx.modules.get<ProviderModule>('provider');
          const { modelId } = providerMod.resolveModel(oldModel);
          const provider = this.ctx.config.providers.find(p => !!p.statsUrl && p.statsEnabled);
          if (provider) void unloadMercuryModel(provider, modelId);
        } catch { /* non-fatal */ }
      } else {
        console.debug(`[agent] autoUnloadOnSwitch=false — skipping unload of ${oldModel} for ${agentId}`);
      }
      agent.model = update.model;
      void this.clearStaleModelOverrides(agentId, oldModel);
    } else if (update.model !== undefined) {
      agent.model = update.model;
    }
    if (update.maxContextTokens !== undefined) agent.maxContextTokens = update.maxContextTokens;
    if (update.maxCompletionTokens !== undefined) agent.maxCompletionTokens = update.maxCompletionTokens;
    if (update.contextMessages !== undefined) agent.contextMessages = update.contextMessages;
    if (update.autoCompactThreshold !== undefined) agent.autoCompactThreshold = update.autoCompactThreshold;
    if (update.dailyCompact !== undefined) {
      agent.dailyCompact = update.dailyCompact;
      // Reset le marqueur "déjà tiré aujourd'hui" pour que le nouveau créneau soit honoré le jour même
      this.dailyCompactLastFired.delete(agentId);
    }
    if (update.workspaceDir !== undefined) agent.workspacePath = path.resolve(this.ctx.config.paths.agentsDir, update.workspaceDir);
    if (update.telegram !== undefined) agent.telegram = update.telegram;
    if (update.tools !== undefined) {
      agent.tools = { ...(agent.tools ?? {}), ...update.tools };
    }
    if (update.promptInjection !== undefined) {
      agent.promptInjection = update.promptInjection;
      this.autoWarmup?.updateWatchedFiles(agentId);
    }
    if (update.enabled !== undefined) agent.enabled = update.enabled;
    if (update.captureReasoningTraces !== undefined) agent.captureReasoningTraces = update.captureReasoningTraces;
    if (update.thinkBudget !== undefined) {
      const v = update.thinkBudget;
      agent.thinkBudget = (v === null || v === 'off') ? undefined : v;
    }
    if (update.bypassUnifiedCache !== undefined) agent.bypassUnifiedCache = update.bypassUnifiedCache;
    if (update.lazySkills !== undefined) agent.lazySkills = update.lazySkills;
    if (update.skillCallMode !== undefined) agent.skillCallMode = update.skillCallMode;
    if (update.excludeSharedMemory !== undefined) agent.excludeSharedMemory = update.excludeSharedMemory;
    // null (reset UI → policy legacy) arrive du PATCH route ; normalise en undefined.
    if (update.delivery !== undefined) agent.delivery = update.delivery ?? undefined;
    if (update.unifiedSession !== undefined) agent.unifiedSession = update.unifiedSession;
    if (update.loraScales !== undefined) {
      // null/[] → clear ; tableau non-vide → remplace. Pas de merge partiel.
      const next = update.loraScales;
      agent.loraScales = Array.isArray(next) && next.length > 0 ? next : undefined;
    }
    if (update.kind !== undefined) {
      const previousKind = agent.kind;
      agent.kind = update.kind;
      // Flipping TO 'subagent' : strip telegram + dailyCompact from in-memory config
      // (init/addAgent/reloadAllAgentsFromConfig already do this on hydration). Without
      // this, downstream code that reads agent.telegram (e.g. failJob notifications,
      // daily-compact tick) keeps seeing the old chat config until a full reload.
      // We do NOT mutate the YAML here — the caller's PUT body is what was just persisted;
      // a subsequent /reload-all-from-config would re-apply the kind-aware sanitation.
      if (update.kind === 'subagent' && previousKind !== 'subagent') {
        agent.telegram = undefined;
        agent.dailyCompact = undefined;
        // delivery suit la même règle que telegram : les 3 chemins d'hydratation le
        // strippent pour les sub-agents, le flip à chaud doit faire pareil.
        agent.delivery = undefined;
        this.dailyCompactLastFired.delete(agentId);
        this.autoWarmup?.removeAgent(agentId);
      }
      // Flipping BACK to 'agent' : drop sub-agent-only fields. Without this, a former
      // sub-agent re-promoted to main keeps stale `allowedCallers` + `caps` in YAML
      // (harmless at runtime since main-agent code paths ignore them, but pollutes the
      // config file and is misleading on inspection). Mirror the strip above.
      if (update.kind === 'agent' && previousKind === 'subagent') {
        agent.allowedCallers = undefined;
        agent.caps = undefined;
        const yaml = this.ctx.config.agents[agentId];
        if (yaml) {
          delete yaml.allowedCallers;
          delete yaml.caps;
        }
      }
    }
    if (update.allowedCallers !== undefined) agent.allowedCallers = update.allowedCallers;
    if (update.caps !== undefined) agent.caps = update.caps;

    console.log(`[agent] Updated config: ${agentId}`);
  }

  /** Liste les agents principaux (kind='agent' ou non spécifié). */
  listMainAgents(): AgentConfig[] {
    return Array.from(this.agents.values()).filter(a => a.kind !== 'subagent');
  }

  /** Liste les sub-agents (kind='subagent'). */
  listSubAgents(): AgentConfig[] {
    return Array.from(this.agents.values()).filter(a => a.kind === 'subagent');
  }

  /** True si l'agent est un sub-agent (one-shot, pas de chat direct). */
  isSubAgent(agentId: string): boolean {
    return this.agents.get(agentId)?.kind === 'subagent';
  }

  /**
   * Set the agent-level reasoning effort and persist to mastermind.local.yml.
   * Single source of truth — read by chat web, Telegram, scheduler.
   * Used by `/think` directive, Telegram think menu callback, and the agent config UI.
   */
  async setAgentThinkBudget(
    agentId: string,
    value: 'off' | 'low' | 'medium' | 'high' | null,
  ): Promise<'off' | 'low' | 'medium' | 'high' | undefined> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);
    const yaml = this.ctx.config.agents[agentId];
    if (!yaml) throw new Error(`Agent YAML "${agentId}" not found`);

    const next = value === null || value === 'off' ? undefined : value;
    if (next === undefined) {
      delete yaml.thinkBudget;
    } else {
      yaml.thinkBudget = next;
    }
    agent.thinkBudget = next;

    const configMod = this.ctx.modules.get<ConfigModule>('config');
    configMod.save();
    invalidateTelegramPromptCache();

    this.broadcastAgentConfigPatch(agentId, { thinkBudget: next ?? 'off' });

    console.log(`[agent] setAgentThinkBudget agent=${agentId} → ${next ?? 'off'}`);
    return next;
  }

  /** Broadcast un patch agent.config sur tous les clients WS connectés. */
  broadcastAgentConfigPatch(agentId: string, patch: import('@mastermind/shared').AgentConfigPatch): void {
    const ws = this.ctx.ws as WsManager;
    ws.broadcastAll({ type: 'agent.config', agentId, patch } satisfies WsServerMessage);
  }

  /** Lecture du reasoning effort agent-level (helper centralisé pour les call sites). */
  getAgentThinkBudget(agentId: string): 'off' | 'low' | 'medium' | 'high' {
    return this.agents.get(agentId)?.thinkBudget ?? 'off';
  }

  /** Re-parse IDENTITY.md from workspace and update the in-memory identity */
  async reloadIdentity(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);
    const memoryMod = this.ctx.modules.get<MemoryModule>('memory');
    const identity = await parseIdentity(memoryMod.workspace, agent.workspacePath, agentId);
    agent.identity = identity;
    console.log(`[agent] Reloaded identity: ${agentId} → ${identity.name}`);
  }

  /** Reload all agents from the current config (add/remove/update). */
  async reloadAllAgentsFromConfig(): Promise<void> {
    const memoryMod = this.ctx.modules.get<MemoryModule>('memory');
    invalidateTelegramPromptCache();

    const desiredIds = new Set(Object.keys(this.ctx.config.agents));

    // Remove agents no longer present in config.
    for (const existingId of [...this.agents.keys()]) {
      if (!desiredIds.has(existingId)) this.removeAgent(existingId);
    }

    // Add/update all agents from config.
    for (const [agentId, agentYaml] of Object.entries(this.ctx.config.agents)) {
      // Stop any run to avoid mixing old/new config during execution.
      this.abort(agentId);

      const oldAgent = this.agents.get(agentId);
      const oldModel = oldAgent?.model;

      const identity = await parseIdentity(memoryMod.workspace, agentYaml.workspaceDir, agentId);

      const isSubAgent = agentYaml.kind === 'subagent';
      const agentConfig: AgentConfig = {
        identity,
        workspacePath: path.resolve(this.ctx.config.paths.agentsDir, agentYaml.workspaceDir),
        model: agentYaml.model || this.ctx.config.defaults.model,
        enabled: agentYaml.enabled !== false,
        kind: agentYaml.kind ?? 'agent',
        maxContextTokens: agentYaml.maxContextTokens ?? this.ctx.config.defaults.maxContextTokens,
        maxCompletionTokens: agentYaml.maxCompletionTokens,
        contextMessages: agentYaml.contextMessages,
        autoCompactThreshold: agentYaml.autoCompactThreshold,
        dailyCompact: isSubAgent ? undefined : agentYaml.dailyCompact,
        telegram: isSubAgent ? undefined : agentYaml.telegram,
        tools: agentYaml.tools,
        promptInjection: agentYaml.promptInjection,
        captureReasoningTraces: agentYaml.captureReasoningTraces,
        thinkBudget: agentYaml.thinkBudget,
        bypassUnifiedCache: agentYaml.bypassUnifiedCache,
        lazySkills: agentYaml.lazySkills,
        skillCallMode: agentYaml.skillCallMode,
        excludeSharedMemory: agentYaml.excludeSharedMemory,
        delivery: isSubAgent ? undefined : agentYaml.delivery,
        unifiedSession: agentYaml.unifiedSession,
        loraScales: (agentYaml.loraScales && agentYaml.loraScales.length > 0)
          ? agentYaml.loraScales
          : (agentYaml.loraScale != null ? [agentYaml.loraScale] : undefined),
        allowedCallers: isSubAgent ? agentYaml.allowedCallers : undefined,
        caps: isSubAgent ? agentYaml.caps : undefined,
      };

      this.agents.set(agentId, agentConfig);
      this.states.set(agentId, 'idle');

      // If the config model changed, clear stale session overrides pointing to the old model
      if (oldModel && oldModel !== agentConfig.model) {
        void this.clearStaleModelOverrides(agentId, oldModel);
      }
    }

    console.log(`[agent] Reloaded ${this.agents.size} agent(s) from config`);

    // Re-sync les watchers de fichiers starred après rechargement (main agents only)
    for (const [agentId, cfg] of this.agents) {
      if (cfg.kind === 'subagent') continue;
      this.autoWarmup?.updateWatchedFiles(agentId);
    }
  }

  /** Remove an agent (persisted in config by the caller) */
  removeAgent(agentId: string): void {
    this.abort(agentId);
    invalidateTelegramPromptCache();
    this.agents.delete(agentId);
    this.states.delete(agentId);
    this.dailyCompactLastFired.delete(agentId);
    this.autoWarmup?.removeAgent(agentId);
    console.log(`[agent] Removed agent: ${agentId}`);
  }

  isSharedFileStarred(agentId: string, filePath: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    const target = normalizePromptPath(filePath);
    if (!target) return false;
    const starred = agent.promptInjection?.sharedStarredFiles ?? [];
    return starred.some(p => normalizePromptPath(p) === target);
  }

  isSharedFileStarredByAnyAgent(filePath: string): boolean {
    const target = normalizePromptPath(filePath);
    if (!target) return false;
    for (const agent of this.agents.values()) {
      const starred = agent.promptInjection?.sharedStarredFiles ?? [];
      if (starred.some(p => normalizePromptPath(p) === target)) return true;
    }
    return false;
  }

  /**
   * If the modelOverride equals the agent's config model, convert to null (clear)
   * so we never persist a redundant override that could become stale.
   */
  private normalizeModelOverride(agentId: string, updates: SessionUpdate): SessionUpdate {
    if (updates.modelOverride != null) {
      const agent = this.agents.get(agentId);
      if (agent && updates.modelOverride === agent.model) {
        return { ...updates, modelOverride: null };
      }
    }
    return updates;
  }

  /**
   * Clear persisted modelOverrides that point to `oldModel` for all sessions of an agent.
   * Called when the agent's config model changes so stale overrides don't keep the old model loaded.
   */
  private async clearStaleModelOverrides(agentId: string, oldModel: string): Promise<void> {
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const ws = this.ctx.ws as WsManager;
    try {
      const sessions = await sessionMod.listByAgent(agentId);
      for (const s of sessions) {
        const opts = await sessionMod.loadOptions(s.id);
        if (opts.modelOverride && opts.modelOverride === oldModel) {
          delete opts.modelOverride;
          this.sessionOptions.set(s.id, opts);
          await sessionMod.saveOptions(s.id, opts as Record<string, unknown>);
          ws.broadcast(s.id, { type: 'session.options', sessionId: s.id, options: opts } satisfies WsServerMessage);
          console.log(`[agent] Cleared stale modelOverride=${oldModel} from session=${s.id}`);
        }
      }
    } catch (err) {
      console.error(`[agent] Failed to clear stale model overrides for ${agentId}:`, err);
    }
  }

  getSessionOptions(sessionId: string): SessionOptions {
    return this.sessionOptions.get(sessionId) ?? {};
  }

  clearSessionOptions(sessionId: string): void {
    this.sessionOptions.delete(sessionId);
    invalidatePromptCache(sessionId);
  }

  /** Load options from DB into memory and return them (call on session subscribe) */
  async loadSessionOptions(sessionId: string): Promise<SessionOptions> {
    if (this.sessionOptions.has(sessionId)) {
      return this.sessionOptions.get(sessionId)!;
    }
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const raw = await sessionMod.loadOptions(sessionId) as SessionOptions & { telegramReasoningDisplay?: boolean };
    // Legacy migration: old boolean telegramReasoningDisplay → tri-state telegramReasoningMode.
    // false (hide) → 'off'. true/missing → default 'full' (don't store).
    if ('telegramReasoningDisplay' in raw) {
      if (raw.telegramReasoningDisplay === false && raw.telegramReasoningMode === undefined) {
        raw.telegramReasoningMode = 'off';
      }
      delete raw.telegramReasoningDisplay;
    }
    const opts = raw as SessionOptions;
    if (Object.keys(opts).length > 0) {
      this.sessionOptions.set(sessionId, opts);
      console.debug(`[agent] loadSessionOptions session=${sessionId} fromDB keys=${Object.keys(opts).join(',')}`);
    }
    return opts;
  }

  /** Run a message through an agent */
  async run(
    agentId: string,
    sessionId: string,
    rawContent: string,
    source: MessageSource = 'web',
    runOptions?: {
      onChunk?: (chunk: string) => void;
      onToolCall?: (event: {
        type: 'start' | 'done';
        name: string;
        args: Record<string, unknown>;
        output?: string;
        durationMs?: number;
        error?: string;
      }) => void;
      /** Called with live Mercury stats during prefill/loading phases */
      onMercuryStats?: (stats: Partial<ProviderStats>) => void;
      /** Vision images attached to the user message */
      images?: MessageImage[];
      /** Called when auto-compact triggers, with the notification text */
      onCompact?: (msg: string) => void;
      /** Called once when the run flips into a hidden mode mid-flight (sandbox). Consumers
       * use this to finalize their streaming display (close the cursor, stop typing). */
      onHideStreaming?: (finalContent: string) => void | Promise<void>;
      /** Active proactive/escalation run id — links this run to scheduler.activeRunContexts */
      activeRunId?: string;
      /** Native visible channel to use if the run becomes hidden. */
      visibleSource?: MessageSource;
      /**
       * Per-run override for the send_to_user safety net. When false, the proactive
       * web/Telegram autodeliver fallbacks at end-of-run are skipped — the agent's
       * silent finish is preserved. Default true (existing behaviour).
       */
      autoDeliver?: boolean;
      /** Override de canaux de réveil hérité de la tâche/source planifiée (UI) — cf. resolveDelivery. */
      deliveryChannels?: Array<'mobile' | 'telegram'>;
      /**
       * Run d'origine vocale (NCM) avec « masquer le transcript » actif : le push APNs
       * interactif de fin de run notifie sans révéler la réponse en clair. Cf. run.ts bloc (B).
       */
      hidePushTranscript?: boolean;
      /** Per-run override for max tool turns (war rooms use this to cap tool calls per turn) */
      maxToolTurnsOverride?: number;
      /**
       * Warmup mode: build the live payload, send it with `max_completion_tokens=1`,
       * discard the response. No DB writes, no chat broadcasts. Skips directives parsing,
       * opening-hours check, autoWarmup activity notification. Emits `warming` → `warm.done`
       * lifecycle events. Caller usually passes `rawContent: ''` and the synthetic warmup
       * message is appended in-memory by `buildLlmPayload`.
       */
      warmup?: boolean;
      /** Async job sub_agent : livraison parent + état mutable (outil submit_subagent_report). */
      subAgentDelivery?: SubAgentDeliveryContext;
      subAgentDeliveryState?: SubAgentDeliveryState;
      /** Sub-agent only — plafond TOTAL d'appels d'outils (parallèles compris). */
      subAgentToolCallsCap?: number | null;
      /** Sub-agent only — compteur partagé incrémenté à chaque dispatch (sauf submit). */
      subAgentToolCallsCounter?: { count: number };
    },
  ): Promise<string> {
    const agentConfig = this.agents.get(agentId);
    if (!agentConfig) throw new Error(`Agent "${agentId}" not found`);
    if (agentConfig.enabled === false) throw new Error(`Agent "${agentId}" is disabled`);

    const isWarmup = runOptions?.warmup === true;

    // Warmup runs skip the busy/conflict checks at user-flow level: they're queued
    // by `autoWarmup` which already gates on `state==='idle'` + no in-flight run.
    // If a real user run kicks off in parallel anyway, the runPromises ordering above
    // serialises us and the warm just becomes a slightly delayed prefill.
    if (isWarmup) {
      if (this.states.get(agentId) !== 'idle') {
        console.log(`[warm] ${agentId} is busy (${this.states.get(agentId)}), skipping`);
        return '';
      }
      if (this.runPromises.has(agentId)) {
        console.log(`[warm] ${agentId} has an active operation, skipping`);
        return '';
      }
    }

    // Opening hours don't apply to:
    //  - warmups (system task)
    //  - sub-agent runs (already-active parent's work)
    //  - proactive runs (scheduler-driven OR sub-agent-triggered handler re-runs — the
    //    work was already authorised when the trigger fired; gating the synthesis at run
    //    time would silently swallow the deliverable, see audit finding 1)
    const oh = this.ctx.config.openingHours;
    if (!isWarmup && source !== 'subagent' && source !== 'proactive' && oh?.enabled && !oh.overrideOpen) {
      const h = new Date().getHours();
      const closed = oh.closedStart <= oh.closedEnd
        ? h >= oh.closedStart && h < oh.closedEnd
        : h >= oh.closedStart || h < oh.closedEnd;
      if (closed) {
        const msg = `Hors horaires d'ouverture (ferme de ${oh.closedStart}h a ${oh.closedEnd}h). Desactivez le mode dans Settings pour forcer.`;
        (this.ctx.ws as WsManager).broadcastAll({
          type: 'chat.error',
          sessionId,
          agentId,
          error: msg,
        } satisfies WsServerMessage);
        throw new Error(msg);
      }
    }

    const memoryMod = this.ctx.modules.get<MemoryModule>('memory');
    const configMod = this.ctx.modules.get<ConfigModule>('config');
    const environmentPaths = resolveEnvironmentPaths(
      configMod,
      this.ctx.config.paths,
      agentConfig,
      agentConfig.identity.id,
      memoryMod.shared.dir,
    );

    const ws = this.ctx.ws as WsManager;

    // Parse slash-command directives and strip them from the content. Warmup runs skip
    // this entirely: directives can have side effects (compactSession writes DB,
    // setAgentThinkBudget writes config, sessionMod.saveOptions writes DB, broadcasts
    // session.options). The contract for `warmup: true` is "build the same payload as
    // a live run, no side effects" — even if a caller mistakenly passes a slash command
    // string, we treat it as raw content (which is then ignored anyway by the warmup
    // synthetic-message fallback in buildLlmPayload).
    const directives = parseDirectives(isWarmup ? '' : rawContent);

    if (!isWarmup) {
      // Handle /compact command: summarize conversation, save to workspace, clear messages, reinject summary
      if (directives.commandResponse === '__compact__') {
        console.log(`[agent] /compact command agent=${agentId} session=${sessionId}`);
        const result = await this.compactSession(agentId, sessionId, source, 'user');
        if (!result) {
          directives.commandResponse = '⚠ Pas assez de messages à compacter.';
        } else {
          directives.commandResponse = `✓ Contexte compacté: ${result.messagesCompacted} messages → résumé. Archive froide: \`${result.archivePath}\``;
          directives.isCommandOnly = true;
        }
      }

      // Handle /status command: delegate to generateStatusText
      if (directives.commandResponse === '__status__') {
        directives.commandResponse = await this.generateStatusText(sessionId, agentId);
      }

      // Apply agent-level updates first (thinkBudget) — single source of truth shared across canaux.
      const hasAgentUpdates = Object.keys(directives.agentUpdates).length > 0;
      if (hasAgentUpdates && directives.agentUpdates.thinkBudget !== undefined) {
        try {
          await this.setAgentThinkBudget(agentId, directives.agentUpdates.thinkBudget);
        } catch (err) {
          console.error(`[agent] /think failed to persist agent-level value: ${err}`);
        }
      }

      // Apply updates to session options and persist to DB
      const hasUpdates = Object.keys(directives.updates).length > 0;
      if (hasUpdates) {
        console.debug(`[agent] applying session updates session=${sessionId}: ${JSON.stringify(directives.updates)}`);
        const current = this.getSessionOptions(sessionId);
        const next = applyUpdate(current, this.normalizeModelOverride(agentId, directives.updates));
        if (Object.keys(next).length === 0) {
          this.sessionOptions.delete(sessionId);
        } else {
          this.sessionOptions.set(sessionId, next);
        }
        // Persist to DB so options survive backend restarts and tab switches.
        // getOrCreate MUST be called first: saveOptions uses UPDATE which silently
        // no-ops if the session row doesn't exist yet (e.g. first Telegram message).
        // MUST be awaited — fire-and-forget caused race conditions where DB reads
        // returned stale options before the write completed (model "jump back" bug).
        const sessionMod = this.ctx.modules.get<SessionModule>('session');
        try {
          await sessionMod.getOrCreate(sessionId, agentId);
          await sessionMod.saveOptions(sessionId, this.getSessionOptions(sessionId) as Record<string, unknown>);
        } catch (err) {
          console.error(`[agent] Failed to persist session options: ${err}`);
        }
        ws.broadcast(sessionId, {
          type: 'session.options',
          sessionId,
          options: this.getSessionOptions(sessionId),
        } satisfies WsServerMessage);
      }

      // For command-only messages that only update options (no /help, /status text),
      // generate a brief ack so the LLM is NOT called.
      if (directives.isCommandOnly && !directives.commandResponse && (hasUpdates || hasAgentUpdates)) {
        const opts = this.getSessionOptions(sessionId);
        const parts: string[] = [];
        if (directives.agentUpdates.thinkBudget !== undefined) {
          const v = this.getAgentThinkBudget(agentId);
          parts.push(`think → ${v} (agent)`);
        }
        if ('modelOverride' in directives.updates) {
          parts.push(opts.modelOverride ? `model → ${opts.modelOverride}` : 'model → défaut');
        }
        if ('temperatureOverride' in directives.updates) {
          parts.push(opts.temperatureOverride !== undefined ? `temp → ${opts.temperatureOverride}` : 'temp → défaut');
        }
        if ('toolsDisabled' in directives.updates) {
          parts.push(opts.toolsDisabled ? 'tools → off' : 'tools → on');
        }
        if ('toolsHidden' in directives.updates) {
          parts.push(opts.toolsHidden ? 'tools display → hide' : 'tools display → show');
        }
        if ('telegramStreaming' in directives.updates) {
          parts.push(opts.telegramStreaming ? 'streaming → on' : 'streaming → off');
        }
        if ('telegramMercuryStatus' in directives.updates) {
          parts.push(opts.telegramMercuryStatus ? 'processing → on' : 'processing → off');
        }
        directives.commandResponse = `✓ ${parts.join(' · ')}`;
      }
    }

    // Merge session options as the effective run config
    const opts = this.getSessionOptions(sessionId);
    // Use cleaned content (directives stripped); fall back to rawContent only when there IS actual text.
    // In warmup, both directives.cleanedContent and rawContent are empty/ignored → buildLlmPayload
    // substitutes the canonical WARMUP_USER_CONTENT synthetic.
    const content = isWarmup ? '' : (directives.cleanedContent || (directives.isCommandOnly ? '' : rawContent));
    const runStartedAt = Date.now();
    console.log(
      `[agent] run requested agent=${agentId} session=${sessionId} source=${source} rawLen=${rawContent.length} contentLen=${content.length} commandOnly=${directives.isCommandOnly} model=${opts.modelOverride ?? agentConfig.model} images=${runOptions?.images?.length ?? 0}`,
    );

    // Don't abort on warmup — a warmup is non-disruptive and runs only when the agent
    // is already idle (gated above). Calling abort() here would also cancel a freshly
    // started user run that raced past the busy check.
    if (!isWarmup) this.abort(agentId);

    // ── Serialization gate (audit M1) ──────────────────────────────────────────
    // Capture the predecessor's gate AND install our own placeholder SYNCHRONOUSLY
    // (no await between the two reads/writes — JS is single-threaded so this block is
    // atomic). Without the synchronous install, two arrivals that both `await` the SAME
    // predecessor P would both resume when P resolves and then both `set` the controller
    // and runPromise — orphaning one controller and running two runAgent loops on the
    // same agent (interleaved history / KV corruption on a shared session). With it, a
    // later arrival reads THIS run's placeholder as its predecessor and chains behind us,
    // preserving "one run at a time per agent". `settleGate` is invoked in the finally so
    // awaiters never hang; we keep the slot pointed at our placeholder until the real
    // tracked promise replaces it at runPromises.set below.
    const predecessorGate = this.runPromises.get(agentId);
    let settleGate!: () => void;
    const gate = new Promise<void>((resolve) => { settleGate = resolve; });
    this.runPromises.set(agentId, gate);

    // Await previous run's cleanup (partial response save) before starting new one.
    //
    // This `await` is the only throwable point between installing our placeholder gate
    // above and entering the main try/finally below (which owns `settleGate()`). If it —
    // or any future throwable inserted in this pre-try window — were to reject, the gate
    // would never settle and EVERY future run() for this agent would hang forever on
    // `await predecessorGate`. Guard the window with its own try/catch that settles the
    // gate and re-throws. `settleGate()` is idempotent; on the normal (non-throwing) path
    // the gate is settled by the main `finally` as before, so behaviour is unchanged.
    try {
      if (predecessorGate) {
        console.debug(`[agent] awaiting previous run cleanup for ${agentId}`);
        await predecessorGate.catch(() => {});
      }
    } catch (err) {
      settleGate();
      throw err;
    }

    const controller = new AbortController();
    // Register into the per-agent Set (never replace a sibling's controller — see M1).
    let controllers = this.abortControllers.get(agentId);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.abortControllers.set(agentId, controllers);
    }
    controllers.add(controller);
    this.states.set(agentId, isWarmup ? 'warming' : 'thinking');

    // ── Mercury SSE stats subscription ─────────────────────────────────────────
    // Subscribe to real-time provider stats (loading, prompt processing) for the
    // duration of the prefill phase. Aborted on first generated token or run end.
    const mercuryAbort = new AbortController();
    let mercuryStarted = false;

    // Live Activity (mobile app) : pousse la progression du préfill via APNs pour que la jauge
    // avance tel verrouillé / app suspendue (le moteur local de mobile app est gelé en arrière-plan).
    // Même garde de politique que broadcastAgentState (run.ts) : 'all' = tous, 'user' = pas les
    // proactifs, 'off' = jamais. Warmup exclu (invisible, aucune Island). No-op si aucun token LA
    // enregistré pour la session.
    const laProgressMod = this.ctx.modules.tryGet<PushModule>('push');
    const laProgressMode = agentConfig.delivery?.liveActivity ?? 'all';
    const laProgressAllowed = !isWarmup && (laProgressMode === 'all' || (laProgressMode === 'user' && source !== 'proactive'));

    const effectiveModel = opts.modelOverride ?? agentConfig.model;
    try {
      const providerMod = this.ctx.modules.get<ProviderModule>('provider');
      const { providerId, modelId } = providerMod.resolveModel(effectiveModel);
      let provider = this.ctx.config.providers.find(p => p.id === providerId);
      if (!provider?.statsUrl || !provider.statsEnabled) {
        provider = this.ctx.config.providers.find(p => !!p.statsUrl && p.statsEnabled === true);
      }
      if (provider?.statsUrl && provider.statsEnabled) {
        mercuryStarted = true;
        console.debug(`[agent] mercury stats subscribed agent=${agentId} session=${sessionId} provider=${provider.id} model=${modelId}`);
        void streamMercuryStats(provider, modelId, (stats) => {
          // Broadcast to web clients
          ws.broadcastAll({
            type: 'provider.stats',
            agentId,
            sessionId,
            stats: { ts: new Date().toISOString(), ...stats },
          } satisfies WsServerMessage);
          // Notify Telegram or other callers
          runOptions?.onMercuryStats?.(stats);
          // Pousse la progression hors-app (Island tel verrouillé), throttlé côté push module.
          if (laProgressAllowed) void laProgressMod?.pushLiveActivityProgress(sessionId, agentId, stats).catch(() => {});
        }, mercuryAbort.signal);
      }
    } catch (err) {
      console.debug(`[agent] mercury stats unavailable agent=${agentId} model=${effectiveModel}: ${err instanceof Error ? err.message : err}`);
    }

    // On first generated token, clear the initial prompt-processing indicator.
    // SSE stats stream stays alive for the whole run (captures mid-run re-prompts between tool calls).
    let firstChunkSeen = false;
    const wrappedOnChunk = (chunk: string) => {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        console.debug(`[agent] first chunk agent=${agentId} session=${sessionId} afterMs=${Date.now() - runStartedAt}`);
        // Clear initial prompt processing state — generation has started
        ws.broadcastAll({
          type: 'provider.stats',
          agentId,
          sessionId,
          stats: { ts: new Date().toISOString(), isPromptProcessing: false, isLoading: false },
        } satisfies WsServerMessage);
        // Pas de clear LA explicite ici : la transition `broadcastAgentState('streaming')`
        // (run.ts) pousse déjà phase=streaming SANS detail/progress → la jauge de préfill
        // disparaît côté Island. Un clear phase='thinking' ici provoquerait un flicker
        // streaming→thinking si la transition l'avait précédé.
      }
      runOptions?.onChunk?.(chunk);
    };
    // ──────────────────────────────────────────────────────────────────────────

    let trackedRun: Promise<void> | undefined;
    try {
      const configMod = this.ctx.modules.get<ConfigModule>('config');
      // Resolve vision fallback provider (uses statsUrl to call Mercury /admin/vision/describe)
      let visionFallbackProvider: import('@mastermind/shared').ProviderConfig | undefined;
      if (runOptions?.images && runOptions.images.length > 0) {
        try {
          const { providerId } = this.ctx.modules.get<ProviderModule>('provider').resolveModel(effectiveModel);
          let candidate = this.ctx.config.providers.find(p => p.id === providerId);
          if (!candidate?.visionFallbackEnabled) {
            candidate = this.ctx.config.providers.find(p => p.visionFallbackEnabled === true && !!p.statsUrl);
          }
          visionFallbackProvider = candidate;
        } catch { /* non-fatal */ }
      }

      // Resolve reasoning provider (any provider with statsUrl — Mercury handles model config)
      const reasoningProvider = this.ctx.config.providers.find(p => !!p.statsUrl);

      const runComplete = runAgent({
        agentConfig,
        sessionId,
        content,
        source,
        sessionMod: this.ctx.modules.get<SessionModule>('session'),
        providerMod: this.ctx.modules.get<ProviderModule>('provider'),
        memoryMod,
        ws,
        signal: controller.signal,
        toolDefaults: this.ctx.config.defaults.toolDefaults,
        defaultPromptCacheTtl: this.ctx.config.defaults.promptCacheTtl,
        sessionOptions: opts,
        directives,
        images: runOptions?.images,
        visionFallbackProvider,
        reasoningProvider,
        braveApiKey: this.ctx.config.search?.braveApiKey,
        environmentPaths,
        codebaseSearchContext: {
          config: this.ctx.config,
          resolvePath: (p: string) => configMod.resolvePath(p),
        },
        onChunk: wrappedOnChunk,
        onToolCall: runOptions?.onToolCall,
        onCompact: runOptions?.onCompact,
        onHideStreaming: runOptions?.onHideStreaming,
        db: this.ctx.db,
        memoryStoreMod: this.ctx.modules.tryGet<MemoryStoreModule>('memory-store'),
        reasoningTraceStore: agentConfig.captureReasoningTraces ? this.reasoningTraceStore : undefined,
        skillActionsMod: this.ctx.modules.tryGet<SkillActionsModule>('skill-actions'),
        schedulerMod: this.ctx.modules.tryGet<SchedulerModule>('scheduler'),
        asyncJobsMod: this.ctx.modules.tryGet<AsyncJobsModule>('async-jobs'),
        templatesMod: this.ctx.modules.tryGet<import('../prompt-templates/index.js').PromptTemplatesModule>('prompt-templates'),
        telegramMod: this.ctx.modules.tryGet<TelegramModule>('telegram'),
        pushMod: this.ctx.modules.tryGet<PushModule>('push'),
        mastermindConfig: this.ctx.config,
        activeRunId: runOptions?.activeRunId,
        visibleSource: runOptions?.visibleSource,
        autoDeliver: runOptions?.autoDeliver,
        deliveryChannels: runOptions?.deliveryChannels,
        hidePushTranscript: runOptions?.hidePushTranscript,
        agentsList: this.listAgents(),
        maxToolTurnsOverride: runOptions?.maxToolTurnsOverride,
        boardMod: this.ctx.modules.tryGet<BoardModule>('board'),
        warmup: isWarmup,
        // Resolve at run-time from config so a hot-config change (Settings UI) takes
        // effect on the next run without restart.
        //
        // `stripThink` resolution:
        //  1. Explicit `stripThinkBlocks` in YAML (power-user override) — honored as-is.
        //  2. Else default to FALSE (keep think) — favours max KV-cache prefix hit, which
        //     matters more than token savings on local single-slot LLMs.
        //
        // `cacheOptimized` controls whether the send_to_user visible-content duplicate
        // rows are filtered out of the rebuilt history (= "cache-optimized" mode), or
        // kept for full LLM context. Default true.
        stripThink: this.ctx.config.defaults.stripThinkBlocks ?? false,
        cacheOptimized: this.ctx.config.defaults.cacheOptimized ?? true,
        subAgentDelivery: runOptions?.subAgentDelivery,
        subAgentDeliveryState: runOptions?.subAgentDeliveryState,
        subAgentToolCallsCap: runOptions?.subAgentToolCallsCap,
        subAgentToolCallsCounter: runOptions?.subAgentToolCallsCounter,
      });

      // Track the run promise so the next run/warmup/compact can await its cleanup.
      // This replaces the synchronous gate placeholder for FUTURE arrivals; siblings that
      // already captured the placeholder are released when `settleGate()` fires in finally.
      trackedRun = runComplete.then(() => {}).catch(() => {});
      this.runPromises.set(agentId, trackedRun);

      const result = await runComplete;
      // Don't reset the auto-warmup idle timer when the run we just finished IS itself
      // a warmup — would loop the queue indefinitely. Only real user activity resets it.
      if (!isWarmup) this.autoWarmup?.notifyActivity(agentId, sessionId);
      // StatusBar WarmupBadge tracks the latest successful warmup per agent via this event.
      if (isWarmup) {
        ws.broadcastAll({
          type: 'warmup.agent.done',
          agentId,
          completedAt: new Date().toISOString(),
        } satisfies WsServerMessage);
      }
      console.log(`[agent] ${isWarmup ? 'warmup' : 'run'} resolved agent=${agentId} session=${sessionId} chars=${result.length} ms=${Date.now() - runStartedAt}`);
      return result;
    } catch (err) {
      this.states.set(agentId, 'error');
      console.error(`[agent] run failed agent=${agentId} session=${sessionId} ms=${Date.now() - runStartedAt}: ${err instanceof Error ? err.message : err}`);
      throw err;
    } finally {
      if (!mercuryAbort.signal.aborted) mercuryAbort.abort();
      // Remove ONLY this run's controller from the agent's Set (never wipe a sibling's).
      const controllers = this.abortControllers.get(agentId);
      if (controllers) {
        controllers.delete(controller);
        if (controllers.size === 0) this.abortControllers.delete(agentId);
      }
      // Clear the runPromises slot only if it still points at one of OUR handles — the
      // placeholder gate (run threw before the trackedRun swap) or the tracked promise.
      // A newer run may already have installed its own gate; don't clobber it.
      const slot = this.runPromises.get(agentId);
      if (slot === gate || (trackedRun && slot === trackedRun)) {
        this.runPromises.delete(agentId);
      }
      // Release any sibling still awaiting our placeholder gate (e.g. a run that captured
      // it as predecessor before the trackedRun swap). Idempotent.
      settleGate();
      this.states.set(agentId, 'idle');
      // Broadcast a final transient-state clear so the gauge resets even if no SSE
      // tick happened between first chunk and run end (short replies, errors, aborts).
      // Idempotent with the wrappedOnChunk first-chunk clear; redundant by design.
      ws.broadcastAll({
        type: 'provider.stats',
        agentId,
        sessionId,
        stats: { ts: new Date().toISOString(), isPromptProcessing: false, isLoading: false },
      } satisfies WsServerMessage);
      // Belt-and-suspenders agent.state idle for the SANDBOX stuck-badge case (see the
      // run.ts broadcastAgentState helper for the full chain). The inner runAgent()
      // already broadcasts this in its own finally; re-emitting here covers the edge
      // case where that single broadcast gets dropped (tab backgrounded, transient
      // disconnect) and the StatusBar's liveAgentStates['sandbox'] stays stuck.
      //
      // Skipped for warmup: runAgent's finally remaps 'idle'→'warm.done' for warmup runs,
      // so emitting a raw 'idle' here would clobber that lifecycle (the StatusBar would
      // see warming → warm.done → idle and the WarmupBadge transition logic loses the
      // distinction). Warmup never enters sandbox mode, so the backstop isn't needed.
      if (!isWarmup) {
        ws.broadcastAll({ type: 'agent.state', agentId, state: 'idle' } satisfies WsServerMessage);
      }
      console.debug(`[agent] ${isWarmup ? 'warmup' : 'run'} cleanup agent=${agentId} session=${sessionId} state=idle mercuryStarted=${mercuryStarted}`);
    }
  }

  /**
   * Generate the same status text as /status, without creating DB messages.
   * Used by the Telegram inline keyboard status button.
   */
  async generateStatusText(sessionId: string, agentId: string): Promise<string> {
    const agentConfig = this.agents.get(agentId);
    if (!agentConfig) return '⚠ Agent introuvable.';

    const currentOpts = this.getSessionOptions(sessionId);
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const providerMod = this.ctx.modules.get<ProviderModule>('provider');
    const memoryMod = this.ctx.modules.get<MemoryModule>('memory');
    const configMod = this.ctx.modules.get<ConfigModule>('config');

    const environmentPaths = resolveEnvironmentPaths(
      configMod,
      this.ctx.config.paths,
      agentConfig,
      agentId,
      memoryMod.shared.dir,
    );

    let systemPromptChars = 0;
    try {
      const isMainSession = !sessionId.includes('-tg-');
      const codebaseSearchToolNote = buildCodebaseSearchToolNote(
        this.ctx.config,
        (p) => configMod.resolvePath(p),
        agentConfig,
        agentId,
      );
      const systemPrompt = await assembleSystemPrompt(memoryMod, {
        agentConfig,
        sessionId,
        isMainSession,
        environmentPaths,
        codebaseSearchToolNote,
        agentsList: this.listAgents(),
      });
      systemPromptChars = systemPrompt.length;
    } catch { /* ignore */ }

    const historyLimit = agentConfig.contextMessages ?? 20;
    const allMessages = await sessionMod.getMessages(sessionId, 500);
    const windowMessages = await sessionMod.getMessages(sessionId, historyLimit);
    const messageChars = windowMessages.reduce((sum, m) => sum + m.content.length, 0);

    const systemTokens = Math.round(systemPromptChars / 4);
    const messageTokens = Math.round(messageChars / 4);
    const estimatedTokens = systemTokens + messageTokens;
    const maxTokens = agentConfig.maxContextTokens ?? 8000;
    const pct = Math.min(100, Math.round((estimatedTokens / maxTokens) * 100));
    const barLen = 20;
    const filled = Math.round((pct / 100) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

    const effectiveModel = currentOpts.modelOverride ?? agentConfig.model;
    let providerId = '';
    try { providerId = providerMod.resolveModel(effectiveModel).providerId; } catch { /* ignore */ }

    let live: ProviderStats | null = null;
    try {
      const resolved = providerMod.resolveModel(effectiveModel);
      let provider = this.ctx.config.providers.find(p => p.id === resolved.providerId);
      if (!provider?.statsUrl || !provider.statsEnabled || provider.chatStatsmercuryEnabled === false) {
        provider = this.ctx.config.providers.find(p =>
          !!p.statsUrl && p.statsEnabled === true && p.chatStatsmercuryEnabled !== false,
        );
      }
      if (provider?.statsUrl && provider.statsEnabled && provider.chatStatsmercuryEnabled !== false) {
        const slashIdx = resolved.modelId.indexOf('/');
        const prefix = slashIdx !== -1 ? resolved.modelId.slice(0, slashIdx).toLowerCase() : '';
        const key = slashIdx !== -1 ? resolved.modelId.slice(slashIdx + 1) : resolved.modelId;
        let adminPath = '';
        // vllm partage les routes /admin/llamacpp/... du brain-daemon
        if (prefix === 'llamacpp' || prefix === 'vllm') adminPath = `/admin/llamacpp/session/${key}`;
        else if (prefix === 'ollama') adminPath = `/admin/ollama/session/${key}`;
        else if (prefix === 'lm-studio' || prefix === 'lmstudio') adminPath = `/admin/lm-studio/session/${encodeURIComponent(key)}`;
        if (adminPath) {
          const headers: Record<string, string> = {};
          const statsToken = provider.statsApiKey || provider.apiKey;
          if (statsToken) headers['Authorization'] = `Bearer ${statsToken}`;
          const res = await fetch(`${provider.statsUrl}${adminPath}`, { headers, signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            const raw = await res.json() as Record<string, unknown>;
            const pm = (raw.proxy_metrics ?? {}) as Record<string, unknown>;
            const s: ProviderStats = {
              ts: (raw.ts as string) ?? new Date().toISOString(),
              tokensPerSecond: (pm.last_generation_tokens_per_second as number) ?? undefined,
              promptTokens: (pm.last_prompt_tokens as number) ?? undefined,
              outputTokens: (pm.last_generation_tokens as number) ?? undefined,
            };
            if (typeof raw.n_ctx_max === 'number') s.ctxMax = raw.n_ctx_max;
            else if (typeof raw.context_length === 'number') s.ctxMax = raw.context_length;
            const slots = raw.slots as Array<Record<string, unknown>> | undefined;
            if (slots?.length) {
              const active = slots.find(x => x.is_processing) ?? slots[0];
              if (typeof active.n_ctx === 'number') s.ctxMax = active.n_ctx;
              if (typeof active.n_past === 'number') s.ctxUsed = active.n_past;
            }
            live = s;
          }
        }
      }
    } catch { live = null; }

    const agentName = agentConfig.identity.name ?? agentId;
    const modelShort = effectiveModel.split('/').pop() ?? effectiveModel;

    const livePrompt = live?.promptTokens;
    const liveCtxUsed = live?.ctxUsed;
    const liveCtxMax = live?.ctxMax ?? maxTokens;
    const liveUsed = livePrompt ?? liveCtxUsed;
    const livePct = (liveUsed != null && liveCtxMax > 0)
      ? Math.min(100, Math.round((liveUsed / liveCtxMax) * 100))
      : null;
    // ── Build the visual status message ──────────────────────────────────────
    const displayPct = livePct ?? pct;
    const displayFilled = Math.round((displayPct / 100) * barLen);
    const displayBar = '\u2588'.repeat(displayFilled) + '\u2591'.repeat(barLen - displayFilled);

    const ctxTokenLine = live
      ? `${(liveUsed ?? 0).toLocaleString()} / ${liveCtxMax.toLocaleString()} tokens`
      : `~${estimatedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`;

    const infoLine = `Sys ~${systemTokens.toLocaleString()}   Msgs ~${messageTokens.toLocaleString()} (${windowMessages.length}/${allMessages.length})`;

    const ctxLines: string[] = [
      `${displayBar}  ${displayPct}%`,
      ctxTokenLine,
      infoLine,
    ];

    if (live) {
      const tokps = live.tokensPerSecond != null ? live.tokensPerSecond.toFixed(1) : '\u2014';
      const lastIn = live.promptTokens != null ? live.promptTokens.toLocaleString() : '\u2014';
      const lastOut = live.outputTokens != null ? live.outputTokens.toLocaleString() : '\u2014';
      ctxLines.push(`Tok/s ${tokps}   Last ${lastIn} in  ${lastOut} out`);
    }

    const sourceLabel = live ? 'Mercury \u{1f7e2}' : 'estimation';
    const optBlock = formatSessionOptions(currentOpts, this.getAgentThinkBudget(agentId));

    // Ligne auto-warmup (timer global — affiché dans la StatusBar frontend)
    const warmupEnabled = this.ctx.config.defaults.autoWarmup?.enabled !== false;
    const warmupLine = warmupEnabled ? `\u{1f525} auto-warm actif (queue globale)` : '';

    return [
      `\u{1f4ca} **Status \u2014 ${agentName}**`,
      '',
      '**Session**',
      optBlock,
      ...(warmupLine ? [warmupLine] : []),
      '',
      `**Contexte  (${sourceLabel})**`,
      '```',
      ctxLines.join('\n'),
      '```',
      '',
      `\u{1f916} \`${modelShort}\`  \u00b7  ${providerId || 'unknown'}`,
    ].join('\n');
  }

  /**
   * Apply session option updates directly (without running the agent or creating messages).
   * Used by Telegram inline keyboard callbacks.
   */
  async setSessionOptions(sessionId: string, agentId: string, updates: SessionUpdate): Promise<SessionOptions> {
    console.debug(`[agent] setSessionOptions session=${sessionId} agent=${agentId} updates=${JSON.stringify(updates)}`);
    // Always load from DB first so we merge on top of the full persisted state,
    // not just whatever happens to be in memory — prevents overwriting other options.
    await this.loadSessionOptions(sessionId);
    const current = this.getSessionOptions(sessionId);
    const next = applyUpdate(current, this.normalizeModelOverride(agentId, updates));
    if (Object.keys(next).length === 0) {
      this.sessionOptions.delete(sessionId);
    } else {
      this.sessionOptions.set(sessionId, next);
    }
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    await sessionMod.getOrCreate(sessionId, agentId);
    await sessionMod.saveOptions(sessionId, this.getSessionOptions(sessionId) as Record<string, unknown>);
    const ws = this.ctx.ws as WsManager;
    ws.broadcast(sessionId, {
      type: 'session.options',
      sessionId,
      options: this.getSessionOptions(sessionId),
    } satisfies WsServerMessage);
    return this.getSessionOptions(sessionId);
  }

  /**
   * Abort ALL in-flight runs for an agent. Aborts every controller in the agent's Set
   * (concurrent runs each register their own — see M1) and clears the Set so each run's
   * finally is a no-op removal. Public contract: every caller ("stop whatever this agent
   * is doing" — chat.abort, war-room timeout, sub-agent cancel, reload/remove, run@980
   * preemption) wants all of the agent's runs cancelled, which is preserved here.
   */
  abort(agentId: string): void {
    const controllers = this.abortControllers.get(agentId);
    if (controllers && controllers.size > 0) {
      console.debug(`[agent] abort ${agentId} (${controllers.size} controller(s))`);
      for (const controller of controllers) controller.abort();
      this.abortControllers.delete(agentId);
      this.states.set(agentId, 'idle');
    }
  }

  /**
   * Abort the agent's in-flight run AND wait for its cleanup (partial-response save in
   * run.ts) to settle before returning. Builds on the M1 run-tracking contract: `abort()`
   * signals every controller, then we await the tracked promise in `runPromises` (run,
   * warmup, or compact — all keep it pointed at their handle while in-flight). The tracked
   * promise is already `.catch(()=>{})`-wrapped at the set sites, but we guard again so a
   * caller never has to handle a rejection. Mirrors what `run()` does internally before
   * starting a fresh run (await predecessorGate); callers that delete a session out from
   * under a run (e.g. war-room closeRoom) MUST use this to avoid racing the partial save
   * against the session DELETE (FK cascade / lost partial). See audit M18.
   */
  async abortAndWait(agentId: string): Promise<void> {
    this.abort(agentId);
    await this.runPromises.get(agentId)?.catch(() => {});
  }

  /**
   * Résume la conversation via le LLM, archive en froid + résumé daily, purge les messages
   * en DB, réinjecte le résumé comme bootstrap assistant, puis déclenche le warmup du KV cache.
   * Utilisé par `/compact` (trigger === 'user') et par le cron quotidien (trigger === 'scheduled').
   * Retourne `null` si la conversation a moins de 2 messages.
   */
  async compactSession(
    agentId: string,
    sessionId: string,
    source: MessageSource = 'web',
    trigger: 'user' | 'scheduled' = 'user',
    options?: { skipWarmup?: boolean },
  ): Promise<{ messagesCompacted: number; archivePath: string; summaryPath: string } | null> {
    const agentConfig = this.agents.get(agentId);
    if (!agentConfig) throw new Error(`Agent "${agentId}" not found`);

    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const providerMod = this.ctx.modules.get<ProviderModule>('provider');
    const configMod = this.ctx.modules.get<ConfigModule>('config');
    const ws = this.ctx.ws as WsManager;

    const activeRun = this.runPromises.get(agentId);
    if (activeRun) {
      console.debug(`[agent] compact waiting for active run agent=${agentId}`);
      await activeRun.catch(() => {});
    }
    if (this.states.get(agentId) !== 'idle') {
      console.log(`[agent] compact skipped agent=${agentId}: state=${this.states.get(agentId)}`);
      return null;
    }

    let resolveCompact!: () => void;
    let rejectCompact!: (err: unknown) => void;
    let compactSettled = false;
    const trackedCompact = new Promise<void>((resolve, reject) => {
      resolveCompact = resolve;
      rejectCompact = reject;
    }).catch(() => {});
    this.runPromises.set(agentId, trackedCompact);
    this.states.set(agentId, 'compacting');
    ws.broadcastAll({ type: 'agent.state', agentId, state: 'compacting' } satisfies WsServerMessage);

    try {
    const effectiveModel = this.getSessionOptions(sessionId).modelOverride ?? agentConfig.model;

    const allMessages = await sessionMod.getMessages(sessionId, 500);
    if (allMessages.length < 2) return null;

    const conversationText = allMessages.map(m => `[${m.role}] ${m.content}`).join('\n\n');
    const compactInput = conversationText.length > 30_000 ? conversationText.slice(-30_000) : conversationText;
    const summaryPrompt = `Résume de façon concise mais complète la conversation suivante. Conserve les décisions importantes, les résultats d'actions, et le contexte nécessaire pour continuer la conversation. Réponds uniquement avec le résumé, sans commentaire.\n\n---\n\n${compactInput}`;

    let summary: string;
    try {
      console.debug(`[agent] compact (${trigger}) generating summary for ${allMessages.length} messages`);
      summary = await providerMod.complete(effectiveModel, {
        messages: [{ role: 'user', content: summaryPrompt }],
      });
      console.debug(`[agent] compact summary generated: ${summary.length} chars`);
    } catch (err) {
      console.warn(`[agent] compact summary failed: ${err instanceof Error ? err.message : err}`);
      summary = `[Erreur résumé auto — conversation sauvegardée]\n\nDerniers échanges:\n${conversationText.slice(-3000)}`;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const compactRoot = this.ctx.config.paths.compactArchivesDir
      ? configMod.resolvePath(this.ctx.config.paths.compactArchivesDir)
      : path.join(agentConfig.workspacePath, 'archives');
    const consolidatedDir = this.ctx.config.paths.compactArchivesDir
      ? path.join(compactRoot, '..', 'consolidated', agentId)
      : path.join(compactRoot, 'consolidated');
    await fs.mkdir(consolidatedDir, { recursive: true });
    const archivePath = path.join(consolidatedDir, `conversation-${timestamp}.md`);
    const mdContent = `# Conversation Archive — ${new Date().toLocaleString()}\n\n_Trigger: ${trigger}_\n\n## Summary\n${summary}\n\n---\n\n## Full Conversation\n\n${allMessages.map(m => `### ${m.role.toUpperCase()} (${m.createdAt})\n${m.content}`).join('\n\n---\n\n')}`;
    await fs.writeFile(archivePath, mdContent, 'utf-8');
    console.debug(`[agent] compact archive saved: ${archivePath}`);

    const dailyDir = this.ctx.config.paths.compactArchivesDir
      ? path.join(compactRoot, agentId)
      : compactRoot;
    await fs.mkdir(dailyDir, { recursive: true });
    const summaryPath = path.join(dailyDir, `summary-${timestamp}.md`);
    await fs.writeFile(summaryPath, `# Résumé — ${new Date().toLocaleString()}\n\n${summary}`, 'utf-8');

    const header = trigger === 'scheduled'
      ? `[Contexte compacté automatiquement le ${new Date().toLocaleString()} (planification quotidienne)]`
      : `[Contexte compacté le ${new Date().toLocaleString()}]`;
    const bootstrapContent = `${header}\n\n**Résumé de la conversation précédente:**\n\n${summary}`;
    const bootstrapId = nanoid();
    const client = await this.ctx.db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '30s'");
      console.debug(`[agent] compact clearing ${allMessages.length} messages from DB session=${sessionId}`);
      await client.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
      await client.query(
        `INSERT INTO messages (id, session_id, role, content, source, metadata)
         VALUES ($1, $2, 'assistant', $3, $4, $5)`,
        [bootstrapId, sessionId, bootstrapContent, source, JSON.stringify({ type: 'auto_compact', trigger })],
      );
      await client.query('UPDATE sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    invalidatePromptCache(sessionId);

    // Auto-warmup pour repeupler le KV cache avec le nouveau contexte (plus léger).
    // skipWarmup (daily-compact d'agents cloud) : on saute — pas de cache local à réchauffer,
    // le warmup ne ferait qu'un appel d'inférence inutile.
    if (options?.skipWarmup) {
      console.log(`[agent] post-compact warmup skipped agent=${agentId} session=${sessionId} (skipWarmup)`);
    } else {
      setImmediate(() => {
        this.run(agentId, sessionId, '', 'web', { warmup: true }).catch(err =>
          console.warn(`[agent] post-compact warmup failed: ${err instanceof Error ? err.message : err}`),
        );
      });
    }

    resolveCompact();
    compactSettled = true;
    return { messagesCompacted: allMessages.length, archivePath, summaryPath };
    } catch (err) {
      if (!compactSettled) {
        rejectCompact(err);
        compactSettled = true;
      }
      throw err;
    } finally {
      // Settle the tracked promise once and only once. If neither try nor catch settled it
      // (e.g. early `return null` for "<2 messages"), resolve here so awaiters don't hang.
      if (!compactSettled) {
        resolveCompact();
        compactSettled = true;
      }
      if (this.runPromises.get(agentId) === trackedCompact) {
        this.runPromises.delete(agentId);
      }
      if (this.states.get(agentId) === 'compacting') {
        this.states.set(agentId, 'idle');
        ws.broadcastAll({ type: 'agent.state', agentId, state: 'idle' } satisfies WsServerMessage);
      }
    }
  }

  /** Mettre à jour la config auto-warmup à chaud (appelé depuis la route config) */
  updateAutoWarmupConfig(cfg: AutoWarmupConfig): void {
    this.autoWarmup?.updateConfig(cfg);
    // Re-sync les watchers si enabled a changé
    for (const [agentId] of this.agents) {
      this.autoWarmup?.updateWatchedFiles(agentId);
    }
  }

  async destroy(): Promise<void> {
    this.autoWarmup?.destroy();
    if (this.dailyCompactTimer) {
      clearInterval(this.dailyCompactTimer);
      this.dailyCompactTimer = null;
    }
    for (const [agentId, controllers] of this.abortControllers) {
      console.debug(`[agent] abort ${agentId} during shutdown (${controllers.size} controller(s))`);
      for (const controller of controllers) controller.abort();
    }
    await Promise.allSettled([...this.runPromises.values()]);
    this.abortControllers.clear();
    this.runPromises.clear();
    this.sessionOptions.clear();
    this.dailyCompactLastFired.clear();
  }
}
