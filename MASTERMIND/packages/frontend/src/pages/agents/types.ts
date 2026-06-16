import type { AgentDeliveryPolicy } from '@mastermind/shared';

export type Tab = 'files' | 'config' | 'shared' | 'skills' | 'cache' | 'jobs' | 'runs';

// Politique de livraison v3 (granulaire par CANAL × TRIGGER) — source de vérité unique côté
// shared. Le backend renvoie TOUJOURS du v3 normalisé via l'API, on ne manipule donc que ce
// shape côté front (plus de miroir plat legacy). Ré-exporté pour les consommateurs internes
// du dossier agents/ qui importaient l'ancien miroir depuis './types'.
export type { AgentDeliveryPolicy, DeliveryTrigger } from '@mastermind/shared';

export const TOOL_CATEGORIES = {
  'Fichiers & Systeme': ['bash', 'read_file', 'write_file', 'edit_file', 'list_dir'],
  'Memoire partagee (filesystem)': ['shared_read', 'shared_write', 'shared_edit', 'shared_list'],
  'Memoire': ['memory_write', 'memory_search', 'session_search'],
  'Web & Recherche': ['web_fetch', 'web_search', 'codebase_search', 'codebase_search_read', 'codebase_search_list'],
  'Raisonnement': ['extended_reasoning'],
  'Vision': ['inspect_image'],
  'Skills': ['skill_create'],
  'Scheduler': ['schedule_task', 'list_scheduled_tasks', 'get_scheduled_task', 'update_scheduled_task', 'delete_scheduled_task'],
  'Tâches async': ['list_my_jobs', 'dispatch_sandbox_run', 'list_subagents', 'spawn_subagent'],
  'Proactif': ['list_proactive_watchers', 'create_proactive_task'],
  'Board': ['board_write', 'board_delete'],
  'Escalade & Notification': ['escalate_to_agent', 'send_to_user'],
} as const;

export const ALL_TOOLS = Object.values(TOOL_CATEGORIES).flat();
export type ToolName = typeof ALL_TOOLS[number];

export interface AgentFull {
  identity: { id: string; name: string; emoji: string; creature?: string; vibe?: string };
  workspacePath: string;
  workspaceDir: string;
  model: string;
  enabled?: boolean;
  temperature?: number;
  promptCacheTtl?: number;
  maxContextTokens: number;
  maxCompletionTokens?: number;
  contextMessages?: number;
  autoCompactThreshold?: number;
  dailyCompact?: {
    enabled: boolean;
    time?: string;
    /** Saute le warmup KV post-compact planifié (agents cloud). */
    skipWarmup?: boolean;
    /** Shuffle quotidien des scales LoRA, appliqué avant le compact. */
    loraShuffle?: {
      enabled: boolean;
      ranges?: Array<{ index: number; min: number; max: number; step?: number }>;
    };
  };
  captureReasoningTraces?: boolean;
  thinkBudget?: 'off' | 'low' | 'medium' | 'high';
  bypassUnifiedCache?: boolean;
  lazySkills?: boolean;
  /** How skill actions are exposed in tools[] when lazy is active. Default 'stub'. */
  skillCallMode?: 'stub' | 'wildcard';
  /** Exclut l'agent de la LECTURE de la mémoire shared (écriture toujours permise). Default false. */
  excludeSharedMemory?: boolean;
  /** Politique de livraison agent→user. `null` = reset explicite vers legacy (PUT + ws patch). */
  delivery?: AgentDeliveryPolicy | null;
  /** Mode session unifiée cross-plateforme : web/mobile/NCM/DM Telegram → 1 session `{agent}-unified`. Default false. */
  unifiedSession?: boolean;
  loraScales?: number[];
  telegram?: { botId?: string; enabled: boolean; chatIds: number[]; streaming?: boolean };
  tools?: {
    disabled?: string[];
    /** Sub-agents uniquement : liste blanche d’outils (noms canoniques + skill_*). Vide/absent = pas de restriction. */
    allowOnly?: string[];
    systemAccess?: boolean;
    codebaseSearchIndex?: string;
    codebaseSearchIndices?: string[];
    codebaseSearchInPrompt?: boolean;
  };
  promptInjection?: { sharedStarredFiles?: string[]; workspaceStarredFiles?: string[]; starredSkills?: string[] };
  state: string;
  // Sub-agent fields (only meaningful when kind === 'subagent')
  kind?: 'agent' | 'subagent';
  allowedCallers?: string[];
  caps?: {
    maxIterations?: number;
    maxToolCalls?: number;
    maxOutputTokens?: number;
    timeoutSeconds?: number;
  };
}

export interface SkillEntry {
  /** Display name — frontmatter ou dir si absent. À utiliser uniquement pour l'UI. */
  name: string;
  /** Dir name canonique (= nom du dossier). Utilisé pour starredSkills + lookup API. */
  dir: string;
  description?: string;
  summary?: string;
  emoji?: string;
  hint?: string;
  requires?: { bins?: string[] };
}

export interface WorkspaceFile {
  name: string;
  mtime: string;
}

export interface BotOption {
  id: string;
  enabled: boolean;
  running: boolean;
}

export interface LiveModel {
  providerId?: string;
  id: string;
  name: string;
  contextLength?: number;
}

export interface ProviderOption {
  id: string;
  type: string;
}

export interface CreateForm {
  id: string;
  workspaceDir: string;
  model: string;
  telegramEnabled: boolean;
}

export interface SharedEntry {
  name: string;
  isDir: boolean;
  mtime?: string;
}

export interface PromptSizeEstimate {
  web: { chars: number; estimatedTokens: number; sections?: Array<{ key: string; chars: number; estimatedTokens: number }> };
  telegram: { chars: number; estimatedTokens: number; sections?: Array<{ key: string; chars: number; estimatedTokens: number }> };
}

/** Response of GET /api/debug/prompt-cache — cross-agent KV-cache sharing analysis. */
export interface PromptCacheAnalysis {
  agents: Array<{
    id: string;
    totalChars: number;
    totalTokensEst: number;
    toolsChars: number;
    systemPromptChars: number;
    sections: Array<{ key: string; chars: number; tokens: number }>;
  }>;
  matrix: Array<{
    a: string;
    b: string;
    commonChars: number;
    commonTokensEst: number;
    firstDivergenceSection: string;
  }>;
}

export const DEFAULT_CREATE: CreateForm = {
  id: '',
  workspaceDir: '',
  model: '',
  telegramEnabled: false,
};

export function formatMtime(mtime: string): string {
  return new Date(mtime).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
