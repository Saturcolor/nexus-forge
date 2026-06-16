import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_READ_BYTES = 100_000;

/** Normalize roots once; dedupe. */
function normalizeAllowedRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    if (!r || !r.trim()) continue;
    const n = path.normalize(path.resolve(r));
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function isUnderRoot(absPath: string, root: string): boolean {
  const norm = path.normalize(path.resolve(absPath));
  const r = path.normalize(path.resolve(root));
  if (norm === r) return true;
  const sep = path.sep;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return norm.startsWith(prefix);
}

function isUnderAnyAllowedRoot(absPath: string, allowedRoots: string[]): boolean {
  return allowedRoots.some(root => isUnderRoot(absPath, root));
}

function isInsideWorkspace(resolved: string, cwd: string): boolean {
  const cwdResolved = path.normalize(path.resolve(cwd));
  const norm = path.normalize(path.resolve(resolved));
  if (norm === cwdResolved) return true;
  const sep = path.sep;
  const prefix = cwdResolved.endsWith(sep) ? cwdResolved : cwdResolved + sep;
  return norm.startsWith(prefix);
}

/**
 * Resolve a user-supplied path to an absolute path, enforcing the same sandbox as the file
 * tools: relative paths resolve under `cwd` (workspace); absolute paths are allowed only with
 * `allowAbsolute` (systemAccess), `~` (home), or when they fall under an Environment root in
 * `allowedRoots`. Throws on traversal/escape. Exported so non-text tools (e.g. `inspect_image`,
 * which reads binary) share byte-identical path safety with read_file/write_file/edit_file.
 */
export function safePath(
  filePath: string,
  cwd: string,
  allowAbsolute = false,
  allowedRoots: string[] = [],
): string {
  // Expand ~ to home directory
  const expanded = filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath.startsWith('~')
      ? os.homedir()
      : filePath;

  const roots = normalizeAllowedRoots(allowedRoots);
  const wasHome = filePath.startsWith('~');
  console.debug(`[tool:files] safePath input=${filePath} cwd=${cwd} absolute=${path.isAbsolute(expanded)} allowAbsolute=${allowAbsolute} roots=${roots.length}`);

  if (path.isAbsolute(expanded)) {
    const normalized = path.normalize(expanded);
    if (allowAbsolute || wasHome) {
      console.debug(`[tool:files] safePath absolute allowed path=${normalized} reason=${allowAbsolute ? 'systemAccess' : 'home'}`);
      return normalized;
    }
    if (isUnderAnyAllowedRoot(normalized, roots)) {
      console.debug(`[tool:files] safePath absolute allowed path=${normalized} reason=environment-root`);
      return normalized;
    }
    console.warn(`[tool:files] safePath denied absolute input=${filePath} normalized=${normalized}`);
    throw new Error(
      `Absolute path "${filePath}" is not under allowed directories (see # Environment in system prompt). ` +
      'Enable tools.systemAccess on the agent for full filesystem access.',
    );
  }

  // Relative paths: workspace, or any configured Environment root
  const resolved = path.resolve(cwd, expanded);
  if (isInsideWorkspace(resolved, cwd)) {
    console.debug(`[tool:files] safePath relative allowed path=${resolved} reason=workspace`);
    return resolved;
  }
  if (isUnderAnyAllowedRoot(resolved, roots)) {
    console.debug(`[tool:files] safePath relative allowed path=${resolved} reason=environment-root`);
    return resolved;
  }
  console.warn(`[tool:files] safePath denied relative input=${filePath} resolved=${resolved}`);
  throw new Error(`Path "${filePath}" escapes the workspace and is not under allowed Environment directories`);
}

export async function readFile(
  filePath: string,
  cwd: string,
  allowAbsolute = false,
  allowedRoots: string[] = [],
  lines?: string,   // e.g. "512-524" or "42" — takes priority over offset/limit
  offset?: number,  // 1-based start line (fallback if lines not set)
  limit?: number,   // number of lines to read from offset
): Promise<string> {
  const full = safePath(filePath, cwd, allowAbsolute, allowedRoots);
  const stat = await fs.stat(full);
  console.debug(`[tool:read_file] path=${full} size=${stat.size} lines=${lines ?? 'all'}`);

  let content: string;
  if (stat.size > MAX_READ_BYTES) {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const fh = await fs.open(full, 'r');
    try {
      await fh.read(buf, 0, MAX_READ_BYTES, 0);
    } finally {
      await fh.close();
    }
    content = buf.toString('utf-8') + `\n\n[truncated — file is ${stat.size} bytes]`;
  } else {
    content = await fs.readFile(full, 'utf-8');
  }

  // Resolve line range: `lines` takes priority over offset/limit
  let start: number | undefined;
  let end: number | undefined;

  if (lines !== undefined) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(lines.trim());
    if (match) {
      start = parseInt(match[1], 10);
      end = match[2] !== undefined ? parseInt(match[2], 10) : start;
    }
  } else if (offset !== undefined) {
    start = offset;
    end = limit !== undefined ? offset + limit - 1 : undefined;
  }

  if (start === undefined) return content;

  const allLines = content.split('\n');
  const total = allLines.length;
  const s = Math.max(1, start);
  const e = end !== undefined ? Math.min(end, total) : total;

  if (s > total) {
    console.warn(`[tool:read_file] offset exceeds file length path=${full} offset=${s} total=${total}`);
    return `[offset ${s} exceeds file length ${total} — ${full}]`;
  }

  const slice = allLines.slice(s - 1, e).join('\n');
  console.debug(`[tool:read_file] returning slice path=${full} lines=${s}-${e}/${total} chars=${slice.length}`);
  return `[Lines ${s}–${e} of ${total} — ${full}]\n\n${slice}`;
}

export async function writeFile(
  filePath: string,
  content: string,
  cwd: string,
  allowAbsolute = false,
  allowedRoots: string[] = [],
): Promise<string> {
  const full = safePath(filePath, cwd, allowAbsolute, allowedRoots);
  console.debug(`[tool:write_file] path=${full} len=${content.length}`);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
  return `Written ${content.length} chars to ${full}`;
}

export async function listDir(
  dirPath: string,
  cwd: string,
  allowAbsolute = false,
  allowedRoots: string[] = [],
): Promise<string> {
  const full = safePath(dirPath || '.', cwd, allowAbsolute, allowedRoots);
  const entries = await fs.readdir(full, { withFileTypes: true });
  console.debug(`[tool:list_dir] path=${full} entries=${entries.length}`);
  // Follow symlinks for d/f classification — a symlinked directory (shared memory is rebuilt
  // with symlinks) must show as 'd', not 'f', or the model treats it as an unreadable file.
  const lines = await Promise.all(entries.map(async e => {
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      const st = await fs.stat(path.join(full, e.name)).catch(() => null);
      isDir = st?.isDirectory() ?? false;
    }
    return `${isDir ? 'd' : 'f'}  ${e.name}`;
  }));
  return lines.join('\n') || '(empty directory)';
}

export async function editFile(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
  cwd: string,
  allowAbsolute = false,
  allowedRoots: string[] = [],
): Promise<string> {
  // Empty old_string would make the indexOf loop below never advance (indexOf('')
  // returns the search start, never -1) → infinite loop hanging the event loop.
  // Reject up front. Covers shared_edit too, which delegates here.
  if (oldString === '') {
    console.warn(`[tool:edit_file] empty old_string rejected path=${filePath}`);
    throw new Error(
      'old_string must not be empty — provide the exact text to replace (use write_file to create or fully rewrite a file).',
    );
  }

  const full = safePath(filePath, cwd, allowAbsolute, allowedRoots);
  const content = await fs.readFile(full, 'utf-8');
  console.debug(`[tool:edit_file] path=${full} replaceAll=${replaceAll}`);

  // Count occurrences
  let count = 0;
  let idx = content.indexOf(oldString);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(oldString, idx + oldString.length);
  }

  if (count === 0) {
    console.warn(`[tool:edit_file] old_string not found path=${full} oldLen=${oldString.length}`);
    throw new Error(
      `old_string not found in ${full} — check whitespace, indentation, and line endings.`,
    );
  }
  if (count > 1 && !replaceAll) {
    console.warn(`[tool:edit_file] ambiguous old_string path=${full} occurrences=${count}`);
    throw new Error(
      `Found ${count} occurrences of old_string in ${full} — use replace_all: true or make old_string more specific by including more surrounding context.`,
    );
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.slice(0, content.indexOf(oldString)) +
      newString +
      content.slice(content.indexOf(oldString) + oldString.length);

  await fs.writeFile(full, updated, 'utf-8');
  console.log(`[tool:edit_file] wrote path=${full} occurrences=${count} beforeLen=${content.length} afterLen=${updated.length}`);
  return `Replaced ${count} occurrence(s) in ${full}`;
}
