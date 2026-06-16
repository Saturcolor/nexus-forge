import { z } from 'zod';
import type { AgentDeliveryPolicy } from '@mastermind/shared';
import { normalizeDeliveryPolicy } from '../delivery/policy.js';

/**
 * Schéma `delivery` PERMISSIF : accepte l'ancien format plat (`wake`, `telegram` string,
 * `presenceDedup`) ET le nouveau v3 (`mobile`/`telegram` objet/`liveActivity`/`proactiveAlerts`).
 * Tous les champs optionnels, pas de `.strict()` (sinon l'ancien serait rejeté). Le `.transform`
 * normalise vers v3 canonique (ou `undefined` si vide) à la LECTURE — `AgentConfig.delivery` est
 * donc TOUJOURS v3 en mémoire. Idempotent : re-parser une policy déjà v3 la laisse intacte.
 */
const deliveryTriggerEnum = z.enum(['interactive', 'proactive', 'task', 'sandbox']);
const deliveryPolicyInputSchema = z.object({
  // ── Ancien format plat (pré-v3) ──
  wake: z.array(z.enum(['mobile', 'telegram'])).optional(),
  presenceDedup: z.boolean().optional(),
  // `telegram` : string (ancien mode) OU objet (v3) — union pour accepter les deux.
  telegram: z.union([
    z.enum(['on', 'fallback', 'off']),
    z.object({
      mode: z.enum(['on', 'fallback', 'off']).optional(),
      triggers: z.array(deliveryTriggerEnum).optional(),
    }),
  ]).optional(),
  // ── Nouveau format v3 ──
  mobile: z.object({
    triggers: z.array(deliveryTriggerEnum).optional(),
    presenceDedup: z.boolean().optional(),
  }).optional(),
  liveActivity: z.enum(['all', 'user', 'off']).optional(),
  proactiveAlerts: z.enum(['all', 'quiet', 'off']).optional(),
}).transform((v): AgentDeliveryPolicy | undefined => normalizeDeliveryPolicy(v));

const providerSchema = z.object({
  id: z.string(),
  type: z.enum(['mercury', 'openai-compat']),
  baseUrl: z.string().url(),
  apiKey: z.string().default(''),
  statsApiKey: z.string().optional(),
  models: z.array(z.object({
    alias: z.string(),
    modelId: z.string(),
    description: z.string().optional(),
  })).optional(),
  hiddenModelIds: z.array(z.string()).optional(),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelsUrl: z.string().url().optional(),
  statsUrl: z.string().url().optional(),
  statsEnabled: z.boolean().optional(),
  chatStatsmercuryEnabled: z.boolean().optional(),
  visionFallbackEnabled: z.boolean().optional(),
  embeddingFallbackEnabled: z.boolean().optional(),
});

const subAgentCapsSchema = z.object({
  maxIterations: z.number().int().min(1).max(100).optional(),
  maxToolCalls: z.number().int().min(1).max(500).optional(),
  maxOutputTokens: z.number().int().min(256).max(64000).optional(),
  timeoutSeconds: z.number().int().min(10).max(3600).optional(),
});

const agentYamlSchema = z.object({
  workspaceDir: z.string(),
  model: z.string(),
  enabled: z.boolean().optional(),
  kind: z.enum(['agent', 'subagent']).optional(),
  allowedCallers: z.array(z.string()).optional(),
  caps: subAgentCapsSchema.optional(),
  temperature: z.number().optional(),
  // Array de scales par LoRA chargé côté brain (index = id LoRA llama-server).
  // Vide / omis = pas de LoRA. Chaque scale ∈ [0, 5] ; 0 = adapter désactivé
  // pour cette agent mais on garde le slot pour la cohérence d'ordre.
  loraScales: z.array(z.number().min(0).max(5)).optional(),
  // Legacy mono-LoRA (deprecated, auto-migré au load → loraScales: [loraScale]).
  // Conservé optionnel pour pouvoir parser les YAML pré-migration sans erreur.
  loraScale: z.number().min(0).max(5).optional(),
  maxContextTokens: z.number().optional(),
  maxCompletionTokens: z.number().optional(),
  contextMessages: z.number().optional(),
  autoCompactThreshold: z.number().min(80).max(100).optional(),
  dailyCompact: z.object({
    enabled: z.boolean(),
    time: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
    // Saute le warmup KV post-compact planifié (agents cloud). Défaut runtime : false.
    skipWarmup: z.boolean().optional(),
    // Shuffle quotidien des scales LoRA, appliqué avant le compact (cf. loraShuffle).
    loraShuffle: z.object({
      enabled: z.boolean(),
      ranges: z.array(z.object({
        index: z.number().int().min(0),
        min: z.number().min(0).max(5),
        max: z.number().min(0).max(5),
        step: z.number().min(0).max(5).optional(),
      })).optional(),
    }).optional(),
  }).optional(),
  captureReasoningTraces: z.boolean().optional(),
  promptCacheTtl: z.number().optional(),
  thinkBudget: z.enum(['off', 'low', 'medium', 'high']).optional(),
  telegram: z.object({
    botId: z.string().optional(),
    enabled: z.boolean(),
    chatIds: z.array(z.number()),
    streaming: z.boolean().optional(),
    primaryChatId: z.number().optional(),
  }).optional(),
  tools: z.object({
    disabled: z.array(z.string()).optional(),
    allowOnly: z.array(z.string()).optional(),
    systemAccess: z.boolean().optional(),
    codebaseSearchIndex: z.string().optional(),
    codebaseSearchIndices: z.array(z.string()).optional(),
    codebaseSearchInPrompt: z.boolean().optional(),
  }).optional(),
  promptInjection: z.object({
    sharedStarredFiles: z.array(z.string()).optional(),
    workspaceStarredFiles: z.array(z.string()).optional(),
    starredSkills: z.array(z.string()).optional(),
  }).optional(),
  bypassUnifiedCache: z.boolean().optional(),
  lazySkills: z.boolean().optional(),
  skillCallMode: z.enum(['stub', 'wildcard']).optional(),
  excludeSharedMemory: z.boolean().optional(),
  // Permissif (ancien plat + v3) → normalisé v3 à la lecture. Cf. deliveryPolicyInputSchema.
  delivery: deliveryPolicyInputSchema.optional(),
  unifiedSession: z.boolean().optional(),
});

export const subagentDefaultsSchema = z.object({
  maxSpawnsPerParentRun: z.number().int().min(1).max(50).optional(),
  maxSpawnsPerDay: z.number().int().min(1).max(10000).optional(),
  caps: subAgentCapsSchema.optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  reportInjectionMaxChars: z.number().int().min(500).max(200000).optional(),
});

/** Mise à jour partielle `subagentDefaults` via `PUT /api/config`. */
export const subagentDefaultsPatchSchema = subagentDefaultsSchema.partial();

const telegramBotSchema = z.object({
  id: z.string(),
  token: z.string(),
  enabled: z.boolean().default(true),
});

/** Canal push mobile (APNs (mobile)). Réutilisé par le schéma global ET la route PUT /api/push/config. */
export const apnsConfigSchema = z.object({
  keyP8: z.string().optional(),
  keyPath: z.string().optional(),
  keyId: z.string().optional(),
  teamId: z.string().optional(),
  topic: z.string().optional(),
  production: z.boolean().optional(),
});

export const pushConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apns: apnsConfigSchema.optional(),
});

/** Schéma complet `codebaseSearch` (pour réutilisation). */
export const codebaseSearchConfigSchema = z.object({
  enabled: z.boolean().optional(),
  configPath: z.string().optional(),
  defaultDbPath: z.string().optional(),
  indices: z.record(z.string(), z.string()).optional(),
  allowUiIndex: z.boolean().optional(),
  embedSources: z.record(z.string(), z.string()).optional(),
  lastEmbedRuns: z
    .record(
      z.string(),
      z.object({
        at: z.string(),
        status: z.enum(['ok', 'error', 'running']),
        message: z.string().optional(),
      }),
    )
    .optional(),
  embedCronEnabled: z.boolean().optional(),
  embedCronHourUtc: z.number().int().min(0).max(23).optional(),
  embedCronMode: z.enum(['full', 'incremental']).optional(),
  /** Cron embed → always cloud (frees the GPU for other background jobs at night). */
  embedCronCloudOnly: z.boolean().optional(),
  /** Override runtime global : tous les embeds Mastermind passent cloud (libère le GPU pour chat). */
  embeddingForceCloud: z.boolean().optional(),
});

/** Mise à jour partielle via `PUT /api/config` (tous les champs optionnels). */
export const codebaseSearchPatchSchema = codebaseSearchConfigSchema.partial();

export const loggingConfigSchema = z.object({
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  file: z.string().optional(),
  maxFileSizeMb: z.number().positive().default(50),
  maxFiles: z.number().int().min(2).max(100).default(5),
});

/** Mise à jour partielle `logging` via `PUT /api/config`. */
export const loggingPatchSchema = loggingConfigSchema.partial();

/** Schéma heures d'ouverture — bloque les inférences pendant la plage fermée sauf override. */
export const openingHoursSchema = z.object({
  enabled: z.boolean().optional(),
  closedStart: z.number().int().min(0).max(23),
  closedEnd: z.number().int().min(0).max(23),
  overrideOpen: z.boolean().optional(),
});

export const openingHoursPatchSchema = openingHoursSchema.partial();

/** Schéma consolidation chat quotidienne. */
export const chatConsolidationSchema = z.object({
  enabled: z.boolean().optional(),
  cronHour: z.number().int().min(0).max(23).optional(),
  model: z.string().optional(),
  validateSummaries: z.boolean().optional(),
  minSummaryChars: z.number().int().min(0).max(10000).optional(),
});

/** Schéma consolidation mémoire. */
export const memoryConsolidationSchema = z.object({
  enabled: z.boolean().optional(),
  cronSchedule: z.enum(['weekly', 'daily']).optional(),
  cronHour: z.number().int().min(0).max(23).optional(),
  mergeModel: z.string().optional(),
  scoring: z.object({
    recencyWeight: z.number().min(0).max(1).optional(),
    frequencyWeight: z.number().min(0).max(1).optional(),
    ageWeight: z.number().min(0).max(1).optional(),
    recencyHalfLifeDays: z.number().positive().optional(),
    maxAgeDays: z.number().positive().optional(),
  }).optional(),
  clustering: z.object({
    mergeThreshold: z.number().min(0).max(1).optional(),
    maxPairsPerRun: z.number().int().positive().optional(),
    maxClusterSize: z.number().int().min(2).max(20).optional(),
  }).optional(),
  archival: z.object({
    scoreThreshold: z.number().min(0).max(1).optional(),
    minAgeDaysBeforeArchive: z.number().int().positive().optional(),
  }).optional(),
  delayBetweenMergesMs: z.number().int().min(0).optional(),
});

/** Schéma unifié consolidation (chat + memory). */
export const consolidationSchema = z.object({
  chat: chatConsolidationSchema.optional(),
  memory: memoryConsolidationSchema.optional(),
});

/** Mise à jour partielle via `PUT /api/config`. */
export const consolidationPatchSchema = z.object({
  chat: chatConsolidationSchema.partial().optional(),
  memory: memoryConsolidationSchema.partial().optional(),
});

export const configSchema = z.object({
  server: z.object({
    port: z.number().default(3000),
    host: z.string().default('0.0.0.0'),
    apiKey: z.string(),
  }),
  paths: z.object({
    agentsDir: z.string(),
    sharedMemoryDir: z.string(),
    compactArchivesDir: z.string().optional(),
    skillsDir: z.string().optional(),
    /** Where chat-uploaded user images get dumped so the agent can pass them
     * by absolute path to tools (e.g. skill_media-gen edit mode). Empty or
     * undefined → defaults to `<sharedMemoryDir>/user-images/`. */
    userImagesDir: z.string().optional(),
    /** Root for sub-agent Markdown reports on disk: `<root>/<presetId>/<jobId>.md`. Empty/absent → DB only. */
    subagentReportsDir: z.string().optional(),
  }),
  database: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().default(5432),
    database: z.string().default('mastermind'),
    user: z.string(),
    password: z.string(),
  }),
  defaults: z.object({
    model: z.string().default('anthropic/claude-sonnet-4'),
    temperature: z.number().default(0.7),
    maxContextTokens: z.number().default(100000),
    toolDefaults: z.object({
      bashTimeoutMs: z.number().optional(),
      webFetchMaxChars: z.number().optional(),
      maxToolTurns: z.number().optional(),
      /** Nombre max d'appels à extended_reasoning par run (défaut: 3). */
      maxReasoningCalls: z.number().optional(),
      /** Taille max du prompt envoyé au modèle de raisonnement en caractères (défaut: 8000). */
      maxReasoningInputChars: z.number().optional(),
      /** Max consecutive identical tool_calls before soft-refuse. Default 5. 0 = disabled. */
      maxIdenticalToolCalls: z.number().int().min(0).max(50).optional(),
      /** Auto-abort run when loop guard fires twice in a row. Default true. */
      autoAbortOnLoopGuard: z.boolean().optional(),
    }).optional(),
    /**
     * Décharger automatiquement le modèle précédent au switch (UI chat / Telegram picker /
     * updateAgentConfig). Défaut : true (backward-compat). Régler à false quand plusieurs
     * agents partagent le même modèle pour que le switch soit instantané.
     */
    autoUnloadOnSwitch: z.boolean().optional(),
    /**
     * Cache-optimized prompt assembly. ON = drop send_to_user duplicate from rebuild +
     * keep think blocks → minimize byte mismatch with llama.cpp's streamed slot KV.
     * OFF = include the duplicate (full audit trail in LLM history), keep think.
     * Default ON. Recommended for local single-slot LLMs (no SWA, latency-bound).
     * See shared/types/config.ts for the full trade-off rationale.
     */
    cacheOptimized: z.boolean().optional(),
    /**
     * @deprecated Hidden from UI. Still honored in YAML for power users wanting
     * token-savings at the cost of prefix cache miss. Default false (keep think for
     * max cache hit). Set true to force-strip even in cache-optimized mode.
     */
    stripThinkBlocks: z.boolean().optional(),
  }).passthrough(),
  providers: z.array(providerSchema).default([]),
  agents: z.record(z.string(), agentYamlSchema).default({}),
  telegram: z.object({
    bots: z.array(telegramBotSchema).default([]),
  }).default({ bots: [] }),
  /** Canal push mobile (APNs (mobile)) — miroir de telegram, désactivé par défaut. */
  push: pushConfigSchema.optional(),
  search: z.object({
    braveApiKey: z.string().optional(),
  }).optional(),
  codebaseSearch: codebaseSearchConfigSchema.optional(),
  logging: loggingConfigSchema.optional(),
  openingHours: openingHoursSchema.optional(),
  consolidation: consolidationSchema.optional(),
  /** @deprecated backward compat — utiliser consolidation.memory */
  memoryConsolidation: memoryConsolidationSchema.optional(),
  memoryStore: z.object({
    enabled: z.boolean().default(false),
    embeddingDimensions: z.number().optional(),
    enableDeduplication: z.boolean().optional(),
    deduplicationThreshold: z.number().min(0).max(1).optional(),
    bypassSignificanceFilter: z.boolean().optional(),
    autoInjection: z.object({
      enabled: z.boolean().optional(),
      topK: z.number().optional(),
      threshold: z.number().optional(),
      maxCharsPerChunk: z.number().optional(),
      includeShared: z.boolean().optional(),
    }).optional(),
  }).optional(),
  ncm: z.object({
    baseUrl: z.string(),
  }).optional(),
  subagentDefaults: subagentDefaultsSchema.optional(),
  ui: z.object({
    theme: z.string().optional(),
  }).optional(),
});
