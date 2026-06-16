/**
 * Outil session_search — recherche plein-texte dans l'historique des conversations.
 *
 * Complète memory_search (mémoire vectorielle) et codebase_search (code) : ici on cherche
 * littéralement « ce qu'on s'est dit » par mot-clé/phrase. Scopé par défaut aux sessions de
 * l'agent courant ; `all_agents: true` élargit à toute la base (mono-utilisateur).
 */
import type { SessionModule } from '../../session/index.js';

export interface SessionSearchToolContext {
  sessionModule: SessionModule;
  agentId: string;
}

export async function executeSessionSearchTool(
  ctx: SessionSearchToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = String(args['query'] ?? '').trim();
  if (!query) {
    return 'session_search: le paramètre "query" est requis.';
  }

  const limit = typeof args['limit'] === 'number'
    ? Math.min(50, Math.max(1, Math.round(args['limit'])))
    : 10;
  const allAgents = args['all_agents'] === true;

  let hits;
  try {
    hits = await ctx.sessionModule.searchMessages(query, {
      agentId: allAgents ? undefined : ctx.agentId,
      limit,
    });
  } catch (err) {
    return `session_search: erreur de recherche — ${err instanceof Error ? err.message : String(err)}`;
  }

  if (hits.length === 0) {
    return `session_search: aucun message pour "${query}"${allAgents ? '' : ' (dans tes sessions — réessaie avec all_agents:true pour élargir)'}.`;
  }

  const lines: string[] = [`session_search: ${hits.length} message(s) pour "${query}"\n`];
  for (const h of hits) {
    const date = (h.createdAt ?? '').slice(0, 10);
    lines.push(`[${date} · ${h.role} · session ${h.sessionId}]\n${h.snippet}\n`);
  }
  return lines.join('\n');
}
