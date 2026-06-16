import path from 'node:path';
import { homedir } from 'node:os';
import type { MastermindConfig } from '@mastermind/shared';

/**
 * Index key reserved for shared memory. It still lives in `codebaseSearch.indices`/`embedSources`
 * (so the embed cron keeps it fresh and `shared_search` can resolve it by key), but it is
 * deliberately excluded from the generic codebase_search resolution — agents reach shared memory
 * only through the dedicated `shared_*` tools. See `agent/tools/shared.ts`.
 */
export const SHARED_MEMORY_INDEX_KEY = 'shared-memory';

export function expandTilde(p: string): string {
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

/** Résout ~ et chemins relatifs au fichier YAML Mastermind. */
export function resolveCodebaseSearchPath(raw: string, resolvePath: (p: string) => string): string {
  const expanded = expandTilde(raw.trim());
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.normalize(resolvePath(expanded));
}

/**
 * Index LanceDB à utiliser pour un agent (override nommé ou defaultDbPath ou index unique).
 * @deprecated Préférer resolveCodebaseSearchDbPaths pour le support multi-index.
 */
export function resolveCodebaseSearchDbPath(
  config: MastermindConfig,
  resolvePath: (p: string) => string,
  agentId?: string,
): { dbPath: string; indexKey: string } | null {
  const results = resolveCodebaseSearchDbPaths(config, resolvePath, agentId);
  return results[0] ?? null;
}

/**
 * Retourne la liste des index LanceDB à utiliser pour un agent.
 * - Si l'agent a `codebaseSearchIndices` (array non vide) → seulement ces index
 * - Si l'agent a `codebaseSearchIndex` (legacy string) → cet index uniquement
 * - Sinon → tous les index configurés (defaultDbPath + indices)
 */
export function resolveCodebaseSearchDbPaths(
  config: MastermindConfig,
  resolvePath: (p: string) => string,
  agentId?: string,
): Array<{ dbPath: string; indexKey: string }> {
  const cs = config.codebaseSearch;
  if (!cs?.enabled) return [];

  const agent = agentId ? config.agents[agentId] : undefined;

  // New: explicit multi-index selection
  const indices = agent?.tools?.codebaseSearchIndices;
  if (indices && indices.length > 0) {
    return indices.flatMap(key => {
      const resolved = resolveCodebaseSearchDbPathByKey(config, resolvePath, key);
      return resolved ? [resolved] : [];
    });
  }

  // Legacy: single named index
  const namedKey = agent?.tools?.codebaseSearchIndex;
  if (namedKey) {
    const resolved = resolveCodebaseSearchDbPathByKey(config, resolvePath, namedKey);
    if (resolved) return [resolved];
  }

  // Fallback: all configured indexes — except the shared-memory index, which is served only
  // through the dedicated `shared_*` tools (shared_search), never via generic codebase_search.
  const all: Array<{ dbPath: string; indexKey: string }> = [];
  if (cs.defaultDbPath) {
    all.push({ dbPath: resolveCodebaseSearchPath(cs.defaultDbPath, resolvePath), indexKey: 'default' });
  }
  for (const [k, v] of Object.entries(cs.indices ?? {})) {
    if (k === SHARED_MEMORY_INDEX_KEY) continue;
    all.push({ dbPath: resolveCodebaseSearchPath(v, resolvePath), indexKey: k });
  }
  if (all.length === 0) return [];
  return all;
}

/** Résout un index par clé explicite (outil ou UI). */
export function resolveCodebaseSearchDbPathByKey(
  config: MastermindConfig,
  resolvePath: (p: string) => string,
  indexKey: string,
): { dbPath: string; indexKey: string } | null {
  const cs = config.codebaseSearch;
  if (!cs?.enabled) return null;
  if (indexKey === 'default' && cs.defaultDbPath) {
    return { dbPath: resolveCodebaseSearchPath(cs.defaultDbPath, resolvePath), indexKey: 'default' };
  }
  if (cs.indices?.[indexKey]) {
    return { dbPath: resolveCodebaseSearchPath(cs.indices[indexKey]!, resolvePath), indexKey };
  }
  return null;
}

/**
 * Racine source d'un index (depuis `codebaseSearch.embedSources[indexKey]`).
 * Sert d'allow-list pour les opérations file/list — on n'expose en lecture que
 * ce qu'on a accepté d'indexer.
 */
export function resolveCodebaseSearchSourceRoot(
  config: MastermindConfig,
  resolvePath: (p: string) => string,
  indexKey: string,
): string | null {
  const cs = config.codebaseSearch;
  if (!cs?.enabled) return null;
  const raw = cs.embedSources?.[indexKey];
  if (!raw) return null;
  return resolveCodebaseSearchPath(raw, resolvePath);
}

/**
 * Infère l'index dont la racine source (`embedSources`) contient `absPath`. Sert à
 * codebase_search_read/list : un hit renvoie un chemin absolu mais l'agent ne sait pas
 * forcément de quel index il vient — on retrouve l'index par le chemin plutôt que de le
 * faire deviner (mauvais devinage = "Absolute path not under allowed directories").
 * La racine la plus spécifique (longue) gagne. shared-memory est exclu (réservé aux shared_*).
 */
export function inferCodebaseSearchIndexForPath(
  config: MastermindConfig,
  resolvePath: (p: string) => string,
  absPath: string,
): { indexKey: string; sourceRoot: string } | null {
  const cs = config.codebaseSearch;
  if (!cs?.enabled || !cs.embedSources) return null;
  const target = path.normalize(path.resolve(expandTilde(absPath.trim())));
  let best: { indexKey: string; sourceRoot: string } | null = null;
  for (const [k, raw] of Object.entries(cs.embedSources)) {
    if (k === SHARED_MEMORY_INDEX_KEY) continue;
    const root = resolveCodebaseSearchPath(raw, resolvePath);
    const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (target === root || target.startsWith(rootSep)) {
      if (!best || root.length > best.sourceRoot.length) best = { indexKey: k, sourceRoot: root };
    }
  }
  return best;
}

export function listResolvedIndices(
  config: MastermindConfig,
  resolvePath: (p: string) => string,
): Record<string, string> {
  const cs = config.codebaseSearch;
  if (!cs?.indices) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cs.indices)) {
    out[k] = resolveCodebaseSearchPath(v, resolvePath);
  }
  return out;
}
