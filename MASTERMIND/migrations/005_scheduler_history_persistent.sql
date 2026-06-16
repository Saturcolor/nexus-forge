-- Mastermind — Migration 005: scheduler historique persistant + auto-delete

-- Rendre task_id nullable (historique survit à la suppression de la tâche)
ALTER TABLE task_runs ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS task_name TEXT;

-- Changer CASCADE → SET NULL
ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_task_id_fkey;
ALTER TABLE task_runs ADD CONSTRAINT task_runs_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE SET NULL;

-- Backfill task_name pour les runs existants
UPDATE task_runs SET task_name = s.name
  FROM scheduled_tasks s
  WHERE task_runs.task_id = s.id AND task_runs.task_name IS NULL;

-- Option auto-delete après exécution
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS delete_after_run BOOLEAN NOT NULL DEFAULT false;
