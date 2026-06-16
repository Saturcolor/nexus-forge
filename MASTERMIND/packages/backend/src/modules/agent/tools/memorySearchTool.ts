/**
 * Outil memory_search — recherche sémantique dans le MemoryStore.
 * Wrapper UX-friendly : l'agent n'a pas besoin de connaître les noms d'index.
 */
import type { MemoryStoreModule } from '../../memory-store/index.js';

export interface MemorySearchToolContext {
  memoryStore: MemoryStoreModule;
  agentId: string;
  /**
   * AgentConfig.excludeSharedMemory. Quand true, la recherche est clampée au scope
   * `agent` quel que soit le `scope` demandé par l'agent — il ne peut pas relire le
   * pot commun `shared` (qu'il a pourtant le droit d'alimenter en écriture).
   */
  excludeShared?: boolean;
}

export async function executeMemorySearchTool(
  ctx: MemorySearchToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = String(args['query'] ?? '').trim();
  if (!query) {
    return 'memory_search: le paramètre "query" est requis.';
  }

  const topK = typeof args['top_k'] === 'number'
    ? Math.min(20, Math.max(1, Math.round(args['top_k'])))
    : 5;

  const threshold = typeof args['threshold'] === 'number'
    ? Math.max(0, Math.min(1, args['threshold']))
    : 0.3;

  const scopeArg = String(args['scope'] ?? 'all');
  // Agent exclu du shared (excludeSharedMemory) → clamp dur à ['agent'], même si l'agent
  // demande explicitement scope='shared'/'all'. L'exclusion en lecture prime sur l'argument.
  const scopes: Array<'agent' | 'shared'> =
    ctx.excludeShared ? ['agent']
    : scopeArg === 'agent' ? ['agent']
    : scopeArg === 'shared' ? ['shared']
    : ['agent', 'shared'];

  const domain = typeof args['domain'] === 'string' ? args['domain'] : undefined;

  console.debug(
    `[memory-store] memory_search tool queryLen=${query.length} topK=${topK} threshold=${threshold} scope=${scopeArg}${ctx.excludeShared ? `→[agent] (excludeSharedMemory)` : ''} domain=${domain ?? '∅'} agent=${ctx.agentId}`,
  );

  let hits;
  try {
    hits = await ctx.memoryStore.search(query, {
      agentId: ctx.agentId,
      scopes,
      domain,
      topK,
      threshold,
    });
  } catch (err) {
    return `memory_search: erreur de recherche — ${err instanceof Error ? err.message : String(err)}`;
  }

  if (hits.length === 0) {
    console.debug(`[memory-store] memory_search 0 hits`);
    return `memory_search: aucun résultat pour "${query}" (seuil: ${threshold}, scope: ${scopeArg})`;
  }

  console.log(`[memory-store] memory_search ${hits.length} hit(s)`);
  const lines: string[] = [
    `memory_search: ${hits.length} résultat(s) pour "${query}"\n`,
  ];

  for (const { entry, similarity } of hits) {
    const score = Math.round(similarity * 100);
    const meta = [
      entry.domain ?? 'mémoire',
      entry.scope === 'shared' ? 'partagé' : `agent:${entry.agentId ?? '?'}`,
      entry.createdAt.split('T')[0],
    ].join(' | ');
    lines.push(`[${score}% — ${meta}]\n${entry.text}\n`);
  }

  return lines.join('\n');
}
