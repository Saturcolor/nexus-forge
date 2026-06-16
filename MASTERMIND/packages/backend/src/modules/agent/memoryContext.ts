/**
 * Injection contextuelle automatique de mémoire dans les messages LLM.
 *
 * Avant chaque appel au LLM, recherche sémantiquement dans le MemoryStore
 * les chunks pertinents au message utilisateur et les injecte comme bloc de
 * préfixe — sans toucher au system prompt (KV-cache préservé).
 *
 * Le bloc injecté a la forme :
 *   [CONTEXTE MÉMOIRE]
 *   • {domain} ({score}%) : {texte}
 *   ...
 *   [/CONTEXTE]
 */
import type pg from 'pg';
import type { MemoryStoreModule, MemoryHit } from '../memory-store/index.js';
import type { MemoryStoreAutoInjectionConfig } from '@mastermind/shared';
import { recordAccess } from '../memory-consolidation/tracker.js';

const DEFAULT_TOP_K = 3;
const DEFAULT_THRESHOLD = 0.45;
const DEFAULT_MAX_CHARS_PER_CHUNK = 600;

/**
 * Cap on the user message length passed to the embedder for the memory search.
 * The embedder model has a 4096-token context (Mercury broker default). With a
 * worst-case ratio of ~5 chars/token in multilingual mode, 8000 chars stays
 * well under the limit. Messages with large inlined files (CSV previews,
 * pasted logs) would otherwise overflow and the search returns empty —
 * defeating auto-injection on exactly the turns where memory matters most.
 */
const EMBED_QUERY_MAX_CHARS = 8000;

export interface MemoryContextResult {
  /** Bloc préfixe à antéposer au message utilisateur, ou "" si aucun résultat */
  injectedBlock: string;
  /** Nombre de chunks injectés */
  hitCount: number;
  /** UUIDs des mémoires récupérées (pour le tracking d'accès) */
  hitIds: string[];
}

/** Tronque un texte à maxChars en respectant les mots */
function truncateChunk(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.7 ? cut.slice(0, lastSpace) : cut) + '…';
}

/** Formate un hit en ligne de bullet */
function formatHit(hit: MemoryHit, maxChars: number): string {
  const score = Math.round(hit.similarity * 100);
  const domain = hit.entry.domain ?? 'memory';
  const text = truncateChunk(hit.entry.text, maxChars);
  return `• [${domain}] (${score}%) : ${text}`;
}

/**
 * Construit le bloc de contexte mémoire pour un message utilisateur.
 * Retourne `{ injectedBlock: "", hitCount: 0 }` si aucun résultat pertinent
 * ou si le memoryStore est indisponible.
 */
export async function buildMemoryContext(
  userMessage: string,
  agentId: string,
  memoryStore: MemoryStoreModule,
  cfg: MemoryStoreAutoInjectionConfig = {},
  /** Pool PG pour le tracking d'accès mémoire (optionnel) */
  pool?: pg.Pool,
  /**
   * Override par-agent (AgentConfig.excludeSharedMemory). Quand true, force l'exclusion
   * du scope `shared` de cet agent quelle que soit la config globale `includeShared`.
   * L'agent ne reçoit alors QUE sa mémoire privée (scope `agent`).
   */
  excludeShared = false,
): Promise<MemoryContextResult> {
  if (!memoryStore.isEnabled) {
    return { injectedBlock: '', hitCount: 0, hitIds: [] };
  }

  const topK = cfg.topK ?? DEFAULT_TOP_K;
  const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;
  const maxCharsPerChunk = cfg.maxCharsPerChunk ?? DEFAULT_MAX_CHARS_PER_CHUNK;
  // Le scope `shared` est inclus par défaut (config globale), sauf si cet agent est
  // explicitement exclu via excludeSharedMemory — l'override par-agent prime.
  const includeShared = !excludeShared && cfg.includeShared !== false;

  // Truncate the query so it fits the embedder context (see EMBED_QUERY_MAX_CHARS).
  // We keep the head — the user's intent is almost always in the first paragraph,
  // not buried in a 20k-char attached log or CSV dump.
  const queryText = userMessage.length > EMBED_QUERY_MAX_CHARS
    ? userMessage.slice(0, EMBED_QUERY_MAX_CHARS)
    : userMessage;
  if (queryText.length < userMessage.length) {
    console.debug(
      `[memory-store] auto-inject query truncated for embedder agent=${agentId} from=${userMessage.length} to=${queryText.length}`,
    );
  }

  console.debug(
    `[memory-store] auto-inject search agent=${agentId} topK=${topK} threshold=${threshold} includeShared=${includeShared} userMsgLen=${userMessage.length} queryLen=${queryText.length}`,
  );

  let hits: MemoryHit[];
  try {
    hits = await memoryStore.search(queryText, {
      agentId,
      scopes: includeShared ? ['agent', 'shared'] : ['agent'],
      topK,
      threshold,
    });
  } catch (err) {
    console.warn('[memory-store] auto-inject search failed (non-fatal):', err);
    return { injectedBlock: '', hitCount: 0, hitIds: [] };
  }

  if (hits.length === 0) {
    console.debug(`[memory-store] auto-inject no hits (threshold=${threshold})`);
    return { injectedBlock: '', hitCount: 0, hitIds: [] };
  }

  const hitIds = hits.map(h => h.entry.id);

  // Track memory access (fire-and-forget, non-bloquant)
  if (pool) {
    recordAccess(pool, hitIds).catch(err =>
      console.warn('[memory-store] recordAccess failed (non-fatal):', err),
    );
  }

  console.log(`[memory-store] auto-inject ${hits.length} chunk(s) → prompt (agent=${agentId})`);

  const lines = hits.map(h => formatHit(h, maxCharsPerChunk));
  const block = [
    '[MEMORY CONTEXT]',
    ...lines,
    '[/MEMORY CONTEXT]',
  ].join('\n');

  return { injectedBlock: block, hitCount: hits.length, hitIds };
}
