import type { MastermindConfig } from '@mastermind/shared';
import { runCodebaseSearchQuery } from '../../codebase-search/service.js';
import { SHARED_MEMORY_INDEX_KEY } from '../../codebase-search/paths.js';

export interface CodebaseSearchToolContext {
  mastermindConfig: MastermindConfig;
  resolvePath: (p: string) => string;
  agentId: string;
}

export async function executeCodebaseSearchTool(
  ctx: CodebaseSearchToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = String(args['query'] ?? '').trim();
  if (!query) throw new Error('codebase_search: query is required');

  const index = typeof args['index'] === 'string' ? args['index'] : undefined;
  // Shared memory is reachable ONLY via shared_search — reject an explicit index= bypass.
  if (index === SHARED_MEMORY_INDEX_KEY) {
    throw new Error(`Index "${SHARED_MEMORY_INDEX_KEY}" is reserved — use shared_search to query shared memory.`);
  }
  const filePattern = typeof args['file_pattern'] === 'string' ? args['file_pattern'] : undefined;
  // Description advertises "Default mode: hybrid" — keep the executor in sync (was defaulting to vector).
  const type = args['type'] === 'vector' ? 'vector' : 'hybrid';
  const exactSymbol = Boolean(args['exact_symbol']);
  const fileNameWeight =
    typeof args['file_name_weight'] === 'number' ? args['file_name_weight'] : undefined;

  let extensions: string[] | undefined;
  if (Array.isArray(args['extensions'])) {
    extensions = args['extensions'].filter((x): x is string => typeof x === 'string');
  } else if (typeof args['extensions'] === 'string' && args['extensions'].trim()) {
    extensions = [args['extensions'].trim()];
  }

  console.debug(`[tool:codebase_search] query="${query.slice(0, 60)}" type=${type} index=${index ?? 'auto'} extensions=${extensions?.join(',') ?? '∅'}`);
  const { indexKey, hits, warnings } = await runCodebaseSearchQuery({
    config: ctx.mastermindConfig,
    resolvePath: ctx.resolvePath,
    agentId: ctx.agentId,
    query,
    limit: args['limit'],
    type,
    extensions,
    filePattern,
    index,
    fileNameWeight,
    exactSymbol,
  });

  console.debug(`[tool:codebase_search] results=${hits.length} index=${indexKey} warnings=${warnings.length}`);
  const warnBlock = warnings.length ? `⚠️  ${warnings.join(' · ')}\n` : '';
  if (hits.length === 0) {
    return `${warnBlock}codebase_search: aucun résultat (index=${indexKey}, query=${JSON.stringify(query)})`;
  }

  const lines: string[] = [`${warnBlock}codebase_search: ${hits.length} résultat(s) (index=${indexKey})\n`];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const sym = h.name ? ` [${h.type ?? 'symbol'}: ${h.name}]` : '';
    const tag = h.indexKey ? `[${h.indexKey}] ` : '';
    lines.push(
      `${i + 1}. ${tag}${h.filePath}:${h.startLine}-${h.endLine}${sym}\n${h.contentPreview}\n`,
    );
  }
  return lines.join('\n');
}
