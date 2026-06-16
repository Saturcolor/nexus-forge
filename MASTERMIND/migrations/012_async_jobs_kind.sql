-- Mastermind — Migration 012: async_jobs.kind discriminator
-- Distingue les shell-exec jobs (generate_video/image) des sandbox runs (agent run
-- complet dispatché en arrière-plan avec source='sandbox').

ALTER TABLE async_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'shell';

CREATE INDEX IF NOT EXISTS idx_async_jobs_kind ON async_jobs(kind, status);
