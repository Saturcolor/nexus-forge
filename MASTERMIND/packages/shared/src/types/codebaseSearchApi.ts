/** Réponses API /api/codebase-search (UI Mémoire + debug) */

export interface CodebaseSearchStatusResponse {
  enabled: boolean;
  configPath?: string;
  defaultDbPath?: string;
  indices: Record<string, string>;
  /** Chemins résolus (absolus) pour l'UI */
  resolvedIndices: Record<string, string>;
  resolvedDefaultDbPath?: string;
  resolvedConfigPath?: string;
  embedSources: Record<string, string>;
  resolvedEmbedSources: Record<string, string>;
  lastEmbedRuns?: Record<
    string,
    {
      at: string;
      status: 'ok' | 'error' | 'running';
      message?: string;
      progress?: { phase: 'chunking' | 'embedding'; done: number; total: number };
    }
  >;
  embedCronEnabled?: boolean;
  embedCronHourUtc?: number;
  embedCronMode?: 'full' | 'incremental';
  /** Cron embed → toujours cloud (libère le GPU pour les jobs nocturnes). */
  embedCronCloudOnly?: boolean;
  /** Override runtime global : tous les embeds tapent cloud (libère le GPU pour chat). */
  embeddingForceCloud?: boolean;
  allowUiIndex?: boolean;
  /** true si un provider Mercury a embeddingFallbackEnabled (broker actif). */
  embeddingBrokerActive?: boolean;
  /** Nombre de jobs d'embedding résolus (source + db) */
  embedJobCount?: number;
}

export interface CodebaseSearchStatsResponse {
  index: string;
  dbPath: string;
  totalChunks: number;
  extensions: Record<string, number>;
}

export interface CodebaseSearchHit {
  /** Index this hit came from. Lets the agent pass the right `index` to codebase_search_read/list
   *  (or omit it — absolute paths are inferred), and disambiguates multi-index merged results. */
  indexKey?: string;
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
  /** Raw distance score from the vector store (lower = closer). */
  score: number;
  /** Normalized relevance score in [0, 1] computed as 1 / (1 + score). Higher = more relevant. */
  relevanceScore: number;
  name?: string;
  type?: string;
  contentPreview: string;
}

export interface CodebaseSearchSearchResponse {
  query: string;
  index: string;
  dbPath: string;
  hits: CodebaseSearchHit[];
}
