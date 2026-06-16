-- Mastermind — Migration 007: war rooms (brainstorm multi-agents)

-- Métadonnées + config + état d'une war room
CREATE TABLE IF NOT EXISTS rooms (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed' | 'crashed'
  max_messages        INTEGER NOT NULL DEFAULT 200,
  max_tools_per_turn  INTEGER NOT NULL DEFAULT 5,
  turn_index          INTEGER NOT NULL DEFAULT 0,    -- 0 = user, 1..N = membre à cet order_index
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  archive_path        TEXT,
  summary             TEXT
);

CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status, created_at DESC);

-- Membres d'une war room. Chaque agent a une fresh session dédiée
-- (créée à l'ouverture, supprimée à la fermeture) pour isoler le contexte
-- de la war room du chat normal de l'agent.
CREATE TABLE IF NOT EXISTS room_members (
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  order_index INTEGER NOT NULL,                       -- 1..N ordre de parole
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_order ON room_members(room_id, order_index);

-- Log canonique chronologique de la war room (ce que l'utilisateur voit dans l'UI).
-- Source unique de vérité pour le rendu et pour la génération du résumé à la fermeture.
CREATE TABLE IF NOT EXISTS room_messages (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_kind     TEXT NOT NULL,                      -- 'user' | 'agent' | 'system'
  author_agent_id TEXT,                               -- NULL quand author_kind = 'user' ou 'system'
  content         TEXT NOT NULL,
  passed          BOOLEAN NOT NULL DEFAULT false,     -- true quand l'agent a répondu [PASS]
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at);
