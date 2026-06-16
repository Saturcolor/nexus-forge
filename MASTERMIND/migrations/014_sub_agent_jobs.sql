-- Mastermind — Migration 014: async_jobs étendus pour sub-agents cloud
-- Nouveau kind='sub_agent' : un agent principal spawne un sub-agent cloud one-shot
-- via le tool `spawn_subagent`, le sub-agent tourne en async, son rapport est
-- ré-injecté en session parente via deliverToChat (mécanique proactive existante).
--
-- Les transcripts sont stockés tels quels dans `result` (markdown), accessibles
-- via drill-down depuis la conv parente. `caps_hit` indique pourquoi un run s'est
-- arrêté tôt (NULL = run propre, 'iterations'|'tool_calls'|'tokens'|'timeout' sinon).

ALTER TABLE async_jobs
  ADD COLUMN IF NOT EXISTS sub_agent_id      TEXT,
  ADD COLUMN IF NOT EXISTS parent_session_id TEXT,
  ADD COLUMN IF NOT EXISTS parent_agent_id   TEXT,
  ADD COLUMN IF NOT EXISTS task_prompt       TEXT,
  ADD COLUMN IF NOT EXISTS caps_hit          TEXT;

-- Page stats : list runs récents par preset, count par status sur 30j
CREATE INDEX IF NOT EXISTS idx_async_jobs_subagent_recent
  ON async_jobs(sub_agent_id, created_at DESC)
  WHERE sub_agent_id IS NOT NULL;

-- Drill-down depuis la conv parente : liste des spawns d'une session parente
CREATE INDEX IF NOT EXISTS idx_async_jobs_parent_session
  ON async_jobs(parent_session_id, created_at DESC)
  WHERE parent_session_id IS NOT NULL;
