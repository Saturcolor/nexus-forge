import type {
  CodebaseSearchConfig,
  CodebaseSearchStatusResponse,
  CodebaseSearchStatsResponse,
  CodebaseSearchSearchResponse,
  EmbeddingChainEntry,
} from '@mastermind/shared';

export type {
  CodebaseSearchConfig,
  CodebaseSearchStatusResponse,
  CodebaseSearchStatsResponse,
  CodebaseSearchSearchResponse,
  EmbeddingChainEntry,
};

export interface MercuryChainSnapshot {
  providerId: string;
  entries: EmbeddingChainEntry[];
  error?: string;
  expectedDim?: number;
}

export type MemoryTab = 'search' | 'conversations' | 'config' | 'store' | 'board';

/** Un résultat de recherche plein-texte sur l'historique des conversations (GET /api/sessions/search). */
export interface SessionSearchHit {
  id: string;
  sessionId: string;
  role: string;
  createdAt: string;
  snippet: string;
  rank: number;
}

export interface MastermindConfigResponse {
  codebaseSearch?: CodebaseSearchConfig;
  memoryStore?: {
    enabled?: boolean;
    embeddingDimensions?: number;
    enableDeduplication?: boolean;
    deduplicationThreshold?: number;
    bypassSignificanceFilter?: boolean;
    autoInjection?: {
      enabled?: boolean;
      topK?: number;
      threshold?: number;
      maxCharsPerChunk?: number;
      includeShared?: boolean;
    };
  };
}

export interface OnboardCheck {
  step: string;
  ok: boolean;
  message: string;
}

export interface OnboardResult {
  ok: boolean;
  checks: OnboardCheck[];
}

export interface IndexEntry {
  id: string;
  key: string;
  sourcePath: string;
  dbPath: string;
}

export interface CsForm {
  enabled: boolean;
  configPath: string;
  indexEntries: IndexEntry[];
  allowUiIndex: boolean;
  embedCronEnabled: boolean;
  embedCronHourUtc: number;
  embedCronMode: 'full' | 'incremental';
  embedCronCloudOnly: boolean;
  embeddingForceCloud: boolean;
}

export interface MemoryEntry {
  id: string;
  text: string;
  agentId?: string;
  scope: 'agent' | 'shared';
  domain?: string;
  tags?: string[];
  source: string;
  createdAt: string;
  similarity?: number;
  accessCount?: number;
  lastAccessedAt?: string | null;
  score?: number | null;
  archived?: boolean;
  mergedInto?: string | null;
  mergeSourceIds?: string[];
}

export interface MemoryStoreStatus {
  enabled: boolean;
  reason?: string;
  error?: string;
  stats?: {
    total: number;
    perScope: Record<string, number>;
    perDomain: Record<string, number>;
    perAgent: Record<string, number>;
  };
}

export interface MemoryImportResult {
  ok: boolean;
  imported: number;
  skippedInsignificant: number;
  skippedDuplicate: number;
  total: number;
  error?: string;
}

export interface MemoryHealthStats {
  total: number;
  active: number;
  archived: number;
  neverAccessed: number;
  avgScore: number | null;
  oldestMemory: string | null;
  lastConsolidationRun: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    stats: { scored: number; clustersFound: number; merged: number; archived: number; errors: number };
  } | null;
}

export interface AgentSummary {
  identity: { id: string; name: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────

let _entryId = 0;
export const newEntryId = () => String(++_entryId);

/** Formate un timestamp ISO en texte lisible : "aujourd'hui 13:53", "hier 13:53", "21 mars 13:53" */
export function fmtRunAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return "a l'instant";
  if (diffMs < 3_600_000) return `il y a ${Math.floor(diffMs / 60_000)} min`;
  const todayStr = now.toDateString();
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === todayStr) return `aujourd'hui ${time}`;
  if (d.toDateString() === yest.toDateString()) return `hier ${time}`;
  const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `${day} ${time}`;
}

export const emptyForm: CsForm = {
  enabled: false,
  configPath: '',
  indexEntries: [{ id: newEntryId(), key: 'default', sourcePath: '', dbPath: '' }],
  allowUiIndex: true,
  embedCronEnabled: false,
  embedCronHourUtc: 3,
  embedCronMode: 'full',
  embedCronCloudOnly: false,
  embeddingForceCloud: false,
};

export function configToForm(cfg: MastermindConfigResponse | null): CsForm {
  const cs = cfg?.codebaseSearch;
  if (!cs) return { ...emptyForm, indexEntries: [{ id: newEntryId(), key: 'default', sourcePath: '', dbPath: '' }] };

  const hour =
    typeof cs.embedCronHourUtc === 'number' && !Number.isNaN(cs.embedCronHourUtc)
      ? Math.min(23, Math.max(0, cs.embedCronHourUtc))
      : 3;

  const indices: Record<string, string> = cs.indices ?? {};
  const embedSources: Record<string, string> = cs.embedSources ?? {};
  const allKeys = new Set<string>();

  if (cs.defaultDbPath) allKeys.add('default');
  Object.keys(indices).forEach(k => allKeys.add(k));
  Object.keys(embedSources).forEach(k => allKeys.add(k));

  let entries: IndexEntry[] = [...allKeys].map(k => ({
    id: newEntryId(),
    key: k,
    sourcePath: embedSources[k] ?? '',
    dbPath: k === 'default' ? (cs.defaultDbPath ?? indices[k] ?? '') : (indices[k] ?? ''),
  }));

  if (entries.length === 0) {
    entries = [{ id: newEntryId(), key: 'default', sourcePath: '', dbPath: '' }];
  }

  return {
    enabled: Boolean(cs.enabled),
    configPath: cs.configPath ?? '',
    indexEntries: entries,
    allowUiIndex: cs.allowUiIndex !== false,
    embedCronEnabled: Boolean(cs.embedCronEnabled),
    embedCronHourUtc: hour,
    embedCronMode: cs.embedCronMode === 'incremental' ? 'incremental' : 'full',
    embedCronCloudOnly: Boolean(cs.embedCronCloudOnly),
    embeddingForceCloud: Boolean(cs.embeddingForceCloud),
  };
}

/** Classe CSS commune pour les cards */
export const cardCls = 'bg-card rounded-xl border border-border/50 p-5';
export const inputCls = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-ring';
export const btnSecondary = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary border border-border/50 text-xs text-foreground hover:bg-muted disabled:opacity-50';
export const btnPrimary = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50';
export const badgeCls = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium';
