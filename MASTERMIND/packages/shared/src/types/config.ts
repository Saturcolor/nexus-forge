import type { ProviderConfig } from './provider.js';
import type { AgentToolsConfig, LoraShuffleConfig, AgentDeliveryPolicy } from './agent.js';

export interface ServerConfig {
  port: number;
  host: string;
  apiKey: string;
}

export interface PathsConfig {
  agentsDir: string;
  sharedMemoryDir: string;
  compactArchivesDir?: string;
  /** Dossier des skills (ex. SKILL.md style Cursor) — chemin absolu résolu au runtime, injecté dans le prompt système */
  skillsDir?: string;
  /** Dossier où dumper les images uploadées par l'user dans le chat, pour que
   * les agents puissent y référer en path absolu (skill_media-gen edit mode, etc.).
   * Si vide → défaut `<sharedMemoryDir>/user-images/`. */
  userImagesDir?: string;
  /** Racine des rapports Markdown des sub-agents : `<racine>/<id_preset>/<jobId>.md`. Vide / absent → pas d'écriture disque. */
  subagentReportsDir?: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface TelegramBotConfig {
  id: string;
  token: string;
  enabled: boolean;
}

export interface TelegramConfig {
  bots: TelegramBotConfig[];
}

/** Credentials APNs (provider token / .p8) pour le canal push mobile. */
export interface ApnsConfigShape {
  /** Contenu PEM de la clé .p8 (alternative à keyPath). */
  keyP8?: string;
  /** Chemin disque vers AuthKey_XXXX.p8 (lu au boot). */
  keyPath?: string;
  /** Key ID (10 car.). */
  keyId?: string;
  /** Team ID (10 car.). */
  teamId?: string;
  /** apns-topic = bundle id of your mobile app (e.g. com.example.myapp). */
  topic?: string;
  /** true = APNs prod (TestFlight/App Store) · false = sandbox (build Xcode dev). */
  production?: boolean;
}

/** Canal push mobile (APNs) — miroir de TelegramConfig (mobile app). */
export interface PushConfig {
  enabled: boolean;
  apns?: ApnsConfigShape;
}

/**
 * Caps d'un run de sub-agent (cloud one-shot). Tous les champs sont optionnels et
 * tombent sur les défauts (subagentDefaults) si omis. Le sub-agent finit avec un
 * partial output + `caps_hit` non-null si un cap déclenche l'arrêt.
 */
export interface SubAgentCaps {
  /** Nombre max de tours d'inférence (assistant turns). Défaut : 15 */
  maxIterations?: number;
  /** Nombre max d'appels d'outils total dans le run. Défaut : 30 */
  maxToolCalls?: number;
  /** Plafond de tokens de génération par turn. Défaut : 8000 */
  maxOutputTokens?: number;
  /** Wall-clock max du run (s). Défaut : 300 */
  timeoutSeconds?: number;
}

export interface AgentYamlConfig {
  workspaceDir: string;
  model: string;
  /** Désactiver l'agent sans le supprimer (default: true) */
  enabled?: boolean;
  /**
   * Type d'agent. `'agent'` (défaut) = agent principal avec session interactive,
   * Telegram, voice, etc. `'subagent'` = agent light spawnable depuis un autre
   * agent via le tool `spawn_subagent`, sans chat direct, one-shot, async.
   */
  kind?: 'agent' | 'subagent';
  /**
   * Sub-agent only — liste des IDs d'agents principaux autorisés à spawner
   * ce sub-agent. Si omis ou vide, accessible à tous les agents principaux.
   */
  allowedCallers?: string[];
  /** Sub-agent only — caps d'exécution par run. */
  caps?: SubAgentCaps;
  maxContextTokens?: number;
  maxCompletionTokens?: number;
  contextMessages?: number;
  /** Seuil (80-100) en % du context window déclenchant l'auto-compact. Défaut : 90 */
  autoCompactThreshold?: number;
  /**
   * Compact quotidien planifié + auto-warmup. Compacte la session la plus récemment
   * active à l'heure indiquée (locale), puis réchauffe le KV cache immédiatement
   * après pour que la conversation du matin soit prête.
   */
  dailyCompact?: {
    enabled: boolean;
    /** Heure locale au format HH:mm (24h). Défaut : 06:00 */
    time?: string;
    /**
     * Saute le warmup KV-cache post-compact (planifié uniquement). Utile pour les agents
     * cloud : pas de cache local à réchauffer, le warmup ne ferait qu'un appel inutile. Défaut : false.
     */
    skipWarmup?: boolean;
    /**
     * Shuffle quotidien des scales LoRA, appliqué juste avant le compact planifié pour que
     * le warmup post-compact cuise la nouvelle scale dans le KV cache (cf. LoraShuffleConfig).
     */
    loraShuffle?: LoraShuffleConfig;
  };
  telegram?: {
    botId?: string;   // references TelegramBotConfig.id — defaults to first bot if omitted
    enabled: boolean;
    chatIds: number[];
  };
  tools?: AgentToolsConfig;
  promptInjection?: {
    sharedStarredFiles?: string[];
    workspaceStarredFiles?: string[];
    starredSkills?: string[];
  };
  /** Si true, les blocs <think> sont persistés dans reasoning_traces (PostgreSQL) */
  captureReasoningTraces?: boolean;
  /**
   * Reasoning effort (extended thinking) — single source of truth pour tous les canaux
   * (chat web, Telegram, scheduler). Modifiable via UI agent config, /think, bouton Telegram.
   * Défaut implicite : 'off'.
   */
  thinkBudget?: 'off' | 'low' | 'medium' | 'high';
  /**
   * Bypass the unified agent cache: tailor this agent's prompt prefix instead of sharing
   * the universal one with all other agents on the same model.
   *
   * When `false` (default), every agent on a given model sees the SAME tools+skills
   * payload (full surface, exec-time gating only). Prefix is byte-identical → KV-cache
   * shared across agents → switching agents on the same slot is free.
   *
   * When `true`:
   *  - Tools listed in `tools.disabled` are STRIPPED from the prompt (not just exec-blocked).
   *  - Skill definitions are filtered to only those in `promptInjection.starredSkills`.
   *  - This agent's prefix becomes unique → smaller (typically -10k to -15k tokens for an
   *    agent with few starred skills) but NO LONGER SHARED with other agents on this model.
   *
   * Recommended ON only when: (a) this agent runs on a dedicated model/slot, OR (b) you
   * accept the cache miss when switching between this agent and any other on the same
   * model. Default OFF preserves the inter-agent cache sharing strategy.
   */
  bypassUnifiedCache?: boolean;
  /**
   * Lazy skill loading. When `false` (default), every skill action's full tool definition
   * (description + JSON-schema parameters) is injected upfront in the prompt's `tools` list
   * — typically ~14k tokens for an agent with ~30 skills × N actions each.
   *
   * When `true`:
   *  - Skill action tool definitions are NOT injected in the prompt.
   *  - A new `inspect_skill(skill_id)` tool is exposed instead.
   *  - The system prompt gets an "Available skills" block listing each loaded skill with
   *    a one-liner description and its action names — typically ~50 tok per skill.
   *  - Agent flow: see the summary → call `inspect_skill('<id>')` to discover params →
   *    emit a tool_call for the action by name (dispatch is unchanged, the action tool is
   *    still routable through the existing skill execution path).
   *
   * Stacks with `bypassUnifiedCache`: when both ON, the system-prompt summary block AND the
   * inspect_skill responses are filtered to `promptInjection.starredSkills` only. Maximum
   * leanness for a dedicated-slot agent.
   *
   * Same cache caveat as `bypassUnifiedCache`: lazy mode shifts the prefix bytes, so
   * mixing lazy and non-lazy agents on the same model splits their KV cache.
   */
  lazySkills?: boolean;
  /**
   * How skill actions are exposed in `tools[]` when lazy mode is active.
   *  - 'stub' (default) — each skill action is pre-declared as a stub in `tools[]`
   *    (name + empty description + empty params). The agent calls `skill_*` directly
   *    after inspect_skill. Pre-Phase 2 behavior.
   *  - 'wildcard' — NO per-skill stubs are emitted. A single `call_skill_action` tool
   *    receives `{ toolName, args }` and dispatches to the same skill executor. Saves
   *    an additional ~3-4k tokens for fleets with 100+ loaded skills, and cleans up
   *    the tools[] surface for the LLM (2 tools vs 140+). Only meaningful with lazy.
   *
   * Same cache caveat as lazy mode: switching between modes shifts the prefix bytes
   * and breaks KV cache sharing with agents in the other mode on the same model.
   */
  skillCallMode?: 'stub' | 'wildcard';
  /**
   * Exclut cet agent de la LECTURE de la mémoire vectorielle partagée (scope `shared`).
   * Défaut false. L'écriture en `shared` reste autorisée — seules l'auto-injection et le
   * tool `memory_search` sont restreints au scope `agent` de cet agent.
   * Voir AgentConfig.excludeSharedMemory pour le détail.
   */
  excludeSharedMemory?: boolean;
  /**
   * Politique de livraison agent→user (canaux de réveil, mode Telegram on/fallback/off,
   * presence dedup push, Live Activity, alertes proactives). Voir AgentConfig.delivery.
   */
  delivery?: AgentDeliveryPolicy;
  /**
   * Mode session unifiée (cross-plateforme). Défaut false. Quand true, tous les canaux
   * (web, mobile, NCM, DM Telegram owner) convergent vers UNE session canonique
   * `{agentId}-unified` — la conversation suit l'utilisateur d'un device à l'autre.
   * Voir AgentConfig.unifiedSession.
   */
  unifiedSession?: boolean;
  /** Liste de scales LoRA — un par adapter chargé côté brain (index = id LoRA llama-server).
   *  Injectée per-request comme `lora: [{id, scale}, ...]`. Vide / omis = brain applique son default. */
  loraScales?: number[];
  /** Legacy mono-LoRA (deprecated, auto-migré en `loraScales: [loraScale]` au load YAML). */
  loraScale?: number;
}

export interface ToolDefaultsConfig {
  bashTimeoutMs?: number;
  webFetchMaxChars?: number;
  maxToolTurns?: number;
  maxReasoningCalls?: number;
  maxReasoningInputChars?: number;
  /**
   * Loop guard. Maximum number of CONSECUTIVE tool_calls with the exact same
   * `name + arguments` signature before the dispatcher soft-refuses (returns a
   * "loop guard" message instead of executing). Resets on signature change or
   * end of run. Stops pathological loops (model hammering the same find
   * command 12× because the result is empty) without aborting the run —
   * the model sees the soft-refuse in tool_result and can change approach.
   *
   * Default: 5 (= 5 consecutive identical executions allowed, the 6th is soft-
   * refused). Runtime fallback when undefined OR omitted is 5 (default ON).
   * Set to 0 explicitly in mastermind.yml / via the Settings UI to DISABLE
   * the guard entirely.
   */
  maxIdenticalToolCalls?: number;
  /**
   * Auto-abort escalation for the loop guard. When enabled, if the model emits
   * the SAME tool_call signature TWICE in a row AFTER the loop guard already
   * fired (i.e. consecutiveIdenticalCount > maxIdenticalToolCalls + 1 — first
   * guard fire = warning, second = stuck), the run aborts immediately instead
   * of letting the model burn another stream cycle on the same dead-end.
   *
   * Observed need: some model finetunings kept regenerating an identical
   * tool_call for 4 turns AFTER the soft-refuse, ignoring the [loop guard]
   * tool_result. The model is in a token-level autopilot pattern — only a
   * hard abort breaks it.
   *
   * The model gets exactly ONE chance to recover after the first soft-refuse.
   * If the next streamRich produces the same signature again, abort.
   *
   * Default: true (cut the grass — pairs with the loop guard's "give one
   * chance" semantics). Set false to keep the legacy soft-refuse-only behavior
   * (model can persist forever until the user manually aborts or maxToolTurns
   * runs out).
   *
   * No-op when `maxIdenticalToolCalls` is 0 (loop guard disabled).
   */
  autoAbortOnLoopGuard?: boolean;
}

export interface AutoWarmupConfig {
  /** Active le warmup automatique du cache prompt. Défaut : true */
  enabled?: boolean;
  /** Durée d'inactivité globale (toutes conversations) avant déclenchement du warmup (minutes). Défaut : 25 */
  globalWarmupIdleMinutes?: number;
  /** Délai de debounce après modification d'un fichier starred (secondes). Défaut : 3 */
  fileDebounceSeconds?: number;
  /** Fenêtre d'activité session pour le warmup fichier (heures). Défaut : 24 */
  recentActivityHours?: number;
}

export interface DefaultsConfig {
  model: string;
  temperature: number;
  maxContextTokens: number;
  /** TTL global du cache prompt (minutes). Défaut : 30. Surchargeable par agent. */
  promptCacheTtl?: number;
  toolDefaults?: ToolDefaultsConfig;
  autoWarmup?: AutoWarmupConfig;
  /**
   * Décharger automatiquement le modèle précédent quand on switch de modèle (UI chat,
   * Telegram model picker, `updateAgentConfig`). Défaut : true pour backward-compat.
   * Régler à false quand plusieurs agents partagent le même modèle : switcher entre
   * eux devient instantané (pas d'unload inutile qui forcerait un reload).
   */
  autoUnloadOnSwitch?: boolean;
  /**
   * Top-level prompt assembly mode. ON = cache-optimized: minimize prompt-vs-slot byte
   * mismatch. OFF = full-context: keep everything in the rebuilt prompt for richer LLM
   * history, accept some cache miss in queue.
   *
   * Concretely, in cache-optimized mode the rebuild:
   *  - keeps `<think>` blocks (matches slot byte-for-byte → max prefix-cache hit)
   *  - drops the visible-content duplicate row that `send_to_user` persists for UI display
   *    (the same content is already inside the previous assistant's `tool_calls.arguments`,
   *    so the LLM has it; including it again in plain assistant form bloats the prompt by
   *    ~440 tokens per call AND the duplicate isn't in the slot's streamed KV, so its
   *    inclusion shifts the queue out of cache match).
   *
   * Default ON. Recommended for local LLMs with full attention (no SWA), single slot,
   * latency-bound inference. Flip OFF on cloud APIs / fast cores where token costs
   * dominate over cache hit, or if you want the LLM to "see" each delivered message
   * as a standalone assistant turn in its history.
   */
  cacheOptimized?: boolean;
  /**
   * Strip `<think>...</think>` blocks from assistant messages when reloading session
   * history into a new LLM payload.
   *
   * @deprecated Hidden from the UI in favour of `cacheOptimized`. Still honored when set
   * explicitly in YAML for power users who want token-savings at the cost of cache miss.
   * Default behaviour is now `false` (keep think) to favor cache prefix hit. Set to `true`
   * to force token-saver mode regardless of `cacheOptimized`.
   *
   * Tradeoff:
   *  - `true`: strips think from rebuilt history. Less tokens in context, BUT the rebuild
   *    differs from the slot's KV cache by exactly the stripped think bytes → cache miss.
   *  - `false` (new default): keeps think — rebuild matches slot byte-for-byte → max hit.
   */
  stripThinkBlocks?: boolean;
}

export interface SearchConfig {
  braveApiKey?: string;
}

/** Niveau minimal écrit sur disque / buffer (console reste inchangé en dev). */
export type LogLevelName = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LoggingConfig {
  level: LogLevelName;
  /** Chemin du fichier journal (relatif au YAML ou absolu). Défaut : ../logs/mastermind.log */
  file?: string;
  /** Rotation lorsque le fichier actif dépasse cette taille (Mo). */
  maxFileSizeMb: number;
  /** Nombre de fichiers conservés (actif + archives .1, .2, …). Min. 2. */
  maxFiles: number;
}

/** Recherche sémantique dans des index LanceDB (package @mastermind/codebase-search) */
export interface CodebaseSearchConfig {
  enabled?: boolean;
  /** Fichier JSON de config embeddings/extensions (optionnel — sinon défauts du package) */
  configPath?: string;
  /** Répertoire LanceDB par défaut si aucun index nommé ne s'applique */
  defaultDbPath?: string;
  /** Index nommés → chemins LanceDB (relatifs au YAML ou absolus, ~ autorisé) */
  indices?: Record<string, string>;
  /** Autoriser index/update depuis l'UI Mémoire (phase ultérieure) */
  allowUiIndex?: boolean;
  /**
   * Répertoires source à indexer : clé `default` + mêmes clés que `indices`.
   * Chemins relatifs au YAML ou absolus, ~ autorisé.
   */
  embedSources?: Record<string, string>;
  /** Dernier run d'embedding par clé d'index */
  lastEmbedRuns?: Record<
    string,
    { at: string; status: 'ok' | 'error' | 'running'; message?: string }
  >;
  /** Cron quotidien (UTC) */
  embedCronEnabled?: boolean;
  /** Heure du déclenchement (0–23, UTC) */
  embedCronHourUtc?: number;
  /** Mode du cron automatique : réindexation complète ou mise à jour incrémentale */
  embedCronMode?: 'full' | 'incremental';
  /** Cron embed → always cloud (frees the local GPU for other background jobs at night). */
  embedCronCloudOnly?: boolean;
  /** Override runtime global : tous les embeds Mastermind passent cloud (libère le GPU pour chat). */
  embeddingForceCloud?: boolean;
}

export interface MemoryStoreAutoInjectionConfig {
  /** Active l'injection automatique de mémoire dans les messages. Défaut : true */
  enabled?: boolean;
  /** Nombre de chunks injectés max. Défaut : 3 */
  topK?: number;
  /** Seuil de similarité cosinus minimum (0-1). Défaut : 0.45 */
  threshold?: number;
  /** Longueur max par chunk injecté (caractères). Défaut : 600 */
  maxCharsPerChunk?: number;
  /** Inclure les mémoires partagées (scope=shared). Défaut : true */
  includeShared?: boolean;
}

/** Configuration de la consolidation quotidienne des messages de chat */
export interface ChatConsolidationConfig {
  /** Active la consolidation chat. Défaut : true */
  enabled?: boolean;
  /** Heure du cron (0-23, heure locale). Défaut : 0 (minuit) */
  cronHour?: number;
  /** Modèle LLM pour les résumés (vide = modèle de l'agent). */
  model?: string;
  /**
   * Valide le résumé avant écriture sur disque (anti « prompt-injection with a save button » :
   * le résumé est injecté dans le system prompt de TOUS les agents via `# Recent Context`).
   * Un résumé vide / refus LLM / trop court n'est PAS écrit. Défaut : true.
   */
  validateSummaries?: boolean;
  /** Longueur min (chars) d'un résumé pour être considéré valide. Défaut : 40 */
  minSummaryChars?: number;
}

/** Configuration de la consolidation mémoire (scoring, clustering, archivage) */
export interface MemoryConsolidationConfig {
  /** Active la consolidation mémoire. Défaut : true si memoryStore.enabled */
  enabled?: boolean;
  /** Fréquence du cron : 'weekly' | 'daily'. Défaut : 'weekly' */
  cronSchedule?: 'weekly' | 'daily';
  /** Heure du cron (0-23, heure locale). Défaut : 3 */
  cronHour?: number;
  /** Modèle LLM pour les merges (override du model par défaut). */
  mergeModel?: string;
  /** Paramètres de scoring */
  scoring?: {
    /** Poids de la récence dans le score. Défaut : 0.5 */
    recencyWeight?: number;
    /** Poids de la fréquence d'accès. Défaut : 0.35 */
    frequencyWeight?: number;
    /** Poids de l'âge. Défaut : 0.15 */
    ageWeight?: number;
    /** Demi-vie du decay de récence (jours). Défaut : 30 */
    recencyHalfLifeDays?: number;
    /** Âge max avant que le score d'âge tombe à 0 (jours). Défaut : 365 */
    maxAgeDays?: number;
  };
  /** Paramètres de clustering */
  clustering?: {
    /** Seuil de similarité cosinus pour le merge (0-1). Défaut : 0.75 */
    mergeThreshold?: number;
    /** Nombre max de paires analysées par run. Défaut : 200 */
    maxPairsPerRun?: number;
    /** Taille max d'un cluster. Défaut : 5 */
    maxClusterSize?: number;
  };
  /** Paramètres d'archivage */
  archival?: {
    /** Score en dessous duquel une mémoire est candidate à l'archivage. Défaut : 0.1 */
    scoreThreshold?: number;
    /** Âge minimum (jours) avant archivage possible. Défaut : 60 */
    minAgeDaysBeforeArchive?: number;
  };
  /** Délai entre chaque merge LLM (ms). Défaut : 1000 */
  delayBetweenMergesMs?: number;
}

/** Configuration unifiée des deux systèmes de consolidation */
export interface ConsolidationConfig {
  /** Consolidation quotidienne des messages de chat → résumés .md */
  chat?: ChatConsolidationConfig;
  /** Consolidation mémoire vectorielle : scoring, clustering, merge, archivage */
  memory?: MemoryConsolidationConfig;
}

/** Configuration du système de mémoire vectorielle (PostgreSQL + pgvector) */
export interface MemoryStoreConfig {
  enabled: boolean;
  /** Dimension des vecteurs d'embedding (doit correspondre au modèle utilisé). Défaut : 1024 */
  embeddingDimensions?: number;
  /** Config d'injection automatique de mémoire dans les messages LLM */
  autoInjection?: MemoryStoreAutoInjectionConfig;
  /**
   * Déduplication opt-in : si true, vérifie la similarité avant d'insérer une nouvelle entrée.
   * Défaut : false (désactivé pour performances).
   */
  enableDeduplication?: boolean;
  /** Seuil de similarité pour la dédup (0-1). Défaut : 0.92 */
  deduplicationThreshold?: number;
  /** Bypass le filtre de significance (garde uniquement les skip patterns triviaux). Défaut : false */
  bypassSignificanceFilter?: boolean;
}

export interface NcmConfig {
  /** NCM base URL (e.g. "http://127.0.0.1:7600") */
  baseUrl: string;
}

/** Défauts globaux pour les sub-agents (override-ables par sub-agent via `caps`). */
export interface SubAgentDefaultsConfig {
  /** Limite globale de spawns par run de parent (anti-runaway). Défaut : 5 */
  maxSpawnsPerParentRun?: number;
  /** Soft-cap journalier global (anti-bug-loop sur la durée). Défaut : 100 */
  maxSpawnsPerDay?: number;
  /** Caps par défaut appliqués si le sub-agent ne les override pas. */
  caps?: SubAgentCaps;
  /** Rétention des transcripts en BDD (jours). Défaut : 30 */
  retentionDays?: number;
  /**
   * Taille max (chars) du rapport sub-agent RÉINJECTÉ dans le re-run du parent. Distinct du
   * hard-cap de persistance DB (200k) : le rapport complet reste consultable via le drill-down,
   * mais seul un extrait est réinjecté pour que le parent (qui doit SYNTHÉTISER, pas reproduire)
   * ne déclenche pas un auto-compact coûteux. Défaut : 12000.
   */
  reportInjectionMaxChars?: number;
}

export interface MastermindConfig {
  server: ServerConfig;
  paths: PathsConfig;
  database: DatabaseConfig;
  defaults: DefaultsConfig;
  providers: ProviderConfig[];
  agents: Record<string, AgentYamlConfig>;
  telegram: TelegramConfig;
  /** Canal push mobile (APNs (mobile)) — optionnel, désactivé par défaut. */
  push?: PushConfig;
  /** Défauts pour les sub-agents (cf. AgentYamlConfig.kind === 'subagent'). */
  subagentDefaults?: SubAgentDefaultsConfig;
  search?: SearchConfig;
  codebaseSearch?: CodebaseSearchConfig;
  /** Système de mémoire vectorielle dédié (PostgreSQL + pgvector) */
  memoryStore?: MemoryStoreConfig;
  /** Heures d'ouverture — bloque les inférences pendant la plage fermée sauf override */
  openingHours?: {
    enabled?: boolean;
    closedStart: number;
    closedEnd: number;
    overrideOpen?: boolean;
  };
  /** Configuration unifiée des consolidations (chat + mémoire) */
  consolidation?: ConsolidationConfig;
  /** @deprecated Utiliser consolidation.memory — backward compat */
  memoryConsolidation?: MemoryConsolidationConfig;
  /** Journalisation fichier + niveau global */
  logging?: LoggingConfig;
  /** NCM voice service connection (for Telegram voice support) */
  ncm?: NcmConfig;
  /** Frontend UI preferences (persisted across reboots) */
  ui?: { theme?: string };
}
