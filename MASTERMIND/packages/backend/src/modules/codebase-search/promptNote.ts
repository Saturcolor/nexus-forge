import type { AgentConfig, MastermindConfig } from '@mastermind/shared';
import { resolveCodebaseSearchDbPaths } from './paths.js';

export function buildCodebaseSearchToolNote(
  mastermindConfig: MastermindConfig,
  resolvePath: (p: string) => string,
  agentConfig: AgentConfig,
  agentId: string,
): string | undefined {
  const resolvedList = resolveCodebaseSearchDbPaths(mastermindConfig, resolvePath, agentId);
  if (resolvedList.length === 0 || !agentConfig.tools?.codebaseSearchInPrompt) return undefined;

  const indexList = resolvedList.map(r => `\`${r.indexKey}\``).join(', ');
  const indexNote = resolvedList.length === 1
    ? `Active index: ${indexList}.`
    : `Active indexes (${resolvedList.length}): ${indexList}. Results are merged and ranked by relevance across all indexes.`;

  return [
    'You have access to **codebase_search** (semantic / hybrid search over pre-indexed code via LanceDB),',
    '**codebase_search_read** (read a file under the index source root, sandboxed) and',
    '**codebase_search_list** (list a directory under the same root).',
    indexNote,
    'Standard workflow: `codebase_search(query)` → pick a hit →',
    '`codebase_search_read(path: <hit.filePath>, lines: "<start>-<end>")` to widen context →',
    'optionally `codebase_search_list(path: <dirname>)` to discover siblings.',
    'You normally do NOT pass `index` back — read/list infer it from the absolute hit path.',
    'Prefer this triad over bash/grep or `read_file` when exploring code covered by the index —',
    'it is sandboxed to the index source root and does not require `systemAccess`.',
    'Shared memory is NOT covered by these — use `shared_search` for that.',
  ].join(' ');
}
