/**
 * API programmatique pour Mastermind (sans CLI / sans spinner).
 */
import { loadConfig, validateConfig } from './config.js';
import { CodebaseSearcher } from './searcher.js';
import { CodebaseIndexer } from './indexer.js';
import type { Config, SearchResult, SearchOptions } from './types.js';

async function loadMergedConfig(
  configPath: string | undefined,
  overrides?: Partial<Config>,
): Promise<Config> {
  const base = await loadConfig(configPath);
  if (!overrides || Object.keys(overrides).length === 0) return base;
  return { ...base, ...overrides };
}

export type SearchCodebaseParams = {
  dbPath: string;
  configPath?: string;
  /** Fusionné sur la config JSON (clé API, modèle d’embedding, etc.) */
  configOverrides?: Partial<Config>;
} & Omit<SearchOptions, 'silent'>;

/**
 * Recherche vectorielle / hybride dans un index LanceDB.
 */
export async function searchCodebase(params: SearchCodebaseParams): Promise<SearchResult[]> {
  const config = await loadMergedConfig(params.configPath, params.configOverrides);
  validateConfig(config, { requireApiKey: true });

  const {
    dbPath,
    configPath: _cp,
    configOverrides: _co,
    query,
    limit,
    extensions,
    filePattern,
    type,
    fileNameWeight,
    candidatePool,
    rerankTopK,
    exactSymbol,
  } = params;

  const searcher = new CodebaseSearcher(config, dbPath);
  await searcher.initialize();

  return searcher.search({
    query,
    limit,
    extensions,
    filePattern,
    type,
    fileNameWeight,
    candidatePool,
    rerankTopK,
    exactSymbol,
    silent: true,
  });
}

export type IndexStatsResult = {
  totalChunks: number;
  extensions: Record<string, number>;
};

export async function getIndexStats(params: {
  dbPath: string;
  configPath?: string;
  configOverrides?: Partial<Config>;
}): Promise<IndexStatsResult> {
  const config = await loadMergedConfig(params.configPath, params.configOverrides);
  validateConfig(config, { requireApiKey: false });

  const searcher = new CodebaseSearcher(config, params.dbPath);
  await searcher.initialize();
  const stats = await searcher.getStats();
  return {
    totalChunks: stats.totalChunks,
    extensions: stats.extensions,
  };
}

export type RunIndexDirectoryResult = {
  totalFiles: number;
  totalChunks: number;
  totalSize: number;
  indexedAt: string;
};

export type EmbedProgressCallback = (phase: string, done: number, total: number) => void;

/**
 * Réindexation complète d’un répertoire source vers un LanceDB (écrase la table).
 */
export async function runIndexDirectory(params: {
  sourcePath: string;
  dbPath: string;
  configPath?: string;
  configOverrides?: Partial<Config>;
  onProgress?: EmbedProgressCallback;
}): Promise<RunIndexDirectoryResult> {
  const config = await loadMergedConfig(params.configPath, params.configOverrides);
  validateConfig(config, { requireApiKey: true });

  const indexer = new CodebaseIndexer(config, params.dbPath, { silent: true });
  await indexer.initialize();
  const stats = await indexer.indexDirectory(params.sourcePath, params.onProgress);
  return {
    totalFiles: stats.totalFiles,
    totalChunks: stats.totalChunks,
    totalSize: stats.totalSize,
    indexedAt: stats.indexedAt,
  };
}

export type IncrementalUpdateResult = {
  addedChunks: number;
  removedFiles: number;
  modifiedFiles: number;
};

/**
 * Incremental update of a LanceDB index: auto-detects new/removed files
 * vs. the current index and only processes the diff.
 */
export async function runIncrementalUpdate(params: {
  sourcePath: string;
  dbPath: string;
  configPath?: string;
  configOverrides?: Partial<Config>;
  onProgress?: EmbedProgressCallback;
}): Promise<IncrementalUpdateResult> {
  const config = await loadMergedConfig(params.configPath, params.configOverrides);
  validateConfig(config, { requireApiKey: true });

  const indexer = new CodebaseIndexer(config, params.dbPath, { silent: true });
  await indexer.initialize();

  const [currentFiles, indexedFiles] = await Promise.all([
    indexer.discoverFiles(params.sourcePath),
    indexer.getIndexedFileMetadata(),
  ]);

  const indexedSet = new Set(indexedFiles.keys());
  const currentSet = new Set(currentFiles);
  const currentMtimes = new Map<string, number>();
  for (const file of currentFiles) {
    currentMtimes.set(file, await indexer.getFileMtimeForPath(file));
  }

  const newFiles = currentFiles.filter(f => !indexedSet.has(f));
  const removedFiles = [...indexedSet].filter(f => !currentSet.has(f));
  const modifiedFiles = currentFiles.filter(f =>
    indexedSet.has(f) && (indexedFiles.get(f) ?? 0) !== (currentMtimes.get(f) ?? 0),
  );

  return indexer.updateIncremental(newFiles, removedFiles, modifiedFiles, params.onProgress);
}

export { CodebaseSearcher } from './searcher.js';
export { CodebaseIndexer } from './indexer.js';
export { loadConfig, validateConfig } from './config.js';
export type { SearchResult, SearchOptions, CodeChunk, Config } from './types.js';
