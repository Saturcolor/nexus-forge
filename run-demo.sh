#!/usr/bin/env bash
# NEXUS demo launcher — the WHOLE stack in one command, with a fake LLM (no GPU, no keys, no models).
# Brings up Postgres + Mercury + Mastermind + brain-daemon (all in demo mode), waits until each is
# ready, and opens the web UIs in your browser.
#
#   ./run-demo.sh            start everything + open the UIs
#   ./run-demo.sh down       stop and remove the stack
#
#   NO_OPEN=1 ./run-demo.sh  start without opening browser tabs
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

# ── Pre-flight: Docker present and running (fail with an actionable message, not a stack trace) ──
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Install it first, e.g.:" >&2
  echo "  brew install colima docker docker-compose && colima start" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start it first, e.g.:  colima start" >&2
  exit 1
fi

echo "Building & starting the NEXUS demo (first run builds images, ~a few minutes)…"
$COMPOSE up --build -d

# ── Wait for each surface to actually answer ──
wait_for() {  # $1 = label, $2 = url
  printf "  %-22s " "$1"
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "$2"; then echo "ready"; return 0; fi
    sleep 1
  done
  echo "TIMEOUT (see: $COMPOSE logs)"; return 1
}
echo "Waiting for services…"
wait_for "Mastermind  (:3000)"  http://localhost:3000/health/ready || true
wait_for "Mercury     (:17890)" http://localhost:17890/api/tags     || true
wait_for "brain-daemon(:4321)"  http://localhost:4321/health        || true

# ── Open the web UIs (Mastermind dashboard + Mercury admin) ──
if [ "${NO_OPEN:-0}" != "1" ]; then
  opener=""
  if command -v open >/dev/null 2>&1; then opener=open
  elif command -v xdg-open >/dev/null 2>&1; then opener=xdg-open; fi
  if [ -n "$opener" ]; then
    "$opener" http://localhost:3000   >/dev/null 2>&1 || true
    "$opener" http://localhost:17890  >/dev/null 2>&1 || true
  fi
fi

cat <<'EOF'

✅ NEXUS demo is up — the whole stack, fake LLM (no GPU / DB keys / cloud / models).

  Mastermind UI + API   →  http://localhost:3000    (dashboard — auto-authenticated)
  Mercury UI + API      →  http://localhost:17890   (admin UI)
  brain-daemon API      →  http://localhost:4321    (daemon — no UI, curl it)

End-to-end test (Mastermind → Mercury fake LLM → reply):
  curl -X POST http://localhost:3000/api/chat/assistant \
       -H 'Authorization: Bearer demo-key' -H 'Content-Type: application/json' \
       -d '{"content":"hello"}'

More:
  curl http://localhost:17890/api/tags
  curl http://localhost:4321/health

Stop it:  ./run-demo.sh down
EOF
