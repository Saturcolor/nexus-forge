import type pg from 'pg';

/**
 * Enregistre un accès aux mémoires récupérées par auto-injection ou recherche.
 * Fire-and-forget — ne doit jamais bloquer le flux agent.
 */
export async function recordAccess(pool: pg.Pool, memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  console.debug(`[memory-consolidation] recordAccess ids=${memoryIds.length}`);
  await pool.query(
    `UPDATE agent_memories
     SET access_count = access_count + 1, last_accessed_at = NOW()
     WHERE id = ANY($1::uuid[])`,
    [memoryIds],
  );
}
