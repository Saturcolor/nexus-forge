import { searchCodebase, getIndexStats } from '@mastermind/codebase-search/lib';
import type { MastermindConfig } from '@mastermind/shared';
import type { CodebaseSearchHit } from '@mastermind/shared';
import path from 'node:path';
import {
  resolveCodebaseSearchDbPaths,
  resolveCodebaseSearchDbPathByKey,
  resolveCodebaseSearchPath,
  resolveCodebaseSearchSourceRoot,
  inferCodebaseSearchIndexForPath,
  SHARED_MEMORY_INDEX_KEY,
} from './paths.js';
import { buildCodebaseSearchConfigOverrides } from './overrides.js';
import { readFile as readFileSandboxed, listDir as listDirSandboxed } from '../agent/tools/files.js';

export const CODEBASE_SEARCH_MAX_LIMIT = 20;

function clampLimit(n: unknown): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 10;
  return Math.min(CODEBASE_SEARCH_MAX_LIMIT, Math.max(1, x));
}

export async function runCodebaseSearchQuery(params: {
  config: MastermindConfig;
  resolvePath: (p: string) => string;
  agentId?: string;
  query: string;
  limit?: unknown;
  type?: 'vector' | 'hybrid';
  extensions?: string[];
  filePattern?: string;
  index?: string;
  fileNameWeight?: number;
  exactSymbol?: boolean;
}): Promise<{ dbPath: string; indexKey: string; hits: CodebaseSearchHit[]; warnings: string[] }> {
  const {
    config,
    resolvePath,
    agentId,
    query,
    limit,
    type = 'vector',
    extensions,
    filePattern,
    index,
    fileNameWeight,
    exactSymbol,
  } = params;

  const q = String(query ?? '').trim();
  if (!q) throw new Error('query is required');
  console.debug(`[codebase-search] query="${q.slice(0, 60)}" type=${type} index=${index ?? 'auto'} agent=${agentId ?? '∅'}`);

  const cs = config.codebaseSearch;
  const configPath = cs?.configPath
    ? resolveCodebaseSearchPath(cs.configPath, resolvePath)
    : undefined;
  const configOverrides = buildCodebaseSearchConfigOverrides(config);
  const maxLimit = clampLimit(limit);

  // Explicit index override (from UI search or tool arg) → single index
  if (index) {
    const resolved = resolveCodebaseSearchDbPathByKey(config, resolvePath, index);
    if (!resolved) throw new Error(`Unknown index "${index}" or codebase search disabled`);
    const startedAt = Date.now();
    const results = await searchCodebase({
      dbPath: resolved.dbPath, configPath, configOverrides,
      query: q, limit: maxLimit, type,
      extensions: extensions?.length ? extensions : undefined,
      filePattern: filePattern || undefined, fileNameWeight, exactSymbol,
    });
    const hits = results.map(r => toHit(r, resolved.indexKey));
    console.debug(`[codebase-search] query done index=${resolved.indexKey} hits=${hits.length} limit=${maxLimit} ms=${Date.now() - startedAt}`);
    return { dbPath: resolved.dbPath, indexKey: resolved.indexKey, hits, warnings: [] };
  }

  // Multi-index: resolve all indexes for the agent, search in parallel
  const resolvedList = resolveCodebaseSearchDbPaths(config, resolvePath, agentId);
  if (resolvedList.length === 0) {
    throw new Error(
      'codebase_search is not configured (enable codebaseSearch in mastermind.yml and set defaultDbPath or indices)',
    );
  }

  if (resolvedList.length === 1) {
    const resolved = resolvedList[0]!;
    const startedAt = Date.now();
    const results = await searchCodebase({
      dbPath: resolved.dbPath, configPath, configOverrides,
      query: q, limit: maxLimit, type,
      extensions: extensions?.length ? extensions : undefined,
      filePattern: filePattern || undefined, fileNameWeight, exactSymbol,
    });
    const hits = results.map(r => toHit(r, resolved.indexKey));
    console.debug(`[codebase-search] query done index=${resolved.indexKey} hits=${hits.length} limit=${maxLimit} ms=${Date.now() - startedAt}`);
    return { dbPath: resolved.dbPath, indexKey: resolved.indexKey, hits, warnings: [] };
  }

  // Multiple indexes: fetch per-index, merge and re-rank by relevanceScore
  const perIndexLimit = Math.min(CODEBASE_SEARCH_MAX_LIMIT, maxLimit * 2);
  const allResults = await Promise.allSettled(
    resolvedList.map(r => searchCodebase({
      dbPath: r.dbPath, configPath, configOverrides,
      query: q, limit: perIndexLimit, type,
      extensions: extensions?.length ? extensions : undefined,
      filePattern: filePattern || undefined, fileNameWeight, exactSymbol,
    })),
  );

  const merged: CodebaseSearchHit[] = [];
  const warnings: string[] = [];
  allResults.forEach((r, i) => {
    const rk = resolvedList[i]!;
    if (r.status === 'fulfilled') {
      merged.push(...r.value.map(h => toHit(h, rk.indexKey)));
    } else {
      // Don't let a broken/missing index vanish silently — surface it to the agent.
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      warnings.push(`index "${rk.indexKey}" indisponible: ${reason}`);
      console.warn(`[codebase-search] index ${rk.indexKey} failed: ${reason}`);
    }
  });
  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const hits = merged.slice(0, maxLimit);

  const primary = resolvedList[0]!;
  const mergedKey = resolvedList.map(r => r.indexKey).join('+');
  console.debug(`[codebase-search] multi-index merge=${mergedKey} totalMerged=${merged.length} returned=${hits.length} warnings=${warnings.length}`);
  return { dbPath: primary.dbPath, indexKey: mergedKey, hits, warnings };
}

function toHit(r: { score: number; chunk: { filePath: string; fileName: string; startLine: number; endLine: number; content?: string; name?: string; type?: string } }, indexKey?: string): CodebaseSearchHit {
  const content = r.chunk.content ?? '';
  const preview = content.split('\n').slice(0, 8).join('\n').slice(0, 1200);
  return {
    indexKey,
    filePath: r.chunk.filePath,
    fileName: r.chunk.fileName,
    startLine: r.chunk.startLine,
    endLine: r.chunk.endLine,
    score: r.score,
    relevanceScore: Math.round((1 / (1 + r.score)) * 1000) / 1000,
    name: r.chunk.name,
    type: r.chunk.type,
    contentPreview: preview,
  };
}

/**
 * Résout (indexKey, sourceRoot) pour un read/list.
 * - Chemin absolu → on infère l'index par le chemin (un hit renvoie un chemin absolu mais
 *   l'agent ne sait pas toujours de quel index il vient). L'inférence prime sur un `index`
 *   fourni mais erroné. Fallback sur l'index fourni si l'inférence échoue.
 * - Chemin relatif → on exige un `index` (rien à inférer).
 */
function resolveIndexAndRoot(
  config: MastermindConfig,
  resolvePath: (p: string) => string,
  index: string | undefined,
  p: string,
): { indexKey: string; sourceRoot: string } {
  const indexKey = String(index ?? '').trim();

  // Shared memory is reachable ONLY via shared_read/shared_search. Reject both an explicit
  // index='shared-memory' and the absolute-path fallback that would resolve its source root.
  // (inferCodebaseSearchIndexForPath already returns null for shared-memory paths.)
  if (indexKey === SHARED_MEMORY_INDEX_KEY) {
    throw new Error(`Index "${SHARED_MEMORY_INDEX_KEY}" is reserved — use shared_read/shared_search to access shared memory.`);
  }

  if (path.isAbsolute(p)) {
    const inferred = inferCodebaseSearchIndexForPath(config, resolvePath, p);
    if (inferred) return inferred;
    if (indexKey) {
      const root = resolveCodebaseSearchSourceRoot(config, resolvePath, indexKey);
      if (root) return { indexKey, sourceRoot: root };
    }
    throw new Error(
      `Could not map absolute path "${p}" to any indexed source root (codebaseSearch.embedSources). ` +
      'Pass a path returned by codebase_search, or a relative path with an explicit index.',
    );
  }

  if (!indexKey) {
    throw new Error('index is required for a relative path (or pass the absolute path from a codebase_search hit to infer it).');
  }
  const sourceRoot = resolveCodebaseSearchSourceRoot(config, resolvePath, indexKey);
  if (!sourceRoot) {
    throw new Error(
      `Unknown index "${indexKey}" or no embedSources configured for it (codebaseSearch.embedSources["${indexKey}"]).`,
    );
  }
  return { indexKey, sourceRoot };
}

/**
 * Lit un fichier sous la racine source d'un index (allow-list = `embedSources[index]`).
 * Path traversal + absolute escape protégés via `safePath()` (réutilisé du file tool agent).
 * `lines` / `offset` / `limit` ont la même sémantique que `read_file`.
 * `index` est optionnel pour un chemin absolu (inféré depuis le chemin).
 */
export async function runCodebaseSearchReadFile(params: {
  config: MastermindConfig;
  resolvePath: (p: string) => string;
  index?: string;
  path: string;
  lines?: string;
  offset?: number;
  limit?: number;
}): Promise<{ indexKey: string; sourceRoot: string; content: string }> {
  const { config, resolvePath, index, path: relPath, lines, offset, limit } = params;
  const p = String(relPath ?? '').trim();
  if (!p) throw new Error('path is required');

  const { indexKey, sourceRoot } = resolveIndexAndRoot(config, resolvePath, index, p);

  console.debug(`[codebase-search] read index=${indexKey} root=${sourceRoot} path=${p} lines=${lines ?? 'all'}`);
  const content = await readFileSandboxed(p, sourceRoot, false, [sourceRoot], lines, offset, limit);
  return { indexKey, sourceRoot, content };
}

/**
 * Liste un répertoire sous la racine source d'un index. Pas de récursion.
 * `path` vide → racine source.
 */
export async function runCodebaseSearchListDir(params: {
  config: MastermindConfig;
  resolvePath: (p: string) => string;
  index?: string;
  path?: string;
}): Promise<{ indexKey: string; sourceRoot: string; path: string; entries: string }> {
  const { config, resolvePath, index, path: relPath } = params;
  const p = (relPath ?? '').trim();
  // Empty path → list the index root; that's a relative target, so an explicit index is needed.
  const { indexKey, sourceRoot } = resolveIndexAndRoot(config, resolvePath, index, p || '.');

  const rel = p || '.';
  console.debug(`[codebase-search] list index=${indexKey} root=${sourceRoot} path=${rel}`);
  const entries = await listDirSandboxed(rel, sourceRoot, false, [sourceRoot]);
  return { indexKey, sourceRoot, path: rel, entries };
}

export async function runCodebaseSearchStats(params: {
  config: MastermindConfig;
  resolvePath: (p: string) => string;
  indexKey: string;
}): Promise<{ dbPath: string; totalChunks: number; extensions: Record<string, number> }> {
  const { config, resolvePath, indexKey } = params;
  const startedAt = Date.now();
  console.debug(`[codebase-search] stats start index=${indexKey}`);
  const resolved = resolveCodebaseSearchDbPathByKey(config, resolvePath, indexKey);
  if (!resolved) {
    console.warn(`[codebase-search] stats unknown index=${indexKey}`);
    throw new Error(`Unknown index "${indexKey}" or codebase search disabled`);
  }
  const cs = config.codebaseSearch;
  const configPath = cs?.configPath
    ? resolveCodebaseSearchPath(cs.configPath, resolvePath)
    : undefined;
  const configOverrides = buildCodebaseSearchConfigOverrides(config);

  const stats = await getIndexStats({
    dbPath: resolved.dbPath,
    configPath,
    configOverrides,
  });
  console.debug(
    `[codebase-search] stats done index=${resolved.indexKey} chunks=${stats.totalChunks} extensions=${Object.keys(stats.extensions ?? {}).length} ms=${Date.now() - startedAt}`,
  );
  return { dbPath: resolved.dbPath, ...stats };
}
