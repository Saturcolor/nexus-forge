-- Mastermind — Migration 006: module proactif (watchers + escalations)

-- scheduled_tasks: nouveaux champs pour les routines proactives
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS escalation_agent_id TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS severity_threshold TEXT DEFAULT 'medium';

-- task_runs: traçabilité du pipeline proactif (watcher → handler)
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS delivered BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- Index ciblés pour les requêtes du module proactif
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_kind ON scheduled_tasks(kind);
CREATE INDEX IF NOT EXISTS idx_task_runs_parent ON task_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_kind ON task_runs(kind, started_at DESC);
