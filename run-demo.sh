#!/usr/bin/env bash
# NEXUS demo launcher — Postgres + Mercury + Mastermind with a fake LLM (no GPU, no keys).
#
#   ./run-demo.sh         start the stack (builds images on first run)
#   ./run-demo.sh down    stop and remove the stack
#
# Requires Docker (e.g. `brew install colima docker docker-compose && colima start`).
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.demo.yml"

if [ "${1:-up}" = "down" ]; then
  $COMPOSE down
  echo "NEXUS demo stopped."
  exit 0
fi

echo "Building & starting NEXUS demo (first run builds images, ~a few minutes)…"
$COMPOSE up --build -d
echo "Waiting for Mastermind to become ready…"
curl -s --retry 120 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:3000/health/ready || true

cat <<'EOF'

✅ NEXUS demo is up.

  Mastermind UI + API  →  http://localhost:3000    (open in your browser)
  Mercury UI + API     →  http://localhost:17890   (open in your browser)

The Mastermind dashboard auto-authenticates with the demo key — just open it.

Quick tests:
  curl http://localhost:3000/health/ready
  curl http://localhost:17890/api/tags
  curl -X POST http://localhost:3000/api/chat/assistant \
       -H 'Authorization: Bearer demo-key' -H 'Content-Type: application/json' \
       -d '{"content":"hello"}'

Stop it:  ./run-demo.sh down
EOF
