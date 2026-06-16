# DEMO.md — Run the stack without a GPU

Each backend ships a **demo mode** that fakes the LLM / hardware so you can explore
the real API with `curl` — no GPU, no database, no cloud keys, no model files. The
actual application boots and runs; only the external dependencies are stubbed.

**Prerequisite:** Python **3.10+** (the code uses `X | None` runtime annotations;
Python 3.9 will fail at import). For the Mastermind backend you also need Node **22.x**
and a Postgres — or just use Docker (below).

---

## Quick start — Docker (the whole stack, one command)

If you have Docker, this builds and runs Postgres + Mercury + Mastermind together with
a fake LLM — no GPU, no keys, no host Python/Node needed.

```bash
./run-demo.sh          # build + start, waits for ready, then prints the URLs
./run-demo.sh down     # stop and remove
```

Equivalent without the helper:

```bash
docker compose -f docker-compose.demo.yml up --build     # add -d to detach
```

(No Docker yet? On macOS: `brew install colima docker docker-compose && colima start`.)

### Ports

Both backends also serve their **web UI** on the same port — open them in a browser.

| Service | URL | In browser | Notes |
|---|---|---|---|
| **Mastermind** | http://localhost:3000 | ✅ dashboard | + REST API & WebSocket. The UI auto-authenticates with `demo-key` (baked at build). `/api/*` via curl needs `Authorization: Bearer demo-key`. |
| **Mercury** | http://localhost:17890 | ✅ admin UI | + OpenAI-compatible API. No auth in demo. |
| Postgres | internal only | — | not published to the host |

### Test it

```bash
# Mastermind health (no auth) — open in a browser too
curl http://localhost:3000/health/ready                 # {"ok":true}

# Mercury model list (no auth)
curl http://localhost:17890/api/tags

# Full pipeline: Mastermind → Mercury → fake LLM
curl -X POST http://localhost:3000/api/chat/assistant \
  -H 'Authorization: Bearer demo-key' -H 'Content-Type: application/json' \
  -d '{"content":"hello"}'
# → {"ok":true,"response":"Mercury is running in DEMO_MODE …","sessionId":"assistant-web"}

# Mercury directly (OpenAI-compatible, streaming)
curl -N http://localhost:17890/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"demo","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

`brain-daemon` is not in the compose (AMD Strix Halo hardware-specific — see section 2
for its standalone demo). The sections below run each component **manually** instead.

---

## 1. Mercury — LLM broker (curl-able)

```bash
cd MERCURY
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
MERCURY_DEMO_MODE=1 MERCURY_CONFIG=../demo/mercury.demo.yaml python main.py
# → listening on http://127.0.0.1:17890
```

> If `MERCURY_CONFIG` is omitted, Mercury falls back to `config.yaml.example` automatically.

Try it:

```bash
# Model list
curl http://127.0.0.1:17890/api/tags

# Chat completion (OpenAI-compatible)
curl http://127.0.0.1:17890/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"demo","messages":[{"role":"user","content":"are you in demo mode?"}]}'

# Streaming (SSE)
curl -N http://127.0.0.1:17890/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"demo","stream":true,"messages":[{"role":"user","content":"stream test"}]}'

# Embeddings
curl http://127.0.0.1:17890/v1/embeddings -H 'Content-Type: application/json' \
  -d '{"model":"demo","input":["hello","world"]}'
```

You get a canned assistant reply that echoes your message, real SSE chunks for the
stream, and 16-dim demo vectors. The real routing/queue/API code runs — only the
model call is faked.

---

## 2. brain-daemon — inference daemon (curl-able)

```bash
cd BRAIN-DAEMON
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
BRAIN_DEMO_MODE=1 BRAIN_CONFIG=../demo/brain.demo.yaml uvicorn main:app --host 127.0.0.1 --port 4321
```

Try it:

```bash
curl http://127.0.0.1:4321/health        # → {"status":"ok","demo_mode":true,...}
curl http://127.0.0.1:4321/v1/models     # → demo model list
curl http://127.0.0.1:4321/mgmt/models   # → management view
curl http://127.0.0.1:4321/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"demo/qwen-demo-7b","messages":[{"role":"user","content":"hi"}]}'
```

No GPU is touched and no `llama-server` subprocess is spawned. (Outside demo mode
this daemon targets AMD Strix Halo hardware — see `BRAIN-DAEMON/README.md`.)

---

## 3. Mastermind — orchestration (full backend, end-to-end)

Mastermind's backend needs PostgreSQL. With it, the **whole stack runs end-to-end**:
a chat request flows Mastermind → Mercury demo → fake LLM, and a reply comes back.

> **Use Node 22.x.** Node 24+ currently hits an undici dispatcher incompatibility
> (`UND_ERR_INVALID_ARG`) between the bundled streaming agent and Node's newer
> internal undici. Node 22 (the supported version) works.

```bash
# 1. A Postgres (no pgvector needed — memoryStore is off in the demo config):
docker run --name mm-pg -p 5432:5432 \
  -e POSTGRES_USER=mastermind -e POSTGRES_PASSWORD=mastermind -e POSTGRES_DB=mastermind \
  -d postgres:16
#   (or: brew install postgresql@16, then create the mastermind role + database)

# 2. Build the workspace deps (the backend runs via tsx, but its workspace
#    packages are published from dist/):
cd MASTERMIND
npm install
npm run build --workspace=packages/shared
npm run build --workspace=@mastermind/codebase-search

# 3. Make sure the Mercury demo (section 1) is running — it's the LLM provider.

# 4. Boot the backend against the demo config:
MASTERMIND_CONFIG=config/mastermind.demo.yml npx tsx packages/backend/src/index.ts
# → http://127.0.0.1:3000
```

Drive an agent end-to-end:

```bash
curl -X POST http://127.0.0.1:3000/api/chat/assistant \
  -H 'Authorization: Bearer demo-key' -H 'Content-Type: application/json' \
  -d '{"content":"hello"}'
# → {"ok":true,"response":"Mercury is running in DEMO_MODE …","sessionId":"assistant-web"}
```

The reply text comes from the Mercury demo (fake LLM), proving the full path works.
The demo config (`config/mastermind.demo.yml`) uses a local Postgres, points the
provider at the Mercury demo, and disables memoryStore/consolidation (so no pgvector).

### Frontend only (zero backend)

To just click around the UI without Postgres:

```bash
cd MASTERMIND && npm install
npm run dev:frontend     # VITE_MOCK_API=1 preset in packages/frontend/.env.development.local
# → http://localhost:5173
```

---

## What's verified

All three were booted and exercised on this machine (macOS, Python 3.13, Node 22.22):
- **Mercury** demo — curl-tested: chat (stream + non-stream), `/api/tags`, embeddings.
- **brain-daemon** demo — curl-tested: health, `/v1/models`, `/mgmt/models`, chat, embeddings.
- **Mastermind** backend — booted against PostgreSQL 16; an agent run via
  `POST /api/chat/assistant` returned a reply sourced from the Mercury demo (true E2E).
- **Docker compose** (`docker-compose.demo.yml`) — built and run end-to-end
  (Postgres + Mercury + Mastermind); `POST /api/chat/assistant` returned 200 with a
  Mercury-demo reply routed through all three containers.

The Mastermind frontend mock uses the existing `VITE_MOCK_API` dev infrastructure.
