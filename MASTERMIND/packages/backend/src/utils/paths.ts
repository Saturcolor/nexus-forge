import path from 'node:path';

/**
 * Normalize a relative prompt path, rejecting traversal attempts.
 * Returns null if the path is empty or contains suspicious patterns.
 */
export function normalizePromptPath(p: string): string | null {
  const normalized = p.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.includes(':')) return null;
  return normalized;
}

/**
 * Resolve `rel` under `baseDir` and guarantee the result is contained inside it.
 * Throws if the resolved path escapes `baseDir` via traversal / absolute path.
 */
export function resolveSafePath(baseDir: string, rel: string): string {
  const normalized = normalizePromptPath(rel);
  if (!normalized) throw new Error(`Invalid path: "${rel}"`);
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, normalized);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path traversal blocked: "${rel}" resolves outside "${baseDir}"`);
  }
  return resolved;
}
