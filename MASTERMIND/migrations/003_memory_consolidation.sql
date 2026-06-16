-- Mastermind — Migration 003: consolidation mémoire (colonnes + audit table)

-- Colonnes de tracking/scoring/archivage sur agent_memories
ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS last_accessed_at  TIMESTAMPTZ;
ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS access_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS score             REAL;
ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS archived          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS merged_into       UUID;
ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS merge_source_ids  UUID[] DEFAULT ARRAY[]::UUID[];

CREATE INDEX IF NOT EXISTS idx_memories_archived ON agent_memories(archived);
CREATE INDEX IF NOT EXISTS idx_memories_score    ON agent_memories(score DESC NULLS LAST);

-- Table d'audit des runs de consolidation
CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'running',
  stats       JSONB DEFAULT '{}',
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_consolidation_runs_agent
  ON memory_consolidation_runs(agent_id, started_at DESC);
