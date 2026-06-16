# NEXUS — Self-Hosted LLM Infrastructure Stack

Three components that form a complete, production-grade local LLM stack: a
custom inference daemon optimised for AMD Strix Halo hardware, an
OpenAI-compatible broker/proxy, and a multi-agent orchestration platform.
Each layer is independently deployable. Together they cover the full path from
raw model weights to user-facing agents with delivery, memory, and scheduling.

License: **AGPL-3.0**

---

## Why this exists

Running LLMs locally at quality parity with cloud services requires solving
problems that off-the-shelf wrappers don't address: unified memory (UMA) where
VRAM and RAM are the same pool and overflow is silent; thermal coupling where
sustained GPU load on the same die as the CPU causes VRM instability; KV-cache
prefix stability as a first-class constraint on the orchestration layer; and
multi-backend routing with graceful local-to-cloud fallback when the local GPU
is saturated.

This stack was built to address those specific problems on specific hardware.
The engineering decisions documented below are all traceable to a concrete
failure mode encountered during development.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Client layer                          │
│   Web UI · iOS app · Telegram bot · REST / SSE consumers    │
└─────────────────────────────────┬───────────────────────────┘
                                  │  OpenAI-compat API / WebSocket
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    MASTERMIND  (v1.28.7)                    │
│  Multi-agent orchestration — TypeScript / Node.js           │
│                                                             │
│  ┌───────────────┐  ┌────────────┐  ┌────────────────────┐  │
│  │ Agent runtime │  │ Scheduler  │  │  Delivery engine   │  │
│  │ sessions ·    │  │ cron tasks │  │  push/TG/chat      │  │
│  │ sub-agents ·  │  │ watcher +  │  │  policy × trigger  │  │
│  │ lazy skills   │  │ escalation │  └────────────────────┘  │
│  └───────────────┘  └────────────┘                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Memory: pgvector · consolidation · starred-file      │   │
│  │ injection · excludeSharedMemory per-agent flag       │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Codebase search: LanceDB · tree-sitter · hybrid      │   │
│  │ (0.55 vector / 0.30 lexical / 0.15 structural)       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────┘
                                  │  HTTP (OpenAI-compat) + routing
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    MERCURY  (v2.4.1)                        │
│  LLM broker / proxy — Python / FastAPI                      │
│                                                             │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────┐   │
│  │  Priority   │  │  Model router    │  │ Cloud fallback│   │
│  │  queue      │  │  8-step chain    │  │ chain         │   │
│  │  (heapq)    │  │  regex rules     │  │ OR → ANT → …  │   │
│  └─────────────┘  └──────────────────┘  └───────────────┘   │
│                                                             │
│  Providers: llama.cpp · Ollama · MLX · LM Studio · vLLM     │
│             OpenRouter · OpenAI · Anthropic                 │
│                                                             │
│  /v1/embeddings  cascade  local (llamacpp) → cloud          │
│  /v1/audio/*     STT/TTS routing (Groq · ElevenLabs · OAI)  │
│  /quant/* /atlas/* proxy → brain-daemon (opt-in)            │
└─────────────────────────────────┬───────────────────────────┘
                                  │  HTTP mgmt + /v1/* (OpenAI-compat)
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│               BRAIN-DAEMON  (v1.8.6)                        │
│  Inference management daemon — Python / FastAPI             │
│  Target: AMD Ryzen AI Max+ 395 · 128 GB UMA · RDNA 3.5      │
│                                                             │
│  ┌──────────────────┐  ┌────────────┐  ┌────────────────┐   │
│  │  ModelManager    │  │  Thermal   │  │  Memory        │   │
│  │  multi-backend   │  │  governor  │  │  controller    │   │
│  │  lazy-load       │  │  EMA + slew│  │  UMA pre-load  │   │
│  │  KV persistence  │  │  rate cap  │  │  check + evict │   │
│  └──────────────────┘  └────────────┘  └────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  brain-quant: imatrix calibration → surgical         │   │
│  │  per-tensor quantisation (F16/Q8_0/QnK mix)          │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  atlas: control-vector extraction (diff-of-means)    │   │
│  │  process-isolated C++ binary → .gguf output          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

Data flows bottom-up. BRAIN-DAEMON exposes `/v1/*` locally; MERCURY routes
requests to it (or to cloud backends); MASTERMIND agents call MERCURY for all
model I/O. Each layer can be replaced or bypassed independently — Mercury can
point at any llama.cpp server, and Mastermind can point at any
OpenAI-compatible endpoint.

---

## Engineering story by layer

### BRAIN-DAEMON

The daemon exists because `llama-server` run in isolation is not enough on
AMD Strix Halo. Two systemic problems required first-class solutions:

**Thermal coupling.** The Tctl sensor oscillates ±2 °C between cores. A naive
governor reacting to raw samples produces CPU frequency swings on noise, not
heat, and the slew from 5.2 GHz to 625 MHz in a single tick is enough to
destabilise the VRM rails shared with the GPU — causing Vulkan `device lost`.
The thermal controller uses EMA smoothing (α=0.4) on the input signal and a
500 MHz/tick slew-rate cap on writes to `scaling_max_freq`. Emergency SIGSTOP
fires at 98 °C sustained for 2 s; SIGCONT + 40 s ramp-up follows when the die
cools below 55 °C. "GPU high" performance level is never used — it bypasses
power limits and causes thermal runaway on this TDP-constrained APU.

**Unified memory accounting.** On UMA hardware, VRAM and RAM are the same
physical pool; weights spill from the GPU range into the CPU range invisibly.
The memory controller measures per-model footprint as the RSS delta before and
after loading (more accurate than any static estimate) and runs a feasibility
check before every `llama-server` spawn: if `weights + kv_cache + headroom`
exceeds the available pool, it evicts by highest observed footprint rather than
by static estimates.

Other notable decisions:

- **Multi-Speculative Decoding (MTP)** via the `atomic-llama-cpp-turboquant`
  fork. Upstream llama.cpp had blocking bugs in the MTP code path for
  Vulkan/SWA models (SWA mask buffer null, Vulkan-specific reshape mismatch).
  The fork patches these and delivers ×2.3 on Gemma 4 and ×2 on Qwen3 MoE.
- **Surgical quantisation** (`quantize/`): instead of applying a uniform
  quantisation level, the pipeline assigns precision per tensor family based on
  activation statistics from `llama-imatrix` on a calibration corpus. MoE
  router tensors (`ffn_gate_inp.*`) and embeddings are pinned to F16 (0.1% of
  weights, but critical for routing decisions and vocabulary distribution);
  attention (k/q/v/o) at Q8_0; bulk FFN at the target budget. Alternative
  path: `source=cartography` derives tensor importance from L2-norms in the
  GGUF file directly when no calibration corpus is available. Quality eval runs
  automated scoring across categories after each variant.
- **GGUF header parse cache**: parsing a sharded 200+ GB model header in Python
  takes 7–8 s. The surgical quant TUI re-fires on slider moves for live
  preview. A mtime-keyed in-process cache with FIFO eviction at 8 entries keeps
  preview latency under 100 ms after the first parse.
- **Atlas module**: control vectors (diff-of-means over positive/negative prompt
  pairs) are extracted via a subprocess-wrapped C++ binary. Process isolation
  means a segfault or OOM in the extractor does not kill the daemon. Outputs
  are standard llama.cpp `.gguf` control vectors.
- **Qwen 3.5 MoE template patches** (`templates/`): three Jinja2 variants
  address a model-specific bug where the full response is emitted inside the
  `<think>` block. Patches include empty-think priming and an "answer-in-think
  recovery" guard that promotes think→content when the response field is empty.
- **vLLM subprocess tree cleanup**: `vllm serve` spawns a separate engine
  subprocess not visible in the main process cmdline. The unload cascade
  explicitly targets `vllm.entrypoints` and `vllm.engine` stragglers after
  SIGTERMing the main PID's children.

---

### MERCURY

Mercury solves the single-ingress problem: one API surface for an operator who
runs llama.cpp locally, Ollama for some models, and needs cloud fallback.

**Model resolution is an 8-step chain**: explicit backend tag → forced override
→ TTL in-memory cache (500 entries, 5 min TTL) → static DB mapping → live
backend cache (polled from all running backends) → regex routing rules → prefix
fallback → cloud fallback. The live cache refreshes in the background; stale
reads serve the last known state rather than blocking or erroring. Any step can
short-circuit the chain.

**Serial queue for local GPU**: local backends share a single GPU context.
Mercury serialises local requests through a priority heap queue with one async
worker. Per-user priority is config-driven. If a streaming client disconnects
mid-response, `cancel_request_if_current` stops the worker immediately so the
GPU is not wasted on a cancelled stream.

**Stream plumbing details**: Starlette's `BaseHTTPMiddleware` raises
`RuntimeError("No response returned")` on client disconnect before a streaming
response starts. Mercury intercepts this specifically and returns 499 (client
closed) rather than 500, preventing spurious error spikes in logs.

**Embedding cascade**: `/v1/embeddings` builds a priority-ordered candidate
chain from local (llamacpp) and cloud (OpenRouter). Fallback triggers are
configurable: retryable HTTP status codes, per-request timeout, or 404
model-unavailable. The `model` field in the response is rewritten to the name
the client originally sent regardless of which backend served it.

**Cloud backends bypass the queue**: OpenRouter and Anthropic requests skip the
serial local-inference queue entirely to avoid head-of-line blocking while a
large local generation is in flight.

**Key isolation**: upstream API keys (OpenRouter, Anthropic) never leave
Mercury. The Anthropic backend reads OAuth credentials from
`~/.claude/.credentials.json` (same format as the Claude CLI), so no separate
key distribution is needed in Claude-authenticated environments.

**Scheduler slot guard**: a cron scheduler can activate exclusive inference
slots for batch jobs. The `/healthz` endpoint monitors the scheduler heartbeat
— if the tick loop dies silently it returns 503, enabling orchestrators to
detect and restart the process.

---

### MASTERMIND

Mastermind is built around one hard constraint: **KV-cache prefix stability on
a locally-running LLM**. Prefix reuse is what keeps per-turn latency acceptable
when the system prompt is large. Every non-obvious design decision in the agent
runtime traces back to that constraint.

**Prefix engineering**:
- `toAiMessage` uses `metadata.rawAssistantStream` (the exact bytes the model
  saw) rather than the UI-merged display blob. These can diverge on streaming
  reassembly; using the wrong one breaks prefix parity on every assistant turn.
- Tool results are hard-capped at 12,000 characters at both push time and
  DB-rebuild time. A divergence between the two would break prefix parity on
  any tool whose output exceeded the cap.
- `stripOrphanedToolCalls` runs in a dual strict/permissive mode. The reverse
  pass that drops orphaned `role:'tool'` rows is only applied when the target
  provider enforces the strict tool contract; applying it to a local llama.cpp
  session that had content-only assistant rows deletes rows already in the KV
  slot and forces a full reprocess.
- Vision fallback turns (image-to-text description prepended to user content)
  persist `visionFallbackPrefix` in metadata so `toAiMessage` can reconstruct
  the exact byte sequence the model processed.
- Unified session mode (`{agent}-unified`) shares one KV slot across web,
  mobile, and Telegram. The template layer strips intermediate `<think>` blocks
  positionally — keeping only the last turn's reasoning — to minimise prefix
  invalidations when clients switch.

**Auto-warmup**: after a configurable idle period, a synthetic `[WARMUP]` user
message with `max_completion_tokens=1` pre-loads the KV slot with the exact
payload that a real run would use. File watchers on starred memory files trigger
a re-warm when content changes. Without this, the first real request after idle
pays the full recompute cost.

**Auto-compact**: when context usage crosses the threshold (default 90%), the
oldest conversation turns are summarised into a structured 7-section block and
replaced by a single compact row. The compact content is prefixed with an
explicit reference-block warning to prevent models from re-executing old actions
listed under "next steps".

**Reasoning delta normalisation**: `delta.reasoning_content` (llama.cpp),
`delta.reasoning` (Mercury), `delta.thinking` (Ollama) are all normalised to
`<think>...</think>` tags before persisting. This lets the compact path and the
frontend treat reasoning output uniformly regardless of backend.

**Lazy skills** (`lazySkills` flag): with 100+ available skills, emitting full
JSON schemas in every tool list is expensive (3–4 k tokens per turn). In
wildcard mode, the agent receives a single `call_skill_action` dispatcher with
no individual schemas. It calls `inspect_skill` to fetch the schema on first
use. This eliminates hallucinated parameters (the model cannot guess at a schema
it has not seen) and saves tokens.

**Delivery engine** (`modules/delivery`): a single pure `resolveDelivery`
function decides per-message output channel before any I/O. Policy is
per-agent, per-channel, per-trigger type (`interactive | proactive | task |
sandbox`). The v3 policy format supports `telegram.mode: fallback` (only send
to Telegram if the APNs push didn't reach anyone) and `presenceDedup` (suppress
push when the iOS app is foregrounded). A safety net prevents an explicit LLM
channel choice from collapsing to zero delivery on background triggers.

**Sub-agents**: a principal agent calls `spawn_subagent(preset, prompt)`. The
call enqueues an `async_job` row and returns immediately. `AsyncJobsModule`
runs the sub-agent against the same provider in a separate worker tick and
re-injects the result into the parent session via the proactive path. Anti-
recursion guard, per-run cap, and a 24 h rolling daily cap are enforced.

**Codebase search**: hybrid semantic + lexical + structural search over indexed
codebases. Tree-sitter parsing for chunk boundary detection, LanceDB for vector
storage, embeddings via Mercury. Score weights: 0.55 vector, 0.30 lexical, 0.15
structural. Used as a Mastermind skill so agents can navigate large codebases
without having everything in context.

---

## Versions

| Component    | Version | Language     |
|---|---|---|
| BRAIN-DAEMON | 1.8.6   | Python / FastAPI |
| MERCURY      | 2.4.1   | Python / FastAPI |
| MASTERMIND   | 1.28.7  | TypeScript / Node.js |

---

## Requirements

**BRAIN-DAEMON**: Python 3.10+, llama.cpp (Vulkan or ROCm build). AMD GPU with
Vulkan support. The `atomic-llama-cpp-turboquant` fork is required for MTP/spec
decoding. `ryzenadj` + `ryzen_smu` kernel module for power limit control.
Root or sysfs write access for thermal and CPU frequency management.

**MERCURY**: Python 3.10+. Optional: Node 18+ and npm to rebuild the React
dashboard frontend.

**MASTERMIND**: Node.js 20+, npm. PostgreSQL 15+ with the `pgvector` extension
for the memory store. An OpenAI-compatible embedding endpoint. LanceDB for
codebase search (native module; pre-built binaries for Linux/macOS x64/arm64).

Each component has its own `README.md` with full configuration reference,
quickstart steps, and module-level detail.

---

## License

AGPL-3.0. See `LICENSE` in each component directory.

This software is designed for self-hosted, single-operator use. It is not
hardened for multi-tenant public deployment.
