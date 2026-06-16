# CLAUDE.md — Agent guide to this repository

> Read this first. It tells an AI agent (or a human) what this repo is, how the
> pieces fit, where to find things, and how to run it without any special hardware.

## What this is

A **public portfolio snapshot** of three independently-deployable components that
together form a self-hosted LLM infrastructure stack. Licensed **AGPL-3.0**.

| Component | Role | Language | Entry point | Port |
|-----------|------|----------|-------------|------|
| **MERCURY** | LLM broker / proxy. OpenAI-compatible API that routes to local backends (llama.cpp, Ollama, MLX, LM Studio, vLLM) with cloud fallback (OpenRouter, Anthropic). Serial GPU queue, embedding cascade, key masking. | Python / FastAPI | `MERCURY/main.py` | 17890 |
| **MASTERMIND** | Multi-agent orchestration platform. Agent runtime, sessions (KV-cache-aware), scheduler, delivery engine (push/Telegram/chat), pgvector memory, hybrid codebase search. | TypeScript (monorepo) | `MASTERMIND/packages/backend` | 3000 |
| **BRAIN-DAEMON** | Custom inference daemon for **AMD Strix Halo**. Manages llama.cpp / vLLM subprocesses, surgical quantization, thermal control, KV-cache save/restore. | Python / FastAPI | `BRAIN-DAEMON/main.py` | 4321 |

**Runtime data flow:** `Mastermind → Mercury → brain-daemon → llama-server`.
Each layer is also usable standalone.

## Read next

- [`README.md`](README.md) — engineering narrative + architecture diagram.
- [`MERCURY/README.md`](MERCURY/README.md), [`MASTERMIND/README.md`](MASTERMIND/README.md), [`BRAIN-DAEMON/README.md`](BRAIN-DAEMON/README.md) — per-component deep dives.
- [`DEMO.md`](DEMO.md) — **run the stack in demo mode with no GPU/DB/cloud** (curl-able).

## Where things live

**Mercury** (`MERCURY/`)
- `core/` — HTTP routes (`routes_chat_completions.py`, `routes_api.py`, `routes_embeddings.py`, `server.py`).
- `routing/router.py` — model → backend resolution (mapping, regex routes, fallback chain).
- `providers/` — one subpackage per backend; `providers/__init__.py:get_backend()` is the factory; `providers/base.py` is the interface.
- `app_queue/` — serial request queue (one GPU job at a time, with stream cancellation).
- `auth/`, `scheduler/`, `admin/` — API keys, exclusive slots, admin API + dashboard.

**Mastermind** (`MASTERMIND/packages/`)
- `backend/src/modules/{agent,delivery,session,memory,prompt-templates,...}` — the orchestration core.
- `frontend/` — Vite/React dashboard (has a full mock-API dev mode, see DEMO.md).
- `shared/` — types shared backend↔frontend. `codebase-search/` — LanceDB + tree-sitter hybrid search.

**brain-daemon** (`BRAIN-DAEMON/`)
- `daemon.py` — the FastAPI app and all routes (`/v1/*`, `/mgmt/*`, `/health`).
- `manager.py` — llama-server / vLLM subprocess lifecycle.
- `quantize/` — surgical quantization pipeline (the `v5build/stage*.py` scripts are the interesting part).
- `thermal/`, `memory/`, `atlas/` — thermal control, UMA memory accounting, control-vector extraction.

## Running it

See [`DEMO.md`](DEMO.md). Both Python daemons have a **demo mode** that fakes the
LLM / hardware so the real app boots and answers `curl` with no GPU, DB, cloud key,
or model file. Mastermind's frontend runs against a mock API. Quickest check:

```bash
cd MERCURY && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
MERCURY_DEMO_MODE=1 MERCURY_CONFIG=../demo/mercury.demo.yaml python main.py
# then: curl http://127.0.0.1:17890/v1/chat/completions -d '{"model":"demo","messages":[{"role":"user","content":"hi"}]}' -H 'Content-Type: application/json'
```

## Conventions & guardrails

- **Public repo — no secrets, no PII.** All configs are committed as `*.example`; real
  secrets live in gitignored `config.yaml` / `*.local.*` / environment variables.
  Never commit a real API key.
- **Demo paths are isolated.** `MERCURY_DEMO_MODE` and `BRAIN_DEMO_MODE` gate the fake
  code paths. Keep demo logic out of the real request paths.
- **brain-daemon is hardware-specific by design.** It targets AMD Strix Halo (gfx1151,
  unified memory, `/sys/class/drm` thermal). This is a feature of the project, not a bug
  to "fix" — document hardware assumptions rather than faking portability.
- **Python 3.10+** is required (the code uses `X | None` runtime type annotations).
- **Node 22.x** for Mastermind (Node 24+ hits an undici dispatcher incompat in the demo path — see DEMO.md).
