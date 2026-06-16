import type pg from 'pg';
import type { MemoryConsolidationConfig } from '@mastermind/shared';
import type { ProviderModule } from '../provider/index.js';
import type { MemoryStore } from '../memory-store/store.js';
import type { MemoryCluster } from './clusterer.js';
import { buildMergePrompt } from './prompts.js';
import { summarizeWithLlm } from '../../utils/summarizeWithLlm.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface MergeResult {
  merged: number;
  errors: number;
}

/**
 * Fusionne les clusters de mémoires via LLM.
 * Pour chaque cluster :
 *  1. Appel LLM avec le prompt de fusion
 *  2. Création d'une nouvelle mémoire consolidée
 *  3. Archivage des originaux avec lien merged_into
 */
export async function mergeClusters(
  pool: pg.Pool,
  clusters: MemoryCluster[],
  providerMod: ProviderModule,
  model: string,
  cfg?: MemoryConsolidationConfig,
  onProgress?: (current: number, total: number) => void,
  store?: MemoryStore,
): Promise<MergeResult> {
  const delayMs = cfg?.delayBetweenMergesMs ?? 1000;
  let merged = 0;
  let errors = 0;

  console.log(`[memory-consolidation] merging ${clusters.length} clusters (model=${model}, delay=${delayMs}ms)`);

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!;
    console.debug(`[memory-consolidation] merge ${i + 1}/${clusters.length} — ${cluster.memberIds.length} members`);
    onProgress?.(i + 1, clusters.length);
    try {
      await mergeOneCluster(pool, cluster, providerMod, model, store);
      merged++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      console.error(`[memory-consolidation] merge failed for cluster [${cluster.memberIds.slice(0, 3).join(',')}...]: ${errMsg}`);
      if (errStack) console.debug(`[memory-consolidation] stack:`, errStack);
      errors++;
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(`[memory-consolidation] merge done: ${merged} merged, ${errors} errors`);

  return { merged, errors };
}

async function mergeOneCluster(
  pool: pg.Pool,
  cluster: MemoryCluster,
  providerMod: ProviderModule,
  model: string,
  store?: MemoryStore,
): Promise<void> {
  const prompt = buildMergePrompt(cluster);

  // LLM call — reasoning désactivé (simple merge de texte, pas besoin de chain-of-thought)
  // Budget tokens augmenté car les modèles reasoning consomment le budget pour le thinking
  const res = await summarizeWithLlm(providerMod, {
    model,
    prompt,
    maxTokens: 16384,
    reasoning: false,
  });

  if (!res.ok) {
    throw new Error(`LLM merge failed (${res.reason})`, { cause: res.error });
  }

  const trimmed = res.summary.slice(0, 1200); // safety cap

  // Metadata
  const firstMember = cluster.members[0]!;
  const scope = firstMember.scope;

  const origRow = await pool.query<{ agent_id: string | null }>(
    `SELECT agent_id FROM agent_memories WHERE id = $1`,
    [firstMember.id],
  );
  const originalAgentId = origRow.rows[0]?.agent_id ?? null;

  // Domain: most common non-null
  const domains = cluster.members.map(m => m.domain).filter(Boolean) as string[];
  const domainCounts = new Map<string, number>();
  for (const d of domains) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
  const bestDomain = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const allTags = [...new Set(cluster.members.flatMap(m => m.tags))];
  const maxAccessCount = Math.max(...cluster.members.map(m => m.accessCount));
  const latestAccess = cluster.members
    .map(m => m.lastAccessedAt)
    .filter(Boolean)
    .sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;

  // Insert via store.add() pour generer l'embedding, sinon fallback SQL sans embedding
  let newId: string;
  if (store) {
    newId = await store.add({
      text: trimmed,
      agentId: originalAgentId,
      scope: scope as 'agent' | 'shared',
      tags: allTags,
      domain: bestDomain,
      source: 'consolidation:merge',
    });
    // Set access stats + merge_source_ids (store.add ne gere pas ces champs)
    await pool.query(
      `UPDATE agent_memories SET access_count = $1, last_accessed_at = $2, merge_source_ids = $3 WHERE id = $4`,
      [maxAccessCount, latestAccess, cluster.memberIds, newId],
    );
  } else {
    const insertRes = await pool.query<{ id: string }>(
      `INSERT INTO agent_memories (text, agent_id, scope, tags, domain, source, access_count, last_accessed_at, merge_source_ids)
       VALUES ($1, $2, $3, $4, $5, 'consolidation:merge', $6, $7, $8)
       RETURNING id`,
      [trimmed, originalAgentId, scope, allTags, bestDomain, maxAccessCount, latestAccess, cluster.memberIds],
    );
    newId = insertRes.rows[0]!.id;
    console.warn(`[memory-consolidation] merged without embedding (store unavailable) id=${newId}`);
  }

  // Archive originals
  await pool.query(
    `UPDATE agent_memories SET archived = TRUE, merged_into = $1, updated_at = NOW()
     WHERE id = ANY($2::uuid[])`,
    [newId, cluster.memberIds],
  );

  console.debug(
    `[memory-consolidation] merged ${cluster.memberIds.length} memories → ${newId} (${trimmed.length} chars, with embedding=${!!store})`,
  );
}
