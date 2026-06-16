import type pg from 'pg';
import type { MemoryConsolidationConfig } from '@mastermind/shared';

export interface MemoryCluster {
  /** UUIDs des mémoires dans le cluster */
  memberIds: string[];
  /** Textes des mémoires (ordre : created_at ASC) */
  members: Array<{ id: string; text: string; createdAt: Date; accessCount: number; lastAccessedAt: Date | null; scope: string; domain: string | null; tags: string[] }>;
}

// ── Union-Find ────────────────────────────────────────────────────────────

class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();
  private size: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
      this.size.set(x, 1);
    }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    // Read both subtree sizes BEFORE mutating parent: after re-parenting, find()
    // resolves the attached root to the new root, so getSize() would double-count
    // the winner. ra/rb are already roots here, so read size directly.
    const combinedSize = this.size.get(ra)! + this.size.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
      this.size.set(rb, combinedSize);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
      this.size.set(ra, combinedSize);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
      this.size.set(ra, combinedSize);
    }
    return true;
  }

  getSize(x: string): number {
    return this.size.get(this.find(x)) ?? 1;
  }

  getClusters(): Map<string, string[]> {
    const clusters = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(key);
    }
    return clusters;
  }
}

// ── Clustering principal ──────────────────────────────────────────────────

const MAX_TEXT_COMBINED = 8000; // Limite de l'embedder

/**
 * Trouve les clusters de mémoires similaires pour un agent donné.
 * Utilise pgvector cross-join + Union-Find.
 */
export async function findClusters(
  pool: pg.Pool,
  agentId: string | null,
  cfg?: MemoryConsolidationConfig,
): Promise<MemoryCluster[]> {
  const mergeThreshold = cfg?.clustering?.mergeThreshold ?? 0.75;
  const maxPairs = cfg?.clustering?.maxPairsPerRun ?? 200;
  const maxClusterSize = cfg?.clustering?.maxClusterSize ?? 5;

  const agentFilter = agentId != null
    ? `a.agent_id = $1 AND b.agent_id = $1`
    : `a.agent_id IS NULL AND b.agent_id IS NULL AND a.scope = 'shared' AND b.scope = 'shared'`;
  const params = agentId != null ? [agentId, mergeThreshold, maxPairs] : [mergeThreshold, maxPairs];
  const thresholdIdx = agentId != null ? 2 : 1;
  const limitIdx = agentId != null ? 3 : 2;

  // Find similar pairs above threshold
  const pairsResult = await pool.query<{ id_a: string; id_b: string; similarity: number }>(
    `SELECT a.id AS id_a, b.id AS id_b,
            1 - (a.embedding <=> b.embedding) AS similarity
     FROM agent_memories a
     JOIN agent_memories b ON a.id < b.id
       AND ${agentFilter}
       AND a.archived = FALSE AND b.archived = FALSE
       -- Anti-dérive (#11) : un merge ne re-cluster JAMAIS ses propres sorties, sinon une mémoire
       -- est re-paraphrasée par le LLM à chaque cycle (lossy cumulatif). Les merges ne consolident
       -- que des mémoires brutes. IS DISTINCT FROM garde les source NULL (mémoires legacy).
       AND a.source IS DISTINCT FROM 'consolidation:merge'
       AND b.source IS DISTINCT FROM 'consolidation:merge'
     WHERE 1 - (a.embedding <=> b.embedding) > $${thresholdIdx}
     ORDER BY similarity DESC
     LIMIT $${limitIdx}`,
    params,
  );

  if (pairsResult.rows.length === 0) {
    console.debug(`[memory-consolidation] clustering: 0 pairs above threshold=${mergeThreshold} for agent=${agentId ?? 'shared'}`);
    return [];
  }

  console.debug(`[memory-consolidation] clustering: ${pairsResult.rows.length} pairs above threshold=${mergeThreshold} for agent=${agentId ?? 'shared'}`);

  // Build clusters via Union-Find
  const uf = new UnionFind();
  for (const pair of pairsResult.rows) {
    // Check cluster size cap before merging
    if (uf.getSize(pair.id_a) + uf.getSize(pair.id_b) > maxClusterSize) continue;
    uf.union(pair.id_a, pair.id_b);
  }

  const rawClusters = uf.getClusters();
  // Only keep clusters with 2+ members
  const multiClusters = [...rawClusters.values()].filter(c => c.length >= 2);

  if (multiClusters.length === 0) {
    console.debug(`[memory-consolidation] clustering: no multi-member clusters after union-find for agent=${agentId ?? 'shared'}`);
    return [];
  }

  // Fetch full data for all clustered memory IDs
  const allIds = multiClusters.flat();
  const memResult = await pool.query<{
    id: string; text: string; created_at: Date; access_count: number;
    last_accessed_at: Date | null; scope: string; domain: string | null; tags: string[];
  }>(
    `SELECT id, text, created_at, access_count, last_accessed_at, scope, domain, tags
     FROM agent_memories WHERE id = ANY($1::uuid[])
     ORDER BY created_at ASC`,
    [allIds],
  );

  const memMap = new Map(memResult.rows.map(r => [r.id, r]));

  // Build final clusters, filtering by combined text length
  const clusters: MemoryCluster[] = [];
  for (const ids of multiClusters) {
    const members = ids
      .map(id => memMap.get(id))
      .filter((m): m is NonNullable<typeof m> => m != null)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    // L10: le filtre c.length >= 2 (plus haut) porte sur les IDs BRUTS d'Union-Find.
    // Entre la requête des paires et celle-ci, des mémoires peuvent avoir été
    // supprimées (memory-store DELETE) ou archivées par un run concurrent → memMap
    // ne les résout plus. Re-vérifier sur les membres RÉSOLUS : 0 survivant
    // pousserait {memberIds:[],members:[]} → TypeError avalé dans le merger ;
    // 1 survivant déclencherait un merge de singleton inutile (appel LLM gaspillé).
    if (members.length < 2) continue;

    const combinedLength = members.reduce((sum, m) => sum + m.text.length, 0);
    if (combinedLength > MAX_TEXT_COMBINED) continue;

    // Ensure same scope
    const scopes = new Set(members.map(m => m.scope));
    if (scopes.size > 1) continue;

    clusters.push({
      memberIds: members.map(m => m.id),
      members: members.map(m => ({
        id: m.id,
        text: m.text,
        createdAt: m.created_at,
        accessCount: Number(m.access_count),
        lastAccessedAt: m.last_accessed_at,
        scope: m.scope,
        domain: m.domain,
        tags: Array.isArray(m.tags) ? m.tags : [],
      })),
    });
  }

  const filtered = multiClusters.length - clusters.length;
  console.log(`[memory-consolidation] found ${clusters.length} clusters for agent=${agentId ?? 'shared'} (${filtered} filtered out by size/scope)`);
  return clusters;
}
