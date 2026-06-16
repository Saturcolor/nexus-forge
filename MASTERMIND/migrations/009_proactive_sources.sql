-- Mastermind — Migration 009: proactive sources (webhook integrations)

CREATE TABLE IF NOT EXISTS proactive_sources (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,                        -- display name ("Nexus Monitor", "Mailmind", ...)
  kind              TEXT NOT NULL DEFAULT 'webhook',      -- 'webhook' for now, 'ws' later
  enabled           BOOLEAN NOT NULL DEFAULT true,
  agent_id          TEXT NOT NULL,                        -- agent assigned to handle incoming alerts
  prompt            TEXT NOT NULL DEFAULT '',              -- custom instructions prepended to every alert dispatched to the agent
  config            JSONB NOT NULL DEFAULT '{}',          -- source-specific config (ex: nexus monitor URL for healthcheck)
  rate_limit_minutes INTEGER NOT NULL DEFAULT 5,          -- min interval between dispatched alerts from this source
  last_alert_at     TIMESTAMPTZ,                          -- last time an alert was dispatched to the agent
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proactive_sources_enabled ON proactive_sources(enabled);

-- Log of ingested alerts (audit trail + UI display)
CREATE TABLE IF NOT EXISTS proactive_alerts (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES proactive_sources(id) ON DELETE CASCADE,
  severity          TEXT NOT NULL,                        -- 'low' | 'medium' | 'high'
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  metric            TEXT,                                 -- 'cpu' | 'ram' | 'disk' | 'latency' | ...
  value             DOUBLE PRECISION,
  threshold         DOUBLE PRECISION,
  state             TEXT NOT NULL DEFAULT 'triggered',    -- 'triggered' | 'resolved'
  dispatched        BOOLEAN NOT NULL DEFAULT false,       -- true if an agent run was triggered
  run_id            TEXT,                                 -- task_runs.id if dispatched
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proactive_alerts_source ON proactive_alerts(source_id, created_at DESC);
