-- Mastermind — Migration 011: async_jobs (fire-and-forget execution pour les skills longs)
-- Sora Pro / Veo 3 / image gen — une table, un worker en mémoire, une fois la génération
-- terminée le résultat est livré via send_to_user (chat + telegram) sans réveiller l'agent.

CREATE TABLE IF NOT EXISTS async_jobs (
  id            TEXT PRIMARY KEY,                    -- nanoid(12)
  agent_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,                       -- ex: skill_sora_generate_video
  args          JSONB NOT NULL,                      -- args originales du tool call (pour affichage)
  status        TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | error | cancelled
  result        TEXT,                                -- stdout+stderr du skill exec (tronqué 50k)
  output_files  JSONB,                               -- MessageAttachment[] effectivement livrés
  error         TEXT,                                -- message d'erreur si status='error'
  caption       TEXT,                                -- on_complete_caption depuis actions.yml
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,                         -- set quand le worker pick la row
  completed_at  TIMESTAMPTZ,                         -- set sur done | error
  cancelled_at  TIMESTAMPTZ                          -- set quand /cancel est appelé
);

-- Les jobs actifs sont rares (quelques unités max) — partial index = petit
CREATE INDEX IF NOT EXISTS idx_async_jobs_active
  ON async_jobs(created_at DESC) WHERE status IN ('queued', 'running');

-- Pour l'UI "mes tâches" par agent (tab + Telegram menu)
CREATE INDEX IF NOT EXISTS idx_async_jobs_agent
  ON async_jobs(agent_id, created_at DESC);
