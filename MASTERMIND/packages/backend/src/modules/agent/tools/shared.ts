import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { readFile, writeFile, listDir, editFile } from './files.js';
import { runCodebaseSearchQuery } from '../../codebase-search/service.js';
import { SHARED_MEMORY_INDEX_KEY } from '../../codebase-search/paths.js';
import type { MastermindConfig } from '@mastermind/shared';

/**
 * Shared-memory-scoped tools — the *only* surface agents should use to discover, read and
 * write the shared memory directory.
 *
 * `shared_read` / `shared_write` / `shared_list` / `shared_edit` / `shared_search` always
 * resolve their `path` against the shared memory directory configured for the current run.
 * Paths are relative to the shared root; we ALSO accept an absolute path that already falls
 * under the shared root (and a `shared:` prefix) by normalizing it back to relative — because
 * the `# Environment` section advertises shared memory by its absolute path and
 * `shared_search` results echo paths, so the model naturally passes those straight back.
 * `~`, `..` traversal, and absolute paths that escape the shared root are still rejected:
 * there is no way for these tools to touch the agent's private workspace or the host fs.
 *
 * Why a separate family vs. just `write_file`: the workspace-by-default resolution of
 * `write_file` is invisible to the LLM (a bare `path: "foo.md"` looks scope-neutral but lands
 * in the agent's private workspace). Naming the scope in the tool name removes that ambiguity
 * for the model AND lets per-agent `allowOnly` whitelists gate shared-memory access at the
 * existing exec gate (see `tools/index.ts` executeTool).
 *
 * Internally the file ops delegate to the workspace-aware helpers in `files.ts` with `cwd`
 * forced to the shared dir and `allowedRoots` constrained to it, so any future feature added
 * to read_file/write_file/list_dir/edit_file (line slicing, MAX_READ_BYTES, occurrence
 * checks…) is inherited automatically. `shared_search` reuses the same LanceDB index that
 * powers codebase_search (index key `shared-memory`), just scoped + relativized here.
 */

function ensureSharedDir(dir: string | undefined): string {
  if (!dir) {
    throw new Error(
      'shared_* tool called but sharedMemoryDir is not configured for this run. ' +
      'This is a wiring bug — check ToolExecOptions in run.ts.',
    );
  }
  return path.resolve(dir);
}

/**
 * Normalize a model-supplied path to a clean path relative to the shared root.
 *
 * Accepts:
 *   - a plain relative path (`"reports/foo.md"`)
 *   - a `shared:` / `shared/` prefix (the attachment convention) → stripped
 *   - an absolute path that resolves *under* the shared root → rebased to relative
 *
 * Rejects:
 *   - empty / whitespace-only
 *   - `~` (home expansion)
 *   - `..` traversal segments
 *   - absolute paths that escape the shared root
 */
function preflightSharedPath(p: string, sharedDir: string): string {
  let trimmed = (p ?? '').trim();
  if (!trimmed) {
    throw new Error('shared_*: path is required (relative to shared memory root).');
  }

  // Strip the `shared:` / `shared/` attachment-style prefix if the model echoes it back.
  const prefixMatch = /^shared:\/*|^shared\/+/i.exec(trimmed);
  if (prefixMatch) trimmed = trimmed.slice(prefixMatch[0].length).trim();
  if (!trimmed) {
    throw new Error('shared_*: path is required (relative to shared memory root).');
  }

  if (trimmed.startsWith('~')) {
    throw new Error(`shared_*: paths starting with "~" are not allowed (got "${p}"). Use a path relative to the shared memory root.`);
  }

  // Absolute path: tolerate it ONLY when it already lives under the shared root, then rebase
  // to relative. Anything pointing elsewhere is a real escape and stays rejected.
  const isAbsolute = trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed);
  if (isAbsolute) {
    const resolved = path.normalize(path.resolve(trimmed));
    const rootWithSep = sharedDir.endsWith(path.sep) ? sharedDir : sharedDir + path.sep;
    if (resolved === sharedDir) return '.';
    if (resolved.startsWith(rootWithSep)) {
      trimmed = path.relative(sharedDir, resolved);
    } else {
      throw new Error(
        `shared_*: absolute path "${p}" is outside shared memory (${sharedDir}). ` +
        'Use a path relative to the shared memory root (e.g. "reports/foo.md").',
      );
    }
  }

  // Catch `..` as a full segment or as a prefix like `../`.
  const segments = trimmed.replace(/\\/g, '/').split('/');
  if (segments.some(s => s === '..')) {
    throw new Error(`shared_*: ".." traversal is not allowed (got "${p}").`);
  }
  return trimmed || '.';
}

export async function sharedRead(
  filePath: string,
  sharedDir: string | undefined,
  lines?: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  const dir = ensureSharedDir(sharedDir);
  const rel = preflightSharedPath(filePath, dir);
  console.debug(`[tool:shared_read] base=${dir} rel=${rel} lines=${lines ?? 'all'}`);
  return readFile(rel, dir, false, [dir], lines, offset, limit);
}

export async function sharedWrite(
  filePath: string,
  content: string,
  sharedDir: string | undefined,
): Promise<string> {
  const dir = ensureSharedDir(sharedDir);
  const rel = preflightSharedPath(filePath, dir);
  console.log(`[tool:shared_write] base=${dir} rel=${rel} contentLen=${content.length}`);
  return writeFile(rel, content, dir, false, [dir]);
}

/** Max entries emitted by a recursive `shared_list` walk (guards against huge trees). */
const SHARED_TREE_MAX_ENTRIES = 1000;

/**
 * Classify a directory entry as 'd' or 'f', following symlinks so a symlinked directory
 * (shared memory is rebuilt with symlinks) is reported as a directory, not a file.
 */
async function classify(absPath: string, entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<'d' | 'f'> {
  if (entry.isSymbolicLink()) {
    const st = await fs.stat(absPath).catch(() => null);
    return st?.isDirectory() ? 'd' : 'f';
  }
  return entry.isDirectory() ? 'd' : 'f';
}

/**
 * Recursive, depth-limited tree listing rooted at `absDir` (paths shown relative to it).
 *
 * `rootReal` is the realpath of the shared memory root. A symlinked directory whose target
 * escapes that root is listed (so the tree stays honest) but NOT traversed — otherwise a
 * symlink planted inside shared memory (e.g. via the bash tool) would let the agent
 * transparently enumerate the host filesystem and feed those paths back into `shared_read`.
 * Internal symlinks (shared memory is rebuilt with symlinks) resolve under the root and are
 * traversed normally.
 */
async function listTree(absDir: string, maxDepth: number, rootReal: string): Promise<string> {
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  const rootRealWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;

  async function walk(dir: string, relPrefix: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A missing/unreadable ROOT must surface as a real error, not look like an empty dir.
      // Deeper failures are annotated inline so the rest of the tree still lists.
      if (depth === 1) throw err;
      lines.push(`!  ${relPrefix} (unreadable: ${(err as Error).message})`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (count >= SHARED_TREE_MAX_ENTRIES) { truncated = true; return; }
      const abs = path.join(dir, e.name);
      const kind = await classify(abs, e);
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (kind === 'd' && depth < maxDepth) {
        const real = await fs.realpath(abs).catch(() => abs);
        if (real === rootReal || real.startsWith(rootRealWithSep)) {
          lines.push(`${kind}  ${rel}`);
          count++;
          await walk(abs, rel, depth + 1);
        } else {
          lines.push(`${kind}  ${rel}  [symlink→outside-shared, not traversed]`);
          count++;
        }
      } else {
        lines.push(`${kind}  ${rel}`);
        count++;
      }
    }
  }

  await walk(absDir, '', 1);
  if (truncated) lines.push(`… (truncated at ${SHARED_TREE_MAX_ENTRIES} entries — narrow with a sub-path)`);
  return lines.join('\n') || '(empty directory)';
}

export async function sharedList(
  dirPath: string | undefined,
  sharedDir: string | undefined,
  recursive = false,
  depth = 3,
): Promise<string> {
  const dir = ensureSharedDir(sharedDir);
  // Empty / missing → list shared root. Otherwise normalize as a regular relative path.
  const raw = (dirPath ?? '').trim();
  const rel = raw === '' || raw === '.' ? '.' : preflightSharedPath(raw, dir);

  if (recursive) {
    const maxDepth = Math.max(1, Math.min(10, Math.floor(depth) || 3));
    const absDir = path.resolve(dir, rel);
    const rootReal = await fs.realpath(dir).catch(() => dir);
    console.debug(`[tool:shared_list] base=${dir} rel=${rel} recursive depth=${maxDepth}`);
    return listTree(absDir, maxDepth, rootReal);
  }

  console.debug(`[tool:shared_list] base=${dir} rel=${rel}`);
  return listDir(rel, dir, false, [dir]);
}

export async function sharedEdit(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  sharedDir: string | undefined,
): Promise<string> {
  const dir = ensureSharedDir(sharedDir);
  const rel = preflightSharedPath(filePath, dir);
  console.log(`[tool:shared_edit] base=${dir} rel=${rel} oldLen=${oldString.length} newLen=${newString.length} replaceAll=${replaceAll}`);
  return editFile(rel, oldString, newString, replaceAll, dir, false, [dir]);
}

export interface SharedSearchContext {
  mastermindConfig: MastermindConfig;
  resolvePath: (p: string) => string;
  agentId: string;
}

/**
 * Semantic / hybrid search over shared memory, backed by the `shared-memory` LanceDB index
 * (the same machinery as codebase_search, scoped to this one index). Hit paths are rebased to
 * the shared root so they feed straight into `shared_read`.
 */
export async function sharedSearch(
  query: string,
  sharedDir: string | undefined,
  ctx: SharedSearchContext | undefined,
  opts: { limit?: number; type?: 'vector' | 'hybrid' } = {},
): Promise<string> {
  const dir = ensureSharedDir(sharedDir);
  if (!ctx) {
    // Soft-fail instead of throwing: an agent that sees shared_search (fleet-wide gate) but
    // has no shared-memory index configured gets a usable hint, not a wasted error turn.
    return (
      'shared_search is unavailable — the shared-memory semantic index is not configured ' +
      `(codebaseSearch.indices["${SHARED_MEMORY_INDEX_KEY}"]). ` +
      'Use shared_list + shared_read to browse shared memory instead.'
    );
  }
  const q = String(query ?? '').trim();
  if (!q) throw new Error('shared_search: query is required');

  const type = opts.type === 'vector' ? 'vector' : 'hybrid';
  console.debug(`[tool:shared_search] query="${q.slice(0, 60)}" type=${type}`);
  const { hits } = await runCodebaseSearchQuery({
    config: ctx.mastermindConfig,
    resolvePath: ctx.resolvePath,
    agentId: ctx.agentId,
    query: q,
    limit: opts.limit,
    type,
    index: SHARED_MEMORY_INDEX_KEY,
  });

  if (hits.length === 0) {
    return `shared_search: aucun résultat (query=${JSON.stringify(q)})`;
  }

  const toRel = (abs: string): string => {
    const r = path.relative(dir, path.resolve(abs));
    return r && !r.startsWith('..') ? r : abs;
  };

  const lines: string[] = [`shared_search: ${hits.length} résultat(s) — lis avec shared_read(path)\n`];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const sym = h.name ? ` [${h.type ?? 'symbol'}: ${h.name}]` : '';
    lines.push(`${i + 1}. ${toRel(h.filePath)}:${h.startLine}-${h.endLine}${sym}\n${h.contentPreview}\n`);
  }
  return lines.join('\n');
}
