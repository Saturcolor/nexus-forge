-- Mastermind — Migration 008: board éphémère (workspace partagé inter-agents)

CREATE TABLE IF NOT EXISTS board_notes (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,                      -- auteur de la note
  content     TEXT NOT NULL,                      -- texte brut, max ~500 chars (enforced app-side)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL                -- auto-purge quand expires_at <= NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_notes_expires ON board_notes(expires_at);
