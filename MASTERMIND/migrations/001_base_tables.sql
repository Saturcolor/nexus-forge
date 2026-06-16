-- Mastermind — Migration 001: tables de base (sessions, messages, reasoning_traces)
-- Idempotent.

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  title      TEXT DEFAULT '',
  options    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);

-- messages
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata   JSONB
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- Soft-delete pour l'auto-compact (conserve les messages originaux)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS compacted_at TIMESTAMPTZ;

-- reasoning_traces
CREATE TABLE IF NOT EXISTS reasoning_traces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  query      TEXT,
  reasoning  TEXT,
  conclusion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reasoning_agent ON reasoning_traces(agent_id, created_at DESC);
