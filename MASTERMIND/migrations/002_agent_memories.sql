-- Mastermind — Migration 002: agent_memories (pgvector) + HNSW index
-- Requires pgvector extension (CREATE EXTENSION vector handled by db-setup).

CREATE TABLE IF NOT EXISTS agent_memories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text       TEXT NOT NULL,
  embedding  VECTOR(4096),
  agent_id   TEXT,
  scope      TEXT NOT NULL DEFAULT 'agent',
  tags       TEXT[] DEFAULT '{}',
  domain     TEXT,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent   ON agent_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_scope   ON agent_memories(scope);
CREATE INDEX IF NOT EXISTS idx_agent_memories_domain  ON agent_memories(domain);
CREATE INDEX IF NOT EXISTS idx_agent_memories_created ON agent_memories(created_at DESC);

-- HNSW index (cosine) — OPTIONAL.
-- pgvector's HNSW supports at most 2000 dimensions (as of pgvector 0.7), but
-- our embeddings are 4096-dim (SOTA models). The index simply cannot be built
-- at this size. Mastermind works fine without it (sequential scan on the
-- few memories per agent). If a future pgvector version lifts the limit, this
-- block will succeed on re-run. Wrap in DO ... EXCEPTION so the migration
-- never fails on this line.
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_agent_memories_hnsw
    ON agent_memories USING hnsw (embedding vector_cosine_ops);
  RAISE NOTICE 'HNSW index created';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'HNSW index skipped: %', SQLERRM;
END $$;
