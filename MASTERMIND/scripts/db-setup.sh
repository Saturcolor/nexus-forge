#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mastermind — db-setup.sh
# Crée l'utilisateur, la base, active pgvector et initialise le schéma.
#
# Usage :
#   ./scripts/db-setup.sh [--config <path>]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC}  $*"; }
err()  { echo -e "  ${RED}✗${NC}  $*" >&2; exit 1; }
warn() { echo -e "  ${YELLOW}!${NC}  $*"; }
step() { echo -e "\n${BOLD}$*${NC}"; }

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2 ;;
    *) echo "Usage: $0 [--config <path>]"; exit 1 ;;
  esac
done

if [[ -z "$CONFIG_FILE" ]]; then
  for c in "$REPO_ROOT/config/mastermind.yml" "$REPO_ROOT/mastermind.yml"; do
    [[ -f "$c" ]] && CONFIG_FILE="$c" && break
  done
fi
[[ -z "$CONFIG_FILE" ]] && err "mastermind.yml introuvable. Utilisez --config <path>."

# ── Lecture YAML ──────────────────────────────────────────────────────────────
yaml_get() {
  awk -v key="$2" '
    /^database:/ { in_s=1; next }
    in_s && /^[^ ]/ { in_s=0 }
    in_s && $0 ~ "^[[:space:]]+" key ":[ \t]*" {
      sub(/^[[:space:]]*[^:]+:[[:space:]]*/, "")
      sub(/[[:space:]]*#.*$/, "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      print; exit
    }
  ' "$1"
}

LOCAL_FILE="$(dirname "$CONFIG_FILE")/mastermind.local.yml"
get_cfg() {
  local v=""
  [[ -f "$LOCAL_FILE" ]] && v="$(yaml_get "$LOCAL_FILE" "$1")"
  [[ -z "$v" ]] && v="$(yaml_get "$CONFIG_FILE" "$1")"
  # Substitution ${ENV_VAR}
  while [[ "$v" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
    v="${v/\$\{${BASH_REMATCH[1]}\}/${!BASH_REMATCH[1]:-}}"
  done
  echo "$v"
}

DB_HOST="$(get_cfg host)";     DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(get_cfg port)";     DB_PORT="${DB_PORT:-5432}"
DB_NAME="$(get_cfg database)"
DB_USER="$(get_cfg user)"
DB_PASS="$(get_cfg password)"

echo -e "\n${BOLD}Mastermind — Initialisation PostgreSQL${NC}"
echo    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Base     : ${BOLD}$DB_NAME${NC}  (@${DB_HOST}:${DB_PORT})"
echo -e "  User     : ${BOLD}$DB_USER${NC}"
echo -e "  Config   : $CONFIG_FILE"

# ── Étape 1 : Utilisateur + base ──────────────────────────────────────────────
step "Étape 1 — Utilisateur et base de données"

sudo -u postgres psql > /dev/null 2>&1 << EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$DB_USER') THEN
    CREATE USER "$DB_USER" WITH PASSWORD '$DB_PASS';
  ELSE
    ALTER USER "$DB_USER" WITH PASSWORD '$DB_PASS';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE "$DB_NAME" OWNER "$DB_USER"'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec
EOF

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";" > /dev/null 2>&1
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\";" > /dev/null 2>&1
sudo -u postgres psql -d "$DB_NAME" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$DB_USER\";" > /dev/null 2>&1
sudo -u postgres psql -d "$DB_NAME" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$DB_USER\";" > /dev/null 2>&1

ok "Utilisateur '$DB_USER' et base '$DB_NAME' prêts"

# ── Étape 2 : Extension pgvector ──────────────────────────────────────────────
step "Étape 2 — Extension pgvector"

VECTOR_AVAIL=$(sudo -u postgres psql -d "$DB_NAME" -tAc \
  "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'" 2>/dev/null || true)

if [[ "$VECTOR_AVAIL" != "1" ]]; then
  err "pgvector n'est pas installé sur ce serveur PostgreSQL.
       Installez-le d'abord :
         Debian/Ubuntu : sudo apt install postgresql-\$(pg_lsclusters -h | awk '{print \$1; exit}')-pgvector
         Arch          : sudo pacman -S pgvector
         macOS         : brew install pgvector"
fi

sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" > /dev/null 2>&1
ok "Extension 'vector' activée"

# ── Étape 3 : Schéma applicatif ───────────────────────────────────────────────
step "Étape 3 — Tables et index"

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" > /dev/null << 'SQL'
-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  title      TEXT DEFAULT '',
  options    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);

-- messages
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata   JSONB
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- reasoning_traces
CREATE TABLE IF NOT EXISTS reasoning_traces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  query      TEXT,
  reasoning  TEXT,
  conclusion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reasoning_agent ON reasoning_traces(agent_id, created_at DESC);

-- agent_memories (pgvector)
CREATE TABLE IF NOT EXISTS agent_memories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text       TEXT NOT NULL,
  embedding  VECTOR(4096),
  agent_id   TEXT,
  scope      TEXT NOT NULL DEFAULT 'agent',
  tags       TEXT[] DEFAULT '{}',
  domain     TEXT,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent   ON agent_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_scope   ON agent_memories(scope);
CREATE INDEX IF NOT EXISTS idx_agent_memories_domain  ON agent_memories(domain);
CREATE INDEX IF NOT EXISTS idx_agent_memories_created ON agent_memories(created_at DESC);
SQL
ok "Tables créées"

# Index HNSW (non bloquant)
if PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "CREATE INDEX IF NOT EXISTS idx_agent_memories_hnsw ON agent_memories USING hnsw (embedding vector_cosine_ops);" \
  > /dev/null 2>&1; then
  ok "Index HNSW (cosine) créé"
else
  warn "Index HNSW non créé (peut être ajouté après les premières insertions)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}Initialisation terminée.${NC}"
echo    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo    "  Ajoutez dans mastermind.yml :"
echo    ""
echo    "    memoryStore:"
echo    "      enabled: true"
echo    "      embeddingDimensions: 4096"
echo    "      autoInjection:"
echo    "        enabled: true"
echo    "        topK: 3"
echo    "        threshold: 0.45"
echo
