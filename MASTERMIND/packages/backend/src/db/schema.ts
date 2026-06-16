import type pg from 'pg';

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      title       TEXT DEFAULT '',
      options     JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';

    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'web',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata    JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS compacted_at TIMESTAMPTZ;

    -- #12 session_search : recherche plein-texte (français) sur l'historique des messages.
    CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING gin (to_tsvector('french', content));
  `);

  // Reasoning traces table (Phase 3 — opt-in via agentConfig.captureReasoningTraces)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reasoning_traces (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      query       TEXT,
      reasoning   TEXT,
      conclusion  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_reasoning_agent ON reasoning_traces(agent_id, created_at DESC);
  `);

  // Scheduled tasks tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      schedule_kind   TEXT NOT NULL CHECK (schedule_kind IN ('once', 'cron')),
      scheduled_at    TIMESTAMPTZ,
      cron_expression TEXT,
      enabled         BOOLEAN NOT NULL DEFAULT true,
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
      task_id           TEXT REFERENCES scheduled_tasks(id) ON DELETE SET NULL,
      task_name         TEXT,
      agent_id          TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'running',
      prompt            TEXT NOT NULL,
      result            TEXT,
      error             TEXT,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at      TIMESTAMPTZ,
      duration_ms       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_task_runs_task
      ON task_runs(task_id, started_at DESC);
  `);

  // Migration: scheduler history preservation + auto-delete
  await pool.query(`
    ALTER TABLE task_runs ALTER COLUMN task_id DROP NOT NULL;
    ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS task_name TEXT;
    ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS delete_after_run BOOLEAN NOT NULL DEFAULT false;
  `);

  // Migration: drop dead notify_telegram (post-run echo) + notified_telegram (audit)
  // L'agent contrôle la livraison via send_to_user — le toggle/écho legacy n'a plus de raison d'être.
  await pool.query(`
    ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS notify_telegram;
    ALTER TABLE task_runs       DROP COLUMN IF EXISTS notified_telegram;
  `);
  // Migrate FK from CASCADE to SET NULL (idempotent: drop + re-add)
  await pool.query(`
    ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_task_id_fkey;
    ALTER TABLE task_runs ADD CONSTRAINT task_runs_task_id_fkey
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE SET NULL;
  `);
  // Backfill task_name for existing runs
  await pool.query(`
    UPDATE task_runs SET task_name = s.name
      FROM scheduled_tasks s
      WHERE task_runs.task_id = s.id AND task_runs.task_name IS NULL;
  `);

  // Migration: proactive module
  await pool.query(`
    ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS escalation_agent_id TEXT;
    ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS severity_threshold TEXT DEFAULT 'medium';

    ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT;
    ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS severity TEXT;
    ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS delivered BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_kind ON scheduled_tasks(kind);
    CREATE INDEX IF NOT EXISTS idx_task_runs_parent ON task_runs(parent_run_id);
    CREATE INDEX IF NOT EXISTS idx_task_runs_kind ON task_runs(kind, started_at DESC);
  `);

  // Backfill task_name for escalation runs — handler rows were inserted with task_name=NULL
  // before the 2026-06 fix, so the history view rendered them as "(supprimee)". MUST run AFTER
  // the kind/parent_run_id columns are added (block just above) — referencing them earlier crashes
  // ensureSchema on a clean DB (42703). Prefer the parent watcher's name; fall back to a generic
  // label for ad-hoc escalations whose parent_run_id has no row. Idempotent (gated task_name IS NULL).
  await pool.query(`
    UPDATE task_runs e SET task_name = '↳ ' || p.task_name
      FROM task_runs p
      WHERE e.kind = 'escalation' AND e.task_name IS NULL
        AND e.parent_run_id = p.id AND p.task_name IS NOT NULL;
  `);
  await pool.query(`
    UPDATE task_runs SET task_name = 'Escalade'
      WHERE kind = 'escalation' AND task_name IS NULL;
  `);

  // Migration: scheduler soft-delete (corbeille / restore)
  await pool.query(`
    ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_deleted ON scheduled_tasks(deleted_at) WHERE deleted_at IS NOT NULL;
  `);

  // Migration: per-task auto_deliver flag — controls the send_to_user safety net in run.ts
  // (proactive web autodeliver + telegram autodeliver fallbacks). Default true preserves
  // existing behaviour; toggle off per task/source for runs that should be allowed to
  // terminate silently when the agent decides not to call send_to_user.
  await pool.query(`
    ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS auto_deliver BOOLEAN NOT NULL DEFAULT true;
  `);

  // Migration: per-task delivery channels override — JSONB array ('["mobile","telegram"]')
  // ou NULL = pas d'override (policy delivery de l'agent / legacy). Prioritaire sur la
  // policy ET sur l'arg `channel` du LLM dans send_to_user (cf. resolveDelivery).
  await pool.query(`
    ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS delivery_channels JSONB;
  `);

  // Migration: war room module
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed' | 'crashed'
      max_messages        INTEGER NOT NULL DEFAULT 200,
      max_tools_per_turn  INTEGER NOT NULL DEFAULT 5,
      turn_index          INTEGER NOT NULL DEFAULT 0,    -- 0 = user, 1..N = member order_index
      user_name           TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at           TIMESTAMPTZ,
      archive_path        TEXT,
      summary             TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS room_members (
      room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      agent_id    TEXT NOT NULL,
      session_id  TEXT NOT NULL,                          -- fresh session dedicated to this war room participation
      order_index INTEGER NOT NULL,                       -- 1..N speaking order
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_room_members_order ON room_members(room_id, order_index);

    CREATE TABLE IF NOT EXISTS room_messages (
      id              TEXT PRIMARY KEY,
      room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      author_kind     TEXT NOT NULL,                      -- 'user' | 'agent' | 'system'
      author_agent_id TEXT,                               -- NULL when author_kind = 'user' or 'system'
      content         TEXT NOT NULL,
      passed          BOOLEAN NOT NULL DEFAULT false,     -- true when message is a [PASS] marker from an agent
      metadata        JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at);
  `);

  // Migration: proactive sources (webhook integrations)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proactive_sources (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'webhook',
      enabled           BOOLEAN NOT NULL DEFAULT true,
      agent_id          TEXT NOT NULL,
      config            JSONB NOT NULL DEFAULT '{}',
      rate_limit_minutes INTEGER NOT NULL DEFAULT 5,
      last_alert_at     TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE proactive_sources ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT '';
    ALTER TABLE proactive_sources ADD COLUMN IF NOT EXISTS context_retention_hours INTEGER NOT NULL DEFAULT 24;
    ALTER TABLE proactive_sources ADD COLUMN IF NOT EXISTS auto_deliver BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE proactive_sources ADD COLUMN IF NOT EXISTS delivery_channels JSONB;
    CREATE INDEX IF NOT EXISTS idx_proactive_sources_enabled ON proactive_sources(enabled);

    CREATE TABLE IF NOT EXISTS proactive_alerts (
      id                TEXT PRIMARY KEY,
      source_id         TEXT NOT NULL REFERENCES proactive_sources(id) ON DELETE CASCADE,
      severity          TEXT NOT NULL,
      title             TEXT NOT NULL,
      message           TEXT NOT NULL,
      metric            TEXT,
      value             DOUBLE PRECISION,
      threshold         DOUBLE PRECISION,
      state             TEXT NOT NULL DEFAULT 'triggered',
      dispatched        BOOLEAN NOT NULL DEFAULT false,
      run_id            TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_alerts_source ON proactive_alerts(source_id, created_at DESC);
  `);

  // Migration: board éphémère (workspace partagé inter-agents)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_notes (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_board_notes_expires ON board_notes(expires_at);
  `);

  // User preferences (tab order, UI state…)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      key    TEXT PRIMARY KEY,
      value  JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Push devices — registry des device tokens APNs (canal mobile mobile app).
  // Alimenté par POST /api/push/register. disabled=true => token mort, purgé après
  // 410/BadDeviceToken par PushModule.sendToAll. Voir migrations/017_push_devices.sql.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      token        TEXT PRIMARY KEY,
      platform     TEXT NOT NULL DEFAULT 'ios',
      agent_id     TEXT,
      disabled     BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_push_devices_active
      ON push_devices(last_seen_at DESC) WHERE disabled = false;
  `);

  // Async jobs — fire-and-forget execution path for long-running skill actions
  // (Sora Pro video, Veo 3, image gen). See plan `l-implementation-m-as-l-air-clean-async-fox.md`.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS async_jobs (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      args          JSONB NOT NULL,
      status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error | cancelled
      result        TEXT,
      output_files  JSONB,                           -- MessageAttachment[] actually delivered
      error         TEXT,
      caption       TEXT,                            -- on_complete_caption from actions.yml
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      cancelled_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_async_jobs_active
      ON async_jobs(created_at DESC) WHERE status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS idx_async_jobs_agent
      ON async_jobs(agent_id, created_at DESC);

    -- Migration 012: sandbox runs — distinguish between shell-exec jobs and
    -- full agent runs dispatched in the background (kind='sandbox_run').
    ALTER TABLE async_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'shell';
    CREATE INDEX IF NOT EXISTS idx_async_jobs_kind ON async_jobs(kind, status);

    -- Migration 014: sub-agent cloud jobs (kind='sub_agent'). Historically these columns
    -- lived ONLY in migrations/014_sub_agent_jobs.sql (applied out-of-band by nexusctl).
    -- Back-ported here so a clean DB bootstrapped by ensureSchema() alone doesn't crash
    -- recoverFromRestart()'s SELECT with "42703 column does not exist". See AUDIT-2026-06-01 C2.
    ALTER TABLE async_jobs
      ADD COLUMN IF NOT EXISTS sub_agent_id      TEXT,
      ADD COLUMN IF NOT EXISTS parent_session_id TEXT,
      ADD COLUMN IF NOT EXISTS parent_agent_id   TEXT,
      ADD COLUMN IF NOT EXISTS task_prompt       TEXT,
      ADD COLUMN IF NOT EXISTS caps_hit          TEXT;
    CREATE INDEX IF NOT EXISTS idx_async_jobs_subagent_recent
      ON async_jobs(sub_agent_id, created_at DESC)
      WHERE sub_agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_async_jobs_parent_session
      ON async_jobs(parent_session_id, created_at DESC)
      WHERE parent_session_id IS NOT NULL;
  `);

  console.log('[db] Schema ensured');
}
