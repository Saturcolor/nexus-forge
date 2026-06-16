export interface AgentIdentity {
  id: string;
  name: string;
  emoji: string;
  creature: string;
  vibe: string;
}

export interface AgentTelegramConfig {
  enabled: boolean;
  chatIds: number[];
  botId?: string;
  /** Streaming des réponses (édition progressive du message). Défaut : false */
  streaming?: boolean;
  /** Durée de vie du cache du prompt système pour les sessions Telegram, en minutes. Défaut : 30 */
  promptCacheTtl?: number;
  /**
   * Chat "owner" qui fold dans la session unifiée quand `unifiedSession` est actif.
   * Défaut : `chatIds[0]` (le DM principal). Les autres chatIds (groupes) restent
   * isolés en `{agent}-tg-{chatId}` même en mode unifié, pour ne pas mélanger les contextes.
   */
  primaryChatId?: number;
}

export interface AgentToolsConfig {
  disabled?: string[];
  /**
   * Sub-agent presets only (`kind: 'subagent'`). When set, only these tool names
   * (core tools + `skill_*`) are exposed to the LLM and accepted at execution.
   * `submit_subagent_report` is always implied — callers need not list it.
   * When absent, legacy behaviour: full unified surface minus `disabled` / global gates.
   */
  allowOnly?: string[];
  /** Allow tools to operate outside the agent workspace (system-wide access) */
  systemAccess?: boolean;
  /** Clé dans mastermind `codebaseSearch.indices` (legacy, single index) */
  codebaseSearchIndex?: string;
  /** Clés dans mastermind `codebaseSearch.indices` — undefined/[] = tous les index */
  codebaseSearchIndices?: string[];
  /** Ajouter une consigne codebase_search dans le prompt système */
  codebaseSearchInPrompt?: boolean;
}

/** Caps d'exécution d'un run de sub-agent (re-export depuis config.ts pour usage runtime). */
export interface AgentSubAgentCaps {
  maxIterations?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;
  timeoutSeconds?: number;
}

/** Une plage de shuffle pour un LoRA donné — référence `loraScales[index]`. */
export interface LoraShuffleRange {
  /** Index du LoRA dans `loraScales` (= id `--lora` côté llama-server). */
  index: number;
  /** Borne basse de la scale aléatoire (incluse). ∈ [0, 5]. */
  min: number;
  /** Borne haute de la scale aléatoire (incluse). ∈ [0, 5]. */
  max: number;
  /** Pas de quantification (ex. 0.05 → arrondi au 1/20e). Défaut : 0.01 (2 décimales). */
  step?: number;
}

/** Config du shuffle LoRA quotidien (cf. `AgentConfig.dailyCompact.loraShuffle`). */
export interface LoraShuffleConfig {
  /** Interrupteur maître. Si false, les `ranges` sont conservés mais aucun shuffle ne tourne. */
  enabled: boolean;
  /** Plages par index LoRA. Un index absent de `loraScales` est ignoré (warn). Vide = no-op. */
  ranges?: LoraShuffleRange[];
}

/** Canaux de réveil pour les livraisons agent→user (la ligne chat est TOUJOURS persistée à part). */
export type DeliveryWakeChannel = 'mobile' | 'telegram';

/**
 * Type de run qui peut déclencher un réveil (push). La granularité de la policy v3 :
 * un agent choisit QUELS types de run réveillent QUEL canal.
 *  - 'interactive' : l'agent répond à un message direct de l'utilisateur (web/mobile/TG).
 *                    Le push ne part que si PERSONNE ne regarde la session (presence) — la
 *                    réponse streame déjà sous les yeux d'un utilisateur présent.
 *  - 'proactive'   : handler proactif / escalade (déclenché par un watcher, pas par l'user).
 *  - 'task'        : tâche planifiée cron (kind='task').
 *  - 'sandbox'     : résultat d'un job async dispatché (dispatch_sandbox_run).
 */
export type DeliveryTrigger = 'interactive' | 'proactive' | 'task' | 'sandbox';

/**
 * Politique de livraison par agent — qui sonne, quand, et sur quelle surface (v3, granulaire
 * par CANAL × TRIGGER). La ligne chat (session = source de vérité) est TOUJOURS persistée,
 * indépendamment de cette policy ; ici on ne décide que des RÉVEILS additionnels (push).
 *
 * Migration : les anciennes policies plates (`wake[]`, `telegram` string, `presenceDedup`
 * top-level) sont converties en v3 à la lecture via `normalizeDeliveryPolicy` — aucune
 * migration de stockage. Une policy vide (`{}` / tous sous-champs absents) = pas de policy
 * (comportement legacy par défaut).
 */
export interface AgentDeliveryPolicy {
  /** Réveil mobile (push APNs). */
  mobile?: {
    /**
     * Triggers qui réveillent le mobile quand l'agent livre SANS canal explicite (auto) et
     * pour les filets auto-deliver. Un canal explicite (`send_to_user channel='mobile'`) et
     * un override par tâche restent prioritaires. Absent = défaut legacy (tous les triggers).
     */
    triggers?: DeliveryTrigger[];
    /**
     * Supprime le push APNs quand un client REGARDE activement la session (premier plan +
     * écran chat visible — cf. hasSessionViewers). Défaut false.
     */
    presenceDedup?: boolean;
  };
  /** Réveil Telegram (sortant). N'affecte jamais le bridge ENTRANT (reply TG-native interactive). */
  telegram?: {
    /**
     * Mode du canal Telegram SORTANT.
     *  - 'on'       : TG livré quand un trigger l'inclut / canal explicite — défaut
     *  - 'fallback' : TG déprécié-mais-dispo — ne sonne que si le push mobile échoue
     *  - 'off'      : jamais de TG sortant AUTO (send_to_user explicite, filets, scheduler).
     * La reply à un message reçu DEPUIS Telegram (interactive TG-native) repart toujours sur
     * TG, quel que soit ce mode — c'est le bridge entrant, jamais filtré.
     */
    mode?: 'on' | 'fallback' | 'off';
    /**
     * Triggers qui réveillent Telegram (auto). La reply TG-native interactive est livrée hors
     * de cette liste (toujours). Absent = défaut legacy (aucun trigger auto hors TG-native).
     */
    triggers?: DeliveryTrigger[];
  };
  /**
   * Live Activity / Dynamic Island :
   *  - 'all'  (défaut) : toutes les transitions de run (y compris proactif/escalade)
   *  - 'user' : uniquement les runs initiés par l'utilisateur (proactif/escalade/cron muets)
   *  - 'off'  : jamais
   */
  liveActivity?: 'all' | 'user' | 'off';
  /**
   * Cartes `proactive.alert` (toast web + panneau alertes mobile app) :
   *  - 'all'   (défaut) : broadcast normal (toast + carte)
   *  - 'quiet' : broadcast avec flag `silent` — carte persistée, pas de toast/banner
   *  - 'off'   : aucun broadcast
   */
  proactiveAlerts?: 'all' | 'quiet' | 'off';
}

export interface AgentConfig {
  identity: AgentIdentity;
  workspacePath: string;
  model: string;
  /** When false the agent is dormant: no runs, no Telegram routing */
  enabled?: boolean;
  /**
   * `'agent'` (défaut) = agent principal interactif. `'subagent'` = agent light
   * spawnable, one-shot, sans chat direct ni Telegram. Détermine la disponibilité
   * du tool `spawn_subagent` (caché pour les sub-agents → pas de récursion).
   */
  kind?: 'agent' | 'subagent';
  /** Sub-agent only — IDs des callers autorisés (vide/undefined = tous). */
  allowedCallers?: string[];
  /** Sub-agent only — caps d'exécution par run (override les défauts globaux). */
  caps?: AgentSubAgentCaps;
  telegram?: AgentTelegramConfig;
  temperature?: number;
  maxContextTokens?: number;
  maxCompletionTokens?: number;
  contextMessages?: number;
  /** Seuil (80-100) en % du context window déclenchant l'auto-compact. Défaut : 90 */
  autoCompactThreshold?: number;
  /** Compact quotidien planifié + auto-warmup post-compact. */
  dailyCompact?: {
    enabled: boolean;
    /** Heure locale au format HH:mm (24h). Défaut : 06:00 */
    time?: string;
    /**
     * Saute le warmup KV-cache déclenché après le compact planifié. Inutile pour les
     * agents cloud (pas de cache local à réchauffer) — économise un appel d'inférence.
     * N'affecte que le compact quotidien (le `/compact` manuel warm toujours). Défaut : false.
     */
    skipWarmup?: boolean;
    /**
     * Shuffle quotidien des scales LoRA, appliqué JUSTE AVANT le compact planifié (donc
     * le warmup post-compact cuit la nouvelle scale dans le KV cache, sans invalidation
     * en milieu de journée). Chaque jour, pour chaque index ciblé, une scale aléatoire
     * uniforme dans [min, max] (quantifiée au `step`, défaut 0.01) remplace l'ancienne.
     */
    loraShuffle?: LoraShuffleConfig;
  };
  /** Durée de vie du cache du prompt système (web + Telegram), en minutes. Défaut : 30 */
  promptCacheTtl?: number;
  tools?: AgentToolsConfig;
  promptInjection?: {
    sharedStarredFiles?: string[];
    workspaceStarredFiles?: string[];
    starredSkills?: string[];
  };
  /** Si true, les blocs <think> sont persistés dans reasoning_traces (PostgreSQL) */
  captureReasoningTraces?: boolean;
  /**
   * Reasoning effort (extended thinking) — global agent setting.
   * Read par chat web, Telegram, scheduler. Défaut implicite : 'off'.
   */
  thinkBudget?: 'off' | 'low' | 'medium' | 'high';
  /**
   * Bypass the unified agent cache. When true, this agent gets a tailored prompt prefix
   * (only its starred skills + only enabled tools), at the cost of NO LONGER sharing the
   * KV-cache with other agents on the same model. See AgentYamlConfig.bypassUnifiedCache
   * for the full rationale. Default false.
   */
  bypassUnifiedCache?: boolean;
  /**
   * Lazy skill loading. When true, skills are advertised in the system prompt as one-line
   * summaries; full schemas are fetched on demand via `inspect_skill(skill_id)` rather
   * than injected upfront. Saves ~10-12k tokens for a typical agent. Default false.
   * See AgentYamlConfig.lazySkills for the full rationale.
   */
  lazySkills?: boolean;
  /**
   * How skill actions are exposed in `tools[]` when lazy mode is active.
   *  - 'stub' (default) — each skill action is pre-declared as a stub (name + empty
   *    description + empty params). Agent calls each `skill_*` directly after inspect_skill.
   *  - 'wildcard' — NO per-skill stubs. Single `call_skill_action(toolName, args)` is
   *    exposed; agent must route every skill invocation through it. Saves an additional
   *    ~3-4k tokens for agents with 100+ skills loaded.
   * Only meaningful when `lazySkills: true`. Ignored otherwise.
   */
  skillCallMode?: 'stub' | 'wildcard';
  /**
   * Exclut cet agent de la LECTURE de la mémoire vectorielle partagée (scope `shared`).
   * Défaut false. Quand true :
   *  - l'auto-injection de contexte mémoire ne lui remonte QUE son scope `agent`
   *    (aucun bloc `shared` injecté) ;
   *  - le tool `memory_search` est clampé à `['agent']` quel que soit le `scope` demandé.
   * L'ÉCRITURE en `shared` reste autorisée — l'agent peut alimenter le pot commun sans
   * jamais le relire. Utile pour un agent "contributeur" qu'on ne veut pas pollué par la
   * mémoire des autres tout en gardant sa propre mémoire privée.
   */
  excludeSharedMemory?: boolean;
  /** Politique de livraison (canaux de réveil, TG fallback, presence dedup, Live Activity, alertes). */
  delivery?: AgentDeliveryPolicy;
  /**
   * Mode session unifiée (cross-plateforme). Défaut false (legacy : une session par canal,
   * `{agent}-web` / `{agent}-mobile` / `{agent}-tg-{chatId}`). Quand true :
   *  - tous les points d'entrée (REST, WS web/mobile, DM Telegram du chat owner, NCM)
   *    résolvent vers UNE session canonique `{agentId}-unified` (titre "Cross-plateforme") ;
   *  - les groupes Telegram (chatIds non-primaires) restent isolés en `-tg-{chatId}` ;
   *  - un seul KV chaud qui suit l'utilisateur d'un device à l'autre.
   * L'activation déclenche un merge + compaction one-shot des historiques existants.
   */
  unifiedSession?: boolean;
  /** Liste de scales LoRA — un par adapter chargé côté brain (index = id LoRA llama-server).
   *  Injectée per-request comme `lora: [{id, scale}, ...]`. Vide / omis = brain applique son default. */
  loraScales?: number[];
  /** Legacy mono-LoRA (deprecated, auto-migré en `loraScales: [loraScale]` au load YAML). */
  loraScale?: number;
}

export type AgentState = 'idle' | 'thinking' | 'streaming' | 'warming' | 'compacting' | 'error';

export interface AgentStatus {
  agentId: string;
  state: AgentState;
  currentSessionId: string | null;
}
