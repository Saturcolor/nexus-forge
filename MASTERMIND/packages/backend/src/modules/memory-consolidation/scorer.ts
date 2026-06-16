import type pg from 'pg';
import type { MemoryConsolidationConfig } from '@mastermind/shared';

interface MemoryRow {
  id: string;
  access_count: number;
  last_accessed_at: Date | null;
  created_at: Date;
}

/**
 * Recalcule le score de pertinence de toutes les mémoires actives d'un agent.
 * Score = w_recency * recency + w_frequency * frequency + w_age * age
 * Retourne le nombre de mémoires scorées.
 */
export async function scoreMemories(
  pool: pg.Pool,
  agentId: string | null,
  cfg?: MemoryConsolidationConfig,
): Promise<number> {
  const wRecency = cfg?.scoring?.recencyWeight ?? 0.5;
  const wFrequency = cfg?.scoring?.frequencyWeight ?? 0.35;
  const wAge = cfg?.scoring?.ageWeight ?? 0.15;
  const halfLifeDays = cfg?.scoring?.recencyHalfLifeDays ?? 30;
  const maxAgeDays = cfg?.scoring?.maxAgeDays ?? 365;

  // Fetch all non-archived memories for this agent
  const agentFilter = agentId != null
    ? `agent_id = $1 AND archived = FALSE`
    : `agent_id IS NULL AND scope = 'shared' AND archived = FALSE`;
  const params = agentId != null ? [agentId] : [];

  const result = await pool.query<MemoryRow>(
    `SELECT id, access_count, last_accessed_at, created_at
     FROM agent_memories WHERE ${agentFilter}`,
    params,
  );

  const rows = result.rows;
  console.debug(`[memory-consolidation] scoring agent=${agentId ?? 'shared'} rows=${rows.length}`);
  if (rows.length === 0) {
    console.debug(`[memory-consolidation] scoring skip — no active memories for agent=${agentId ?? 'shared'}`);
    return 0;
  }

  const now = Date.now();
  const maxAccessCount = Math.max(1, ...rows.map(r => Number(r.access_count)));

  // Compute scores in TypeScript (lisible et testable)
  const updates: Array<{ id: string; score: number }> = [];

  for (const row of rows) {
    const accessCount = Number(row.access_count);
    const createdAt = row.created_at.getTime();
    const lastAccessed = row.last_accessed_at?.getTime() ?? null;

    // recencyScore: exp decay based on last access
    const daysSinceAccess = lastAccessed != null
      ? (now - lastAccessed) / 86_400_000
      : (now - createdAt) / 86_400_000;
    const recencyPenalty = lastAccessed != null ? 1 : 0.5; // pénalité si jamais accédé
    const recencyScore = Math.exp(-daysSinceAccess / halfLifeDays) * recencyPenalty;

    // frequencyScore: log-normalisé
    const frequencyScore = Math.min(1, Math.log(1 + accessCount) / Math.log(1 + maxAccessCount));

    // ageScore: linéaire, décroit avec l'âge
    const daysSinceCreation = (now - createdAt) / 86_400_000;
    const ageScore = Math.max(0, 1 - daysSinceCreation / maxAgeDays);

    const score = wRecency * recencyScore + wFrequency * frequencyScore + wAge * ageScore;

    updates.push({ id: row.id, score: Math.round(score * 1000) / 1000 });
  }

  // Batch UPDATE par chunks de 500
  const CHUNK_SIZE = 500;
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    const cases = chunk.map((u, idx) => `WHEN $${idx * 2 + 1}::uuid THEN $${idx * 2 + 2}::real`).join(' ');
    const ids = chunk.map((_, idx) => `$${idx * 2 + 1}::uuid`).join(', ');
    const params: unknown[] = [];
    for (const u of chunk) {
      params.push(u.id, u.score);
    }

    await pool.query(
      `UPDATE agent_memories SET score = CASE id ${cases} END WHERE id IN (${ids})`,
      params,
    );
  }

  console.log(`[memory-consolidation] scored ${updates.length} memories for agent=${agentId ?? 'shared'}`);
  return updates.length;
}
