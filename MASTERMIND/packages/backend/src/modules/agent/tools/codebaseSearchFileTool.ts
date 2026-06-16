import type { MastermindConfig } from '@mastermind/shared';
import {
  runCodebaseSearchReadFile,
  runCodebaseSearchListDir,
} from '../../codebase-search/service.js';

export interface CodebaseSearchFileToolContext {
  mastermindConfig: MastermindConfig;
  resolvePath: (p: string) => string;
}

export async function executeCodebaseSearchReadFile(
  ctx: CodebaseSearchFileToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const index = String(args['index'] ?? '').trim() || undefined;
  const path = String(args['path'] ?? '').trim();
  const lines = typeof args['lines'] === 'string' ? args['lines'] : undefined;
  const offset = typeof args['offset'] === 'number' ? args['offset'] : undefined;
  const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;

  if (!path) throw new Error('codebase_search_read: path is required');

  console.debug(`[tool:codebase_search_read] index=${index ?? 'auto'} path=${path} lines=${lines ?? 'all'}`);
  const { content } = await runCodebaseSearchReadFile({
    config: ctx.mastermindConfig,
    resolvePath: ctx.resolvePath,
    index,
    path,
    lines,
    offset,
    limit,
  });
  return content;
}

export async function executeCodebaseSearchListDir(
  ctx: CodebaseSearchFileToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const index = String(args['index'] ?? '').trim() || undefined;
  const path = typeof args['path'] === 'string' && args['path'].trim() ? args['path'] : undefined;

  console.debug(`[tool:codebase_search_list] index=${index ?? 'auto'} path=${path ?? '.'}`);
  const { entries, path: resolvedPath, indexKey } = await runCodebaseSearchListDir({
    config: ctx.mastermindConfig,
    resolvePath: ctx.resolvePath,
    index,
    path,
  });
  // Use the resolved indexKey (not the raw arg) — `index` is undefined when inferred from an absolute path.
  return `${indexKey}:${resolvedPath}\n${entries}`;
}
