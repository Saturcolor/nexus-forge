import type pg from 'pg';
import type { MemoryConsolidationConfig } from '@mastermind/shared';

/**
 * Archive les mémoires stale pour un agent donné.
 * Critères (tous vrais) :
 *  - archived = FALSE, merged_into IS NULL
 *  - score < scoreThreshold (défaut 0.1)
 *  - access_count = 0
 *  - created_at > minAgeDaysBeforeArchive jours (défaut 60)
 *
 * Retourne le nombre de mémoires archivées.
 */
export async function archiveStaleMemories(
  pool: pg.Pool,
  agentId: string | null,
  cfg?: MemoryConsolidationConfig,
): Promise<number> {
  const scoreThreshold = cfg?.archival?.scoreThreshold ?? 0.1;
  const minAgeDays = cfg?.archival?.minAgeDaysBeforeArchive ?? 60;

  const agentFilter = agentId != null
    ? `agent_id = $1`
    : `agent_id IS NULL AND scope = 'shared'`;
  const paramOffset = agentId != null ? 2 : 1;

  const sql = `
    UPDATE agent_memories
    SET archived = TRUE, updated_at = NOW()
    WHERE ${agentFilter}
      AND archived = FALSE
      AND merged_into IS NULL
      AND score IS NOT NULL
      AND score < $${paramOffset}
      AND access_count = 0
      AND created_at < NOW() - INTERVAL '1 day' * $${paramOffset + 1}
    RETURNING id
  `;

  const params = agentId != null
    ? [agentId, scoreThreshold, minAgeDays]
    : [scoreThreshold, minAgeDays];

  console.debug(`[memory-consolidation] archiving stale for agent=${agentId ?? 'shared'} (scoreThreshold=${scoreThreshold}, minAgeDays=${minAgeDays})`);

  const result = await pool.query<{ id: string }>(sql, params);
  const count = result.rowCount ?? 0;

  console.log(`[memory-consolidation] archived ${count} stale memories for agent=${agentId ?? 'shared'}`);
  return count;
}

/** Désarchive une mémoire par son UUID. */
export async function unarchiveMemory(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_memories SET archived = FALSE, updated_at = NOW() WHERE id = $1`,
    [id],
  );
  console.log(`[memory-consolidation] unarchived memory id=${id}`);
}
