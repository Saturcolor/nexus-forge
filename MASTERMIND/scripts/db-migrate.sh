#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mastermind — db-migrate.sh
# Applique les migrations PENDING depuis `migrations/*.sql`, en suivant l'état via
# la table `schema_migrations` — équivalent bash de `nexusctl migrate <app>`.
#
# Mêmes sémantiques que nexusctl (nexusctl/nexusctl/migrate.py) pour partager la
# MÊME table de suivi sans double-application :
#   - version  = nom de fichier sans `.sql`        (ex: 016_session_fts)
#   - checksum = sha256 du contenu du fichier
#   - seules les versions absentes de schema_migrations sont appliquées
#   - mismatch de checksum sur une version déjà appliquée = WARN only (policy année 1)
#
# Ne crée PAS l'utilisateur ni la base (voir db-setup.sh).
#
# Usage :
#   ./scripts/db-migrate.sh [--config <path>]
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

# ── Lecture YAML (même pattern que db-setup.sh) ──────────────────────────────
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

echo -e "\n${BOLD}Mastermind — Migration de schéma${NC}"
echo    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Base     : ${BOLD}$DB_NAME${NC}  (@${DB_HOST}:${DB_PORT})"
echo -e "  User     : ${BOLD}$DB_USER${NC}"
echo -e "  Config   : $CONFIG_FILE"

run_sql() {
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}
# Variante "scalaire" : -t (tuples only) -A (unaligned) — pour récupérer une valeur.
run_sql_scalar() {
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# ── Table de suivi (identique à nexusctl) ────────────────────────────────────
step "Table de suivi schema_migrations"
run_sql > /dev/null << 'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  checksum   TEXT
);
SQL
ok "schema_migrations prête"

# ── Application des migrations pending (migrations/*.sql) ─────────────────────
step "Migrations pending (migrations/*.sql)"
MIG_DIR="$REPO_ROOT/migrations"
[[ -d "$MIG_DIR" ]] || err "Dossier introuvable : $MIG_DIR"

# Bash trie les globs par LC_COLLATE → l'ordre NNN_ (zéro-paddé) est numérique.
shopt -s nullglob
MIG_FILES=("$MIG_DIR"/*.sql)
shopt -u nullglob
[[ ${#MIG_FILES[@]} -gt 0 ]] || { warn "Aucune migration .sql trouvée — rien à faire."; echo; exit 0; }

applied=0; skipped=0
for f in "${MIG_FILES[@]}"; do
  name="$(basename "$f")"
  # Même filtre que nexusctl : ^\d{3,}_[a-zA-Z0-9_-]+\.sql$
  if [[ ! "$name" =~ ^[0-9]{3,}_[a-zA-Z0-9_-]+\.sql$ ]]; then
    warn "ignoré (nom non conforme) : $name"
    continue
  fi
  version="${name%.sql}"
  checksum="$(sha256_of "$f")"

  if [[ "$(run_sql_scalar "SELECT 1 FROM schema_migrations WHERE version='$version';")" == "1" ]]; then
    stored="$(run_sql_scalar "SELECT COALESCE(checksum,'') FROM schema_migrations WHERE version='$version';")"
    if [[ -n "$stored" && "$stored" != "$checksum" ]]; then
      warn "checksum différent pour $version (disque=${checksum:0:12} db=${stored:0:12}) — non ré-appliqué (warn-only)"
    fi
    skipped=$((skipped + 1))
    continue
  fi

  if run_sql -f "$f" > /dev/null; then
    run_sql_scalar "INSERT INTO schema_migrations (version, checksum) VALUES ('$version', '$checksum') ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum;" > /dev/null
    ok "appliqué : $version"
    applied=$((applied + 1))
  else
    err "échec migration : $version"
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}Migration terminée.${NC} ($applied appliquée(s), $skipped déjà à jour)"
echo    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
