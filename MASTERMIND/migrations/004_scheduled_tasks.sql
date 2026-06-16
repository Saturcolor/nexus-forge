-- Mastermind — Migration 004: scheduled_tasks + task_runs

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  schedule_kind   TEXT NOT NULL CHECK (schedule_kind IN ('once', 'cron')),
  scheduled_at    TIMESTAMPTZ,
  cron_expression TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  notify_telegram BOOLEAN NOT NULL DEFAULT true,
  created_by      TEXT NOT NULL DEFAULT 'user',
  next_run_at     TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  last_run_status TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
  ON scheduled_tasks(next_run_at) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent
  ON scheduled_tasks(agent_id);

CREATE TABLE IF NOT EXISTS task_runs (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running',
  prompt            TEXT NOT NULL,
  result            TEXT,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  notified_telegram BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task
  ON task_runs(task_id, started_at DESC);
