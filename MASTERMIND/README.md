# Mastermind

Multi-agent LLM orchestration backend with a React control panel. Each agent maintains persistent sessions, long-term vector memory, and a configurable tool set. Agents run on any OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, OpenRouter …), can spawn cloud sub-agents asynchronously, receive and route proactive notifications across Telegram, APNs (iOS), and WebSocket, and compact their own context automatically when approaching the token limit.

The architecture is notable because every design decision flows from one constraint: KV-cache prefix stability on a locally-running LLM. Getting that right requires careful control of prompt construction, message reconstruction, tool-output truncation, `<think>` block handling, and orphaned-tool-call cleanup — all of which show up as non-trivial code.

---

## Repository layout

```
MASTERMIND/
├── packages/
│   ├── backend/          TypeScript, Hono + node:http/ws
│   │   └── src/
│   │       ├── modules/  Domain modules (see below)
│   │       ├── routes/   REST API handlers
│   │       └── ws.ts     WebSocket broadcast layer
│   ├── frontend/         React + Vite + Tailwind
│   └── shared/           Zod schemas, types, shared constants
├── migrations/           18 sequential PostgreSQL migrations
├── config/
│   └── mastermind.example.yml
└── packages/codebase-search/   LanceDB semantic search package
```

---

## Backend modules

### `modules/agent`

The core run loop (`run.ts`, 2 800 lines). For each user message:

1. Kick off a pgvector similarity search on the memory store in parallel with system-prompt construction (hides ~2–4 s embedding latency).
2. Build the system prompt (TTL-cached per session; refreshed when starred files change).
3. Load message history from PostgreSQL; run `autoCompactIfNeeded` if the estimated token count exceeds the configured threshold (default 90 %).
4. Inject memory context and a board block into the current user turn prefix; persist both as `injectedPrefix` in the message metadata so future rebuilds produce byte-identical tokens at the same position (KV-cache prefix hit).
5. Strip `<think>` blocks from past assistant turns on the `stripThink` path; otherwise keep them to maximise prefix reuse. Persist `rawAssistantStream` on assistant rows so the rebuild uses the exact bytes the LLM slot generated, not the UI-merged blob.
6. Call the provider with `streamRich`; fan tool-call results back into the loop for up to `maxToolTurns` iterations.
7. On completion, run delivery resolution and push the result to the appropriate channels.

**Sub-agents** (`tools/spawn_subagent.ts`): a principal agent calls `spawn_subagent(preset, prompt)`. The call enqueues an `async_job` row and returns immediately. `AsyncJobsModule` picks it up in its worker tick and runs the sub-agent against the same provider. The final report is re-injected into the parent session via the proactive delivery path. Anti-recursion guard (sub-agents cannot spawn), per-run cap, and a 24 h rolling daily cap are enforced.

**KV-cache prefix engineering** (several non-obvious details):

- `toAiMessage` uses `metadata.rawAssistantStream` on assistant rows to avoid the display-blob divergence.
- Tool results are hard-capped at 12 000 characters at both push time and DB-rebuild time; divergence between the two would break prefix parity on every tool whose output exceeded the cap.
- `stripOrphanedToolCalls` has a strict/permissive dual mode: the reverse pass (drop orphaned `role:'tool'` rows) is only applied when the target provider is positively known to enforce the strict tool contract; running it unconditionally on a local llama.cpp session that had content-only assistant rows deletes rows that are already in the KV slot and forces a full reprocess.
- Vision-fallback turns (image-to-text description prepended to the user content) persist `visionFallbackPrefix` in metadata so `toAiMessage` can reconstruct the exact byte sequence seen by the model.
- `buildLlmPayload` validates that either `contentInHistory` or `warmup` is true; neither = a programming error surfaced immediately rather than silently producing a payload with no user message.

**Auto-warmup** (`autoWarmup.ts`): a global queue fires after a configurable idle period and sends a synthetic `[WARMUP]` user message with `max_completion_tokens=1`. The resulting payload is byte-identical to a real run (same memory injection, same prefix), so the LLM's KV slot is pre-loaded. File watchers on starred memory files trigger a re-warm when content changes.

**Auto-compact** (`compactSummary.ts`): when context usage crosses the threshold, the oldest conversation turns are summarised into a structured 7-section block (objective / constraints / progress / decisions / files / next steps / critical context) and replaced by a single compact row in the DB. The compact content is prefixed with an explicit reference-block warning to prevent weak models from re-executing old actions listed under "next steps".

**Lazy skills** (`lazySkills` flag): instead of emitting full JSON schema stubs for every skill in the tool list (expensive at 100 + skills), the agent receives minimal single-line stubs or, in `wildcard` mode, no individual tool definitions at all — just a `call_skill_action` dispatcher that inspects the skill schema on demand. Saves 3–4 k tokens per turn.

### `modules/provider`

Two adapters: `openai-compat` (generic) and `mercury` (local proxy). Both implement `streamRich`, which does a single streaming request and accumulates text chunks and tool-call deltas in one pass.

Notable provider-layer work:

- **Reasoning delta normalisation**: `delta.reasoning_content` (llama.cpp), `delta.reasoning` (Mercury), `delta.thinking` (Ollama) are all wrapped into `<think>...</think>` tags before forwarding to the frontend and persisting to the DB. This lets the UI and the compact path treat reasoning uniformly regardless of backend.
- **Unclosed `<think>` balancing**: the stream can be cut off by a `tool_calls` finish before the matching `</think>`. Both cases (native reasoning field left open, literal tag in `delta.content`) are detected and closed at end-of-stream so `stripThinkBlocks` and `extractThinkContents` never receive malformed input.
- **Text tool-call fallback**: models that emit tool calls as `<tool_call>…</tool_call>` XML in the text delta (Hermes-style, not native structured tool-calls) are parsed by `parseTextToolCalls`. The regex matches tool names containing hyphens (`[\w.-]+`) — a bug that tripped on hyphenated skill names.
- **Synthetic tool-call id**: some llama.cpp/vLLM builds omit `id` on tool-call deltas. A stable synthesised id (`tc-stream-{index}`) is added; an empty string id breaks the orphan-cleanup contract and causes 400 errors on strict providers.
- **Streaming dispatcher scoped to streaming calls**: `undici.Agent` with `headersTimeout:0, bodyTimeout:0` is attached only to `streamRich`/`stream`, not set as the global dispatcher. Setting it globally would disable body timeouts on every `fetch`, including non-streaming sub-agent calls that have no abort signal — leaving them susceptible to hanging on a half-closed Mercury socket.
- **Mid-stream structured errors**: Mercury and llama.cpp can forward upstream errors as an SSE chunk with an `error` field and an empty `choices` array. These are captured after the loop and thrown as `Error` objects so `run.ts` crash-recovery triggers rather than silently returning a truncated partial as a successful turn.

### `modules/delivery`

Delivery is resolved through a single pure function `resolveDelivery` (`resolve.ts`) before any I/O.

Policy is per-agent, per-channel, per-trigger type (`interactive | proactive | task | sandbox`). A v3 policy looks like:

```yaml
delivery:
  mobile:
    triggers: [proactive, task]
    presenceDedup: true
  telegram:
    mode: fallback     # only if mobile push didn't reach anyone
    triggers: [task]
  liveActivity: user
  proactiveAlerts: quiet
```

`normalizeDeliveryPolicy` converts legacy flat configs (`wake: [mobile, telegram]`) to v3 at read time, never in storage. The normaliser is idempotent and correctly handles the `{}` edge case (empty policy must be indistinguishable from no policy so the legacy mobile default remains active).

Resolution hierarchy (most → least authoritative):
1. Per-task channel override set in the UI — bypasses policy and LLM channel choice entirely.
2. Explicit LLM `channel` argument — filtered by `telegram.mode`.
3. Per-agent policy for the current trigger.
4. Legacy default (mobile on all triggers if no policy is set).

A safety net prevents an explicit non-empty LLM channel choice from collapsing to zero wake channels due to `telegram.mode=off/fallback` on background triggers (it falls back to the policy auto-wake). The safety net is intentionally disabled for `interactive` triggers — the user is already present and an unexpected push during a live conversation would be wrong.

### `modules/memory-store`

PostgreSQL + `pgvector`. Each memory entry has scope (`agent` / `shared`), domain, tags, access count, consolidation score, and soft-delete (archived flag). The HNSW index is built on the embedding column.

Auto-injection: at the start of each run, the current user message is embedded and the top-K memories (above a configurable cosine similarity threshold) are injected as a prefix block. The search is kicked off in parallel with system-prompt construction.

### `modules/memory-consolidation`

Four-step scheduled pipeline (weekly or daily, configurable):

1. **Score**: update every memory's relevance score using recency, frequency, and age decay weights.
2. **Cluster**: find groups of semantically similar memories using pgvector cosine similarity (configurable merge threshold).
3. **Merge**: call the LLM to synthesise each cluster into a single canonical memory; update merge provenance fields.
4. **Archive**: soft-delete memories whose score falls below the archival threshold and whose age exceeds the minimum age guard.

Concurrency: a partial unique index on `(COALESCE(agent_id,'__shared__')) WHERE status='running'` makes the at-most-one-running-per-agent invariant atomic. The startup migration deduplicates zombie `running` rows so the index can be created on an existing DB without failing on existing data.

### `modules/scheduler`

Cron-based proactive pipeline. Each scheduled task has a `watcher` agent (runs on schedule, assesses the situation) and an optional `escalation` agent (called by `escalate_to_agent` when the watcher decides action is needed). Both stages inherit `autoDeliver` and `deliveryChannels` from the task row so the user's channel configuration is respected end-to-end without the LLM needing to know about it.

Tick interval is 30 s; tasks fire at the next tick after their cron fires.

### `modules/telegram`

Bot bridge built on [grammy](https://grammy.dev/). Live streaming to Telegram is implemented via two primitives in `stream/`:

- `draftStream`: edit-in-place on a single message (smooth but subject to Telegram rate limits on long responses).
- `nativeDraftStream`: accumulate a paragraph and send it as a new message (avoids edit rate limits; results in a "chat bubble" pattern).

The `thinkAnswerFSM` routes incoming chunks into either the live reasoning display or the answer accumulator, handling `<think>` tag boundaries that fall across SSE chunk boundaries.

### `modules/push`

Zero-dependency APNs client using `node:http2` and `node:crypto`. Auth via provider token (JWT ES256 signed with an `.p8` AuthKey); the token is refreshed every 50 minutes. Sandbox vs production endpoint is config-driven (dev builds require `api.sandbox.push.apple.com`; App Store builds require production).

### `modules/skill-actions`

YAML-defined skills exposed as agent tools. Each skill is a shell command executed by the backend. Skills support synchronous and async execution (async jobs deliver results via the proactive pipeline). Output files can be collected post-execution by glob pattern and delivered as attachments. Lazy loading and wildcard dispatch reduce token overhead for large skill fleets.

---

## Data model (key tables)

| Table | Purpose |
|---|---|
| `sessions` | Per-agent conversation sessions |
| `messages` | Message history with JSONB metadata (injectedPrefix, rawAssistantStream, …) |
| `agent_memories` | pgvector memory store with score, access tracking, and merge provenance |
| `scheduled_tasks` | Cron jobs with watcher/handler/escalation agent bindings |
| `async_jobs` | Queue for sub-agent runs and async skill executions |
| `push_devices` | APNs device tokens per agent |
| `delivery_channels` | Per-session delivery overrides |
| `memory_consolidation_runs` | Audit log for consolidation pipeline runs |

---

## Run (standalone)

**Prerequisites**

- Node.js 20+
- PostgreSQL 15+ with the `vector` extension (`CREATE EXTENSION IF NOT EXISTS vector`)
- An OpenAI-compatible LLM endpoint (Ollama, llama.cpp server, LM Studio, vLLM …)

**Steps**

```bash
# 1. Install dependencies
npm ci

# 2. Copy and fill in the example config
cp config/mastermind.example.yml config/mastermind.yml
# Edit config/mastermind.yml:
#   - server.apiKey         → generate with: openssl rand -base64 32
#   - database.password     → your PostgreSQL password
#   - providers[0].baseUrl  → your LLM endpoint (default: http://localhost:11434/v1)
#   - providers[0].apiKey   → API key, or remove the field if not required
#   - defaults.model        → model string recognised by your endpoint

# 3. Create the PostgreSQL user and database
psql -U postgres -c "CREATE USER mastermind WITH PASSWORD 'changeme';"
psql -U postgres -c "CREATE DATABASE mastermind OWNER mastermind;"
psql -U postgres mastermind -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 4. Run migrations in order
for f in migrations/*.sql; do psql -U mastermind mastermind < "$f"; done

# 5. Build and start
npm run build
npm start
# Backend listens on http://0.0.0.0:3000 (configurable via server.port)
# Frontend (if building the full package): served at the same port under /
```

The two example agents (`assistant`, `researcher`) are available immediately with no skills pre-configured. Tool use (bash, file read/write) is disabled by default (`systemAccess: false`); set it to `true` in the agent config and provide an `agentsDir` path to enable it.

**Optional integrations**

- **Telegram**: uncomment the `telegram` block and add a bot token + chat ID per agent.
- **Web search**: uncomment `search.braveApiKey`.
- **APNs push**: configure `push.apns` with your `.p8` key, key ID, team ID, and bundle ID.
- **Semantic memory**: the `memoryStore` block is enabled in the example config; it requires pgvector and an embedding endpoint. The default embedding dimensions (1536) match `text-embedding-3-small`; adjust to your model.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM) |
| HTTP server | [Hono](https://hono.dev/) + `@hono/node-server` |
| WebSocket | `ws` |
| Database | PostgreSQL + `pgvector` (via `pg`) |
| HTTP client (streaming) | `undici` (scoped dispatcher, no global override) |
| Telegram | [grammy](https://grammy.dev/) |
| Config / validation | YAML + [Zod](https://zod.dev/) |
| Frontend | React + Vite + Tailwind |
| Build | TypeScript project references (`tsc -b`) |
