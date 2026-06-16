import type { ToolDefinition, ToolCall, AgentConfig, DeliveryTrigger, MastermindConfig, MessageSource, ChatMessage, WsServerMessage } from '@mastermind/shared';
import { execBash } from './bash.js';
import { readFile, writeFile, listDir, editFile } from './files.js';
import { sharedRead, sharedWrite, sharedList, sharedEdit, sharedSearch } from './shared.js';
import { memoryWrite } from './memory.js';
import { webFetch } from './web.js';
import { braveSearch } from './search.js';
import { executeCodebaseSearchTool } from './codebaseSearchTool.js';
import {
  executeCodebaseSearchReadFile,
  executeCodebaseSearchListDir,
} from './codebaseSearchFileTool.js';
import { callReasoningModel, type ReasoningConfig } from './reasoning.js';
import { executeInspectImage } from './vision.js';
import type { VisionDescribeConfig } from '../visionFallback.js';
import { executeMemorySearchTool } from './memorySearchTool.js';
import { executeSessionSearchTool } from './sessionSearchTool.js';
import { executeEscalateToAgent } from './escalate.js';
import { executeSendToUser } from './send.js';
import { deliverToTelegram, runKindTrigger } from '../../delivery/index.js';
import { executeSpawnSubagent } from './spawn_subagent.js';
import type { MemoryStoreModule } from '../../memory-store/index.js';
import type { SchedulerModule } from '../../scheduler/index.js';
import type { BoardModule } from '../../board/index.js';
import type { SessionModule } from '../../session/index.js';
import type { TelegramModule } from '../../telegram/index.js';
import type { PushModule } from '../../push/index.js';
import type { SkillActionsModule } from '../../skill-actions/index.js';
import type { AsyncJobsModule } from '../../async-jobs/index.js';
import type { WsManager } from '../../../ws.js';
import type { Pool } from 'pg';
import { executeSubmitSubagentReport, type SubAgentDeliveryContext, type SubAgentDeliveryState } from './submit_subagent_report.js';
import { formatAgentRosterLine } from '../workspace.js';

export type { SubAgentDeliveryContext, SubAgentDeliveryState };

export interface ToolExecOptions {
  bashTimeoutMs?: number;
  webFetchMaxChars?: number;
  /** Brave Search API key — enables web_search tool */
  braveApiKey?: string;
  /** Allow file/bash tools to operate outside workspace (system-wide access) */
  systemAccess?: boolean;
  /**
   * Absolute paths under these roots are allowed for read_file / write_file / list_dir
   * without systemAccess (typically Environment paths: workspace, shared memory, agents dir, compact, skills).
   */
  allowedPathRoots?: string[];
  /**
   * Absolute path to the shared memory directory for the current run. Used as the base
   * for `shared_read` / `shared_write` / `shared_list` / `shared_edit`. Distinct from
   * `allowedPathRoots` (which is a flat allowlist) because the shared tools need to know
   * which specific root to resolve their relative paths against.
   */
  sharedMemoryDir?: string;
  /** Recherche sémantique dans l'index LanceDB (mastermind codebaseSearch) */
  codebaseSearch?: {
    mastermindConfig: MastermindConfig;
    resolvePath: (p: string) => string;
    agentId: string;
  };
  /** MemoryStore vectoriel (PostgreSQL + pgvector) */
  memoryStore?: {
    module: MemoryStoreModule;
    agentId: string;
    /** AgentConfig.excludeSharedMemory — clampe memory_search au scope `agent` quand true. */
    excludeShared?: boolean;
  };
  /** Déduplication mémoire opt-in (config.memoryStore.enableDeduplication) */
  enableDeduplication?: boolean;
  /** Seuil de similarité pour la dédup (0-1, défaut 0.92) */
  deduplicationThreshold?: number;
  /** Bypass le filtre de significance (garde uniquement les skip patterns) */
  bypassSignificanceFilter?: boolean;
  /** Raisonnement étendu via Mercury /admin/reasoning/ask */
  reasoningConfig?: ReasoningConfig;
  /** Vision à la demande via Mercury /admin/vision/describe — enables the `inspect_image` tool. */
  visionConfig?: VisionDescribeConfig;
  /** Skill actions executor — handles skill_* tool calls. Receives an optional ctx so async skills can attach their job to the calling agent/session. */
  skillActionsExecutor?: (toolName: string, args: Record<string, unknown>, ctx?: { agentId: string; sessionId: string }) => Promise<string>;
  /** Full skill-actions module reference — needed by the exec gate to resolve skill_* → skillDir */
  skillActionsMod?: SkillActionsModule;
  /** Calling agent's full config — used by the per-agent exec gate (disabled tools / non-starred skills). */
  agentConfig?: AgentConfig;
  /** Scheduler module — enables schedule_task tool */
  schedulerModule?: SchedulerModule;
  /** Current agent ID — used as default for schedule_task */
  currentAgentId?: string;
  /** All known agents — used by list_proactive_watchers and create_proactive_task validation */
  agentsList?: AgentConfig[];
  /** Board module — enables board_write / board_delete tools */
  boardModule?: BoardModule;
  // ── Proactive module plumbing ──
  /** Set when the current run is proactive (watcher or handler-escalation). */
  proactiveRunId?: string;
  /** For send_to_user dispatch (handler side). */
  sessionModule?: SessionModule;
  telegramModule?: TelegramModule;
  /** Push module (canal mobile APNs) for send_to_user dispatch. */
  pushModule?: PushModule;
  ws?: WsManager;
  mastermindConfig?: MastermindConfig;
  /** Resolve path relative to mastermind.yml directory (ConfigModule.resolvePath). */
  resolveConfigPath?: (p: string) => string;
  /** Handler agent config needed by send_to_user to resolve telegram chatIds. */
  handlerAgentConfig?: AgentConfig;
  /** Current session id for send_to_user chat delivery. */
  currentSessionId?: string;
  /** Absolute roots used by send_to_user to resolve attachment paths (workspace: and shared:). */
  attachmentRoots?: { workspace: string; shared: string };
  /** Async-jobs module — enables list_my_jobs + dispatch_sandbox_run tools. */
  asyncJobsModule?: AsyncJobsModule;
  /** Initial source of the current run — used by getAllTools to filter dispatch_sandbox_run out when the run STARTED as a sandbox (anti-recursion). */
  currentRunSource?: MessageSource;
  /** Visible channel source to use when delivering messages back to the user — 'web' or 'telegram' depending on the session's native channel. Persists across sandbox flips. */
  visibleSource?: MessageSource;
  /** Override de canaux de réveil hérité de la tâche/source planifiée (UI). Prioritaire sur la policy agent et l'arg `channel` du LLM — cf. resolveDelivery. */
  taskDeliveryChannels?: Array<'mobile' | 'telegram'>;
  /** Run lancé par le scheduler/proactive-source (activeRunId posé côté run.ts, y compris cron kind='task') — `policy.wake` ne s'applique qu'à ces runs + sandbox, jamais au chat interactif. */
  isBackgroundRun?: boolean;
  /** Dynamic getter — true if the current run is in sandbox mode right now (either started as one or flipped mid-run). Used by the dispatch_sandbox_run exec-time anti-recursion check. */
  isSandboxActive?: () => boolean;
  /**
   * Dynamic getter — `DeliveryTrigger` v3 du run courant (interactive/proactive/task/sandbox),
   * recalculé à l'exécution car le sandbox peut s'activer en plein run. Fourni par run.ts (qui a
   * accès au `sandboxJobId` live + `activeRunId` même non-proactif). Consommé par send_to_user.
   */
  currentRunTrigger?: () => DeliveryTrigger;
  /**
   * Callback invoked by dispatch_sandbox_run to flip the ongoing run's source.
   * runAgent provides this; subsequent addMessage calls + broadcasts use the new source
   * so the agent's work becomes invisible to the chat UI without spawning a separate run.
   */
  setRunSource?: (source: MessageSource) => void;
  /**
   * Callback invoked by dispatch_sandbox_run to register the sandbox tracking job id
   * so runAgent can finalize it (done/cancelled/error) on run completion.
   */
  setSandboxJobId?: (jobId: string) => void;
  /**
   * Sub-agent spawn counter — mutable, incremented by `spawn_subagent` each time it
   * successfully enqueues a sub-agent job. Capped by `spawnSubagentsLimit`.
   */
  spawnSubagentsCounter?: { count: number };
  /** Max sub-agents that the current parent run can spawn (anti-runaway). Default 5. */
  spawnSubagentsLimit?: number;
  /**
   * Mutable queue of side-effects that must run STRICTLY AFTER run.ts has persisted the
   * current call's tool_result row. Tools push closures here when they need to insert a
   * row whose `created_at` must come AFTER the tool_result (so the next turn's history
   * stays byte-stable for llama.cpp's KV-cache prefix).
   *
   * Why a queue and not a direct call: the tool itself runs INSIDE the dispatcher loop,
   * before run.ts has had a chance to persist the tool_result. Doing the side-effect
   * inline (with default NOW()) yields `created_at` BEFORE the tool_result row, which
   * inserts the side-effect message in the middle of the rebuilt history at the next
   * turn — invalidating ~440+ tokens of KV-cache per call.
   *
   * Today's only producer is `send_to_user` (visible-content duplicate). Keep it generic
   * so any future tool that needs the same ordering guarantee just pushes here.
   *
   * Closures are awaited sequentially after the tool_result persist, so each call's
   * `created_at` strictly increases. Failures are caught and logged — they don't break
   * the run loop.
   */
  pendingPostToolResult?: Array<() => Promise<void>>;
  /** Livraison sub-agent (job parent) — requis pour `submit_subagent_report`. */
  subAgentDelivery?: SubAgentDeliveryContext;
  /** État mutable : première livraison réussie via l’outil. */
  subAgentDeliveryState?: SubAgentDeliveryState;
  db?: Pool;
  /**
   * Sub-agent uniquement : plafond TOTAL d'appels d'outils sur le run (parallèles compris).
   * `null` ou `undefined` = pas de cap. `submit_subagent_report` ne compte PAS contre ce cap
   * (c'est la sortie obligatoire). Quand atteint, soft-refuse avec rappel d'appeler submit.
   */
  subAgentToolCallsCap?: number | null;
  /** Sub-agent uniquement : compteur partagé (mutable) incrémenté à chaque dispatch. */
  subAgentToolCallsCounter?: { count: number };
}

export type { ReasoningConfig };

/**
 * Description used for lazy-mode skill stubs in `tools[]`.
 *
 * In lazy mode, EVERY loaded skill action is emitted as a stub in the payload
 * `tools[]` array (so the LLM has a callable name once it's done an inspect_skill).
 * Previously each stub carried a long ~165-char boilerplate description duplicated
 * N times — at 141 skills that's ~6k wasted tokens per run with zero info content.
 *
 * The procedural signal ("call inspect_skill first, then call the tool by name")
 * lives in the `## Available skills (lazy mode)` block that run.ts:888+ APPENDS to
 * `messages[0].content` — and `messages[0]` is the SYSTEM message (run.ts:812-813),
 * not a user message. So the canonical instruction is in the system prompt itself,
 * once. The per-stub description was redundant.
 *
 * The empty string keeps the JSON shape valid (Anthropic + OpenAI/llama.cpp all
 * accept empty descriptions on tools — `description` is optional per spec) while
 * reclaiming the duplicated tokens. If a downstream provider ever rejects empty
 * descriptions, change this to a single-word marker like `'Call inspect_skill first.'`
 * — fix lands here in one place.
 */
export const LAZY_SKILL_STUB_DESCRIPTION = '';

/**
 * Single source of truth for the shape of a lazy-mode skill stub. All three callers
 * (`buildLlmPayload` in run.ts, `buildAgentToolsForRender` here, `debugRoutes`
 * prompt-cache analysis) MUST go through this factory so the prod payload, the
 * Prompt Builder render, and the cache divergence analyser stay byte-identical.
 */
export function makeLazySkillStub(name: string): ToolDefinition {
  return {
    name,
    description: LAZY_SKILL_STUB_DESCRIPTION,
    parameters: { type: 'object' as const },
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'bash',
    description:
      'Execute a shell command and return stdout+stderr. ' +
      'Use for: running tests (npm test), git operations (git status, git log), installing packages (npm install, pip install), searching (grep -rn "pattern" src/), moving/renaming files. ' +
      'Do NOT use bash to read or write files — use read_file/write_file/edit_file instead.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The shell command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file and return its content. Use lines (e.g. "40-60") to read only a specific range — strongly preferred for large files (>80 lines). ' +
      'Workflow for large files: codebase_search → get line numbers → read_file(lines: "40-60") → edit_file. ' +
      'Use full read (no lines) only for small files, configs, or notes. Path relative to workspace or absolute under Environment directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute under allowed roots)' },
        lines: { type: 'string', description: 'Line range to read, e.g. "512-524" or "42". Takes priority over offset/limit. Use the line numbers returned by codebase_search (hybrid) or grep -n. Strongly preferred over reading the whole file for large files.' },
        offset: { type: 'number', description: 'First line to read (1-based). Fallback when lines is not set.' },
        limit: { type: 'number', description: 'Number of lines to read from offset. Used together with offset.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'inspect_image',
    description:
      'Look at an image file on disk and get a description, OR ask a targeted question about its visual content (OCR, "what colour is X", "read the serial number", "is there a person", etc.). ' +
      'Use this whenever you need to SEE an image — including images the user uploaded (their absolute paths are listed in the "uploaded images" system-note footer of their message) and images you produced. ' +
      'You do NOT automatically retain a chat-uploaded image across turns; call inspect_image on its saved path to look at it again later. ' +
      'For relevance, pass a specific `question` rather than relying on the generic default. ' +
      'Supported formats: png, jpg, jpeg, gif, webp, bmp. This is read-only analysis — it does not edit the image (use the media-gen skill for edits).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image file path — absolute (e.g. an uploaded-image path from the message footer) or relative to your workspace.' },
        question: { type: 'string', description: 'What you want to know about the image. Optional — omit for a general detailed description. Be specific for best results (e.g. "transcribe all visible text", "what is the error shown on screen").' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create a new file or completely rewrite an existing one IN YOUR PRIVATE WORKSPACE (or any absolute path under Environment directories). Use ONLY when creating a file that does not exist or when the entire content must be replaced. ' +
      'For any partial modification (fix a bug, change a value, add a line), use edit_file instead. ' +
      'For outputs that other agents/runs must see (reports, deliverables, hand-offs), use `shared_write` instead — `write_file` lands in YOUR workspace only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace, or absolute under allowed roots). Use `shared_write` for shared memory.' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description:
      'List files and subdirectories in a directory. Defaults to workspace root if no path given. ' +
      'Use this to discover what files exist before reading them — especially when you are unsure of a filename or directory structure. ' +
      'Path relative to workspace or absolute under Environment directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (relative or absolute under allowed roots)' },
      },
      required: [],
    },
  },
  {
    name: 'edit_file',
    description:
      'Partially edit a file by replacing an exact substring with new content. ALWAYS prefer this over write_file for any change that does not rewrite the whole file. ' +
      'old_string must match the file exactly — including whitespace and indentation. If old_string appears multiple times, add surrounding context to make it unique, or set replace_all: true. ' +
      'Example: edit_file(path: "config.ts", old_string: "timeout: 3000", new_string: "timeout: 5000"). ' +
      'For edits inside SHARED MEMORY, use `shared_edit` instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute under allowed roots). Use `shared_edit` for shared memory.' },
        old_string: { type: 'string', description: 'Exact text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'shared_read',
    description:
      'Read a file from SHARED MEMORY (the directory visible to all agents and runs — see `# Environment > Shared memory`). ' +
      'Path is relative to the shared memory root; an absolute path under that root (or a `shared:` prefix) is also accepted and rebased automatically. "~" and ".." (escapes) are rejected. ' +
      'Use this when you need to consume an artifact produced by another agent/run, a shared report, a hand-off note, etc. ' +
      'For your private workspace, use `read_file` instead. ' +
      'Same `lines` / `offset` / `limit` semantics as `read_file` (prefer `lines: "40-60"` for large files).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path under the shared memory root, e.g. "reports/2026-05-15.md" (an absolute path under the root is also accepted). No "~", no "..".' },
        lines: { type: 'string', description: 'Line range, e.g. "512-524" or "42". Takes priority over offset/limit.' },
        offset: { type: 'number', description: 'First line to read (1-based). Fallback when lines is not set.' },
        limit: { type: 'number', description: 'Number of lines to read from offset.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'shared_write',
    description:
      'Create a new file or completely rewrite an existing one IN SHARED MEMORY (the directory visible to all agents and runs). ' +
      'Use this for any artifact intended to be consumed by another agent, another run, or persisted as a shared deliverable: reports, hand-off notes, structured outputs, etc. ' +
      'Path is relative to the shared memory root (an absolute path under that root or a `shared:` prefix is rebased automatically). "~" and ".." are rejected. ' +
      'For partial edits, use `shared_edit`. For files that should stay private to your run, use `write_file` (workspace).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path under the shared memory root (e.g. "reports/foo.md"). No "~", no "..". Parent dirs are created automatically.' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'shared_list',
    description:
      'List files and subdirectories under SHARED MEMORY. Defaults to the shared memory root if no path given. ' +
      'Set `recursive: true` to get the whole tree (depth-limited) in one call — the fastest way to learn the layout. ' +
      'Path is relative to the shared memory root (an absolute path under that root is also accepted). "~" and ".." are rejected. ' +
      'Use to discover existing shared artifacts before reading them (`shared_read`) or searching their content (`shared_search`).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path under the shared memory root (defaults to "."). No "~", no "..".' },
        recursive: { type: 'boolean', description: 'List the full subtree instead of just the immediate directory (default false).' },
        depth: { type: 'number', description: 'Max depth when recursive (default 3, max 10).' },
      },
      required: [],
    },
  },
  {
    name: 'shared_search',
    description:
      'Semantic / hybrid search over SHARED MEMORY content (the directory visible to all agents and runs). ' +
      'This is the dedicated way to FIND something in shared memory by meaning or keyword — codebase_search does NOT cover shared memory. ' +
      'Returns matching chunks with paths relative to the shared root + line ranges; feed a hit straight into `shared_read(path, lines)`. ' +
      'Default mode hybrid (vector + keyword). Workflow: `shared_search(query)` → pick a hit → `shared_read(path, lines)`.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword query' },
        limit: { type: 'number', description: 'Max results (default 10, max 20)' },
        type: { type: 'string', enum: ['vector', 'hybrid'], description: 'Search mode: hybrid (default) or vector' },
      },
      required: ['query'],
    },
  },
  {
    name: 'shared_edit',
    description:
      'Partially edit a file IN SHARED MEMORY by replacing an exact substring. ALWAYS prefer over `shared_write` for any change that is not a full rewrite. ' +
      'Same matching rules as `edit_file`: old_string must match exactly (whitespace + indentation); if it appears multiple times, add context or set replace_all: true. ' +
      'Path is relative to the shared memory root (an absolute path under that root is also accepted). "~" and ".." are rejected.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path under the shared memory root. No "~", no "..".' },
        old_string: { type: 'string', description: 'Exact text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'memory_write',
    description:
      'Save information to persistent memory that survives across conversations. ' +
      'Call IMMEDIATELY — without asking for confirmation — when: user says "remember/note/save/keep in mind", user shares a preference or decision, or a task produces an important result. ' +
      'Example: user says "remember I prefer dark mode" → memory_write(content: "User prefers dark mode", mode: "append"). ' +
      'Trivial content (greetings, "ok") is silently skipped. scope: "agent" (private, default) or "shared" (visible to all agents).',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to memorize' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: 'Write mode' },
        section: {
          type: 'string',
          description: 'Optional section header (e.g. "## Decisions", "## TODOs", "## Technical notes")',
        },
        scope: {
          type: 'string',
          enum: ['agent', 'shared'],
          description: 'Memory scope: "agent" (private, default) or "shared" (visible to all agents)',
        },
      },
      required: ['content', 'mode'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Search your persistent memory using natural language. Finds relevant memories even when wording differs from what was stored. ' +
      'IMPORTANT: always call this BEFORE saying "I don\'t know" or "I don\'t remember" — the answer may be in memory. ' +
      'Top memories are already auto-injected each turn; use this tool for targeted lookups on a specific topic. ' +
      'Example: memory_search(query: "user database preferences") or memory_search(query: "deploy process", scope: "shared").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for (natural language)' },
        top_k: { type: 'number', description: 'Number of results (default: 5, max: 20)' },
        threshold: { type: 'number', description: 'Minimum similarity threshold 0-1 (default: 0.3)' },
        scope: {
          type: 'string',
          enum: ['agent', 'shared', 'all'],
          description: 'Search scope (default: all)',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain (e.g. "decisions", "errors", "preferences")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'session_search',
    description:
      'Full-text search over your past conversation history (what was actually said). ' +
      'Use it to recall an earlier discussion, decision, or detail from a previous session — ' +
      'complements memory_search (curated memory) and codebase_search (code). ' +
      "Scoped to your own sessions by default; pass all_agents:true to search every agent's history. " +
      'Example: session_search(query: "authentication bug") or session_search(query: "deploy steps", limit: 20).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words/phrase to search for (websearch syntax: quotes, OR, -exclude).' },
        limit: { type: 'number', description: 'Max results (default: 10, max: 50)' },
        all_agents: { type: 'boolean', description: "Search across all agents' sessions, not just yours (default: false)" },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch and return the text content of a URL (up to 20,000 chars). ' +
      'Use when: user pastes a URL and wants you to read it, you know the exact URL of documentation or an article, or you need to check a public API endpoint. ' +
      'Example: user says "read this: https://example.com/article" → web_fetch(url: "https://example.com/article").',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web and return titles, URLs, and descriptions of matching results. ' +
      'Use when: you need current/recent information, looking up library docs or error messages, user asks about news or events, or your training data may be outdated. ' +
      'Example: web_search(query: "Express CORS middleware setup 2026").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        count: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'codebase_search',
    description:
      'Search across a pre-indexed codebase using natural language or keywords. Returns matching code chunks with file paths and line numbers. ' +
      'Default mode: hybrid (vector similarity + keyword matching — best for most queries). Use type: "vector" only if hybrid returns too many false positives. ' +
      'After getting results, use codebase_search_read(path: <hit.filePath>, lines: "<start>-<end>") to read the surrounding code. ' +
      'Each hit is prefixed with its source index in brackets, e.g. "[mastermind-code] /path/to/file.ts:34-67"; you normally do NOT need to pass that index back — codebase_search_read/list infer it from the absolute path. ' +
      'Note: SHARED MEMORY is not covered here — use shared_search for that.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword query' },
        limit: {
          type: 'number',
          description: 'Max results (default 10, max 20)',
        },
        type: {
          type: 'string',
          enum: ['vector', 'hybrid'],
          description: 'Search mode: hybrid (default) or vector',
        },
        index: {
          type: 'string',
          description: 'Named index key from mastermind.yml codebaseSearch.indices (optional)',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by file extensions, e.g. [".ts", ".tsx"]',
        },
        file_pattern: {
          type: 'string',
          description: 'Substring filter on file path',
        },
        file_name_weight: {
          type: 'number',
          description: 'Hybrid mode: weight for file name match (0-1)',
        },
        exact_symbol: {
          type: 'boolean',
          description: 'Hybrid mode: boost exact symbol name matches',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'codebase_search_read',
    description:
      'Read a file from an indexed codebase, sandboxed to the index source root (codebaseSearch.embedSources[index]). ' +
      'Workflow: codebase_search → pick a hit → codebase_search_read(path: <hit.filePath>, lines: "<start>-<end>") to grab surrounding context. ' +
      'Pass the absolute path from a codebase_search hit and `index` is inferred automatically — only provide `index` for a path relative to the source root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Absolute path returned by codebase_search (index inferred), or a path relative to the index source root (then `index` is required).' },
        index: { type: 'string', description: 'Index key (optional — only needed for a relative path; inferred from an absolute path).' },
        lines: { type: 'string', description: 'Line range, e.g. "40-60" or "42". Takes priority over offset/limit. Use the range from a codebase_search hit (optionally widened).' },
        offset: { type: 'number', description: '1-based start line (fallback if lines not set).' },
        limit: { type: 'number', description: 'Number of lines to read from offset.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'codebase_search_list',
    description:
      'List a directory inside an indexed codebase source root. Use to discover sibling files of a search hit, or to browse the layout of an index. ' +
      'Pass the absolute path of a hit (or its parent) and `index` is inferred; for a path relative to the source root, provide `index`.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Absolute path under an index source root (index inferred), or relative to the source root (then `index` is required). Omit / "." for the index root (requires `index`).' },
        index: { type: 'string', description: 'Index key (optional — only needed for a relative path or the root listing).' },
      },
      required: [],
    },
  },
  {
    name: 'skill_create',
    description:
      'Create or update a reusable skill with executable actions. Writes actions.yml (and optional SKILL.md) to the skills directory and hot-reloads — new tools become available immediately. ' +
      'Use when you discover a useful API, CLI tool, or repeatable workflow that should be packaged as callable tools for future use. ' +
      'See existing skills in the skills directory for actions.yml format reference.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill directory name (kebab-case, e.g. "my-api-client")' },
        actions_yml: { type: 'string', description: 'Full actions.yml content (YAML format, see existing skills for reference)' },
        skill_md: { type: 'string', description: 'Optional SKILL.md documentation content (markdown with YAML frontmatter)' },
      },
      required: ['skill_name', 'actions_yml'],
    },
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a task for future execution. You will be woken up automatically at the scheduled time and the prompt will be executed. ' +
      'If the task should notify the user when it fires, write that into the prompt (the agent will use send_to_user during the run, which delivers via the session\'s native channel). ' +
      'Two modes: one-time (provide scheduledAt) or recurring (provide cronExpression, e.g. "0 9 * * 1-5" = weekdays 9am). ' +
      'Use when user says "remind me", "tomorrow at X do Y", "every day at 9am", "in 2 hours", "schedule", "plan".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short task name (e.g. "Meeting reminder", "Daily backup")' },
        prompt: { type: 'string', description: 'Full instructions to execute when the task fires' },
        scheduledAt: { type: 'string', description: 'Datetime for one-time task — local Paris time, e.g. "2026-04-02T09:00" or "2026-04-02T09:00:00". The current Paris time is already in your context, so just write the wall-clock you want; no need to compute UTC offsets.' },
        cronExpression: { type: 'string', description: '5-field cron expression for recurring task (e.g. "0 9 * * 1-5" = weekdays at 9am)' },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description:
      'List all scheduled tasks with their status (enabled/disabled), next execution time, and schedule expression (cron or one-time). ' +
      'Use when: user asks "what reminders do I have?", "show my scheduled tasks", or before creating a new task to check for duplicates.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Filter by agent (optional, default: all tasks)' },
      },
      required: [],
    },
  },
  {
    name: 'delete_scheduled_task',
    description:
      'Delete a scheduled task by its ID. Always call list_scheduled_tasks first to find the correct task ID. ' +
      'Use when user says "cancel my reminder", "delete that task", "stop the recurring check". Works for both normal and proactive tasks.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to delete' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_scheduled_task',
    description:
      'Fetch the FULL details of a single scheduled task: its complete prompt, schedule, status, last 5 run outcomes, and timestamps. ' +
      'Use when: (a) the user asks "what does my reminder X do?", "show me the details of task Y", (b) before update_scheduled_task to know what fields exist, ' +
      '(c) to debug "why didn\'t my task fire?" by checking enabled state and recent run statuses. ' +
      'list_scheduled_tasks gives you the IDs; this one gives you the full payload.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID (from list_scheduled_tasks)' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'update_scheduled_task',
    description:
      'Modify an existing scheduled task. Pass only the fields you want to change — others stay as-is. ' +
      'Use when user says "change my reminder to 9am", "update the prompt to also include X", "pause that task", "switch from daily to weekdays only". ' +
      'IMPORTANT: changing schedule type (one-shot ↔ recurring) requires passing the corresponding field (cronExpression for recurring, scheduledAt for one-shot) — the other one is cleared automatically. ' +
      'Always call get_scheduled_task first to confirm the current state and the exact ID.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to modify (from list_scheduled_tasks)' },
        name: { type: 'string', description: 'New short task name (optional)' },
        prompt: { type: 'string', description: 'New full instructions (optional). Replaces the existing prompt entirely.' },
        scheduledAt: { type: 'string', description: 'New datetime for one-time task — local Paris time (e.g. "2026-04-02T09:00"). Switches schedule to one-shot if it was cron.' },
        cronExpression: { type: 'string', description: 'New 5-field cron (e.g. "0 9 * * 1-5"). Switches schedule to recurring if it was one-shot.' },
        enabled: { type: 'boolean', description: 'Pause (false) or resume (true) without deleting. Disabled tasks skip execution but stay in the list.' },
        severityThreshold: { type: 'string', enum: ['low', 'medium', 'high'], description: 'For proactive tasks only: minimum severity to escalate.' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'list_proactive_watchers',
    description:
      'List agents available to serve as watchers in a proactive monitoring routine. Returns each agent\'s ID, name, model, and starred skills. ' +
      'Call this BEFORE create_proactive_task so you can pick a watcher agent that has the right skills for the monitoring job.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_proactive_task',
    description:
      'Create a recurring proactive monitoring routine with two agents: a watcher (runs on cron, checks something via its skills) and a handler (you — receives escalations and decides whether to notify the user). ' +
      'Use when user says "alert me if...", "check daily if...", "watch for...", "monitor...". ' +
      'IMPORTANT: the watcher prompt must explicitly state (1) what to check, (2) when to escalate via escalate_to_agent, (3) when to finish silently. ' +
      'Example watcher prompt: "Call skill_meteo_forecast for Paris. If rain or storm, call escalate_to_agent with a summary. Otherwise finish silently."',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short routine name (e.g. "Daily weather alert")' },
        watcherAgentId: { type: 'string', description: 'Agent ID for the watcher role (use list_proactive_watchers to discover). Must be different from you.' },
        prompt: { type: 'string', description: 'Detailed instructions for the watcher: what to check, when to escalate, when to stay silent.' },
        cronExpression: { type: 'string', description: '5-field cron in local time (e.g. "0 18 * * *" = daily at 6pm)' },
        severityThreshold: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Minimum severity to escalate (default: medium). Watcher logs but does not escalate below this.' },
      },
      required: ['name', 'watcherAgentId', 'prompt', 'cronExpression'],
    },
  },
  {
    name: 'board_write',
    description:
      'Post a short note on the shared Board — an ephemeral notepad visible to ALL agents at every turn (auto-deleted after 24h). ' +
      'Use for: cross-agent alerts ("API X is down"), observations ("user asked about Y"), short-term coordination ("task Z in progress"). Max 500 chars. ' +
      'IMPORTANT: after you have processed a board note (action done, info integrated), delete it with board_delete to keep the board clean.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note text (max 500 chars). Be concise and actionable.' },
        ttl_hours: { type: 'number', description: 'Time-to-live in hours (default: 24, max: 48). Use short TTL for temporary alerts.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'board_delete',
    description:
      'Delete a note from the shared Board by its ID (format: bn-XXXX, visible in the board block in your context). ' +
      'Call this after you have handled a board note: the alert is resolved, the info is acted on, or the reminder is done. ' +
      'The board should only contain current/active items, not history.',
    parameters: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Note ID to delete (visible in the board block injected in your context, format bn-XXXX)' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'escalate_to_agent',
    description:
      'Hand off a situation to another agent for handling. Non-blocking: returns immediately, target agent runs asynchronously in the background. ' +
      'The target agent receives your summary and can decide to notify the user via send_to_user. ' +
      'Available from any context (chat, push, proactive). In a scheduled proactive watcher run, the target is auto-resolved from the task config; otherwise pass target_agent_id explicitly.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise 1-3 sentence summary for the target agent: what you found and why it matters.' },
        severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Escalation severity.' },
        context: { type: 'string', description: 'Optional raw context (e.g. email content, monitoring output) forwarded to the target agent.' },
        target_agent_id: { type: 'string', description: 'Target agent ID (optional if escalationAgentId is configured on the proactive task).' },
      },
      required: ['summary', 'severity'],
    },
  },
  {
    name: 'send_to_user',
    description:
      'Deliver a message and/or file(s) to the user. This is your single channel for reaching the user outside your regular streaming reply.\n' +
      'Use when: (a) you generated an image/video/audio/document the user needs to receive, OR (b) the user is likely not watching chat and should be notified, OR (c) you are in a proactive/scheduled run and decided the user needs to know something.\n' +
      'Do NOT use for your ordinary text reply during a live chat — your streaming output is already shown.\n' +
      'Notification routing (Telegram / mobile push) is decided by the user\'s per-agent delivery policy — you normally do NOT need to pick a channel. Omit `channel` (or pass "auto"): in background runs (scheduled/proactive/sandbox) the user\'s preferred surfaces ring; in a LIVE chat it stays chat-only (the user is already watching — never ping them for content they can see). Only set an explicit channel when the user asked to be notified elsewhere.\n' +
      'Examples:\n' +
      '- Generated a chart mid-chat → send_to_user(content="Le graph demandé:", attachments=["outputs/chart.png"])\n' +
      '- Long task done while user is away → send_to_user(subject="Report prêt", content="...")\n' +
      '- Proactive watcher escalated something important → send_to_user(subject="🚨 Alert", content="...")',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['auto', 'chat', 'telegram', 'mobile', 'both'], description: 'OPTIONAL routing override — default "auto" lets the user\'s delivery policy decide (recommended). Only set it when the user explicitly asked for a specific surface: chat = session only (no push) · telegram = + Telegram · mobile = + APNs mobile push · both = + Telegram AND mobile. The message is ALWAYS recorded as a visible message in the session regardless of channel. Note: the user\'s policy may downgrade telegram requests (fallback/off).' },
        content: { type: 'string', description: 'User-facing text. May be empty if attachments alone carry the payload.' },
        subject: { type: 'string', description: 'Optional short title. Rendered as a bold header on Telegram, as the push notification title, and used as the summary in the Proactive audit tab when the run is proactive.' },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional file paths. Each entry: "outputs/chart.png" (workspace of this agent) or "shared:reports/foo.pdf" (shared memory). ' +
            'Images/videos/audio render inline in chat; other types appear as downloadable links. ' +
            'Telegram limits: photo ≤ 10 MB, video/audio/document ≤ 50 MB.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'dispatch_sandbox_run',
    description:
      'Switch the current conversation into invisible "sandbox mode" to work autonomously on a long task (multiple tool calls, reasoning, sub-turns) without polluting the chat UI. ' +
      'Use when: (a) the user explicitly asks for a deep task ("analyse en profondeur", "fais une recherche complète", "génère un rapport"), OR (b) you estimate the work needs more than 3-4 tool turns. ' +
      'Flow: 1) tell the user with a rough ETA ("OK je lance ça en sandbox, ~X min"). 2) call `dispatch_sandbox_run(task="<brief summary for audit>")`. 3) your very next turn and all subsequent turns are HIDDEN from the chat — you work silently. 4) at the end, call `send_to_user` ONCE with the final deliverable — that message appears in the chat. ' +
      'This is NOT a new run — it is the same conversation flipped invisible. Full context is preserved, the KV cache stays hot. Do not mention being in sandbox in your internal turns. If the user sends a new message, you auto-exit sandbox mode and handle the message normally.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Brief summary of the task for the audit trail (1-2 sentences). This is NOT sent to you as a new prompt — you already have the full conversation context. It is just stored for the user to see in the Tâches tab.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_my_jobs',
    description:
      'List your currently queued / running / recently completed async jobs (long-running skill generations like Sora video, Veo, image gen). ' +
      'Use this when: the user asks "ça avance, ma vidéo ?", you want to confirm a previous async call was actually dispatched, or you want to know if anything is still in-flight before moving on. ' +
      'Returns a short text listing with job id, tool name, status, uptime for running jobs, and output file count for done ones. ' +
      'Do NOT call the same async skill twice to "check" — use this instead (no side-effects).',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'all'],
          description: 'active (default) = only queued+running · all = also includes done/error/cancelled from recent history',
          default: 'active',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return (default 20, max 50)',
          default: 20,
        },
      },
      required: [],
    },
  },
  {
    name: 'extended_reasoning',
    description:
      'Send a complex problem to a powerful external reasoning model for deep analysis. The model has NO context about the current conversation — you must include ALL relevant details in the prompt. ' +
      'Use sparingly (limited calls per run). Reserved for problems where your own reasoning is insufficient: tricky SQL optimization, intricate algorithm design, subtle multi-component bugs, ambiguous architecture trade-offs. ' +
      'Do NOT use for simple questions or tasks you can handle yourself.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The precise, self-contained question or problem to reason about. Include all relevant context.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'inspect_skill',
    description:
      'Reveal the full action schemas of a loaded skill (description + parameters per action). ' +
      'Only available when the agent is in lazy-skill mode — in that mode the system prompt advertises skills as one-liners and you must call this tool before invoking any action of a skill you have not used yet. ' +
      'After inspect_skill returns, call the action tool by its `toolName` (shown in the result) like any other tool — the dispatch is unchanged.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill directory id (the `id` field shown in the "Available skills" block of your system prompt).' },
      },
      required: ['skill_id'],
    },
  },
  {
    // Wildcard dispatch — only emitted when the agent is in lazy + wildcard mode.
    // In wildcard mode, skill actions are NOT pre-declared as individual stubs in
    // `tools[]` (which saves ~6-8k tokens for agents with 100+ skills loaded).
    // Instead, the agent calls inspect_skill(skill_id) to discover an action, then
    // routes its invocation through this single tool. The Mastermind dispatcher
    // forwards `toolName` to the same skillActionsExecutor used for direct calls.
    name: 'call_skill_action',
    description:
      'Invoke a skill action by its full toolName. ' +
      '**Required workflow**: 1) read the "## Available skills (lazy mode)" block in the system prompt to find the skill id, 2) call `inspect_skill(skill_id="<id>")` to get the action\'s toolName + parameter schema, 3) call this tool with that toolName and a matching args object. ' +
      'Use this instead of trying to call `skill_*` tools directly — those are not declared individually in this mode.',
    parameters: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Full toolName as returned by inspect_skill, e.g. "skill_meteo_forecast".' },
        args: { type: 'object', description: 'Arguments object matching the action\'s parameter schema (returned by inspect_skill).' },
      },
      required: ['toolName', 'args'],
    },
  },
  {
    name: 'list_subagents',
    description:
      'List all configured sub-agents (cloud one-shot presets you can spawn via `spawn_subagent`). ' +
      'Returns each preset with its id, model, allowed callers, and caps. ' +
      'Call this BEFORE `spawn_subagent` if you don\'t already know which preset id to target — ' +
      'don\'t guess preset names from main-agent IDs (those are different — main agents are people you ' +
      'talk with, sub-agents are scoped one-shot workers).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'spawn_subagent',
    description:
      'Delegate a self-contained one-shot task to a cloud sub-agent. The sub-agent runs ' +
      'asynchronously in the background and its final report is delivered as a separate ' +
      'message in this session when it completes — you do NOT block waiting for it. ' +
      'Use when: (a) the task needs a model/skillset different from yours (web exploration, ' +
      'long-form writing, deep code review), (b) you want to parallelize independent ' +
      'investigations, (c) you want to keep your own context clean of intermediate research. ' +
      'You can spawn multiple sub-agents in the same run (capped per run). Sub-agents cannot ' +
      'spawn other sub-agents (anti-recursion). Each sub-agent must end its report with a ' +
      '`## TL;DR` section — that\'s what gets re-injected here; the full transcript stays ' +
      'available for drill-down. ' +
      'IMPORTANT: `preset` must be a real configured sub-agent ID — call `list_subagents` first ' +
      'if you are not 100% sure of the available presets (don\'t guess from main-agent names; main ' +
      'agents and sub-agents may share names but are different entities — only sub-agents are ' +
      'spawnable). ' +
      'Flow: 1) tell the user briefly that you\'re delegating ("OK je file ça à l\'explorer, je reviens"). ' +
      '2) call `spawn_subagent(preset, prompt)`. 3) finish your turn or continue with other work. ' +
      '4) when the report arrives, you\'ll be re-invoked with it in context — synthesize and reply.',
    parameters: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          description: 'ID of the sub-agent preset to spawn. Must be a configured sub-agent — call `list_subagents` to see what\'s available if you don\'t already know.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task description for the sub-agent. Include ALL context it needs (the sub-agent has no access to your conversation). Be explicit about the expected output format and scope.',
        },
      },
      required: ['preset', 'prompt'],
    },
  },
];

/** File tool definitions with system access descriptions */
const SYSTEM_ACCESS_OVERRIDES: Record<string, Partial<ToolDefinition>> = {
  read_file: {
    description: 'Read a file and return its content. Path can be absolute or relative to workspace. Use lines (e.g. "40-60") for large files (>80 lines). Workflow: codebase_search → read_file(lines) → edit_file. For READ-ONLY exploration of an indexed codebase, prefer `codebase_search_read` (sandboxed to the index source root, no systemAccess needed).',
  },
  write_file: {
    description: 'Create a new file or completely rewrite an existing one IN YOUR WORKSPACE (or any absolute path under Environment dirs). Use ONLY for new files or full rewrites — use edit_file for partial changes. For shared deliverables, use `shared_write` (lands in shared memory).',
  },
  list_dir: {
    description: 'List files and subdirectories in a directory. Path can be absolute or relative to workspace. Use to discover filenames before reading them. For shared memory, use `shared_list`.',
  },
  edit_file: {
    description: 'Partially edit a file by replacing an exact substring. Path can be absolute or relative to workspace. ALWAYS prefer over write_file. old_string must match exactly (whitespace, indentation). Example: edit_file(path: "config.ts", old_string: "timeout: 3000", new_string: "timeout: 5000"). For shared memory, use `shared_edit`.',
  },
  bash: {
    description: 'Execute a shell command with full system access and return stdout+stderr. Use for: tests, git, packages, grep/find, moving files. Do NOT use for reading/writing files — use file tools instead.',
  },
};

/**
 * Returns the unified tool definition list exposed to EVERY agent on a given model.
 *
 * Rationale: llama.cpp prefix cache is byte-sensitive — any per-agent variation in the
 * `tools` block invalidates the KV cache the moment we switch agents. By exposing the same
 * full set everywhere and enforcing per-agent allowlist at execution time (see `executeTool`
 * gate), all agents on the same model share the tokenized tools prefix.
 *
 * Filters are GLOBAL only (module availability, API keys). Per-agent fields
 * (`tools.disabled`, `tools.systemAccess`, `promptInjection.starredSkills`) are IGNORED here
 * and enforced in `executeTool` via a soft-refuse message.
 *
 * `SYSTEM_ACCESS_OVERRIDES` is applied UNCONDITIONALLY so every agent sees the permissive
 * descriptions; restricted agents still get blocked at execution via `allowedPathRoots`.
 *
 * The skill list comes from `skillActionsMod.getToolDefinitions()` — ALL loaded skills,
 * not filtered by any agent's `starredSkills`.
 */
export function getAllTools(opts: {
  braveApiKey?: string;
  /** True if at least one agent in the fleet has codebase_search configured. */
  codebaseSearchEverAvailable?: boolean;
  reasoningAvailable?: boolean;
  /** True if a provider with statsUrl is configured (Mercury serves /admin/vision/describe). Gates `inspect_image`. */
  visionDescribeAvailable?: boolean;
  memorySearchAvailable?: boolean;
  /** Full loaded skill tool definitions (from SkillActionsModule.getToolDefinitions()). */
  skillActions?: ToolDefinition[];
  schedulerAvailable?: boolean;
  boardAvailable?: boolean;
  /** True when the AsyncJobsModule is loaded — gates `list_my_jobs` + `dispatch_sandbox_run` + `spawn_subagent`. */
  asyncJobsAvailable?: boolean;
  /** True when at least one sub-agent is configured in the fleet — gates `spawn_subagent`. */
  subAgentPresetsAvailable?: boolean;
  /** Source of the current run — `sandbox` hides `dispatch_sandbox_run`, `subagent` hides `spawn_subagent` (anti-recursion). */
  currentRunSource?: MessageSource;
  /**
   * When true, `inspect_skill` is exposed (used in lazy-skill mode). Default false to keep
   * the universal prefix lean for non-lazy agents — they have all skill schemas inlined,
   * `inspect_skill` would be dead weight.
   */
  lazySkillsActive?: boolean;
  /**
   * When true, `call_skill_action` is exposed (used in lazy + wildcard mode).
   * Implies `lazySkillsActive` (wildcard dispatch is only meaningful when skills are lazy-loaded).
   * In this mode, individual `skill_*` stubs are NOT emitted by the caller — the wildcard
   * tool handles all skill invocations after the agent has discovered the action schema via
   * `inspect_skill`. Saves ~6-8k tokens for agents with 100+ skills loaded.
   */
  wildcardSkillsActive?: boolean;
}): ToolDefinition[] {
  let tools = [...TOOL_DEFINITIONS];

  if (!opts.braveApiKey) tools = tools.filter(t => t.name !== 'web_search');
  if (!opts.codebaseSearchEverAvailable) {
    // shared_search reuses the codebase-search LanceDB machinery (index key `shared-memory`),
    // so it's only meaningful when that infra is configured for the fleet.
    tools = tools.filter(t => !['codebase_search', 'codebase_search_read', 'codebase_search_list', 'shared_search'].includes(t.name));
  }
  if (!opts.reasoningAvailable) tools = tools.filter(t => t.name !== 'extended_reasoning');
  if (!opts.visionDescribeAvailable) tools = tools.filter(t => t.name !== 'inspect_image');
  if (!opts.memorySearchAvailable) tools = tools.filter(t => t.name !== 'memory_search');
  if (!opts.schedulerAvailable) {
    tools = tools.filter(t => !['schedule_task', 'list_scheduled_tasks', 'delete_scheduled_task', 'get_scheduled_task', 'update_scheduled_task', 'create_proactive_task', 'list_proactive_watchers'].includes(t.name));
  }
  if (!opts.boardAvailable) {
    tools = tools.filter(t => !['board_write', 'board_delete'].includes(t.name));
  }
  if (!opts.asyncJobsAvailable) {
    tools = tools.filter(t => !['list_my_jobs', 'dispatch_sandbox_run', 'spawn_subagent', 'list_subagents'].includes(t.name));
  }

  // Sub-agent panel tools (list + spawn) only when at least one sub-agent is configured.
  if (!opts.subAgentPresetsAvailable) {
    tools = tools.filter(t => !['spawn_subagent', 'list_subagents'].includes(t.name));
  }
  if (!opts.lazySkillsActive) {
    tools = tools.filter(t => t.name !== 'inspect_skill');
  }
  if (!opts.wildcardSkillsActive) {
    tools = tools.filter(t => t.name !== 'call_skill_action');
  }

  // Anti-recursion: inside a sandbox run, hide dispatch_sandbox_run so the agent can't
  // spawn nested sandboxes (would lead to confusion and potential resource exhaustion).
  // Also hide spawn_subagent — once we've flipped invisible via sandbox, the user has
  // already been promised "I'll work on this in the background" and spinning up a cloud
  // sub-agent on top would split the work in confusing ways. Stay self-contained.
  if (opts.currentRunSource === 'sandbox') {
    tools = tools.filter(t => !['dispatch_sandbox_run', 'spawn_subagent', 'list_subagents'].includes(t.name));
  }

  // Anti-recursion: sub-agents themselves cannot spawn other sub-agents — and no point
  // exposing the listing either.
  if (opts.currentRunSource === 'subagent') {
    tools = tools.filter(t => !['spawn_subagent', 'list_subagents'].includes(t.name));
  }

  // Always apply the permissive descriptions so every agent sees identical tokens.
  // Restrictive agents are still enforced at exec via allowedPathRoots + gate.
  tools = tools.map(t => {
    const override = SYSTEM_ACCESS_OVERRIDES[t.name];
    return override ? { ...t, ...override } : t;
  });

  if (opts.skillActions?.length) {
    tools.push(...opts.skillActions);
  }

  return tools;
}

/**
 * Render a lazy-skills-summary template using the user's override (via templatesMod)
 * or fall back to the hardcoded default. Mirrors the logic in run.ts and prompt.ts
 * (same regex replace, same fallback path) so the preview shown by /prompt-render
 * is byte-identical to what the LLM receives in production.
 */
function renderLazyTemplate(
  key: 'lazy-skills-summary.stub' | 'lazy-skills-summary.wildcard',
  vars: Record<string, string>,
  templatesMod: import('../../prompt-templates/index.js').PromptTemplatesModule | undefined,
): string {
  if (templatesMod) return templatesMod.render(key, vars);
  // Hardcoded fallback — same content as exported from prompt-templates/defaults.ts.
  // Note: importing DEFAULTS here would create a cycle (defaults.ts is imported by
  // run.ts which imports this file), so we inline the strings. They MUST stay byte-
  // identical to the defaults to avoid divergence. CI / tests should pin this.
  const STUB = `## Available skills (lazy mode)\nEach skill is summarised below. To use any action of a skill, FIRST call \`inspect_skill(skill_id="<id>")\` to fetch its parameter schemas — THEN call the action tool by its \`toolName\` (returned by inspect_skill) like any other tool.\n\n{{skillsList}}`;
  const WILDCARD = `## Available skills (lazy mode)\nEach skill is summarised below. To use any action of a skill, FIRST call \`inspect_skill(skill_id="<id>")\` to fetch its parameter schemas — THEN call \`call_skill_action(toolName="<returned toolName>", args={...})\` to invoke it. Direct \`skill_*\` invocations are NOT available in wildcard mode.\n\n{{skillsList}}`;
  const tpl = key === 'lazy-skills-summary.wildcard' ? WILDCARD : STUB;
  return tpl.replace(/\{\{([\w.]+)\}\}/g, (m, n) => (vars[n] !== undefined ? vars[n] : m));
}

/**
 * Replicates the tool+skill assembly logic from `buildLlmPayload` (run.ts:582-666)
 * for the Prompt Builder UI (Advanced tab). Returns the exact same tool list that
 * would be sent to the LLM, given the agent config and module availability.
 *
 * This is a READ-ONLY render helper — no side effects, no session, no provider call.
 * Used by `GET /api/agents/:id/prompt-render`.
 *
 * Why not refactor `buildLlmPayload` to share this code? `buildLlmPayload` mixes the
 * tool list with message history, caching, reasoning provider lookups — extracting
 * cleanly would be a bigger refacto. For V1 we duplicate intentionally, with this
 * comment as the canonical link to the source of truth.
 */
export function buildAgentToolsForRender(opts: {
  agentConfig: AgentConfig;
  agentsList?: AgentConfig[];
  skillActionsMod?: SkillActionsModule;
  memoryStoreEnabled?: boolean;
  schedulerAvailable?: boolean;
  boardAvailable?: boolean;
  asyncJobsAvailable?: boolean;
  codebaseSearchEverAvailable?: boolean;
  reasoningAvailable?: boolean;
  /** True if a Mercury statsUrl provider is configured — gates `inspect_image` (mirrors reasoning). */
  visionDescribeAvailable?: boolean;
  braveApiKey?: string;
  /** Defaults to 'user' (the regular interactive render path). */
  source?: MessageSource;
  /**
   * How to expose skill actions in the payload `tools[]` array. Only matters when
   * lazy mode is active (the agent must be in lazy for either of these to make sense).
   *  - 'stub' (default) — emit one stub per loaded skill action (current behavior).
   *  - 'wildcard' — emit NO per-skill stubs; expose a single `call_skill_action`
   *    wildcard tool that dispatches by toolName. Saves ~6-8k tokens for agents
   *    with 100+ skills loaded, at the cost of an extra indirection for the LLM.
   *
   * Production `buildLlmPayload` reads `agentConfig.skillCallMode` (V2 persistence).
   * The Prompt Builder render endpoint also accepts a query override that layers on
   * top of the YAML value to preview "what-if" scenarios without writing the config.
   */
  skillCallMode?: 'stub' | 'wildcard';
  /**
   * Prompt templates module — used to render the lazy-skills-summary using the user's
   * overrides (if any). Without it the lazy summary falls back to the hardcoded default,
   * which would diverge from production (audit V3 bug #2).
   */
  templatesMod?: import('../../prompt-templates/index.js').PromptTemplatesModule;
}): {
  tools: ToolDefinition[];
  lazySkillsActive: boolean;
  bypassUnified: boolean;
  skillCount: { full: number; emitted: number };
  /** 'stub' (default) | 'wildcard'. Reflects what was actually applied for this render. */
  skillCallMode: 'stub' | 'wildcard';
  /**
   * Markdown block appended to the SYSTEM message (`messages[0].content` in run.ts —
   * messages[0] is the system role, not user). Null when lazy is inactive.
   * Mirrors run.ts:888-933 exactly for the Prompt Builder render.
   */
  lazySkillSummary: string | null;
} {
  const { agentConfig, skillActionsMod, agentsList } = opts;
  // Default to 'web' (= regular interactive run, identical to live chat session for tool
  // visibility purposes). 'sandbox' / 'subagent' restrict the tool list further per
  // run.ts:875-883 anti-recursion logic.
  const source: MessageSource = opts.source ?? 'web';
  const skillCallMode: 'stub' | 'wildcard' = opts.skillCallMode ?? 'stub';

  // Mirror of run.ts:573-580 — sub-agents may restrict to allowOnly[] (regular agents don't).
  const useAllowOnly =
    agentConfig.kind === 'subagent'
    && Array.isArray(agentConfig.tools?.allowOnly)
    && (agentConfig.tools!.allowOnly!.length > 0);
  const allowOnlySet: Set<string> | null = useAllowOnly
    ? new Set([...agentConfig.tools!.allowOnly!, 'submit_subagent_report'])
    : null;

  const bypassUnified = agentConfig.bypassUnifiedCache === true;
  const lazySkills = agentConfig.lazySkills === true;

  // Mirror run.ts:584-590
  let allSkillDefs = skillActionsMod?.isActive ? skillActionsMod.getToolDefinitions() : [];
  if (useAllowOnly && allowOnlySet) {
    allSkillDefs = allSkillDefs.filter(d => allowOnlySet.has(d.name));
  }
  const fullSkillCount = allSkillDefs.length;

  // Mirror run.ts:591-619 — skillDefsForPrompt selection
  const bypassStarredFilter = bypassUnified
    ? (agentConfig.promptInjection?.starredSkills?.slice() ?? null)
    : null;
  let skillDefsForPrompt: ToolDefinition[];
  if (lazySkills && skillActionsMod?.isActive) {
    let baseDefs = allSkillDefs;
    if (bypassUnified) {
      baseDefs = bypassStarredFilter
        ? skillActionsMod.getToolDefinitionsForSkills(bypassStarredFilter)
        : [];
    }
    // Wildcard mode short-circuits stub emission entirely — the agent will use
    // call_skill_action to invoke any skill by toolName after inspect_skill.
    skillDefsForPrompt = skillCallMode === 'wildcard'
      ? []
      : baseDefs.map(def => makeLazySkillStub(def.name));
  } else if (bypassUnified && skillActionsMod?.isActive) {
    skillDefsForPrompt = (bypassStarredFilter && bypassStarredFilter.length > 0)
      ? skillActionsMod.getToolDefinitionsForSkills(bypassStarredFilter)
      : [];
  } else {
    skillDefsForPrompt = allSkillDefs;
  }
  if (useAllowOnly && allowOnlySet) {
    skillDefsForPrompt = skillDefsForPrompt.filter(d => allowOnlySet.has(d.name));
  }

  const subAgentPresetsAvailable = !!agentsList?.some(a => a.kind === 'subagent' && a.enabled !== false);
  // Wildcard mode is only meaningful with lazy. If user toggled wildcard on a non-lazy
  // agent, ignore — caller (UI) should also clamp but this is a defensive guard.
  const wildcardSkillsActive = (skillCallMode === 'wildcard') && lazySkills && !!skillActionsMod?.isActive;

  // Mirror run.ts:625-640
  let tools = getAllTools({
    braveApiKey: opts.braveApiKey,
    codebaseSearchEverAvailable: opts.codebaseSearchEverAvailable,
    reasoningAvailable: opts.reasoningAvailable,
    visionDescribeAvailable: opts.visionDescribeAvailable,
    memorySearchAvailable: opts.memoryStoreEnabled,
    skillActions: skillDefsForPrompt,
    schedulerAvailable: opts.schedulerAvailable,
    boardAvailable: opts.boardAvailable,
    asyncJobsAvailable: opts.asyncJobsAvailable,
    subAgentPresetsAvailable,
    currentRunSource: source,
    lazySkillsActive: lazySkills && !!skillActionsMod?.isActive,
    wildcardSkillsActive,
  });

  // Mirror run.ts:642-666 — bypassUnified disabled filter, allowOnly filter
  if (bypassUnified && tools.length > 0) {
    const disabledNames = new Set(agentConfig.tools?.disabled ?? []);
    if (disabledNames.size > 0) {
      tools = tools.filter(t => !disabledNames.has(t.name));
    }
  }
  if (useAllowOnly && allowOnlySet) {
    tools = tools.filter(t => allowOnlySet.has(t.name));
  }

  const lazySkillsActive = lazySkills && !!skillActionsMod?.isActive;

  // Lazy skill summary — mirror run.ts:888-933 (the block appended to message[0]).
  // Returned even when empty so the UI can show "(none — no skills loaded)" honestly.
  let lazySkillSummary: string | null = null;
  if (lazySkillsActive && skillActionsMod) {
    const summariesRaw = bypassStarredFilter === null
      ? skillActionsMod.getSkillSummaries()
      : skillActionsMod.getSkillSummaries(bypassStarredFilter);
    const summaries = useAllowOnly && allowOnlySet
      ? summariesRaw
          .map(s => ({ ...s, actions: s.actions.filter(a => allowOnlySet.has(a.toolName)) }))
          .filter(s => s.actions.length > 0)
      : summariesRaw;
    if (summaries.length === 0) {
      const reason = bypassStarredFilter !== null && bypassStarredFilter.length === 0
        ? ' / bypass mode + zero starred skills'
        : '';
      lazySkillSummary = `## Available skills (lazy mode)\n(none — no skills loaded${reason}.)\n`;
    } else {
      // Use the templates module (or its hardcoded default fallback) to render the
      // lazy summary — same path as run.ts:buildLlmPayload so /prompt-render's preview
      // matches what the LLM actually receives (audit V3 bug #2: this block was inline
      // and ignored both templates AND skillCallMode-aware wildcard text).
      const skillsList = summaries.map(s => {
        const actionList = s.actions.map(a => a.id).join(', ');
        const desc = s.skillDescription ? ` — ${s.skillDescription}` : '';
        return `- **${s.skillEmoji ? s.skillEmoji + ' ' : ''}${s.skillName}** (id: \`${s.skillDir}\`)${desc}. ${s.actions.length} action(s): ${actionList}`;
      }).join('\n');
      const templateKey = wildcardSkillsActive ? 'lazy-skills-summary.wildcard' : 'lazy-skills-summary.stub';
      lazySkillSummary = renderLazyTemplate(templateKey, { skillsList }, opts.templatesMod);
    }
  }

  return {
    tools,
    lazySkillsActive,
    bypassUnified,
    skillCount: { full: fullSkillCount, emitted: skillDefsForPrompt.length },
    skillCallMode,
    lazySkillSummary,
  };
}

/** @deprecated Use `getAllTools()` + exec-gate in `executeTool`. Kept for potential legacy callers. */
export function getToolsForAgent(
  agentConfig: AgentConfig,
  opts?: {
    braveApiKey?: string;
    codebaseSearchAvailable?: boolean;
    reasoningAvailable?: boolean;
    memorySearchAvailable?: boolean;
    /** Skill action tool definitions (from SkillActionsModule) */
    skillActions?: ToolDefinition[];
    /** Whether the scheduler module is available */
    schedulerAvailable?: boolean;
    /** Whether the board module is available */
    boardAvailable?: boolean;
    /**
     * Current phase within the proactive pipeline.
     * - 'watcher'  = agent is running a proactive task (kind='proactive') → gets `escalate_to_agent`
     * - 'handler'  = agent is running an escalation triggered by a watcher → gets `send_to_user`
     * - undefined  = normal chat/task run → neither tool is exposed
     * The agent's own config (skills, tools, files) is NOT modified between phases — the
     * same full surface is available in all modes, only the proactive-specific tools toggle.
     */
    proactivePhase?: 'watcher' | 'handler';
  },
): ToolDefinition[] {
  const disabled = agentConfig.tools?.disabled ?? [];
  const systemAccess = agentConfig.tools?.systemAccess ?? false;

  let tools = [...TOOL_DEFINITIONS];

  // Filter out web_search if no Brave API key configured
  if (!opts?.braveApiKey) {
    tools = tools.filter(t => t.name !== 'web_search');
  }

  if (!opts?.codebaseSearchAvailable) {
    tools = tools.filter(t => !['codebase_search', 'codebase_search_read', 'codebase_search_list', 'shared_search'].includes(t.name));
  }

  if (!opts?.reasoningAvailable) {
    tools = tools.filter(t => t.name !== 'extended_reasoning');
  }

  if (!opts?.memorySearchAvailable) {
    tools = tools.filter(t => t.name !== 'memory_search');
  }

  if (!opts?.schedulerAvailable) {
    tools = tools.filter(t => !['schedule_task', 'list_scheduled_tasks', 'delete_scheduled_task', 'get_scheduled_task', 'update_scheduled_task', 'create_proactive_task', 'list_proactive_watchers'].includes(t.name));
  }

  if (!opts?.boardAvailable) {
    tools = tools.filter(t => !['board_write', 'board_delete'].includes(t.name));
  }

  // escalate_to_agent and send_to_user are always available — agents decide when to use them.
  // No phase gating: any agent can escalate or deliver in any context (chat, task, proactive, push).
  // Proactive side-effects of send_to_user (proactive.alert broadcast + markDelivered) are added
  // transparently by the executor when a proactive runId is present in the run context.

  // Filter out disabled tools
  if (disabled.length > 0) {
    tools = tools.filter(t => !disabled.includes(t.name));
  }

  // Apply system access description overrides so the LLM knows paths can be absolute
  if (systemAccess) {
    tools = tools.map(t => {
      const override = SYSTEM_ACCESS_OVERRIDES[t.name];
      return override ? { ...t, ...override } : t;
    });
  }

  // Append skill action tools — same surface as any normal run, no proactive-specific filter.
  if (opts?.skillActions?.length) {
    tools.push(...opts.skillActions);
  }

  return tools;
}

/**
 * Normalise un `scheduledAt` reçu d'un agent ou d'un client.
 *
 * Accepte trois formes :
 *   - ISO 8601 avec `Z` (UTC)            → renvoyé tel quel après round-trip Date
 *   - ISO 8601 avec offset `[+-]HH:MM`   → renvoyé tel quel après round-trip Date
 *   - Datetime "naïf" `YYYY-MM-DDTHH:MM(:SS)?` (sans TZ) → interprété en Europe/Paris
 *
 * Pourquoi : les agents ont déjà l'heure de Paris injectée dans leur prompt courant.
 * Les forcer à recalculer l'offset UTC (et la DST !) à chaque schedule_task est inutile —
 * un datetime naïf à interpréter localement est plus naturel.
 *
 * Retourne null si la chaîne n'est pas parseable.
 */
function normalizeScheduledAt(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // Avec timezone explicite → on round-trip via Date pour normaliser le format
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Naïf : YYYY-MM-DD[T| ]HH:MM(:SS)?
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    // Avoid host-TZ parsing: ambiguous local formats must not drift with the VPS timezone.
    return null;
  }

  const [, y, mo, da, hh, mi, ss] = m;
  // Wall-clock Paris → UTC :
  // 1) On construit l'instant UTC qui aurait l'horloge donnée si on était en UTC.
  // 2) On demande à Intl quel est l'offset Paris à cet instant (DST-aware).
  // 3) On retire l'offset pour obtenir l'instant UTC réel correspondant au wall-clock Paris.
  const pseudoUtcMs = Date.UTC(+y, +mo - 1, +da, +hh, +mi, ss ? +ss : 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    timeZoneName: 'longOffset',
  });
  const tzPart = fmt.formatToParts(new Date(pseudoUtcMs)).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
  const off = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  let offsetMs = 0;
  if (off) {
    const sign = off[1] === '+' ? 1 : -1;
    const oh = parseInt(off[2], 10);
    const om = off[3] ? parseInt(off[3], 10) : 0;
    offsetMs = sign * (oh * 60 + om) * 60_000;
  }
  return new Date(pseudoUtcMs - offsetMs).toISOString();
}

/**
 * Per-agent access gate for skill action invocations.
 *
 * Returns a soft-refuse message string when the call must be blocked, or null
 * when the call is authorized.
 *
 * Used by:
 *  - Direct `skill_*` dispatch in `executeTool` (the original gate, line ~1339)
 *  - `call_skill_action` wildcard handler — without this re-check, the wildcard
 *    would bypass the starredSkills curation and per-action allowOnly subset
 *    that direct `skill_*` calls are subject to.
 *
 * For sub-agents:
 *  - When `allowOnly` is populated, the inner `toolName` must be in that list.
 *    (The outer `call_skill_action` being in `allowOnly` does NOT grant access
 *    to the full skill catalogue — each action must be whitelisted individually.)
 *
 * For main agents:
 *  - The skill's dir must be in `promptInjection.starredSkills`.
 *  - If the agent has `allowOnly` populated AND at least one `skill_<dir>_*`
 *    action listed for the same dir, only those actions are authorized
 *    (per-action subset filter). No actions listed for a starred dir = all
 *    actions of that dir allowed (backward-compat).
 *
 * Notes:
 *  - If skillActionsMod can't resolve the toolName to a skillDir, the gate
 *    returns null (defer to the executor's "Unknown skill action" error).
 *  - Called AFTER the outer disabled/sub-allowOnly checks on `call.name` for
 *    direct `skill_*` dispatches; the sub-allowOnly inner check is only
 *    relevant in the wildcard path.
 */
function enforceSkillCallGate(
  toolName: string,
  agentCfg: AgentConfig,
  skillActionsMod: SkillActionsModule | undefined,
): string | null {
  if (!skillActionsMod) return null;
  if (!toolName.startsWith('skill_')) return null;
  const skillDir = skillActionsMod.getSkillDirForTool(toolName);
  if (!skillDir) return null; // unknown skill — let the executor surface the error
  const allowOnlyArr = Array.isArray(agentCfg.tools?.allowOnly) ? agentCfg.tools!.allowOnly! : [];
  const hasAllowOnly = allowOnlyArr.length > 0;
  const isSubAgent = agentCfg.kind === 'subagent';
  const subAllowOnly = isSubAgent && hasAllowOnly;
  if (subAllowOnly) {
    // Sub-agent: inner toolName must be explicitly whitelisted (the outer
    // call_skill_action passing the gate doesn't grant access to all skills).
    const allow = new Set(allowOnlyArr);
    if (!allow.has(toolName)) {
      console.warn(`[tool] gate-deny ${toolName} agent=${agentCfg.identity.id} (sub-agent inner allowOnly)`);
      return `${toolName}: cet outil n'est pas dans la liste allowOnly du preset sub-agent "${agentCfg.identity.id}".`;
    }
    return null; // sub-agent allowOnly is the authoritative check; starredSkills doesn't apply to subagents
  }
  // Main agent: starred filter + per-action allowOnly subset
  const starred = agentCfg.promptInjection?.starredSkills ?? [];
  if (!starred.includes(skillDir)) {
    console.warn(`[tool] gate-deny ${toolName} agent=${agentCfg.identity.id} (skill "${skillDir}" not starred)`);
    const starredStr = starred.length ? starred.join(', ') : 'aucun';
    return `${toolName}: skill "${skillDir}" non activé pour l'agent "${agentCfg.identity.id}". Skills activés : ${starredStr}.`;
  }
  if (hasAllowOnly) {
    const dirPrefix = `skill_${skillDir}_`;
    const dirActions = allowOnlyArr.filter(t => t.startsWith(dirPrefix));
    if (dirActions.length > 0 && !dirActions.includes(toolName)) {
      console.warn(`[tool] gate-deny ${toolName} agent=${agentCfg.identity.id} (action not in allowOnly subset of skill "${skillDir}")`);
      return `${toolName}: action non sélectionnée pour la skill "${skillDir}" sur l'agent "${agentCfg.identity.id}". Actions autorisées : ${dirActions.join(', ')}.`;
    }
  }
  return null;
}

export async function executeTool(
  call: ToolCall,
  workspacePath: string,
  opts: ToolExecOptions = {},
): Promise<string> {
  console.log(`[tool] dispatch ${call.name} id=${call.id} agent=${opts.currentAgentId ?? '?'} proactiveRunId=${opts.proactiveRunId ?? '-'}`);

  // ── Sub-agent maxToolCalls cap (P2.3) ──────────────────────────────────────
  // Compte tous les dispatches sauf submit_subagent_report (sortie obligatoire).
  // Quand dépassé, soft-refuse pour pousser le LLM à appeler submit.
  if (
    call.name !== 'submit_subagent_report'
    && opts.subAgentToolCallsCap != null
    && opts.subAgentToolCallsCounter
  ) {
    opts.subAgentToolCallsCounter.count += 1;
    if (opts.subAgentToolCallsCounter.count > opts.subAgentToolCallsCap) {
      console.warn(
        `[tool] sub-agent maxToolCalls exceeded ${opts.subAgentToolCallsCounter.count}/${opts.subAgentToolCallsCap} — soft-refuse ${call.name} (agent=${opts.currentAgentId ?? '?'})`,
      );
      return `${call.name}: sub-agent tool-call cap reached (${opts.subAgentToolCallsCap}). Stop tool calls and submit your final report now via submit_subagent_report (you may pass caps_hit="tool_calls").`;
    }
  }

  // ── Per-agent exec gate ────────────────────────────────────────────────────
  // The tools list is unified across agents (see getAllTools) to preserve the KV cache.
  // Per-agent restrictions (`tools.disabled`, `promptInjection.starredSkills`) are enforced
  // here with a soft-refuse return value so the model can try an alternative on the next turn.
  const agentCfg = opts.agentConfig;
  if (agentCfg) {
    const disabled = agentCfg.tools?.disabled ?? [];
    if (disabled.includes(call.name)) {
      console.warn(`[tool] gate-deny ${call.name} agent=${agentCfg.identity.id} (disabled)`);
      return `${call.name}: ce tool est désactivé pour l'agent "${agentCfg.identity.id}". Essaie un autre outil ou demande à l'utilisateur.`;
    }

    const allowOnlyArr = Array.isArray(agentCfg.tools?.allowOnly) ? agentCfg.tools!.allowOnly! : [];
    const hasAllowOnly = allowOnlyArr.length > 0;
    const isSubAgent = agentCfg.kind === 'subagent';
    // Sub-agent: allowOnly is a strict whitelist over EVERYTHING (core + skill_*).
    const subAllowOnly = isSubAgent && hasAllowOnly;
    if (subAllowOnly) {
      const allow = new Set([...allowOnlyArr, 'submit_subagent_report']);
      if (!allow.has(call.name)) {
        console.warn(`[tool] gate-deny ${call.name} agent=${agentCfg.identity.id} (sub-agent allowOnly)`);
        return `${call.name}: cet outil n'est pas dans la liste allowOnly du preset sub-agent "${agentCfg.identity.id}".`;
      }
    }

    // Per-skill access gate (starredSkills + per-action allowOnly subset for main agents,
    // skipped for sub-agents because subAllowOnly above already vetted call.name against
    // the whitelist). Extracted into enforceSkillCallGate so the wildcard handler
    // (case 'call_skill_action') can re-apply the same check on its inner toolName.
    if (call.name.startsWith('skill_') && !subAllowOnly) {
      const gateError = enforceSkillCallGate(call.name, agentCfg, opts.skillActionsMod);
      if (gateError) return gateError;
    }
  }

  const args = call.arguments;
  const systemAccess = opts.systemAccess ?? false;
  const allowedPathRoots = opts.allowedPathRoots ?? [];
  console.debug(
    `[tool] args ${call.name} id=${call.id} keys=${Object.keys(args).join(',') || 'none'} systemAccess=${systemAccess} roots=${allowedPathRoots.length}`,
  );

  switch (call.name) {
    case 'bash': {
      // Per-call timeout takes precedence, then global override, then default
      const timeout = typeof args['timeout_ms'] === 'number'
        ? args['timeout_ms']
        : (opts.bashTimeoutMs ?? 30_000);
      return execBash(String(args['cmd'] ?? ''), workspacePath, timeout);
    }

    case 'read_file':
      console.debug(`[tool:read_file] path=${String(args['path'] ?? '')} lines=${String(args['lines'] ?? '') || 'auto'} offset=${args['offset'] ?? 'none'} limit=${args['limit'] ?? 'none'}`);
      return readFile(
        String(args['path'] ?? ''),
        workspacePath,
        systemAccess,
        allowedPathRoots,
        typeof args['lines'] === 'string' ? args['lines'] : undefined,
        typeof args['offset'] === 'number' ? args['offset'] : undefined,
        typeof args['limit'] === 'number' ? args['limit'] : undefined,
      );

    case 'write_file':
      console.log(`[tool:write_file] path=${String(args['path'] ?? '')} contentLen=${String(args['content'] ?? '').length}`);
      return writeFile(String(args['path'] ?? ''), String(args['content'] ?? ''), workspacePath, systemAccess, allowedPathRoots);

    case 'list_dir':
      console.debug(`[tool:list_dir] path=${String(args['path'] ?? '.')}`);
      return listDir(String(args['path'] ?? '.'), workspacePath, systemAccess, allowedPathRoots);

    case 'edit_file':
      console.log(`[tool:edit_file] path=${String(args['path'] ?? '')} oldLen=${String(args['old_string'] ?? '').length} newLen=${String(args['new_string'] ?? '').length} replaceAll=${args['replace_all'] === true}`);
      return editFile(
        String(args['path'] ?? ''),
        String(args['old_string'] ?? ''),
        String(args['new_string'] ?? ''),
        args['replace_all'] === true,
        workspacePath,
        systemAccess,
        allowedPathRoots,
      );

    case 'shared_read':
      console.debug(`[tool:shared_read] path=${String(args['path'] ?? '')} lines=${String(args['lines'] ?? '') || 'auto'} offset=${args['offset'] ?? 'none'} limit=${args['limit'] ?? 'none'}`);
      return sharedRead(
        String(args['path'] ?? ''),
        opts.sharedMemoryDir,
        typeof args['lines'] === 'string' ? args['lines'] : undefined,
        typeof args['offset'] === 'number' ? args['offset'] : undefined,
        typeof args['limit'] === 'number' ? args['limit'] : undefined,
      );

    case 'shared_write':
      console.log(`[tool:shared_write] path=${String(args['path'] ?? '')} contentLen=${String(args['content'] ?? '').length}`);
      return sharedWrite(
        String(args['path'] ?? ''),
        String(args['content'] ?? ''),
        opts.sharedMemoryDir,
      );

    case 'shared_list':
      console.debug(`[tool:shared_list] path=${String(args['path'] ?? '.')} recursive=${args['recursive'] === true}`);
      return sharedList(
        typeof args['path'] === 'string' ? args['path'] : undefined,
        opts.sharedMemoryDir,
        args['recursive'] === true,
        typeof args['depth'] === 'number' ? args['depth'] : undefined,
      );

    case 'shared_search':
      console.debug(`[tool:shared_search] query="${String(args['query'] ?? '').slice(0, 60)}"`);
      return sharedSearch(
        String(args['query'] ?? ''),
        opts.sharedMemoryDir,
        opts.codebaseSearch,
        {
          limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
          type: args['type'] === 'vector' ? 'vector' : 'hybrid',
        },
      );

    case 'shared_edit':
      console.log(`[tool:shared_edit] path=${String(args['path'] ?? '')} oldLen=${String(args['old_string'] ?? '').length} newLen=${String(args['new_string'] ?? '').length} replaceAll=${args['replace_all'] === true}`);
      return sharedEdit(
        String(args['path'] ?? ''),
        String(args['old_string'] ?? ''),
        String(args['new_string'] ?? ''),
        args['replace_all'] === true,
        opts.sharedMemoryDir,
      );

    case 'memory_write':
      console.log(`[tool:memory_write] mode=${args['mode'] === 'overwrite' ? 'overwrite' : 'append'} scope=${args['scope'] === 'shared' ? 'shared' : 'agent'} contentLen=${String(args['content'] ?? '').length}`);
      return memoryWrite(
        String(args['content'] ?? ''),
        (args['mode'] === 'overwrite' ? 'overwrite' : 'append'),
        workspacePath,
        {
          memoryStore: opts.memoryStore?.module,
          agentId: opts.memoryStore?.agentId,
          section: typeof args['section'] === 'string' ? args['section'] : undefined,
          enableDeduplication: opts.enableDeduplication,
          deduplicationThreshold: opts.deduplicationThreshold,
          bypassSignificanceFilter: opts.bypassSignificanceFilter,
          scope: args['scope'] === 'shared' ? 'shared' : 'agent',
        },
      );

    case 'memory_search': {
      if (!opts.memoryStore?.module.isEnabled) {
        console.warn(`[tool:memory_search] unavailable agent=${opts.currentAgentId ?? '?'}`);
        return 'memory_search: le MemoryStore vectoriel n\'est pas activé. Utilisez read_file("MEMORY.md") à la place.';
      }
      console.debug(`[tool:memory_search] queryLen=${String(args['query'] ?? '').length} scope=${String(args['scope'] ?? 'all')} topK=${args['top_k'] ?? 'default'}`);
      return executeMemorySearchTool(
        {
          memoryStore: opts.memoryStore.module,
          agentId: opts.memoryStore.agentId,
          excludeShared: opts.memoryStore.excludeShared === true,
        },
        args as Record<string, unknown>,
      );
    }

    case 'session_search': {
      if (!opts.sessionModule) {
        console.warn(`[tool:session_search] sessionModule unavailable agent=${opts.currentAgentId ?? '?'}`);
        return 'session_search: indisponible (module session absent).';
      }
      console.debug(`[tool:session_search] queryLen=${String(args['query'] ?? '').length} allAgents=${args['all_agents'] === true} agent=${opts.currentAgentId ?? '?'}`);
      return executeSessionSearchTool(
        { sessionModule: opts.sessionModule, agentId: opts.currentAgentId ?? '' },
        args as Record<string, unknown>,
      );
    }

    case 'web_fetch':
      console.log(`[tool:web_fetch] url=${String(args['url'] ?? '').slice(0, 200)} maxChars=${opts.webFetchMaxChars ?? 'default'}`);
      return webFetch(String(args['url'] ?? ''), opts.webFetchMaxChars);

    case 'web_search': {
      if (!opts.braveApiKey) {
        console.warn('[tool:web_search] missing Brave API key');
        throw new Error('web_search requires a Brave API key (search.braveApiKey in config)');
      }
      const count = typeof args['count'] === 'number' ? args['count'] : 5;
      console.log(`[tool:web_search] queryLen=${String(args['query'] ?? '').length} count=${count}`);
      return braveSearch(String(args['query'] ?? ''), opts.braveApiKey, count);
    }

    case 'codebase_search': {
      if (!opts.codebaseSearch) {
        // Soft-fail — the tool is exposed uniformly to all agents for prefix-cache sharing,
        // but this particular agent has no index configured.
        console.warn(`[tool:codebase_search] unavailable agent=${opts.currentAgentId ?? '?'}`);
        return `codebase_search: aucun index configuré pour l'agent "${opts.currentAgentId ?? '?'}". Ajoute un index via \`tools.codebaseSearchIndices\` dans sa config.`;
      }
      console.debug(`[tool:codebase_search] dispatch agent=${opts.codebaseSearch.agentId} queryLen=${String(args['query'] ?? '').length}`);
      return executeCodebaseSearchTool(
        {
          mastermindConfig: opts.codebaseSearch.mastermindConfig,
          resolvePath: opts.codebaseSearch.resolvePath,
          agentId: opts.codebaseSearch.agentId,
        },
        args as Record<string, unknown>,
      );
    }

    case 'codebase_search_read': {
      if (!opts.codebaseSearch) {
        console.warn(`[tool:codebase_search_read] unavailable agent=${opts.currentAgentId ?? '?'}`);
        return `codebase_search_read: aucun index configuré pour l'agent "${opts.currentAgentId ?? '?'}".`;
      }
      return executeCodebaseSearchReadFile(
        {
          mastermindConfig: opts.codebaseSearch.mastermindConfig,
          resolvePath: opts.codebaseSearch.resolvePath,
        },
        args as Record<string, unknown>,
      );
    }

    case 'codebase_search_list': {
      if (!opts.codebaseSearch) {
        console.warn(`[tool:codebase_search_list] unavailable agent=${opts.currentAgentId ?? '?'}`);
        return `codebase_search_list: aucun index configuré pour l'agent "${opts.currentAgentId ?? '?'}".`;
      }
      return executeCodebaseSearchListDir(
        {
          mastermindConfig: opts.codebaseSearch.mastermindConfig,
          resolvePath: opts.codebaseSearch.resolvePath,
        },
        args as Record<string, unknown>,
      );
    }

    case 'schedule_task': {
      if (!opts.schedulerModule) {
        throw new Error('schedule_task requires the scheduler module');
      }
      const hasCron = typeof args['cronExpression'] === 'string' && args['cronExpression'] !== '';
      const scheduleKind = hasCron ? 'cron' as const : 'once' as const;

      // Normalise le datetime : naïf accepté (interprété Europe/Paris).
      let scheduledAtIso: string | undefined;
      if (!hasCron) {
        const raw = typeof args['scheduledAt'] === 'string' ? args['scheduledAt'] : '';
        if (!raw) {
          return 'schedule_task: scheduledAt requis pour une tache ponctuelle (ou fournis cronExpression).';
        }
        const normalized = normalizeScheduledAt(raw);
        if (!normalized) {
          return `schedule_task: scheduledAt "${raw}" non parseable. Format attendu: YYYY-MM-DDTHH:MM (heure Paris) ou ISO 8601 avec offset.`;
        }
        scheduledAtIso = normalized;
      }

      console.log(`[tool:schedule_task] Creating ${scheduleKind} task "${args['name']}" for agent=${opts.currentAgentId} ${hasCron ? `cron=${args['cronExpression']}` : `at=${scheduledAtIso} (raw="${args['scheduledAt']}")`}`);
      const task = await opts.schedulerModule.createTask({
        name: String(args['name'] ?? 'Tache sans nom'),
        agentId: opts.currentAgentId ?? 'unknown',
        prompt: String(args['prompt'] ?? ''),
        scheduleKind,
        scheduledAt: scheduledAtIso,
        cronExpression: hasCron ? String(args['cronExpression']) : undefined,
        createdBy: 'agent',
      });
      return `Tache "${task.name}" creee (id=${task.id}). Prochaine execution: ${task.nextRunAt ?? 'non planifiee'}.`;
    }

    case 'list_scheduled_tasks': {
      if (!opts.schedulerModule) {
        throw new Error('list_scheduled_tasks requires the scheduler module');
      }
      const filterAgent = typeof args['agentId'] === 'string' ? args['agentId'] : undefined;
      console.log(`[tool:list_scheduled_tasks] Listing tasks${filterAgent ? ` for agent=${filterAgent}` : ' (all agents)'}`);
      const tasks = await opts.schedulerModule.listTasks(filterAgent);
      if (tasks.length === 0) return 'Aucune tache planifiee.';
      return tasks.map(t => {
        const schedule = t.scheduleKind === 'cron' ? `cron: ${t.cronExpression}` : `ponctuel: ${t.scheduledAt ?? '?'}`;
        const kindBadge = t.kind === 'proactive'
          ? `[PROACTIVE watcher=${t.agentId} handler=${t.escalationAgentId ?? '?'} threshold=${t.severityThreshold ?? 'medium'}]`
          : `agent=${t.agentId}`;
        return `- [${t.id}] "${t.name}" (${schedule}) ${kindBadge} enabled=${t.enabled} prochain=${t.nextRunAt ?? 'aucun'} dernier=${t.lastRunStatus ?? 'jamais'}`;
      }).join('\n');
    }

    case 'delete_scheduled_task': {
      if (!opts.schedulerModule) {
        throw new Error('delete_scheduled_task requires the scheduler module');
      }
      const taskId = String(args['taskId'] ?? '');
      if (!taskId) return 'Erreur: taskId requis.';
      console.log(`[tool:delete_scheduled_task] Deleting task ${taskId}`);
      const deleted = await opts.schedulerModule.deleteTask(taskId);
      return deleted ? `Tache ${taskId} supprimee.` : `Tache ${taskId} introuvable.`;
    }

    case 'get_scheduled_task': {
      if (!opts.schedulerModule) {
        throw new Error('get_scheduled_task requires the scheduler module');
      }
      const taskId = String(args['taskId'] ?? '').trim();
      if (!taskId) return 'Erreur: taskId requis.';
      console.log(`[tool:get_scheduled_task] Fetching task ${taskId}`);
      const task = await opts.schedulerModule.getTask(taskId);
      if (!task) {
        console.warn(`[tool:get_scheduled_task] not found id=${taskId}`);
        return `Tache ${taskId} introuvable. Utilise list_scheduled_tasks pour voir les IDs disponibles.`;
      }
      // Last 5 runs for context (status + duration + escalation flag).
      const runs = await opts.schedulerModule.getTaskRuns(taskId, 5);
      const lines: string[] = [];
      lines.push(`Tache [${task.id}] "${task.name}"`);
      lines.push(`  agent=${task.agentId} kind=${task.kind} createdBy=${task.createdBy}`);
      const schedule = task.scheduleKind === 'cron'
        ? `cron="${task.cronExpression ?? '?'}"`
        : `ponctuel scheduledAt=${task.scheduledAt ?? '?'}`;
      lines.push(`  schedule: ${schedule} enabled=${task.enabled} deleteAfterRun=${task.deleteAfterRun}`);
      lines.push(`  prochain run: ${task.nextRunAt ?? 'aucun (desactivee ou ponctuelle deja executee)'}`);
      lines.push(`  dernier run: ${task.lastRunAt ?? 'jamais'} status=${task.lastRunStatus ?? 'n/a'}`);
      if (task.kind === 'proactive') {
        lines.push(`  proactive: handler=${task.escalationAgentId ?? '?'} severityThreshold=${task.severityThreshold ?? 'medium'}`);
      }
      lines.push(`  cree: ${task.createdAt} | maj: ${task.updatedAt}`);
      lines.push(`  prompt:`);
      lines.push(task.prompt.split('\n').map(l => `    ${l}`).join('\n'));
      if (runs.length > 0) {
        lines.push(`  derniers runs (${runs.length}):`);
        for (const r of runs) {
          const dur = typeof r.durationMs === 'number' ? `${(r.durationMs / 1000).toFixed(1)}s` : 'n/a';
          const flags = [r.escalated ? 'escalated' : null, r.delivered ? 'delivered' : null].filter(Boolean).join(',');
          lines.push(`    - ${r.startedAt} status=${r.status} duration=${dur}${flags ? ` flags=[${flags}]` : ''}${r.error ? ` error="${r.error.slice(0, 80)}"` : ''}`);
        }
      } else {
        lines.push(`  derniers runs: aucun`);
      }
      return lines.join('\n');
    }

    case 'update_scheduled_task': {
      if (!opts.schedulerModule) {
        throw new Error('update_scheduled_task requires the scheduler module');
      }
      const taskId = String(args['taskId'] ?? '').trim();
      if (!taskId) return 'Erreur: taskId requis.';

      // Build a partial UpdateTaskInput from the args, leaving untouched fields out so
      // the scheduler module's `updateTask` merges with the existing row.
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];

      if (typeof args['name'] === 'string' && args['name'].trim()) {
        patch['name'] = args['name'].trim();
        changes.push('name');
      }
      if (typeof args['prompt'] === 'string' && args['prompt'].trim()) {
        patch['prompt'] = args['prompt'].trim();
        changes.push('prompt');
      }
      if (typeof args['enabled'] === 'boolean') {
        patch['enabled'] = args['enabled'];
        changes.push(`enabled=${args['enabled']}`);
      }
      if (args['severityThreshold'] === 'low' || args['severityThreshold'] === 'medium' || args['severityThreshold'] === 'high') {
        patch['severityThreshold'] = args['severityThreshold'];
        changes.push(`severity=${args['severityThreshold']}`);
      }

      // Schedule transitions: passing one of cron/scheduledAt switches the schedule kind
      // and clears the other field. Refuse passing both (ambiguous).
      const hasCron = typeof args['cronExpression'] === 'string' && (args['cronExpression'] as string).trim() !== '';
      const hasOnce = typeof args['scheduledAt'] === 'string' && (args['scheduledAt'] as string).trim() !== '';
      if (hasCron && hasOnce) {
        return 'update_scheduled_task: ne fournis que cronExpression OU scheduledAt, pas les deux.';
      }
      if (hasCron) {
        patch['scheduleKind'] = 'cron';
        patch['cronExpression'] = (args['cronExpression'] as string).trim();
        patch['scheduledAt'] = undefined; // clear the one-shot side
        changes.push(`cron="${patch['cronExpression']}"`);
      } else if (hasOnce) {
        const normalized = normalizeScheduledAt((args['scheduledAt'] as string).trim());
        if (!normalized) {
          return `update_scheduled_task: scheduledAt "${args['scheduledAt']}" non parseable. Format attendu: YYYY-MM-DDTHH:MM (heure Paris) ou ISO 8601 avec offset.`;
        }
        patch['scheduleKind'] = 'once';
        patch['scheduledAt'] = normalized;
        patch['cronExpression'] = undefined; // clear the recurring side
        changes.push(`scheduledAt=${normalized}`);
      }

      if (changes.length === 0) {
        return 'update_scheduled_task: aucun champ a modifier — fournis au moins un parametre (name, prompt, scheduledAt, cronExpression, enabled, severityThreshold).';
      }

      console.log(`[tool:update_scheduled_task] task=${taskId} changes=${changes.join(',')}`);
      try {
        const updated = await opts.schedulerModule.updateTask(taskId, patch as Parameters<typeof opts.schedulerModule.updateTask>[1]);
        if (!updated) {
          return `Tache ${taskId} introuvable. Utilise list_scheduled_tasks pour voir les IDs disponibles.`;
        }
        const scheduleStr = updated.scheduleKind === 'cron'
          ? `cron "${updated.cronExpression}"`
          : `ponctuel ${updated.scheduledAt}`;
        return `Tache "${updated.name}" (${taskId}) mise a jour [${changes.join(', ')}]. Schedule: ${scheduleStr}, enabled=${updated.enabled}, prochain run: ${updated.nextRunAt ?? 'aucun'}.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tool:update_scheduled_task] failed task=${taskId}: ${msg}`);
        return `update_scheduled_task: erreur lors de la mise a jour — ${msg}`;
      }
    }

    case 'list_proactive_watchers': {
      if (!opts.agentsList || opts.agentsList.length === 0) {
        console.warn('[tool:list_proactive_watchers] no agentsList in context');
        return 'Aucun agent disponible dans le contexte.';
      }
      // N'importe quel agent actif peut etre assigne comme watcher — sauf l'appelant
      // (qui devient automatiquement le handler, donc doit etre different).
      const candidates = opts.agentsList.filter(a =>
        a.enabled !== false && a.identity.id !== opts.currentAgentId,
      );
      if (candidates.length === 0) {
        console.warn(`[tool:list_proactive_watchers] no candidates caller=${opts.currentAgentId ?? '?'}`);
        return 'Aucun autre agent disponible pour servir de watcher. Il faut au moins un deuxieme agent actif dans la config.';
      }
      console.debug(`[tool:list_proactive_watchers] candidates=${candidates.length} caller=${opts.currentAgentId ?? '?'}`);
      return candidates.map(w => {
        const model = w.model.split('/').pop() ?? w.model;
        const starred = w.promptInjection?.starredSkills?.length
          ? w.promptInjection.starredSkills.join(', ')
          : '(aucun skill star)';
        return `- ${w.identity.id} ("${w.identity.name}") modele=${model} starredSkills=[${starred}]`;
      }).join('\n');
    }

    case 'create_proactive_task': {
      if (!opts.schedulerModule) {
        throw new Error('create_proactive_task requires the scheduler module');
      }
      if (!opts.currentAgentId) {
        return 'create_proactive_task: contexte agent manquant (currentAgentId).';
      }
      const name = String(args['name'] ?? '').trim();
      const watcherAgentId = String(args['watcherAgentId'] ?? '').trim();
      const prompt = String(args['prompt'] ?? '').trim();
      const cronExpression = String(args['cronExpression'] ?? '').trim();
      const severityThreshold = (args['severityThreshold'] === 'low' || args['severityThreshold'] === 'high'
        ? args['severityThreshold']
        : 'medium') as 'low' | 'medium' | 'high';

      if (!name || !watcherAgentId || !prompt || !cronExpression) {
        return 'create_proactive_task: name, watcherAgentId, prompt et cronExpression sont requis.';
      }
      if (watcherAgentId === opts.currentAgentId) {
        return 'create_proactive_task: le watcher doit etre different de toi (tu es automatiquement le handler). Utilise list_proactive_watchers pour voir les watchers disponibles.';
      }

      // Validate watcher exists and is enabled
      if (opts.agentsList) {
        const watcher = opts.agentsList.find(a => a.identity.id === watcherAgentId);
        if (!watcher) {
          return `create_proactive_task: agent "${watcherAgentId}" introuvable. Utilise list_proactive_watchers pour voir les agents disponibles.`;
        }
        if (watcher.enabled === false) {
          return `create_proactive_task: l'agent "${watcherAgentId}" est desactive. Choisis un agent actif.`;
        }
      }

      console.log(`[tool:create_proactive_task] agent=${opts.currentAgentId} (handler) watcher=${watcherAgentId} cron=${cronExpression}`);
      try {
        const task = await opts.schedulerModule.createTask({
          name,
          agentId: watcherAgentId,
          prompt,
          scheduleKind: 'cron',
          cronExpression,
          kind: 'proactive',
          escalationAgentId: opts.currentAgentId,
          severityThreshold,
          createdBy: 'agent',
        });
        return `Routine proactive "${task.name}" (${task.id}) creee. Watcher=${task.agentId} Handler=${task.escalationAgentId} Cron=${task.cronExpression} Threshold=${task.severityThreshold}. Prochain run: ${task.nextRunAt ?? 'non planifie'}.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `create_proactive_task: erreur lors de la creation — ${msg}`;
      }
    }

    case 'skill_create': {
      if (!opts.skillActionsExecutor) {
        console.warn('[tool:skill_create] unavailable skill-actions module');
        throw new Error('skill_create requires the skill-actions module (skillsDir not configured)');
      }
      console.log(`[tool:skill_create] name=${String(args['skill_name'] ?? '')} actionsLen=${String(args['actions_yml'] ?? '').length} skillMdLen=${String(args['skill_md'] ?? '').length}`);
      // Delegate to the skill actions module's createSkill method via a special convention:
      // The executor recognizes '__create__' as a creation request
      return opts.skillActionsExecutor('__create__', {
        skill_name: String(args['skill_name'] ?? ''),
        actions_yml: String(args['actions_yml'] ?? ''),
        skill_md: typeof args['skill_md'] === 'string' ? args['skill_md'] : undefined,
      });
    }

    case 'extended_reasoning': {
      if (!opts.reasoningConfig) {
        console.warn('[tool:extended_reasoning] unavailable reasoningConfig');
        throw new Error('extended_reasoning non configuré (aucun provider avec statsUrl + openrouter_reasoning_model dans Mercury)');
      }
      console.log(`[tool:extended_reasoning] promptLen=${String(args['prompt'] ?? '').length}`);
      return callReasoningModel(String(args['prompt'] ?? ''), opts.reasoningConfig);
    }

    case 'inspect_image': {
      if (!opts.visionConfig) {
        console.warn('[tool:inspect_image] unavailable visionConfig');
        return 'inspect_image: unavailable (no provider with statsUrl + openrouter_vision_model configured in Mercury).';
      }
      return executeInspectImage(args, {
        visionConfig: opts.visionConfig,
        workspacePath,
        systemAccess,
        allowedPathRoots,
      });
    }

    case 'board_write': {
      if (!opts.boardModule) {
        console.warn('[tool:board_write] unavailable board module');
        return 'board_write: board module not available';
      }
      try {
        const ttl = typeof args['ttl_hours'] === 'number' ? args['ttl_hours'] : undefined;
        console.log(`[tool:board_write] agent=${opts.currentAgentId ?? 'unknown'} contentLen=${String(args['content'] ?? '').length} ttlHours=${ttl ?? 'default'}`);
        const note = await opts.boardModule.write(
          opts.currentAgentId ?? 'unknown',
          String(args['content'] ?? ''),
          ttl,
        );
        return `Note posted on the board (id=${note.id}, expires ${note.expiresAt}). All agents will see it on their next turn.`;
      } catch (err) {
        console.warn(`[tool:board_write] failed: ${err instanceof Error ? err.message : err}`);
        return `board_write: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'board_delete': {
      if (!opts.boardModule) {
        console.warn('[tool:board_delete] unavailable board module');
        return 'board_delete: board module not available';
      }
      const noteId = String(args['note_id'] ?? '').trim();
      if (!noteId) return 'board_delete: note_id required';
      console.log(`[tool:board_delete] note=${noteId}`);
      const deleted = await opts.boardModule.deleteNote(noteId);
      if (!deleted) console.warn(`[tool:board_delete] note=${noteId} not found`);
      return deleted ? `Note ${noteId} deleted from the board.` : `Note ${noteId} not found (already expired or deleted).`;
    }

    case 'escalate_to_agent': {
      // No proactive-context gating: any agent can escalate from any context (chat, push, proactive).
      // The only gate is the per-agent tool execution policy (allow/deny) handled upstream.
      if (!opts.schedulerModule || !opts.currentAgentId) {
        console.warn(`[tool:escalate_to_agent] unavailable missing infra agent=${opts.currentAgentId ?? '?'} hasScheduler=${!!opts.schedulerModule}`);
        return 'escalate_to_agent: unavailable (scheduler module not loaded).';
      }
      return executeEscalateToAgent(args, {
        schedulerModule: opts.schedulerModule,
        ...(opts.proactiveRunId ? { activeRunId: opts.proactiveRunId } : {}),
        watcherAgentId: opts.currentAgentId,
      });
    }

    case 'send_to_user': {
      if (
        !opts.sessionModule ||
        !opts.ws ||
        !opts.mastermindConfig ||
        !opts.handlerAgentConfig ||
        !opts.currentSessionId
      ) {
        console.warn(`[tool:send_to_user] unavailable missing context agent=${opts.currentAgentId ?? '?'}`);
        return 'send_to_user: unavailable (missing run context — session/ws/handler config required).';
      }
      console.log(`[tool:send_to_user] agent=${opts.currentAgentId ?? '?'} session=${opts.currentSessionId} contentLen=${String(args['content'] ?? '').length} channel=${String(args['channel'] ?? 'auto')}`);
      return executeSendToUser(args, {
        sessionModule: opts.sessionModule,
        telegramModule: opts.telegramModule,
        pushModule: opts.pushModule,
        ws: opts.ws,
        mastermindConfig: opts.mastermindConfig,
        handlerAgentConfig: opts.handlerAgentConfig,
        sessionId: opts.currentSessionId,
        ...(opts.attachmentRoots ? { attachmentRoots: opts.attachmentRoots } : {}),
        // Proactive side-effects (proactive.alert broadcast + markDelivered) are added
        // transparently by the handler when these are set. The agent isn't aware.
        ...(opts.schedulerModule ? { schedulerModule: opts.schedulerModule } : {}),
        ...(opts.proactiveRunId ? { activeRunId: opts.proactiveRunId } : {}),
        ...(opts.visibleSource ? { visibleSource: opts.visibleSource } : {}),
        // v3 : type de run → trigger policy (interactive/proactive/task/sandbox). On préfère le
        // getter live de run.ts (sandbox flip + activeRunId non-proactif/cron kind='task' couverts) ;
        // fallback sur une dérivation locale si le getter est absent (chemins hors run.ts).
        runTrigger: opts.currentRunTrigger
          ? opts.currentRunTrigger()
          : runKindTrigger({
              ...(opts.currentRunSource ? { source: opts.currentRunSource } : {}),
              ...(opts.proactiveRunId ? { activeRunId: opts.proactiveRunId } : {}),
              ...(opts.isSandboxActive?.() ? { sandboxJobId: 'active' } : {}),
            }),
        // `!= null` et PAS truthy : `[]` = override "chat seul, aucun réveil" — un check
        // truthy l'avalerait et la policy reprendrait la main (bug hunt 2026-06-12).
        ...(opts.taskDeliveryChannels != null ? { taskDeliveryChannels: opts.taskDeliveryChannels } : {}),
        // KV-cache ordering: hand the queue down so the visible-content duplicate is
        // persisted AFTER run.ts has committed the tool_result row.
        ...(opts.pendingPostToolResult ? { pendingPostToolResult: opts.pendingPostToolResult } : {}),
      });
    }

    case 'dispatch_sandbox_run': {
      if (!opts.asyncJobsModule || !opts.currentAgentId || !opts.currentSessionId) {
        console.warn('[tool:dispatch_sandbox_run] unavailable missing async job/run context');
        return 'dispatch_sandbox_run: unavailable (async-jobs module or run context missing).';
      }
      if (opts.currentRunSource === 'sandbox' || opts.isSandboxActive?.()) {
        console.warn(`[tool:dispatch_sandbox_run] rejected already sandbox agent=${opts.currentAgentId}`);
        return 'dispatch_sandbox_run: already in sandbox mode — just continue with the task.';
      }
      if (!opts.setRunSource || !opts.setSandboxJobId) {
        console.warn('[tool:dispatch_sandbox_run] unavailable missing transition callbacks');
        return 'dispatch_sandbox_run: unavailable (run does not support sandbox mode transitions).';
      }
      const task = String(args['task'] ?? '').trim();
      if (!task) return 'dispatch_sandbox_run: "task" parameter is required.';
      console.log(`[tool:dispatch_sandbox_run] start agent=${opts.currentAgentId} session=${opts.currentSessionId} taskLen=${task.length}`);

      const { jobId } = await opts.asyncJobsModule.startSandboxTracking({
        agentId: opts.currentAgentId,
        sessionId: opts.currentSessionId,
        task,
      });

      // Flip the current run's source → subsequent messages + broadcasts become hidden.
      // No new run is spawned: the agent's next tool turn happens invisibly in the SAME run,
      // preserving the Mercury KV cache continuity (append-only, no prompt rebuild).
      opts.setRunSource('sandbox');
      opts.setSandboxJobId(jobId);

      // Push a transient "Sandbox démarrée" notice in the visible channel.
      //
      // NOT persisted in DB on purpose: this notice is a UI-only artifact, not part of the
      // conversation the LLM sees on subsequent turns. Persisting it would inject a fake
      // assistant turn into the prompt history, invalidate the KV cache prefix on the next
      // build, AND pollute the model's reasoning ("did I really say that?"). Instead we
      // broadcast a synthetic `session.message` for the web UI; on Telegram we send the
      // text directly via the bot API (Telegram itself is the persistence there).
      //
      // Why we need it: the agent's preamble before `dispatch_sandbox_run` ends up in a
      // tool_call_turn row (visible thanks to `sandbox_trigger`) on web, but on Telegram
      // the streaming text gets cleaned up when the live edit closes — the user loses
      // the trigger framing. A clean dedicated notice survives both UX issues.
      const truncatedTask = task.length > 200 ? task.slice(0, 200) + '…' : task;
      const startNoticeText = `🪁 Sandbox démarrée — ${truncatedTask}`;
      const visibleSource = opts.visibleSource ?? 'web';

      if (opts.ws && opts.currentSessionId) {
        const startNotice: ChatMessage = {
          id: `sandbox-start-${jobId}`,
          sessionId: opts.currentSessionId,
          role: 'assistant',
          content: startNoticeText,
          source: visibleSource,
          createdAt: new Date().toISOString(),
          metadata: { sandbox_start: true, sandbox_job_id: jobId, ephemeral: true },
        };
        opts.ws.broadcast(opts.currentSessionId, {
          type: 'session.message',
          sessionId: opts.currentSessionId,
          message: startNotice,
        } satisfies WsServerMessage);
      }

      if (visibleSource === 'telegram' && opts.telegramModule && opts.mastermindConfig && opts.handlerAgentConfig) {
        void deliverToTelegram({
          telegramModule: opts.telegramModule,
          mastermindConfig: opts.mastermindConfig,
          handlerAgentConfig: opts.handlerAgentConfig,
          content: startNoticeText,
          attachments: [],
        }).catch(err =>
          console.warn(`[tool:dispatch_sandbox_run] telegram start notice failed: ${err instanceof Error ? err.message : err}`),
        );
      }

      return (
        `Sandbox mode active (job ${jobId}). You are now working invisibly — your next ` +
        `turns won't appear in the chat.\n\n` +
        `**MANDATORY**: end this run with EXACTLY ONE \`send_to_user\` tool call carrying ` +
        `the final deliverable. Plain text written without \`send_to_user\` reaches NOBODY ` +
        `— it is persisted invisibly and discarded. If you finish the work and just emit ` +
        `text, the user sees nothing and the system flags an orphan sandbox.\n\n` +
        `Flow from here: execute the task → call \`send_to_user\` ONCE with the final ` +
        `result → done. Do not mention being in sandbox in your internal turns; only the ` +
        `\`send_to_user\` payload is what the user reads.`
      );
    }

    case 'list_my_jobs': {
      if (!opts.asyncJobsModule || !opts.currentAgentId) {
        console.warn('[tool:list_my_jobs] unavailable missing async job/currentAgent context');
        return 'list_my_jobs: unavailable (async-jobs module not loaded).';
      }
      const statusArg = String(args['status'] ?? 'active').toLowerCase();
      const limitArg = typeof args['limit'] === 'number' ? Math.min(50, Math.max(1, args['limit'])) : 20;
      const statusFilter = statusArg === 'all'
        ? undefined
        : (['queued', 'running'] as const);
      const jobs = await opts.asyncJobsModule.list({
        agentId: opts.currentAgentId,
        ...(statusFilter ? { status: [...statusFilter] } : {}),
        limit: limitArg,
      });
      console.debug(`[tool:list_my_jobs] agent=${opts.currentAgentId} status=${statusArg} limit=${limitArg} jobs=${jobs.length}`);
      if (jobs.length === 0) {
        return statusArg === 'active'
          ? 'No active async jobs. (Use status="all" to see history.)'
          : 'No async jobs on record.';
      }
      const now = Date.now();
      const lines: string[] = [];
      for (const j of jobs) {
        const shortId = j.id.slice(0, 8);
        const tool = j.toolName.replace(/^skill_/, '');
        if (j.status === 'running') {
          const elapsed = j.startedAt ? now - new Date(j.startedAt).getTime() : 0;
          lines.push(`- ${shortId} [running] ${tool} — ${Math.round(elapsed / 1000)}s elapsed`);
        } else if (j.status === 'queued') {
          const waited = now - new Date(j.createdAt).getTime();
          lines.push(`- ${shortId} [queued] ${tool} — ${Math.round(waited / 1000)}s waiting`);
        } else if (j.status === 'done') {
          const durMs = j.completedAt && j.startedAt
            ? new Date(j.completedAt).getTime() - new Date(j.startedAt).getTime()
            : 0;
          const files = j.outputFiles?.length ?? 0;
          lines.push(`- ${shortId} [done] ${tool} — ${Math.round(durMs / 1000)}s, ${files} file(s) delivered`);
        } else if (j.status === 'error') {
          lines.push(`- ${shortId} [error] ${tool} — ${(j.error ?? '').slice(0, 80)}`);
        } else {
          lines.push(`- ${shortId} [cancelled] ${tool}`);
        }
      }
      return `Async jobs (${jobs.length}):\n${lines.join('\n')}`;
    }

    case 'inspect_skill': {
      if (!opts.skillActionsMod) {
        return 'inspect_skill: skill-actions module non disponible.';
      }
      const skillId = String(args['skill_id'] ?? '').trim();
      if (!skillId) return 'inspect_skill: skill_id requis (id du skill comme indiqué dans le bloc "Available skills" du system prompt).';
      // bypass+lazy gate: the curated starredSkills list is the agent's authoritative
      // surface. ANY non-starred skill must be refused, including the empty-list case
      // (zero starred = zero accessible skills, NOT all-accessible). The previous
      // `starred.length > 0` early-out leaked all skills when the curated list was empty.
      // Sub-agent + allowOnly : la liste blanche prime sur starredSkills (sinon inspect_skill
      // serait inutilisable pour des skills non étoilés alors que leurs toolNames sont dans allowOnly).
      const subAllowInspect =
        opts.agentConfig?.kind === 'subagent'
        && opts.agentConfig.tools?.allowOnly
        && opts.agentConfig.tools.allowOnly.length > 0;
      if (opts.agentConfig?.bypassUnifiedCache && opts.agentConfig.lazySkills && !subAllowInspect) {
        const starred = opts.agentConfig.promptInjection?.starredSkills ?? [];
        if (!starred.includes(skillId)) {
          console.warn(`[tool:inspect_skill] gate-deny agent=${opts.currentAgentId ?? '?'} skill=${skillId} (not starred under bypass+lazy, starred=[${starred.join(',')}])`);
          const starredStr = starred.length > 0 ? starred.join(', ') : '(aucun)';
          return `inspect_skill: skill "${skillId}" non disponible pour cet agent (skills activés : ${starredStr}).`;
        }
      }
      const rendered = opts.skillActionsMod.renderSkillInspection(skillId);
      if (!rendered) {
        console.warn(`[tool:inspect_skill] unknown skill_id=${skillId} agent=${opts.currentAgentId ?? '?'}`);
        return `inspect_skill: skill "${skillId}" introuvable. Vérifie l'id dans le bloc "Available skills" du system prompt.`;
      }
      console.log(`[tool:inspect_skill] agent=${opts.currentAgentId ?? '?'} skill=${skillId} chars=${rendered.length}`);
      return rendered;
    }

    case 'list_subagents': {
      if (!opts.agentsList) {
        console.warn('[tool:list_subagents] unavailable missing agentsList');
        return 'list_subagents: unavailable (agent registry not loaded).';
      }
      const subAgents = opts.agentsList.filter(a => a.kind === 'subagent');
      if (subAgents.length === 0) {
        return 'list_subagents: no sub-agents are configured. Ask the user to add one via the Sub-agents page or mastermind.yml.';
      }
      const callerId = opts.currentAgentId ?? '';
      const lines = subAgents.map(a => {
        const enabled = a.enabled === false ? ' `[DISABLED]`' : '';
        const allowedNote = (() => {
          const allowed = a.allowedCallers ?? [];
          if (allowed.length === 0) return 'all main agents';
          if (callerId && !allowed.includes(callerId)) return `${allowed.join(',')} (NOT YOU — you can't spawn this one)`;
          return allowed.join(',');
        })();
        const caps = a.caps ?? {};
        const capsStr = [
          caps.maxIterations ? `iter=${caps.maxIterations}` : 'iter=15',
          caps.maxToolCalls ? `tool_calls=${caps.maxToolCalls}` : 'tool_calls=30',
          caps.maxOutputTokens ? `tok=${caps.maxOutputTokens}` : 'tok=8000',
          caps.timeoutSeconds ? `timeout=${caps.timeoutSeconds}s` : 'timeout=300s',
        ].join(' ');
        const model = a.model ? a.model.split('/').pop() ?? a.model : '';
        const roster = formatAgentRosterLine(a, 'subagent');
        return `${roster}${enabled} · **Technical:** model=\`${model}\` · callers=[${allowedNote}] · caps=[${capsStr}]`;
      });
      console.debug(`[tool:list_subagents] caller=${callerId} returning ${subAgents.length} sub-agent(s)`);
      return (
        `Configured sub-agents (${subAgents.length}):\n${lines.join('\n')}\n\n` +
        `Use \`spawn_subagent(preset, prompt)\` with one of the IDs above. ` +
        `If a sub-agent's callers list shows "NOT YOU", you can't spawn that one — pick another or tell the user.`
      );
    }

    case 'spawn_subagent': {
      if (!opts.asyncJobsModule || !opts.currentAgentId || !opts.currentSessionId || !opts.agentsList) {
        console.warn('[tool:spawn_subagent] unavailable missing async-jobs/agentsList/run context');
        return 'spawn_subagent: unavailable (async-jobs module or run context missing).';
      }
      // Anti-recursion exec-side double check (getAllTools already hides the tool when source==='subagent',
      // but we re-verify here as defense in depth — a misconfigured registry shouldn't cascade).
      if (opts.currentRunSource === 'subagent' || opts.agentConfig?.kind === 'subagent') {
        console.warn(`[tool:spawn_subagent] rejected recursion exec-time agent=${opts.currentAgentId}`);
        return 'spawn_subagent: sub-agents cannot spawn other sub-agents (anti-recursion).';
      }
      // Lazily init counter — first spawn in this run.
      if (!opts.spawnSubagentsCounter) opts.spawnSubagentsCounter = { count: 0 };
      const limit = opts.spawnSubagentsLimit ?? 5;
      // Resolve parent's native visible channel — falls back to 'web' if absent or 'sandbox'/etc.
      const parentVisibleSource: 'web' | 'telegram' | undefined =
        opts.visibleSource === 'telegram' ? 'telegram'
          : opts.visibleSource === 'web' ? 'web'
          : undefined;
      return executeSpawnSubagent(args as Record<string, unknown>, {
        asyncJobsModule: opts.asyncJobsModule,
        agentsList: opts.agentsList,
        currentAgentId: opts.currentAgentId,
        callerConfig: opts.agentConfig,
        currentSessionId: opts.currentSessionId,
        spawnCounter: opts.spawnSubagentsCounter,
        spawnsLimit: limit,
        ...(opts.mastermindConfig ? { mastermindConfig: opts.mastermindConfig } : {}),
        ...(parentVisibleSource ? { parentVisibleSource } : {}),
      });
    }

    case 'submit_subagent_report': {
      // Submit persists DB (+ optional disk under paths.subagentReportsDir); parent re-run
      // is triggered by runSubAgent post-loop in async-jobs/index.ts.
      return executeSubmitSubagentReport(args as Record<string, unknown>, {
        subAgentDelivery: opts.subAgentDelivery,
        subAgentDeliveryState: opts.subAgentDeliveryState,
        db: opts.db,
        sessionModule: opts.sessionModule,
        ws: opts.ws,
        ...(opts.mastermindConfig ? { mastermindConfig: opts.mastermindConfig } : {}),
        ...(opts.resolveConfigPath ? { resolveConfigPath: opts.resolveConfigPath } : {}),
      });
    }

    case 'call_skill_action': {
      // Wildcard dispatch — forward to the same skillActionsExecutor used for direct
      // skill_* calls. The agent must have done an inspect_skill first to know toolName
      // and args shape (mirrored in the tool description).
      //
      // SECURITY: re-validate the INNER toolName against the same gates that direct
      // skill_* invocations face. Without this, an agent in bypass+lazy+starred mode
      // could bypass starredSkills curation by wrapping any loaded skill in
      // call_skill_action, and a sub-agent with allowOnly could access the full skill
      // catalogue by smuggling the toolName through the wildcard.
      // skillActionsExecutor itself does NOT enforce these per-agent gates — it just
      // does a Map lookup on byToolName.
      const toolName = String(args['toolName'] ?? '').trim();
      const toolArgs = (args['args'] && typeof args['args'] === 'object' ? args['args'] : {}) as Record<string, unknown>;
      if (!toolName) return 'call_skill_action: toolName requis (récupère-le via inspect_skill).';
      if (!toolName.startsWith('skill_')) return `call_skill_action: toolName invalide "${toolName}" (doit commencer par skill_).`;
      if (!opts.skillActionsExecutor) return 'call_skill_action: skill-actions executor non disponible.';
      // Apply the per-skill gate on the inner toolName. The helper handles both
      // sub-agent inner-allowOnly and main-agent starred + per-action subset.
      if (opts.agentConfig) {
        const gateError = enforceSkillCallGate(toolName, opts.agentConfig, opts.skillActionsMod);
        if (gateError) return gateError;
      }
      const ctx = opts.currentAgentId && opts.currentSessionId
        ? { agentId: opts.currentAgentId, sessionId: opts.currentSessionId }
        : undefined;
      console.log(`[tool:call_skill_action] agent=${opts.currentAgentId ?? '?'} toolName=${toolName} argKeys=${Object.keys(toolArgs).join(',')}`);
      return opts.skillActionsExecutor(toolName, toolArgs, ctx);
    }

    default: {
      // Dispatch skill action tools (skill_<dir>_<actionId>)
      if (call.name.startsWith('skill_') && opts.skillActionsExecutor) {
        const ctx = opts.currentAgentId && opts.currentSessionId
          ? { agentId: opts.currentAgentId, sessionId: opts.currentSessionId }
          : undefined;
        return opts.skillActionsExecutor(call.name, args as Record<string, unknown>, ctx);
      }
      throw new Error(`Unknown tool: ${call.name}`);
    }
  }
}
