# Mercury

Mercury is an OpenAI-compatible LLM proxy and broker written in Python (FastAPI). It
sits between clients and a heterogeneous set of inference backends — local (Ollama,
LM Studio, MLX, llama.cpp/brain-daemon, vLLM) and cloud (OpenRouter, Anthropic) —
and exposes a single, unified API surface with priority queueing, cascading fallback,
embedding brokering, audio routing, and a React dashboard.

The core routing and provider layer has no hard dependency on any specific deployment:
all backend URLs, credentials, and optional modules are driven by a single `config.yaml`.

---

## Architecture

```
Clients (OpenAI-compat)
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │  FastAPI app  (core/server.py)                          │
  │                                                         │
  │  POST /v1/chat/completions ──► Priority queue  ──► Worker task
  │                                 (heapq, FIFO within     │
  │                                  same priority)         │
  │            ┌────────────────────────────────────────────┘
  │            │  Cloud backends bypass the queue
  │            ▼
  │  resolve_model()  (routing/router.py)
  │    1. explicit backend tag (ollama/ollama, llamacpp/llamacpp …)
  │    2. openrouter_fallback_force override
  │    3. in-memory TTL cache (500 entries, 5 min TTL)
  │    4. model_mapping  (config / DB, exact key)
  │    5. models_cache   (polled from live backends, exact + normalised)
  │    6. model_routes   (regex rules, first match wins)
  │    7. prefix fallback (ollama/ mlx/ lm_studio/ llamacpp/ …)
  │    8. ordered cloud fallback  (fallback_providers_order)
  │            │
  │            ▼
  │  Backend health check  (core/backends_health.py)
  │    local down  ──► cloud fallback chain (OpenRouter → Anthropic or custom order)
  │            │
  │            ▼
  │  Provider adapters  (providers/)
  │    OllamaBackend / LMStudioBackend / MLXBackend
  │    LlamacppBackend / VllmBackend / LuceboxBackend
  │    OpenRouterBackend / AnthropicBackend
  │
  │  POST /v1/embeddings          ──► Cascading chain
  │    local_embedding_models (llamacpp) → OpenRouter
  │    Fallback triggers: retryable status codes, timeout, 404 model-unavailable
  │
  │  POST /v1/audio/{transcriptions,speech}  ──► STT/TTS broker
  │    providers: OpenAI, Groq (STT), ElevenLabs (TTS), local brain-daemon
  │    auto-routed from model name if X-Audio-Provider header absent
  │
  │  /v1/realtime  ──► WebSocket proxy → OpenAI Realtime API
  │
  │  /atlas/*  ──► proxy → brain-daemon /atlas/*  (optional, see below)
  │  /quant/*  ──► proxy → brain-daemon /quant/*  (optional, see below)
  │
  │  /admin/*  ──► React dashboard (config, routing, users, logs, scheduler…)
  │  /         ──► Static frontend (frontend/dist/)
  └─────────────────────────────────────────────────────────┘
```

### Module breakdown

| Module | Role |
|---|---|
| `routing/router.py` | Core model resolution (8-step chain + cloud fallback), config loading, DB override merging |
| `routing/models_cache.py` | Background TTL cache of live models from all local backends |
| `app_queue/request_queue.py` | Priority heap queue, single serial worker for local inference, stream plumbing with client-disconnect cancellation |
| `providers/` | One adapter per backend: translates OpenAI-format body, streams SSE, normalises usage tracking |
| `core/routes_embeddings.py` | Cascading embedding broker (priority-ordered chain, configurable fallback triggers per status code or timeout) |
| `core/routes_audio.py` | STT/TTS broker across OpenAI / Groq / ElevenLabs / local, auto-routing from model name |
| `core/routes_chat_completions.py` | Queue entry point: cloud backends bypass the serial queue, local backends enqueue |
| `scheduler/` | Cron-based slot scheduler: activates/deactivates inference slots on schedule; heartbeat wired into `/healthz` |
| `auth/auth.py` | Bearer API key resolution → (user\_id, priority, threshold); constant-time comparison |
| `credits/credits.py` | Aggregates credit balances from OpenRouter / OpenAI / Anthropic billing APIs |
| `probe/` | Lightweight sidecar (separate process) to deploy on the inference host: exposes CPU/RAM/temperature + LM Studio log parsing + Ollama `/api/ps`, streams via SSE |
| `admin/` | REST routes consumed by the dashboard: model management, routing config, user CRUD, logs, benchmark proxy |
| `frontend/` | React 19 + Vite + Tailwind dashboard (Models, Routing, Cloud, Brain, Scheduler, Stats, Users, Logs, OpenBill pages) |

---

## Hard problems addressed

### 1. Multi-backend model resolution with live discovery
Clients send arbitrary model names. Mercury resolves each name through an 8-step chain
(explicit tag → forced override → TTL cache → static mapping → live backend cache →
regex rules → prefix → cloud fallback) without blocking the hot path. The live backend
cache is refreshed in the background on a configurable TTL; stale reads serve the last
known state rather than blocking or erroring.

### 2. Automatic cloud fallback on backend health
If the resolved local backend is unreachable at request time, Mercury switches to the
configured cloud fallback chain (`fallback_providers_order`) before the client times
out. The fallback order is configurable from the dashboard and persisted in the DB.
Cloud backends (OpenRouter, Anthropic) bypass the serial queue entirely to avoid
head-of-line blocking.

### 3. Serial queue for local GPU with priority and stream cancellation
Local inference backends (llamacpp, vLLM, Ollama) typically own a single GPU context.
Mercury serialises local requests through a priority heap queue with a single async
worker. If a streaming client disconnects mid-response, `cancel_request_if_current`
stops the worker immediately so the GPU is not wasted. Priority is per-user (configured
via `users[].priority`) with an optional grace-period threshold between priority bands.

### 4. Cascading embedding fallback with configurable triggers
`/v1/embeddings` builds a priority-ordered chain from `local_embedding_models`
(llamacpp backend) and an optional cloud entry (OpenRouter). Each candidate is tried in
order; a candidate is skipped on: retryable HTTP status codes (configurable set), client
timeout (configurable ms), or 404 model-unavailable (configurable flag). The client
receives the first successful response; the model field is rewritten to the name the
client originally sent.

### 5. API key masking in multi-backend routing
API keys for OpenRouter and Anthropic never leave Mercury. Clients authenticate with
user-scoped keys (or none); Mercury substitutes the appropriate upstream credential per
backend. The Anthropic backend reads OAuth credentials from `~/.claude/.credentials.json`
(same format as the Claude CLI) so no separate key distribution is needed in
Claude-authenticated environments.

### 6. Scheduler slot guard
A cron-based scheduler can activate exclusive inference slots (e.g. for scheduled batch
jobs). While a slot is active, requests from other users are rejected with 503.
`/healthz` monitors scheduler heartbeat: if the tick loop dies silently the health
endpoint returns 503, allowing an orchestrator to restart the process.

### 7. Client-disconnect 499 handling
Starlette's `BaseHTTPMiddleware` raises `RuntimeError("No response returned")` when the
client disconnects before a streaming response is produced. Mercury catches this
specifically in the HTTP middleware and returns 499 (client closed), preventing spurious
500 errors and unhandled asyncio warnings in the logs.

---

## Optional routes (external dependencies)

### `/atlas/*` — AtlasMind integration
Proxy to `brain-daemon /atlas/*` for control-vector extraction and hot-swap loading.
Disabled by default (`atlas_enabled: false`). When disabled, all `/atlas/*` routes
return **501** with an explicit message. Requires a running AtlasMind instance (separate
application, not included in this repository) and a brain-daemon reachable at
`atlas_brain_url`.

### `/quant/*` — Quantisation pipeline
Proxy to `brain-daemon /quant/*` for llama.cpp quantisation jobs (imatrix, surgical
quant profiles, GGUF validation, job streaming). Enabled in the example config
(`quant_enabled: true`) but brain-daemon on `localhost:4321` must be running. Without
it, all `/quant/*` routes return **501**. Set `quant_enabled: false` to suppress.

---

## Running standalone

### Requirements

- Python 3.10+
- At least one inference backend running locally, **or** OpenRouter / Anthropic credentials for cloud-only mode

### Quick start

```bash
# 1. Copy and edit the example config
cp "config.yaml copy.example" config.yaml
# Edit config.yaml: set backend URLs, enable/disable providers as needed

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Start Mercury
python main.py
```

Mercury starts on `0.0.0.0:17890` by default (change `server_host` / `server_port` in
`config.yaml`).

```
GET  http://localhost:17890/healthz           # liveness + scheduler heartbeat
GET  http://localhost:17890/api/tags          # list available models (Ollama-compat)
POST http://localhost:17890/v1/chat/completions   # OpenAI-compat chat
POST http://localhost:17890/v1/embeddings         # embedding with cascade fallback
```

### Frontend (optional)

```bash
cd frontend
npm ci
npm run build
# Rebuilt dist/ is served automatically by Mercury on /
```

### What works without any inference backend

Mercury starts and responds to all routes. Without a configured backend:

- `/v1/chat/completions` returns 503 with a message listing what to configure.
- `/v1/embeddings` returns 503 (chain is empty).
- `/atlas/*` returns 501 (`atlas_enabled` absent = false by default).
- `/quant/*` returns 501 if `quant_enabled: false`, or 502 if enabled but brain-daemon
  is unreachable.
- `/healthz` returns 200 (the scheduler loop is alive regardless of backends).

### Probe sidecar (optional)

The `probe/` directory contains a separate lightweight service to deploy on the machine
running LM Studio or Ollama. It exposes system stats (CPU, RAM, temperature) and LM
Studio log parsing over HTTP/SSE. See [`probe/README.md`](probe/README.md) for
installation.

---

## Configuration reference

The annotated example is in [`config.yaml copy.example`](config.yaml%20copy.example).
Key sections:

| Key | Default | Description |
|---|---|---|
| `server_port` | `17890` | Listening port |
| `backend_timeout` | `300` | Upstream request timeout (seconds) |
| `ollama_url` / `mlx_url` / `lm_studio_url` | `localhost:*` | Backend URLs |
| `llamacpp_url` | `http://localhost:4321` | brain-daemon URL (llama.cpp + vLLM + quant) |
| `model_mapping` | `{}` | Static name → backend mappings (highest priority after explicit tags) |
| `model_routes` | see example | Regex routing rules |
| `openrouter_enabled` / `openrouter_api_key` | `false` / `""` | Cloud fallback via OpenRouter |
| `anthropic_enabled` / `anthropic_fallback_model` | `false` / `""` | Cloud fallback via Anthropic OAuth |
| `fallback_providers_order` | `["openrouter","anthropic"]` | Cloud fallback chain order |
| `local_embedding_models` | `[]` | Embedding chain entries (llamacpp backend) |
| `atlas_enabled` | `false` | Enable `/atlas/*` proxy (requires AtlasMind) |
| `quant_enabled` | `true` | Enable `/quant/*` proxy (requires brain-daemon) |
| `require_api_key` | `false` | Enforce Bearer token on inference routes |
| `admin_token` | `""` | Token for `/admin/*` routes |

Runtime config (routing rules, users, backend toggles) is editable from the dashboard
and persisted in `data/db.json`; values there override `config.yaml` on the next
request without a restart.

---

## Version

Current: **2.4.1** (see `VERSION`)
