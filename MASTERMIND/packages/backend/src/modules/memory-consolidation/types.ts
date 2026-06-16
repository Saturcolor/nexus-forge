export interface ConsolidationRunStats {
  scored: number;
  clustersFound: number;
  merged: number;
  archived: number;
  errors: number;
}

export interface ConsolidationRun {
  id: string;
  agentId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'error';
  stats: ConsolidationRunStats;
  error: string | null;
}

export interface MemoryHealthStats {
  total: number;
  active: number;
  archived: number;
  neverAccessed: number;
  avgScore: number | null;
  oldestMemory: string | null;
  lastConsolidationRun: ConsolidationRun | null;
}
