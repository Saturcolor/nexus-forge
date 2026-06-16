-- Mastermind — Migration 016: session_search full-text index
-- GIN index sur to_tsvector('french', content) pour la recherche plein-texte de l'historique
-- des conversations (tool agent `session_search` + GET /sessions/search). Idempotent.
-- Note : la même définition existe dans db/schema.ts (ensureSchema) — les deux sont obligatoires
-- (ensureSchema = boot clean, migrations/*.sql = flux nexusctl).
CREATE INDEX IF NOT EXISTS idx_messages_fts
  ON messages USING gin (to_tsvector('french', content));
