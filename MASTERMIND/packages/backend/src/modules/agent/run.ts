import path from 'node:path';
import type {
  AgentConfig,
  ChatMessage,
  DeliveryTrigger,
  MessageSource,
  WsServerMessage,
  ToolDefaultsConfig,
  ToolEventPayload,
  MastermindConfig,
  MessageImage,
  ProviderConfig,
  ToolDefinition,
} from '@mastermind/shared';
import { resolveImagesAsText } from './visionFallback.js';
import { dumpUserImages, buildUserImagesNote } from './userImageDump.js';
import type { SessionModule } from '../session/index.js';
import type { ProviderModule } from '../provider/index.js';
import type { MemoryModule } from '../memory/index.js';
import type { WsManager } from '../../ws.js';
import type { MessageDirectives, SessionOptions } from './directives.js';
import { assembleSystemPrompt, type EnvironmentPaths } from './prompt.js';
import {
  DEFAULT_LAZY_SKILLS_SUMMARY_STUB as LAZY_SUMMARY_STUB_DEFAULT,
  DEFAULT_LAZY_SKILLS_SUMMARY_WILDCARD as LAZY_SUMMARY_WILDCARD_DEFAULT,
} from '../prompt-templates/defaults.js';
import { getAllTools, executeTool, makeLazySkillStub } from './tools/index.js';
import {
  SUBMIT_SUBAGENT_REPORT_DEF,
  type SubAgentDeliveryContext,
  type SubAgentDeliveryState,
} from './tools/submit_subagent_report.js';
import { executeDelivery, runKindTrigger } from '../delivery/index.js';
import { isUnifiedSessionId } from './sessionResolve.js';
import { resolveCodebaseSearchDbPaths } from '../codebase-search/paths.js';
import { buildCodebaseSearchToolNote } from '../codebase-search/promptNote.js';
import type { MemoryStoreModule } from '../memory-store/index.js';
import type { SkillActionsModule } from '../skill-actions/index.js';
import type { SchedulerModule } from '../scheduler/index.js';
import type { AsyncJobsModule } from '../async-jobs/index.js';
import type { TelegramModule } from '../telegram/index.js';
import type { PushModule } from '../push/index.js';
import type { BoardModule } from '../board/index.js';
import { buildMemoryContext } from './memoryContext.js';
import { pruneToolOutputs, detectPriorSummary, buildCompactSummaryPrompt, COMPACT_REFERENCE_PREAMBLE } from './compactSummary.js';
import { ReasoningTraceStore } from '../reasoning-traces/index.js';
import { summarizeWithLlm } from '../../utils/summarizeWithLlm.js';

const DEFAULT_MAX_TOOL_TURNS = 10;
const CHARS_PER_TOKEN = 3.5;
/** When auto-compact triggers, keep newest turns that fit in this fraction of maxContextTokens */
const AUTO_COMPACT_KEEP_RATIO = 0.55;

/**
 * Synthetic user message appended to history during warmup. Drives 3 properties:
 *  1. Marked `[WARMUP]` so it's identifiable in any log dump and obviously not a real user.
 *  2. "no response needed" aligns the semantics with `max_completion_tokens=1` — the model
 *     doesn't try to start a useful answer with that single token.
 *  3. Generic enough that the memory auto-inject search returns 0 high-confidence hits
 *     (similarity threshold 0.45+ rarely matches this string against domain-tagged memories),
 *     so the injected memory block at this position stays small/empty in warmup → the
 *     divergence with the live message remains tightly bounded to the user content tail.
 *
 * Used by `buildLlmPayload` when `warmup === true` and `content` is empty/falsy.
 */
export const WARMUP_USER_CONTENT = '[WARMUP] Pre-loading context — no user message yet, do not respond.';

/**
 * Per-section SHA256(12 chars) hash logging for an LLM payload. Identical shape between
 * live runs (`tag='run-payload'`) and warmups (`tag='warm'`) so a side-by-side grep
 * confirms KV-cache parity at every position. If any earlier hash diverges between the
 * two, the construction is unstable and the prefix cache will miss past that point.
 */
async function logPayloadHashes(
  tag: 'run-payload' | 'warm',
  payload: { messages: AiMessage[]; tools: ToolDefinition[]; reasoningEffort?: string; reasoningEnabled: boolean },
  agentId: string,
  sessionId: string,
  effectiveModel: string,
  extra?: { buildMs?: number },
): Promise<void> {
  const { createHash } = await import('node:crypto');
  const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);
  const systemPrompt = (payload.messages[0]?.content as string) ?? '';
  const toolsJson = JSON.stringify(payload.tools);
  const totalChars = payload.messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
    0,
  );
  const buildHint = extra?.buildMs !== undefined ? ` buildMs=${extra.buildMs}` : '';
  console.log(`[${tag}] ${agentId} session=${sessionId} model=${effectiveModel} messages=${payload.messages.length} tools=${payload.tools.length} think=${payload.reasoningEffort ?? 'off'} reasoning=${payload.reasoningEnabled} payloadChars=${totalChars}${buildHint}`);
  console.log(`[${tag}] ${agentId} hashes: system=${hash(systemPrompt)}/${systemPrompt.length} tools=${hash(toolsJson)}/${toolsJson.length}`);
  payload.messages.forEach((m, i) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const tcHint = (m as { tool_calls?: unknown[] }).tool_calls
      ? ` tool_calls=${(m as { tool_calls?: unknown[] }).tool_calls!.length}`
      : '';
    console.log(`[${tag}] ${agentId} msg[${i}] role=${m.role} hash=${hash(c)} chars=${c.length}${tcHint}`);
  });
}

// ── Token & history helpers ────────────────────────────────────────────────────

/** Rough token estimate: ~3.5 chars/token (conservative for mixed FR/EN + code).
 *  Exporté pour que la route GET /api/sessions/:id/stats puisse réutiliser exactement
 *  le même calcul que `runAgent`, en passant par `toAiMessage` (cf. routes/sessions.ts).
 *  Sinon l'estimation initiale du gauge dérive structurellement (wrap JSON, tool truncation,
 *  think strip) du nombre réel de tokens envoyé au modèle. */
export function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / CHARS_PER_TOKEN);
}

type AiMessage = {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
};

/** Strip <think> blocks from assistant content before re-sending to the model.
 * Saves tokens and avoids re-exposing internal reasoning as context.
 * Tool outputs (role=tool) are kept intact — the model needs the full result. */
function stripThinkBlocks(content: string | null | undefined): string | null {
  if (!content) return content ?? null;
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return stripped || null;
}

function buildInjectedPrefix(injectedBlock: string, datePrefix: string): string {
  return injectedBlock
    ? `${injectedBlock}\n\n[MESSAGE]\n${datePrefix}`
    : datePrefix;
}

/** Extract the inner contents of all <think>...</think> blocks (without the tags). */
function extractThinkContents(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /<think>([\s\S]*?)<\/think>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner) out.push(inner);
  }
  return out;
}

/** Hard cap on tool result content sent to the LLM. ~3,400 tokens — enough context, drops bulk.
 *  MUST be applied at BOTH intra-run push (run.ts:~1437, `messages.push({ role: 'tool', ... })`)
 *  AND DB rebuild (toAiMessage below) — otherwise the same tool_result row tokenises to a
 *  different byte sequence between the streaming turn and the next turn's prompt rebuild,
 *  invalidating llama.cpp's KV-cache prefix on every tool whose output exceeds the cap. */
const MAX_TOOL_CONTENT_CHARS = 12_000;
const TOOL_TRUNCATION_MARKER = '\n... [truncated for context window]';

export function truncateToolContentForLlm(content: string): string {
  if (content.length <= MAX_TOOL_CONTENT_CHARS) return content;
  return content.slice(0, MAX_TOOL_CONTENT_CHARS) + TOOL_TRUNCATION_MARKER;
}

/** Reconstruct an OpenAI-compatible message from a DB ChatMessage.
 *  `stripThink` controls whether `<think>...</think>` blocks are removed from assistant
 *  content. Default true (token-saving). Set false from config to keep full think blocks
 *  for maximum KV-cache prefix-hit on subsequent turns (cost: bigger context). */
export function toAiMessage(m: ChatMessage, stripThink: boolean = true): AiMessage {
  const meta = m.metadata as Record<string, unknown> | undefined;
  const maybeStrip = (s: string | null | undefined): string | null =>
    stripThink ? stripThinkBlocks(s) : (s ?? null);
  if (m.role === 'assistant' && Array.isArray(meta?.tool_calls)) {
    const cleanedToolCalls = (meta.tool_calls as unknown[]).filter(tc => tc != null);
    return { role: 'assistant', content: maybeStrip(m.content), ...(cleanedToolCalls.length > 0 ? { tool_calls: cleanedToolCalls } : {}) };
  }
  if (m.role === 'tool') {
    const tcId = meta?.tool_call_id;
    const content = typeof m.content === 'string' ? truncateToolContentForLlm(m.content) : m.content;
    return { role: 'tool', content, ...(tcId ? { tool_call_id: String(tcId) } : {}) };
  }
  if (m.role === 'assistant') {
    // KV-cache parity (audit 2026-06-01 L1): a final assistant row whose CONTENT is the
    // merged-think display blob (prior tool turns' <think> re-joined for the UI) diverges from
    // the bytes the LLM slot streamed for that turn. runAgent stashed those exact bytes in
    // `metadata.rawAssistantStream`; prefer them here so the rebuilt prompt matches the slot's
    // KV-cache at the final-assistant position (prefix hit, no reprocess). The UI still reads the
    // merged blob from m.content directly — only this LLM-rebuild path uses the raw stream.
    // Absent on every other assistant row → falls back to m.content unchanged.
    const rawStream = typeof meta?.rawAssistantStream === 'string' ? meta.rawAssistantStream : null;
    return { role: 'assistant', content: maybeStrip(rawStream ?? m.content) };
  }
  // User message — reconstruct the byte-identical text that was sent to the LLM when
  // this message was the current turn:
  //   1. Prepend `injectedPrefix` (memory+board+date block) if it was persisted
  //   2. Append the `userImagePaths` footer if images were dumped that turn
  // Both come from metadata persisted by `runAgent` after addMessage. The paths must match
  // what was originally sent so llama.cpp's prefix cache hits — the dump is deterministic
  // (msgId + idx + ext), so as long as `userImagesDir` config doesn't change, we're safe.
  if (m.role === 'user') {
    let content = m.content;
    // Vision-fallback delta (description block + separator) spliced BETWEEN the injected prefix
    // and the raw content — mirrors exactly what was sent that turn (`prefix + descriptionText +
    // content`). Persisted by runAgent as `visionFallbackPrefix` only when the vision-fallback
    // path fired; absent (and a no-op) for every normal turn. Restores byte-identity → KV-cache
    // prefix hit instead of a permanent miss from the vision-fallback turn onward.
    if (typeof meta?.visionFallbackPrefix === 'string' && meta.visionFallbackPrefix) {
      content = meta.visionFallbackPrefix + content;
    }
    if (typeof meta?.injectedPrefix === 'string' && meta.injectedPrefix) {
      content = meta.injectedPrefix + content;
    }
    if (Array.isArray(meta?.userImagePaths) && meta.userImagePaths.length > 0) {
      const paths = (meta.userImagePaths as unknown[]).filter((p): p is string => typeof p === 'string');
      if (paths.length > 0) content = content + buildUserImagesNote(paths);
    }
    return { role: 'user', content };
  }
  return { role: m.role, content: m.content };
}

/** Strip orphaned tool_calls/tool_results so both directions of the tool contract hold.
 * Anthropic (and other strict providers) require every tool_use to have a matching tool_result
 * AND every tool_result to be preceded by a matching tool_use. We enforce:
 *   forward  — strip assistant tool_calls that have no matching tool_result (crashed sessions).
 *              UNCONDITIONAL: safe for every provider (a tool_use with no answer is invalid
 *              everywhere AND its in-memory shape can never have been a KV-cached prefix).
 *   reverse  — drop role:'tool' rows whose tool_call_id matches no SURVIVING assistant tool_call.
 *              GATED behind `strictToolContract` — see the KV-parity regression below.
 *
 * The reverse pass was added to save a session persisted while `dropStructuredForKvParity` was
 * true (local model emitted inline <tool_call> markup → assistant turn stored WITHOUT structured
 * tool_calls, but its tool_result rows still carry a tool_call_id): those rows would otherwise
 * reach a STRICT provider as orphaned tool messages on a mid-conversation /model switch.
 *
 * KV-PARITY REGRESSION (audit 2026-06-01): running the reverse pass UNCONDITIONALLY breaks the
 * local llama.cpp path. When the SAME local provider rebuilds such a session, the content-only
 * assistant turn legitimately has no tool_calls → its tool_result rows look "orphaned" → the
 * reverse pass DELETES them. But those exact rows are already in the local model's KV-cache
 * (they were streamed and persisted last run). Dropping them diverges the KV prefix at precisely
 * the point the contract at run.ts:~1860 protects → full reprocess (~5min). The reverse pass is
 * therefore only correct/necessary for STRICT native providers (Anthropic/OpenAI), which reject
 * orphaned tool_results (400). For the permissive local path it is actively harmful.
 *
 * `strictToolContract` MUST default conservatively to false at every call site whose target
 * provider is not POSITIVELY known to be strict: tolerating a stray orphaned tool_result on a
 * permissive backend costs nothing, whereas a false strict→drop on the KV-sensitive local path
 * costs a multi-minute reprocess. See the gate computed in buildLlmPayload (step 6).
 * Both passes only ever touch genuinely orphaned messages. */
function stripOrphanedToolCalls(messages: AiMessage[], strictToolContract: boolean): AiMessage[] {
  // Collect all tool_call_ids that have a matching tool result
  const answeredIds = new Set<string>();
  let hasToolWithoutId = false;
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.tool_call_id) answeredIds.add(m.tool_call_id);
      else hasToolWithoutId = true;
    }
  }
  // If any tool message lacks an ID (old format), skip cleanup entirely to avoid false positives
  if (hasToolWithoutId) return messages;

  // Forward pass: drop assistant tool_calls with no matching tool_result.
  const forward: AiMessage[] = messages.map(m => {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
    const validCalls = (m.tool_calls as Array<{ id?: string }>).filter(
      tc => tc?.id && answeredIds.has(tc.id),
    );
    if (validCalls.length === m.tool_calls.length) return m; // all matched — no change
    if (validCalls.length === 0) {
      // No valid tool calls left — return as plain assistant message (keep text content)
      const { tool_calls: _, ...rest } = m;
      return rest;
    }
    return { ...m, tool_calls: validCalls };
  });

  // Reverse pass — STRICT-ONLY. Collect the ids declared by SURVIVING assistant tool_calls,
  // then drop any role:'tool' row whose tool_call_id is not among them. Without this, an
  // assistant turn persisted with content-only (dropStructuredForKvParity) leaves its
  // tool_result rows bearing a tool_call_id with no preceding tool_use → strict-provider
  // contract rejection. But on the LOCAL llama.cpp path those very rows are in the model's
  // KV-cache: dropping them diverges the prefix and forces a full reprocess. So only run this
  // when the target provider is positively known to enforce the strict contract; otherwise
  // keep `forward` untouched (KV-parity preserved — see the regression note on this function).
  if (!strictToolContract) return forward;

  const declaredIds = new Set<string>();
  for (const m of forward) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ id?: string }>) {
        if (tc?.id) declaredIds.add(tc.id);
      }
    }
  }
  const orphanedToolRows = forward.reduce(
    (n, m) => n + (m.role === 'tool' && m.tool_call_id && !declaredIds.has(m.tool_call_id) ? 1 : 0),
    0,
  );
  if (orphanedToolRows === 0) return forward;
  console.log(`[payload] stripOrphanedToolCalls: dropping ${orphanedToolRows} orphaned tool_result row(s) with no matching tool_call`);
  return forward.filter(
    m => !(m.role === 'tool' && m.tool_call_id && !declaredIds.has(m.tool_call_id)),
  );
}

/** Group history messages into conversation turns (each group starts with a user message) */
function groupTurns(history: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let cur: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === 'user' && cur.length > 0) { groups.push(cur); cur = []; }
    cur.push(m);
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * Auto-compact session history when approaching the token limit.
 * Keeps the newest turns that fit in 55% of maxContextTokens,
 * summarises the rest and replaces them with a single compact message in DB.
 * Returns { history, compactMsg } — compactMsg is non-null when a compact occurred.
 */
async function autoCompactIfNeeded(
  sessionId: string,
  history: ChatMessage[],
  systemPrompt: string,
  maxContextTokens: number,
  /** Threshold percentage (80-100). Compact triggers when usage exceeds this. */
  thresholdPct: number,
  sessionMod: SessionModule,
  providerMod: ProviderModule,
  effectiveModel: string,
  source: MessageSource,
  stripThink: boolean,
): Promise<{ history: ChatMessage[]; compactMsg: ChatMessage | null }> {
  const threshold = Math.floor(maxContextTokens * (thresholdPct / 100));
  const total = estimateTokens([{ role: 'system', content: systemPrompt }, ...history.map(m => toAiMessage(m, stripThink))]);

  if (total <= threshold) return { history, compactMsg: null };

  console.log(`[run] auto-compact triggered: ~${total} tokens > ${threshold} (${thresholdPct}% of ${maxContextTokens})`);

  const systemTokens = estimateTokens({ role: 'system', content: systemPrompt });
  const targetBudget = Math.floor(maxContextTokens * AUTO_COMPACT_KEEP_RATIO) - systemTokens;

  const turns = groupTurns(history);
  const keptTurns: ChatMessage[][] = [];
  let keptTokens = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = estimateTokens(turns[i].map(m => toAiMessage(m, stripThink)));
    // ALWAYS keep the very last turn — it carries the current run's input (user message,
    // sub-agent report injection in proactive handler runs, etc.). If we drop it because it
    // alone exceeds the budget (huge sub-agent rapport on a near-full session, audit finding
    // I), the parent ends up reading a SUMMARY of its own input, losing fidelity. Better to
    // overshoot maxContextTokens momentarily than to silently degrade the input — the
    // following turns will compact again from a leaner baseline.
    if (i === turns.length - 1) {
      keptTurns.unshift(turns[i]);
      keptTokens += turnTokens;
      continue;
    }
    if (keptTokens + turnTokens > targetBudget) break;
    keptTurns.unshift(turns[i]);
    keptTokens += turnTokens;
  }

  const toCompact = turns.slice(0, turns.length - keptTurns.length).flat();
  if (toCompact.length === 0) return { history, compactMsg: null }; // Nothing we can safely compact

  console.log(`[run] compacting ${toCompact.length} messages, keeping ${keptTurns.flat().length}`);

  // Generate structured summary (Hermes-inspired 7-section compact)
  const prunedToCompact = pruneToolOutputs(toCompact);
  const conversationText = prunedToCompact.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n');

  // Detect if the very first message to compact is itself a prior compact — update it
  const priorSummary = detectPriorSummary(toCompact) ?? undefined;
  const isUpdate = Boolean(priorSummary);
  const summaryPrompt = buildCompactSummaryPrompt(conversationText, isUpdate, priorSummary);

  const summaryRes = await summarizeWithLlm(providerMod, { model: effectiveModel, prompt: summaryPrompt });
  if (!summaryRes.ok) {
    console.warn(`[run] auto-compact summary failed (${summaryRes.reason}), using fallback`);
  }
  const summary = summaryRes.ok
    ? summaryRes.summary
    : `[Résumé auto indisponible — ${toCompact.length} messages archivés]\n\nDerniers échanges:\n${conversationText.slice(-2000)}`;

  const keptMessages = keptTurns.flat();
  const compactContent = `🗜️ *Auto-compact* — ${toCompact.length} messages résumés (seuil ${thresholdPct}% atteint)\n\n${COMPACT_REFERENCE_PREAMBLE}\n\n${summary}`;
  const insertBefore = keptMessages.length > 0 ? new Date(keptMessages[0].createdAt) : new Date();

  const compactMsg = await sessionMod.replaceWithCompact(
    sessionId,
    toCompact.map(m => m.id),
    compactContent,
    source,
    { type: 'auto_compact', originalCount: toCompact.length },
    insertBefore,
  );

  console.log(`[run] auto-compact done: ${toCompact.length} → 1 summary message`);
  return { history: [compactMsg, ...keptMessages], compactMsg };
}

/** Roots autorisés pour read/write/list sans systemAccess (alignés sur # Environment). */
function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || !String(p).trim()) continue;
    const n = path.resolve(p);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Résumé textuel des caps sub-agent (prompt harness). */
export function buildSubagentCapsSummary(agentConfig: AgentConfig, mastermindConfig?: MastermindConfig): string {
  const g = mastermindConfig?.subagentDefaults?.caps ?? {};
  const c = agentConfig.caps ?? {};
  const maxIter = c.maxIterations ?? g.maxIterations ?? 15;
  const timeout = c.timeoutSeconds ?? g.timeoutSeconds ?? 300;
  const maxOut = c.maxOutputTokens ?? g.maxOutputTokens ?? 8000;
  const maxToolCalls = c.maxToolCalls ?? g.maxToolCalls ?? 30;
  return [
    `- Maximum tool iterations (assistant turns): ${maxIter}`,
    `- Maximum total tool calls: ${maxToolCalls} (submit_subagent_report is exempt)`,
    `- Wall-clock timeout: ${timeout}s`,
    `- Max completion output tokens: ${maxOut}`,
  ].join('\n');
}

const PROMPT_CACHE_TTL_DEFAULT_MS = 30 * 60 * 1000; // 30 minutes
const PROMPT_CACHE_MAX_ENTRIES = 200;
const promptCache = new Map<string, { prompt: string; ts: number }>();

export function invalidatePromptCache(sessionId?: string): void {
  if (sessionId) {
    promptCache.delete(sessionId);
    return;
  }
  promptCache.clear();
}

/** @deprecated Use invalidatePromptCache */
export const invalidateTelegramPromptCache = invalidatePromptCache;

function setPromptCache(sessionId: string, prompt: string): void {
  promptCache.set(sessionId, { prompt, ts: Date.now() });
  if (promptCache.size <= PROMPT_CACHE_MAX_ENTRIES) return;
  const overflow = promptCache.size - PROMPT_CACHE_MAX_ENTRIES;
  const oldest = [...promptCache.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .slice(0, overflow);
  for (const [key] of oldest) promptCache.delete(key);
}

// ── Shared LLM payload builder ───────────────────────────────────────────────

export interface BuildLlmPayloadOpts {
  agentConfig: AgentConfig;
  sessionId: string;
  /** User message content.  For warmup pass '.', for real run pass the actual message (vision-fallback-patched if applicable). */
  content: string;
  effectiveModel: string;
  sessionMod: SessionModule;
  providerMod: ProviderModule;
  memoryMod: MemoryModule;
  environmentPaths: EnvironmentPaths;
  codebaseSearchContext?: { config: MastermindConfig; resolvePath: (p: string) => string };
  sessionOptions?: SessionOptions;
  defaultPromptCacheTtl?: number;
  memoryStoreMod?: MemoryStoreModule;
  boardMod?: BoardModule;
  db?: import('pg').Pool;
  agentsList?: AgentConfig[];
  braveApiKey?: string;
  skillActionsMod?: SkillActionsModule;
  schedulerMod?: SchedulerModule;
  asyncJobsMod?: AsyncJobsModule;
  /** Prompt templates module — used to render editable sections (platform / env / lazy summary).
   *  Optional: when undefined, falls back to hardcoded DEFAULTS via prompt.ts helper. */
  templatesMod?: import('../prompt-templates/index.js').PromptTemplatesModule;
  reasoningAvailable?: boolean;
  /** True if a Mercury statsUrl provider is configured — gates the `inspect_image` tool. */
  visionDescribeAvailable?: boolean;
  /** Source for auto-compact DB write.  Default: 'web'. */
  source?: MessageSource;
  /** Vision images for the current user message (native vision path). */
  images?: MessageImage[];
  /** Whether vision fallback was applied (image descriptions prepended to content). */
  visionFallbackApplied?: boolean;
  /** Absolute paths of user images already dumped to disk by runAgent (the dump must
   *  happen before the vision-fallback branch, which clears `images`). When non-empty,
   *  buildLlmPayload appends a `_System note — uploaded images saved to disk_` footer
   *  to the user message text so the agent can reference these paths in tool calls. */
  userImagePaths?: string[];
  /** Contexte livraison sub-agent (injecté par AsyncJobsModule → agentMod.run). */
  subAgentRunContext?: SubAgentDeliveryContext;
  /** Proactive pipeline phase — affects which tools are exposed. */
  proactivePhase?: 'watcher' | 'handler';
  /**
   * True when the user message has already been stored in session history (the standard
   * runAgent path: message inserted before payload build, last history entry IS the
   * current user message). Set by runAgent. Warmups use `warmup: true` instead.
   */
  contentInHistory?: boolean;
  /**
   * Warmup mode: produce a payload byte-identical to a live run, but without DB writes.
   * Implementation: a synthetic user message (containing `content`) is appended to the
   * fetched history *in memory only*, and the rest of the build proceeds exactly like a
   * live run (memory auto-inject, prefix, last-user-msg branch). Auto-compact is skipped
   * (warmup must remain read-only). The point: warm and live emit identical token streams
   * up to the user message, so llama.cpp's prefix cache hits at maximum length when the
   * user actually sends a message.
   */
  warmup?: boolean;
  /**
   * Strip `<think>...</think>` blocks from assistant messages reloaded from history.
   * Source : `config.defaults.stripThinkBlocks` (now defaults to false — keep think for
   * max KV-cache prefix hit). Set true in YAML to force-strip (legacy / token-saver mode).
   */
  stripThink?: boolean;
  /**
   * Cache-optimized prompt assembly. When true, the rebuild filters out the visible-content
   * duplicate rows persisted by `send_to_user` (rows with `metadata.delivered_via_send_to_user`).
   * The same content is already in the previous assistant's `tool_calls.arguments`, so the LLM
   * loses nothing useful, and the rebuild stays byte-aligned with the slot's streamed KV.
   *
   * Source : `config.defaults.cacheOptimized` (defaults to true). Flip false in the Settings
   * UI to keep the duplicates in the rebuilt history (= "full context" mode).
   */
  cacheOptimized?: boolean;
}

export interface LlmPayload {
  systemPrompt: string;
  messages: AiMessage[];
  tools: ToolDefinition[];
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  reasoningEnabled: boolean;
  /** Non-null when auto-compact was triggered (for UI notification). */
  compactMsg: ChatMessage | null;
  /** Whether codebase search is available for this agent (reused by toolExecOpts). */
  codebaseSearchAvailable: boolean;
  /**
   * Exact prefix string that was prepended to the current user message (memory+board+date+MESSAGE
   * marker). `runAgent` persists this in the user row's metadata so future turns reconstruct
   * byte-identical tokens at the same position → llama.cpp's KV prefix cache hits.
   *
   * Empty string when `contentInHistory` is false (warmup path — nothing to persist) or when no
   * injection was applied (vision native path overrides the content entirely).
   */
  lastUserMsgLivePrefix: string;
  /**
   * Vision-fallback delta prepended to the RAW current user content this turn — the description
   * block plus its separator (everything in the MUTATED content that precedes the raw row text).
   * `runAgent` persists it in the user row metadata as `visionFallbackPrefix`; `toAiMessage`
   * splices it back between `injectedPrefix` and the raw content on later rebuilds, so the bytes
   * the LLM saw at the vision-fallback turn (`prefix + descriptionText + content`) reconstruct
   * identically and the KV-cache prefix keeps hitting. Empty for every non-vision-fallback turn
   * (and when the byte-identity guard in buildLlmPayload declined to persist).
   */
  lastUserMsgVisionPrefix: string;
  /**
   * Absolute paths of user-uploaded images dumped to disk this turn. `runAgent` persists these
   * in the user row's metadata as `userImagePaths` so subsequent turns can reconstruct the
   * same `_System note — uploaded images saved to disk_` footer in the user message — keeping
   * byte-identity for KV cache and letting the agent re-reference the paths in later turns
   * (e.g. "edit the photo I sent you earlier"). Empty when no images were dumped.
   */
  userImagePaths: string[];
}

/**
 * Build the full LLM request payload — system prompt, messages (with injections),
 * tool list, and reasoning params.  Used by `runAgent()` for both live and warmup
 * runs (`warmup: true` short-circuits to a cap=1 stream, no DB writes).
 */
export async function buildLlmPayload(opts: BuildLlmPayloadOpts): Promise<LlmPayload> {
  const startedAt = Date.now();
  const {
    agentConfig, sessionId, effectiveModel,
    sessionMod, providerMod, memoryMod, environmentPaths,
    codebaseSearchContext, sessionOptions, defaultPromptCacheTtl,
    memoryStoreMod, boardMod, db, agentsList, braveApiKey,
    skillActionsMod, schedulerMod, asyncJobsMod, templatesMod,
    reasoningAvailable = false,
    visionDescribeAvailable = false,
    source = 'web',
    images, visionFallbackApplied,
    proactivePhase,
    contentInHistory = false,
    warmup = false,
    stripThink = false,
    cacheOptimized = true,
    userImagePaths = [],
    subAgentRunContext,
  } = opts;
  // Warmup with empty/falsy content falls back to the canonical synthetic message —
  // this lets callers do `agentMod.run(agentId, sessionId, '', { warmup: true })`
  // without having to know what content to pass. The live path always provides real content.
  const content = warmup && !opts.content ? WARMUP_USER_CONTENT : opts.content;
  // Warmup forces the live code path (memory inject, prefix, last-user-msg branch) so
  // the produced payload is byte-identical to a live run except for the synthetic user
  // content. We skip DB-mutating side-effects (auto-compact) explicitly below.
  const effectiveContentInHistory = contentInHistory || warmup;
  const agentId = agentConfig.identity.id;
  const contentPreview = content.slice(0, 120).replace(/\s+/g, ' ');
  console.debug(
    `[payload] start agent=${agentId} session=${sessionId} model=${effectiveModel} contentLen=${content.length} contentInHistory=${contentInHistory} images=${images?.length ?? 0} preview="${contentPreview}"`,
  );

  // ── 1. Codebase search availability ──
  const codebaseSearchAvailable = Boolean(
    codebaseSearchContext
    && resolveCodebaseSearchDbPaths(
      codebaseSearchContext.config,
      codebaseSearchContext.resolvePath,
      agentId,
    ).length > 0,
  );
  // Global flag for the unified tools list (see getAllTools): true if at least one enabled
  // agent in the fleet has an index configured, so every agent sees the tool uniformly.
  // The per-agent availability is enforced in executeTool via a soft-fail message.
  const codebaseSearchEverAvailable = Boolean(
    codebaseSearchContext
    && (agentsList ?? [agentConfig]).some(a =>
      a.enabled !== false
      && resolveCodebaseSearchDbPaths(
        codebaseSearchContext.config,
        codebaseSearchContext.resolvePath,
        a.identity.id,
      ).length > 0,
    ),
  );
  const codebaseSearchToolNote = codebaseSearchContext
    ? buildCodebaseSearchToolNote(
        codebaseSearchContext.config,
        codebaseSearchContext.resolvePath,
        agentConfig,
        agentId,
      )
    : undefined;

  // ── Early: kick off memory search in parallel with steps 2+3 ──
  // The embedding API call is the main latency cost (~2-4s); it only needs
  // content/agentId/config which are already available, so we overlap it with
  // the system prompt build and history fetch.
  // Skipped for scheduled tasks — they have a precise prompt and don't need memory context.
  const isScheduledTask = content.startsWith('[SCHEDULED_TASK]');
  const memorySearchPromise = (effectiveContentInHistory && memoryStoreMod?.isEnabled && !isScheduledTask)
    ? buildMemoryContext(
        content,
        agentId,
        memoryStoreMod,
        codebaseSearchContext?.config.memoryStore?.autoInjection,
        db,
        agentConfig.excludeSharedMemory === true,
      )
    : null;

  const mmCfg = codebaseSearchContext?.config;
  const useAllowOnly =
    agentConfig.kind === 'subagent'
    && Array.isArray(agentConfig.tools?.allowOnly)
    && (agentConfig.tools!.allowOnly!.length > 0);
  const allowOnlySet = useAllowOnly
    ? new Set([...agentConfig.tools!.allowOnly!, 'submit_subagent_report'])
    : null;

  // ── 1b. Tools (before system prompt: harness lists names + allowOnly for sub-agents) ──
  const bypassUnified = agentConfig.bypassUnifiedCache === true;
  const lazySkills = agentConfig.lazySkills === true;
  // skillCallMode only matters when lazy is active; defaults to 'stub' for backward compat.
  const skillCallMode: 'stub' | 'wildcard' = agentConfig.skillCallMode ?? 'stub';
  const wildcardSkillsActive = lazySkills && skillCallMode === 'wildcard';
  let allSkillDefs = skillActionsMod?.isActive
    ? skillActionsMod.getToolDefinitions()
    : [];
  if (useAllowOnly && allowOnlySet) {
    allSkillDefs = allSkillDefs.filter(d => allowOnlySet.has(d.name));
  }

  const bypassStarredFilter = bypassUnified
    ? (agentConfig.promptInjection?.starredSkills ?? [])
    : null;

  let skillDefsForPrompt: ToolDefinition[];
  if (lazySkills && skillActionsMod?.isActive) {
    let baseDefs = allSkillDefs;
    if (bypassUnified) {
      baseDefs = (bypassStarredFilter && bypassStarredFilter.length > 0)
        ? skillActionsMod.getToolDefinitionsForSkills(bypassStarredFilter)
        : [];
    }
    // Wildcard mode short-circuits stub emission entirely — the agent dispatches
    // every skill invocation through `call_skill_action(toolName, args)` after an
    // inspect_skill. Saves ~3-4k extra tokens vs stub mode for 100+ skill fleets.
    if (wildcardSkillsActive) {
      skillDefsForPrompt = [];
      console.debug(`[payload] ${agentId} lazySkills+wildcard: ${allSkillDefs.length} skills NOT emitted (call_skill_action wildcard dispatch)${bypassUnified ? ` (bypass starred filter would apply)` : ''}`);
    } else {
      skillDefsForPrompt = baseDefs.map(def => makeLazySkillStub(def.name));
      console.debug(`[payload] ${agentId} lazySkills+stub: ${allSkillDefs.length} full defs → ${skillDefsForPrompt.length} minimal stubs${bypassUnified ? ` (bypass starred filter applied)` : ''}`);
    }
  } else if (bypassUnified && skillActionsMod?.isActive) {
    skillDefsForPrompt = (bypassStarredFilter && bypassStarredFilter.length > 0)
      ? skillActionsMod.getToolDefinitionsForSkills(bypassStarredFilter)
      : [];
    const dropped = allSkillDefs.length - skillDefsForPrompt.length;
    if (dropped > 0) {
      console.debug(`[payload] ${agentId} bypassUnifiedCache: filtered skills ${allSkillDefs.length} → ${skillDefsForPrompt.length} (kept ${(bypassStarredFilter ?? []).join(',') || '(none)'})`);
    }
  } else {
    skillDefsForPrompt = allSkillDefs;
  }

  if (useAllowOnly && allowOnlySet) {
    skillDefsForPrompt = skillDefsForPrompt.filter(d => allowOnlySet.has(d.name));
  }

  const subAgentPresetsAvailable = !!agentsList?.some(a => a.kind === 'subagent' && a.enabled !== false);
  let tools = (sessionOptions?.toolsDisabled)
    ? []
    : getAllTools({
        braveApiKey,
        codebaseSearchEverAvailable,
        reasoningAvailable,
        visionDescribeAvailable,
        memorySearchAvailable: memoryStoreMod?.isEnabled,
        skillActions: skillDefsForPrompt,
        schedulerAvailable: !!schedulerMod,
        boardAvailable: !!boardMod,
        asyncJobsAvailable: !!asyncJobsMod,
        subAgentPresetsAvailable,
        currentRunSource: source,
        lazySkillsActive: lazySkills && !!skillActionsMod?.isActive,
        wildcardSkillsActive,
      });

  if (bypassUnified && tools.length > 0) {
    const disabledNames = new Set(agentConfig.tools?.disabled ?? []);
    if (disabledNames.size > 0) {
      const before = tools.length;
      tools = tools.filter(t => !disabledNames.has(t.name));
      const dropped = before - tools.length;
      if (dropped > 0) {
        console.debug(`[payload] ${agentId} bypassUnifiedCache: stripped ${dropped} disabled tools from prompt`);
      }
    }
  }

  if (useAllowOnly && allowOnlySet) {
    const before = tools.length;
    tools = tools.filter(t => allowOnlySet.has(t.name));
    if (before !== tools.length) {
      console.debug(`[payload] ${agentId} subagent allowOnly: filtered tools ${before} → ${tools.length}`);
    }
  }

  const appendSubmitTool = source === 'subagent' && !!subAgentRunContext;
  if (appendSubmitTool) {
    tools = tools.filter(t => t.name !== 'submit_subagent_report');
    tools.push(SUBMIT_SUBAGENT_REPORT_DEF);
  }

  // ── 2. System prompt (TTL-cached) ──
  const isMainSession = !sessionId.includes('-tg-');
  const skipPromptCache = agentConfig.kind === 'subagent';
  let systemPrompt: string;
  {
    const cached = skipPromptCache ? undefined : promptCache.get(sessionId);
    const ttlMinutes = agentConfig.promptCacheTtl ?? agentConfig.telegram?.promptCacheTtl ?? defaultPromptCacheTtl ?? 30;
    const ttlMs = ttlMinutes * 60 * 1000 || PROMPT_CACHE_TTL_DEFAULT_MS;
    const isStale = !cached || (Date.now() - cached.ts) > ttlMs;
    if (!isStale) {
      systemPrompt = cached.prompt;
      console.debug(`[payload] ${agentId} prompt cache hit session=${sessionId} ageMs=${Date.now() - cached.ts} ttlMs=${ttlMs}`);
    } else {
      const subAgentHarness = agentConfig.kind === 'subagent'
        ? {
            jobId: subAgentRunContext?.jobId ?? '—',
            parentAgentId: subAgentRunContext?.parentAgentId ?? '—',
            allowedToolNames: tools.map(t => t.name).sort(),
            capsSummary: buildSubagentCapsSummary(agentConfig, mmCfg),
          }
        : undefined;
      systemPrompt = await assembleSystemPrompt(memoryMod, {
        agentConfig,
        sessionId,
        isMainSession,
        environmentPaths,
        codebaseSearchToolNote,
        reasoningAvailable,
        visionDescribeAvailable,
        memoryStoreEnabled: memoryStoreMod?.isEnabled,
        schedulerAvailable: !!schedulerMod,
        agentsList,
        subAgentHarness,
        templatesMod,
      });
      if (!skipPromptCache) {
        setPromptCache(sessionId, systemPrompt);
      }
      console.debug(`[payload] ${agentId} prompt cache ${cached ? 'refresh' : 'miss'} session=${sessionId} promptLen=${systemPrompt.length} ttlMs=${ttlMs}${skipPromptCache ? ' (subagent: no cache)' : ''}`);
    }
  }

  // ── 3. History + auto-compact ──
  const historyLimit = agentConfig.contextMessages ?? 20;
  const maxContextTokens = agentConfig.maxContextTokens ?? 131072;
  const thresholdPct = Math.min(100, Math.max(80, agentConfig.autoCompactThreshold ?? 90));

  let history = await sessionMod.getMessages(sessionId, historyLimit);
  console.debug(`[payload] ${agentId} history loaded session=${sessionId} rows=${history.length}/${historyLimit}`);

  // Cache-optimized mode: drop the visible-content duplicate rows that `send_to_user`
  // persists for the UI. The same content is already inside the previous assistant's
  // `tool_calls.arguments` (visible to the LLM), so removing the standalone assistant
  // row costs zero information but saves ~440 tokens per send_to_user call AND keeps
  // the rebuilt prompt byte-aligned with what llama.cpp streamed (the duplicate isn't
  // in the slot's KV either). Done BEFORE the autoCompact / map / token estimation
  // below so all downstream code sees the filtered history.
  if (cacheOptimized) {
    const before = history.length;
    history = history.filter(m => {
      if (m.role !== 'assistant') return true;
      const meta = m.metadata as Record<string, unknown> | undefined;
      return meta?.delivered_via_send_to_user !== true;
    });
    if (history.length !== before) {
      console.debug(`[payload] ${agentId} cacheOptimized: filtered ${before - history.length} send_to_user duplicate(s) from history`);
    }
  }

  // Auto-compact only during real runs — warmup must stay non-destructive (no DB writes).
  let compactMsg: ChatMessage | null = null;
  if (contentInHistory && !warmup) {
    const result = await autoCompactIfNeeded(
      sessionId, history, systemPrompt, maxContextTokens, thresholdPct,
      sessionMod, providerMod, effectiveModel, source, stripThink,
    );
    history = result.history;
    compactMsg = result.compactMsg;
  }

  // Warmup mode: append a synthetic user message to the in-memory history so the rest of
  // the build (memory inject, prefix, last-user-msg branch in the map below) treats it
  // exactly like a live run. The fake message never hits the DB.
  if (warmup) {
    history = [
      ...history,
      {
        id: 'warm-synthetic',
        sessionId,
        role: 'user',
        content,
        source: 'web',
        createdAt: new Date().toISOString(),
        metadata: { warmup_synthetic: true },
      } as ChatMessage,
    ];
  }

  // ── 4. Memory context injection (await the promise kicked off before step 2) ──
  let memoryInjectedBlock = '';
  if (memorySearchPromise) {
    const memCtx = await memorySearchPromise;
    if (memCtx.hitCount > 0) {
      memoryInjectedBlock = memCtx.injectedBlock;
      console.debug(`[payload] ${agentId} memory injected: ${memCtx.hitCount} chunks, ${memoryInjectedBlock.length} chars`);
    }
  }

  // ── 5. Board injection ──
  if (boardMod) {
    const agentNames = new Map<string, string>();
    if (agentsList) {
      for (const a of agentsList) agentNames.set(a.identity.id, a.identity.name ?? a.identity.id);
    }
    const boardBlock = await boardMod.buildBoardBlock(agentNames);
    if (boardBlock) {
      console.debug(`[payload] ${agentId} board injected chars=${boardBlock.length}`);
      memoryInjectedBlock = memoryInjectedBlock
        ? `${memoryInjectedBlock}\n\n${boardBlock}`
        : boardBlock;
    }
  }

  // ── 6. Build messages array ──
  // If contentInHistory, the last history entry IS the current user message and gets injections.
  // Otherwise (warmup), history is as-is and we append a synthetic user message with injections.
  const datePrefix = `[${new Date().toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}]\n`;

  // Live prefix applied to the current user message. Returned to runAgent so it can persist
  // it in the message's metadata — next turn's build reconstructs identical tokens at this
  // position, letting llama.cpp's KV prefix cache hit instead of re-tokenizing the whole tail.
  // Empty when native-vision path overrides content or when no injection is applicable.
  let lastUserMsgLivePrefix = '';

  // Vision-fallback delta prepended to the RAW user content this turn (= description block +
  // its separator). Persisted by runAgent into the user row metadata so toAiMessage can splice
  // it back between injectedPrefix and the raw content on every later rebuild — restoring the
  // EXACT bytes (`prefix + descriptionText + content`) the LLM saw at this turn. Empty unless
  // the vision-fallback branch fires AND the mutated content provably ends with the raw row
  // content (guard below) — otherwise we keep the legacy no-persist behavior (known miss, no
  // regression) rather than persist a delta that wouldn't reconstruct byte-identically.
  let lastUserMsgVisionPrefix = '';

  // ── User-uploaded image paths note ──
  // The dump itself is performed by runAgent BEFORE the vision-fallback branch (because
  // vision fallback nullifies `images` for text-only providers). Here we just build the
  // markdown footer that gets appended to the user message text — both for the live turn
  // and (via toAiMessage) for past turns that have userImagePaths persisted in metadata.
  // Returned in the LlmPayload so runAgent can persist them for cross-turn KV-cache stability.
  const userImagesNote = userImagePaths.length > 0 ? buildUserImagesNote(userImagePaths) : '';

  const messages: AiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m, index) => {
      const isLastUserMsg = effectiveContentInHistory && m.role === 'user' && index === history.length - 1;

      if (isLastUserMsg && images && images.length > 0 && !visionFallbackApplied) {
        // Native vision: send the last user message with image_url attachments.
        // The userImagesNote (paths to the dumped files) is appended to the text part
        // so the agent can pass them to image-editing tools without re-uploading.
        // livePrefix left empty — the image attachments override the content shape anyway.
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.content + userImagesNote },
            ...images.map(img => ({
              type: 'image_url',
              image_url: { url: img.dataUrl },
            })),
          ],
        };
      }

      if (isLastUserMsg && visionFallbackApplied) {
        // Vision fallback: LLM sees `prefix + descriptionText + m.content + userImagesNote`.
        // `content` here is the MUTATED value runAgent built before this call
        // (`descriptionText + (m.content ? '\n\n' + m.content : '')`, run.ts vision-fallback
        // branch), while the DB user row stores only the RAW `m.content` (persisted before the
        // mutation). To make next-turn rebuilds byte-identical (KV-cache prefix hit instead of a
        // full reprocess from this turn onward), we persist BOTH:
        //   • injectedPrefix  → via lastUserMsgLivePrefix (same as the normal branch)
        //   • the vision delta → via lastUserMsgVisionPrefix = the slice of the mutated content
        //     that precedes the raw row content (= descriptionText + its separator).
        // toAiMessage then reconstructs `injectedPrefix + visionPrefix + m.content (+ imagesNote)`,
        // matching exactly what we send below.
        //
        // Guard: only persist the delta when the mutated content provably ends with the raw row
        // content. The mutation always prepends to m.content, so this holds in practice; if it
        // ever doesn't (unexpected upstream change), fall back to the legacy no-persist behavior
        // (lastUserMsgVisionPrefix stays '') — a known prefix miss, never a wrong reconstruction.
        const prefix = buildInjectedPrefix(memoryInjectedBlock, datePrefix);
        const rawRowContent = typeof m.content === 'string' ? m.content : '';
        if (content.length >= rawRowContent.length && content.endsWith(rawRowContent)) {
          lastUserMsgLivePrefix = prefix;
          lastUserMsgVisionPrefix = content.slice(0, content.length - rawRowContent.length);
        }
        return { role: 'user', content: prefix + content + userImagesNote };
      }

      if (isLastUserMsg) {
        const prefix = buildInjectedPrefix(memoryInjectedBlock, datePrefix);
        lastUserMsgLivePrefix = prefix;
        return { role: 'user' as const, content: prefix + m.content };
      }

      return toAiMessage(m, stripThink);
    }),
  ];

  // No legacy fallback needed: every real call site sets either contentInHistory=true
  // (live run) or warmup=true (which appends a synthetic user msg to history above).
  // If you reach this point with both false, the payload won't have a user message —
  // that's a programming error, surface it explicitly.
  if (!effectiveContentInHistory) {
    throw new Error(
      `[payload] buildLlmPayload called with neither contentInHistory nor warmup — at least one must be true to produce a valid payload (agent=${agentId} session=${sessionId})`,
    );
  }

  // Clean up orphaned tool_calls/tool_results.
  //
  // Forward pass (drop assistant tool_calls with no answer) is unconditional — safe everywhere.
  // Reverse pass (drop tool_results with no surviving tool_use) is GATED on `strictToolContract`
  // because it breaks KV-parity on the local llama.cpp path (see stripOrphanedToolCalls header):
  // a content-only assistant turn (dropStructuredForKvParity) makes its already-KV-cached
  // tool_result rows look orphaned, and dropping them forces a ~5min reprocess on the same
  // local provider.
  //
  // Determining strictness from the call site: the only provider signal here is the transport
  // `type` (`mercury` | `openai-compat`) — there is NO local-vs-cloud nor capability flag in
  // ProviderConfig. In NEXUS, cloud chat (Anthropic/OpenAI via OpenRouter — the providers that
  // reject orphaned tool_results, cf. provider/mercury.ts) is brokered through `mercury`, while
  // the KV-sensitive local llama.cpp backend is a plain `openai-compat` provider
  // (config: providers[].type=openai-compat → http://localhost:28332). So we treat ONLY the
  // `mercury` transport as strict. This is the conservative choice: any provider whose strictness
  // is uncertain (every `openai-compat` config, which today is the local path) defaults to
  // NON-strict → reverse pass skipped → KV-parity preserved. A stray orphaned tool_result
  // tolerated by the permissive local backend is cheap; a wrong drop on it is not. On a real
  // /model switch to a Mercury-brokered cloud model the reverse pass runs and the strict
  // contract is honored.
  const targetProviderType = providerMod.getProviderType(effectiveModel);
  const strictToolContract = targetProviderType === 'mercury';
  const cleanedMessages = stripOrphanedToolCalls(messages, strictToolContract);
  if (cleanedMessages.length !== messages.length || cleanedMessages.some((m, i) => m !== messages[i])) {
    const stripped = messages.length - cleanedMessages.length;
    console.log(`[payload] stripOrphanedToolCalls: cleaned orphaned tool_calls from history${stripped > 0 ? ` (removed ${stripped} messages)` : ''}`);
    messages.length = 0;
    messages.push(...cleanedMessages);
  }

  // ── 7. Tools ── (surface built in step 1b — here only lazy-skill summaries mutate messages[0])

  // Lazy skills: append the "Available skills" summary block to the system prompt so the
  // agent knows which skill ids it can `inspect_skill('<id>')`. The block is deterministic
  // given the loaded skills + the bypass-starred filter, so it's byte-stable across
  // rebuilds (cache-friendly). Appended AFTER the TTL cache lookup so the cached body stays
  // unchanged — the lazy block is rebuilt cheaply each call from in-memory module state.
  //
  // Suppressed when the run had tools globally disabled (sessionOptions.toolsDisabled) —
  // no point telling the agent to call inspect_skill if no tools are exposed at all.
  if (lazySkills && skillActionsMod?.isActive && !sessionOptions?.toolsDisabled) {
    // Filter resolution — three states, NOT two:
    //   - bypassStarredFilter === null         → no bypass → no filter (show ALL loaded skills)
    //   - bypassStarredFilter.length === 0     → bypass active + zero starred → show NONE
    //                                            (passing [] to getSkillSummaries explicitly)
    //   - bypassStarredFilter.length > 0       → bypass active + curated list → filter to it
    // Earlier version coalesced "[] → undefined" which silently exposed all skills under
    // bypass+lazy with empty starredSkills — opposite of the user's intent.
    const summariesRaw = bypassStarredFilter === null
      ? skillActionsMod.getSkillSummaries() // no filter
      : skillActionsMod.getSkillSummaries(bypassStarredFilter); // explicit filter (may be empty array)
    const summaries = useAllowOnly && allowOnlySet
      ? summariesRaw
          .map(s => ({
            ...s,
            actions: s.actions.filter(a => allowOnlySet.has(a.toolName)),
          }))
          .filter(s => s.actions.length > 0)
      : summariesRaw;
    if (summaries.length === 0) {
      // Lazy + no skills (or bypass+lazy + 0 starred). Add a marker block so the agent
      // doesn't expect skills that aren't there.
      const reason = bypassStarredFilter !== null && bypassStarredFilter.length === 0
        ? ' / bypass mode + zero starred skills'
        : '';
      messages[0].content = `${messages[0].content as string}

## Available skills (lazy mode)
(none — no skills loaded${reason}.)
`;
    } else {
      // Build skillsList (markdown bullets) as a variable. Header + instructions live
      // in the editable template `lazy-skills-summary.{stub|wildcard}.md`.
      const skillsList = summaries.map(s => {
        const actionList = s.actions.map(a => a.id).join(', ');
        const desc = s.skillDescription ? ` — ${s.skillDescription}` : '';
        return `- **${s.skillEmoji ? s.skillEmoji + ' ' : ''}${s.skillName}** (id: \`${s.skillDir}\`)${desc}. ${s.actions.length} action(s): ${actionList}`;
      }).join('\n');
      // Inline fallback renderer — same regex replace as PromptTemplatesModule.applyVars
      // so behavior is identical with or without the module wired.
      const renderLazy = (key: string, vars: Record<string, string>): string => {
        if (templatesMod) return templatesMod.render(key, vars);
        const tpl = key === 'lazy-skills-summary.wildcard'
          ? LAZY_SUMMARY_WILDCARD_DEFAULT
          : LAZY_SUMMARY_STUB_DEFAULT;
        return tpl.replace(/\{\{([\w.]+)\}\}/g, (m, n) => vars[n] !== undefined ? vars[n] : m);
      };
      const summaryBody = renderLazy(
        wildcardSkillsActive ? 'lazy-skills-summary.wildcard' : 'lazy-skills-summary.stub',
        { skillsList },
      );
      // Two leading newlines + trailing newline preserve the legacy formatting bytes.
      const appended = `\n\n${summaryBody}\n`;
      messages[0].content = `${messages[0].content as string}${appended}`;
      console.debug(`[payload] ${agentId} lazySkills+${skillCallMode}: appended ${summaries.length} skill summaries to system prompt (~${appended.length} chars)`);
    }
  }

  // ── 8. Reasoning params ──
  // Single source of truth: agent-level thinkBudget (UI agent config / /think / Telegram menu
  // all write here). Session options no longer carry thinkBudget — read agentConfig directly.
  const agentThink = agentConfig.thinkBudget;
  const reasoningEffort: 'low' | 'medium' | 'high' | undefined =
    agentThink && agentThink !== 'off' ? agentThink : undefined;
  const reasoningEnabled: boolean = !!reasoningEffort;
  console.debug(
    `[payload] done agent=${agentId} session=${sessionId} messages=${messages.length} tools=${tools.length} promptLen=${systemPrompt.length} injectLen=${lastUserMsgLivePrefix.length} compact=${compactMsg ? 'yes' : 'no'} ms=${Date.now() - startedAt}`,
  );

  return {
    systemPrompt,
    messages,
    tools,
    reasoningEffort,
    reasoningEnabled,
    compactMsg,
    codebaseSearchAvailable,
    lastUserMsgLivePrefix,
    lastUserMsgVisionPrefix,
    userImagePaths,
  };
}

// ── Agent run ────────────────────────────────────────────────────────────────

export interface AgentRunContext {
  agentConfig: AgentConfig;
  sessionId: string;
  content: string;
  source: MessageSource;
  sessionMod: SessionModule;
  providerMod: ProviderModule;
  memoryMod: MemoryModule;
  ws: WsManager;
  signal?: AbortSignal;
  toolDefaults?: ToolDefaultsConfig;
  /** Parsed slash-command directives for this request */
  directives?: MessageDirectives;
  /** Merged session options (persistent overrides) */
  sessionOptions?: SessionOptions;
  /** Optional streaming callback — called for each text chunk as it arrives */
  onChunk?: (chunk: string) => void;
  /** Called when auto-compact triggers, with the notification text (for Telegram forwarding) */
  onCompact?: (msg: string) => void;
  /**
   * Called once when the run flips into a hidden mode mid-flight (e.g. sandbox).
   * Consumers (Telegram bridge, web UI via WS) use this to finalize their current
   * streaming display: drop the cursor, do a final edit, stop the typing indicator.
   * The agent continues working invisibly; the final visible message is delivered
   * separately via send_to_user. Consumers should also SKIP their normal post-run
   * "final response" display if this was called, to avoid duplicate/empty messages.
   */
  onHideStreaming?: (finalContent: string) => void | Promise<void>;
  /** Optional tool-event callback — called on tool.start and tool.done */
  onToolCall?: (event: {
    type: 'start' | 'done';
    name: string;
    args: Record<string, unknown>;
    output?: string;
    durationMs?: number;
    error?: string;
  }) => void;
  /** Vision images attached to the current user message */
  images?: MessageImage[];
  /** Provider config to use for vision fallback (Mercury /admin/vision/describe) */
  visionFallbackProvider?: ProviderConfig;
  /** Provider config to use for extended reasoning (Mercury /admin/reasoning/ask) */
  reasoningProvider?: ProviderConfig;
  /** Brave Search API key (from config.search.braveApiKey) */
  braveApiKey?: string;
  /** Chemins résolus pour la section # Environment du system prompt */
  environmentPaths: EnvironmentPaths;
  /** Config Mastermind + resolvePath pour l'outil codebase_search */
  codebaseSearchContext?: {
    config: MastermindConfig;
    resolvePath: (p: string) => string;
  };
  /** TTL global du cache prompt (depuis defaults config) — fallback si non défini par agent */
  defaultPromptCacheTtl?: number;
  /** MemoryStore vectoriel pour l'injection contextuelle et les outils mémoire */
  /** Pool PostgreSQL pour le tracking d'accès mémoire */
  db?: import('pg').Pool;
  memoryStoreMod?: MemoryStoreModule;
  /** Store de traces de raisonnement (opt-in via agentConfig.captureReasoningTraces) */
  reasoningTraceStore?: ReasoningTraceStore;
  /** Skill actions module — provides executable skill tools */
  skillActionsMod?: SkillActionsModule;
  /** Scheduler module — enables schedule_task tool */
  schedulerMod?: SchedulerModule;
  /** Async jobs module — enables list_my_jobs tool (agent-side query of its own queue) */
  asyncJobsMod?: AsyncJobsModule;
  /** Prompt templates module — renders editable sections. Pass through to buildLlmPayload. */
  templatesMod?: import('../prompt-templates/index.js').PromptTemplatesModule;
  /** Telegram module — enables send_to_user telegram delivery */
  telegramMod?: TelegramModule;
  /** Push module — enables send_to_user mobile (APNs) delivery */
  pushMod?: PushModule;
  /** Mastermind root config — passed to send_to_user for bot resolution */
  mastermindConfig?: MastermindConfig;
  /** Active proactive/escalation run id — set by scheduler when source='proactive' */
  activeRunId?: string;
  /** Native visible channel for hidden deliveries. Defaults to the run source when visible. */
  visibleSource?: MessageSource;
  /**
   * Per-run override for the send_to_user safety net. When false, the proactive web
   * and Telegram autodeliver fallbacks at end-of-run are skipped, letting the agent
   * finish silently when it doesn't call send_to_user. Defaults to true (legacy behaviour).
   * Sourced from ScheduledTask.autoDeliver / ProactiveSource.autoDeliver.
   */
  autoDeliver?: boolean;
  /**
   * Override de canaux de réveil hérité de la tâche/source planifiée (UI). Transmis au
   * dispatcher d'outils (send_to_user) et aux safety nets — prioritaire sur la policy
   * `delivery` de l'agent et sur l'arg `channel` du LLM. Cf. resolveDelivery (deliver.ts).
   */
  deliveryChannels?: Array<'mobile' | 'telegram'>;
  /**
   * Run d'origine vocale (NCM) avec « masquer le transcript » actif (mobile app). Le réveil
   * mobile interactif de fin de run (bloc B) notifie SANS mettre la réponse en clair dans le
   * body de la notif — en vocal on écoute le TTS, on ne lit pas. La ligne chat reste intacte.
   */
  hidePushTranscript?: boolean;
  /** Full list of known agents — used by list_proactive_watchers and create_proactive_task */
  agentsList?: AgentConfig[];
  /** Per-run override for max tool turns — used by war rooms to cap tool calls per agent turn */
  maxToolTurnsOverride?: number;
  /** Board module — enables board_write / board_delete tools + prompt injection */
  boardMod?: BoardModule;
  /**
   * Warmup mode: build the exact same payload as a live run, send it with
   * `max_completion_tokens=1`, discard the response. No DB writes, no chat broadcasts.
   * Emits `'warming'` at start and `'warm.done'` at end (instead of `'thinking'`/`'idle'`).
   * The point: pre-fill llama.cpp's KV cache so the next live run hits the prefix cache
   * at maximum length. Caller should pass `content: ''` — buildLlmPayload substitutes the
   * canonical `WARMUP_USER_CONTENT` synthetic.
   */
  warmup?: boolean;
  /**
   * Override `<think>...</think>` stripping on history reload. Resolved by AgentModule.run
   * from `config.defaults.stripThinkBlocks` (now defaults to false). Forwarded to buildLlmPayload.
   */
  stripThink?: boolean;
  /**
   * Cache-optimized prompt assembly toggle. Resolved by AgentModule.run from
   * `config.defaults.cacheOptimized` (default true). Forwarded to buildLlmPayload, where it
   * controls whether send_to_user duplicates are filtered from rebuilt history.
   */
  cacheOptimized?: boolean;
  subAgentDelivery?: SubAgentDeliveryContext;
  subAgentDeliveryState?: SubAgentDeliveryState;
  /** Sub-agent only — plafond TOTAL d'appels d'outils (parallèles compris). */
  subAgentToolCallsCap?: number | null;
  /** Sub-agent only — compteur partagé incrémenté à chaque dispatch (sauf submit). */
  subAgentToolCallsCounter?: { count: number };
}

/** Run an agent: store user message, call LLM (with tool loop), store assistant response.
 *  When `ctx.warmup` is true: build the same payload, stream with `max_completion_tokens=1`,
 *  discard the chunks, no DB writes, no chat broadcasts. Single source of truth for the
 *  payload construction — no parallel `warmCacheAgent` to drift out of sync. */
export async function runAgent(ctx: AgentRunContext): Promise<string> {
  let {
    agentConfig, sessionId, content, source,
    sessionMod, providerMod, memoryMod, ws, signal,
    toolDefaults, directives, sessionOptions, images, visionFallbackProvider, reasoningProvider, braveApiKey, environmentPaths, codebaseSearchContext,
    onChunk, onToolCall, onCompact, onHideStreaming, db, memoryStoreMod, reasoningTraceStore, skillActionsMod, schedulerMod, asyncJobsMod, templatesMod,
    telegramMod, pushMod, mastermindConfig, activeRunId, visibleSource: explicitVisibleSource, autoDeliver: autoDeliverOpt, deliveryChannels: taskDeliveryChannels, hidePushTranscript, agentsList, maxToolTurnsOverride, boardMod,
    subAgentDelivery, subAgentDeliveryState, subAgentToolCallsCap, subAgentToolCallsCounter,
  } = ctx;
  const isWarmup = ctx.warmup === true;
  const isProactive = source === 'proactive';
  /**
   * Sandbox mode transitions mid-run via dispatch_sandbox_run (see tools/index.ts) — not a
   * new agentMod.run but a flag flip. We keep `source` as the canonical current source
   * (used by addMessage calls) and derive hidden-ness dynamically so the moment the flag
   * flips, subsequent broadcasts become no-op.
   */
  // Warmup runs are hidden too — no chat broadcast, no DB persistence — the only
  // visible signal is the `warming → warm.done` agent.state pair (re-mapped below).
  // Sub-agent runs are also hidden : the user never sees the transient sub-session,
  // only the TL;DR delivered to the parent session via deliverToChat.
  const isHiddenNow = (): boolean =>
    source === 'proactive' || source === 'sandbox' || source === 'subagent' || isWarmup;
  const isSandboxNow = (): boolean => source === 'sandbox';

  /** Broadcast to the chat channel — no-op during hidden runs (proactive + sandbox + subagent + warmup). */
  const chatBroadcast: typeof ws.broadcast = (room, data) => {
    if (isHiddenNow()) return; // swallowed for hidden runs
    ws.broadcast(room, data);
  };

  // Sub-agent live UI: emit progress events scoped by jobId so the dedicated
  // SubAgentRunDetail panel can show turns/tool calls/text as they happen.
  // chatBroadcast is a no-op for sub-agents (they're hidden), and the user-facing
  // chat WS events would pollute unrelated session subscribers — these go through
  // broadcastAll with a dedicated message type.
  const subAgentJobId: string | null = source === 'subagent' ? (ctx.activeRunId ?? null) : null;
  const emitSubAgentEvent = (msg: WsServerMessage) => {
    if (subAgentJobId) ws.broadcastAll(msg);
  };

  /**
   * Agent state broadcast helper.
   *  - Warmup: remap `'thinking'`→`'warming'` and `'idle'`→`'warm.done'` so the StatusBar
   *    sees the warmup lifecycle distinctly (frontend uses `warm.done` to skip the chat
   *    refetch — no DB writes happened so there's nothing new to fetch).
   *  - Sandbox (non-warmup): remap `'thinking'`/`'streaming'` to `'sandbox'` so the chat
   *    UI doesn't show a spinner in the main thread while background work happens.
   *    `'idle'` passes through unchanged so the badge clears.
   */
  const broadcastAgentState = (state: string) => {
    let remapped = state;
    if (isWarmup) {
      if (state === 'thinking') remapped = 'warming';
      else if (state === 'idle') remapped = 'warm.done';
    } else if (isSandboxNow() && (state === 'thinking' || state === 'streaming')) {
      remapped = 'sandbox';
    }
    // `background` : run d'arrière-plan (proactif/escalade/cron via activeRunId, sandbox).
    // Consommé par mobile app pour ne PAS démarrer de Live Activity sur un run interactif
    // lancé depuis un autre device (session unifiée : taper sur le web ne doit pas
    // allumer l'Island du téléphone). Warmup volontairement non-background : aucun
    // client ne doit démarrer d'Island pour un warmup.
    const background = !isWarmup && (isProactive || !!activeRunId || isSandboxNow());
    ws.broadcastAll({ type: 'agent.state', agentId, state: remapped, background } satisfies WsServerMessage);
    // Live Activity (Dynamic Island) : pousse l'état hors de l'app (écran verrouillé) via APNs.
    // No-op si aucune activité enregistrée pour cette session. Best-effort, jamais bloquant.
    // Policy delivery.liveActivity : 'all' (défaut) = tous les runs ; 'user' = uniquement les
    // runs initiés par l'utilisateur (proactif/escalade/cron muets — l'Island ne s'allume plus
    // pour un briefing à 6h du matin) ; 'off' = jamais.
    const laMode = agentConfig.delivery?.liveActivity ?? 'all';
    const laAllowed = laMode === 'all' || (laMode === 'user' && source !== 'proactive' && !isWarmup);
    if (laAllowed) void pushMod?.pushLiveActivityState(sessionId, agentId, remapped).catch(() => {});
  };

  // ── Sandbox tracking (updated mid-run when dispatch_sandbox_run is called) ─────────
  let sandboxJobId: string | null = null;
  /** Tracks whether we've already finalized the visible streaming at the moment of flip.
   * When true, the Telegram bridge skips its post-run final message, and runAgent skips
   * the final chat.done broadcast (both would produce duplicate/empty user-visible output). */
  let hideStreamingFired = false;
  /** Current turn's accumulated text — used to finalize the streaming display at flip. */
  let currentTurnText = '';
  /** Latest tool_call_turn row id persisted in this run — the ONE that flipped to sandbox
   * is the trigger turn whose text the user must keep seeing after refresh. We stamp it
   * with `sandbox_trigger:true` in setRunSource so hydrateToolEvents stops filtering it. */
  let lastToolCallTurnRowId: string | null = null;
  /** Set to true once a successful `send_to_user` has fired during this run. Drives:
   *   1. the sandbox break-early path (sandbox contract fulfilled)
   *   2. the sandbox safety net (orphan auto-delivery)
   *   3. the Telegram fallback for non-sandbox runs that target a Telegram-native
   *      session (scheduler/proactive without live bridge — light models often forget). */
  let sendToUserCalled = false;

  /**
   * The visible channel source to use when `send_to_user` delivers back to the user.
   * Sandbox / proactive runs need a "native" source to tag the delivery with so the
   * message matches its neighbours in the chat thread. We derive it from the sessionId
   * convention: Telegram sessions contain `-tg-` (see ws.ts handler + bridge.ts).
   * Stays stable even if `source` flips to 'sandbox' mid-run.
   */
  const visibleSource: MessageSource = explicitVisibleSource ?? (source === 'telegram' ? 'telegram' : 'web');
  /** Resolved per-run autoDeliver flag. Default true preserves the legacy safety net. */
  const autoDeliver = autoDeliverOpt ?? true;

  /** Phase within the proactive pipeline — derived from SchedulerModule's run context.
   * 'watcher' during a kind='proactive' run (gets escalate_to_agent),
   * 'handler' during a kind='escalation' run OR a push-based proactive run without run context (gets send_to_user with auto-alert side-effects),
   * undefined otherwise (normal chat/task run). */
  const runContext = isProactive && activeRunId ? schedulerMod?.getRunContext(activeRunId) : undefined;
  const proactivePhase: 'watcher' | 'handler' | undefined =
    runContext?.kind === 'proactive' ? 'watcher' :
    runContext?.kind === 'escalation' ? 'handler' :
    // Push-based proactive alerts (from proactive-source webhook) run with source='proactive'
    // but without a scheduler run context — they act as handlers (can send_to_user + escalate).
    isProactive && !runContext ? 'handler' :
    undefined;

  const agentId = agentConfig.identity.id;
  console.debug(
    `[agent] run start ${agentId} session=${sessionId} source=${source} contentLen=${content.length} images=${images?.length ?? 0}`,
  );
  // Session unifiée cross-plateforme : pilote la livraison multi-canal (mobile push même quand
  // visibleSource='telegram') et le ciblage Telegram (DM owner uniquement, pas les groupes).
  const isUnifiedSession = isUnifiedSessionId(agentId, sessionId);

  // Effective values = session options (already merged by AgentModule before calling runAgent)
  const effectiveModel = sessionOptions?.modelOverride ?? agentConfig.model;
  const maxCompletionTokens = agentConfig.maxCompletionTokens;
  // Multi-LoRA : `loraScales[i]` = scale pour le LoRA d'`id=i` côté llama-server.
  // La migration depuis le legacy mono-LoRA `loraScale` (scalaire) est faite à
  // la résolution `agentYaml → agentConfig` (cf agent/index.ts), donc ici on ne
  // lit que la forme array — un tableau vide / absent = pas d'injection LoRA.
  const loraPayload = agentConfig.loraScales && agentConfig.loraScales.length > 0
    ? agentConfig.loraScales.map((scale, id) => ({ id, scale }))
    : null;

  // Ensure session exists. Skipped in warmup mode: warmup is supposed to be strictly
  // side-effect-free, and `getOrCreate` does an INSERT if the session row is missing.
  // In practice all warmup callers (autoWarmup queue, post-compact, TG bridge button,
  // WS cache.warm) only fire on sessions that already have messages, so the row
  // always exists. Even if it didn't, `getMessages` works fine with no session row
  // (returns []) and the warmup payload is built from system+tools+synthetic user msg.
  if (!isWarmup) {
    await sessionMod.getOrCreate(sessionId, agentId);
    console.debug(`[agent] session ready agent=${agentId} session=${sessionId}`);
  }

  // Store user message (directives already stripped by caller). Warmup runs skip this:
  // no DB write, no broadcast, no command parsing — they only build a payload + cap=1 stream.
  let userMsg: ChatMessage | null = null;
  if (!isWarmup) {
    userMsg = await sessionMod.addMessage(sessionId, 'user', content, source);
    console.debug(`[agent] user message stored agent=${agentId} session=${sessionId} message=${userMsg.id} source=${source}`);

    // Broadcast user message to web clients
    chatBroadcast(sessionId, {
      type: 'session.message',
      sessionId,
      message: userMsg,
    } satisfies WsServerMessage);

    // Command-only message (e.g. /help with no text) — respond directly without calling the LLM
    if (directives?.isCommandOnly && directives.commandResponse) {
      broadcastAgentState('thinking');
      const assistantMsg = await sessionMod.addMessage(sessionId, 'assistant', directives.commandResponse, source);
      chatBroadcast(sessionId, {
        type: 'chat.done',
        sessionId,
        agentId,
        messageId: assistantMsg.id,
        content: directives.commandResponse,
      } satisfies WsServerMessage);
      broadcastAgentState('idle');
      return directives.commandResponse;
    }
  }

  // Broadcast agent state
  broadcastAgentState('thinking');

  try {
    const reasoningAvailable = Boolean(reasoningProvider?.statsUrl);
    // Vision-describe shares the same Mercury statsUrl as reasoning (different endpoint +
    // model config server-side). If statsUrl exists, expose `inspect_image`; Mercury surfaces
    // a clear error at call time if openrouter_vision_model isn't configured.
    const visionDescribeAvailable = Boolean(reasoningProvider?.statsUrl);

    // ── Dump user-uploaded images to disk for path-based tools ──
    // MUST run BEFORE the vision-fallback branch below: when the provider is text-only
    // (e.g. Qwen3.6 local without vision), we set `images = undefined` to skip native
    // multimodal injection — but we still want the agent to be able to reference the
    // original image by path (skill_media-gen edit, OCR, etc.). Doing the dump here,
    // with the original `images` array, covers both paths uniformly.
    let userImagePaths: string[] = [];
    if (!isWarmup && images && images.length > 0 && userMsg) {
      try {
        userImagePaths = await dumpUserImages(images, userMsg.id, environmentPaths.userImagesDir);
        if (userImagePaths.length > 0) {
          console.log(`[run] ${agentId} dumped ${userImagePaths.length} user image(s) to ${environmentPaths.userImagesDir}`);
        }
      } catch (err) {
        console.warn(`[run] ${agentId} user image dump failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Vision fallback — convert images to text descriptions if the provider is text-only.
    let visionFallbackApplied = false;
    if (images && images.length > 0 && visionFallbackProvider?.visionFallbackEnabled && visionFallbackProvider.statsUrl) {
      console.log(`[run] ${agentId} vision fallback: describing ${images.length} image(s) via Mercury`);
      const descriptionText = await resolveImagesAsText(images, visionFallbackProvider, content);
      if (descriptionText) {
        content = descriptionText + (content ? `\n\n${content}` : '');
        images = undefined;
        visionFallbackApplied = true;
      }
    }

    // ── Build LLM payload (single source of truth — shared between live and warmup) ──
    // The warmup flag forces buildLlmPayload to:
    //   - Skip auto-compact (no DB writes during warmup)
    //   - Append a synthetic user message in-memory only (with WARMUP_USER_CONTENT)
    //   - Otherwise produce a payload byte-identical to a live run
    // Every option below is passed identically in both modes — no parallel chain to drift.
    const payloadStartedAt = Date.now();
    const payload = await buildLlmPayload({
      agentConfig, sessionId, content, effectiveModel,
      sessionMod, providerMod, memoryMod, environmentPaths,
      codebaseSearchContext, sessionOptions,
      defaultPromptCacheTtl: ctx.defaultPromptCacheTtl,
      memoryStoreMod, boardMod, db, agentsList, braveApiKey,
      skillActionsMod, schedulerMod, asyncJobsMod, templatesMod, reasoningAvailable, visionDescribeAvailable,
      source, images, visionFallbackApplied, proactivePhase,
      contentInHistory: !isWarmup,
      warmup: isWarmup,
      stripThink: ctx.stripThink,
      cacheOptimized: ctx.cacheOptimized,
      userImagePaths,
      subAgentRunContext: subAgentDelivery,
    });
    const payloadBuildMs = Date.now() - payloadStartedAt;
    const { messages, tools: availableTools, reasoningEffort, reasoningEnabled, compactMsg, codebaseSearchAvailable, lastUserMsgLivePrefix, lastUserMsgVisionPrefix } = payload;

    // Verbose payload telemetry — same shape for warm and live so a side-by-side grep
    // tells us if any section diverges. Only msg[N] (the trailing user message) should
    // legitimately differ between the two; if any earlier hash differs, the prefix
    // KV-cache will miss past that point.
    // Always emit buildMs in both modes — sinon le diff manuel `[warm]` vs `[run-payload]`
    // a une clé en moins côté live, ce qui casse le grep strict pour comparer les shapes.
    await logPayloadHashes(
      isWarmup ? 'warm' : 'run-payload',
      payload,
      agentId,
      sessionId,
      effectiveModel,
      { buildMs: payloadBuildMs },
    );

    // ── Warmup early-return: stream cap=1, discard chunks, exit through the same finally ──
    // No DB writes (userMsg was never created above), no chat broadcasts (chatBroadcast is
    // already a no-op for hidden runs), no tool loop, no persistence of any kind. The
    // 'warm.done' agent.state is emitted by the finally via the broadcastAgentState remap.
    if (isWarmup) {
      const streamStartedAt = Date.now();
      let firstChunkAt = 0;
      let chunkCount = 0;
      let totalChars = 0;
      await providerMod.streamRich(effectiveModel, {
        messages: messages as Parameters<typeof providerMod.streamRich>[1]['messages'],
        tools: availableTools,
        max_completion_tokens: 1,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        reasoning: reasoningEnabled,
        ...(loraPayload ? { lora: loraPayload } : {}),
      }, (chunk: string) => {
        chunkCount++;
        totalChars += chunk.length;
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        // discard — only the prefill matters for KV-cache warming
      }, signal);

      const streamMs = Date.now() - streamStartedAt;
      const prefillMs = firstChunkAt > 0 ? firstChunkAt - streamStartedAt : streamMs;
      // Sanity check: cap=1 should clip output. If we got a paragraph back, llama-server
      // or the model is ignoring the cap (some reasoning configs do) — warn loudly.
      const CAP_WARN_THRESHOLD_CHARS = 50;
      if (totalChars > CAP_WARN_THRESHOLD_CHARS) {
        console.warn(`[warm] ${agentId} CAP NOT ENFORCED: max_completion_tokens=1 but received ${totalChars} chars in ${chunkCount} chunks — model or llama-server may not respect the cap (model=${effectiveModel}, reasoning=${reasoningEnabled})`);
      } else {
        console.log(`[warm] ${agentId} cap respected: ${totalChars} chars in ${chunkCount} chunks`);
      }
      console.log(`[warm] ${agentId} done streamMs=${streamMs} prefillMs=${prefillMs} chunks=${chunkCount} genChars=${totalChars}`);
      return ''; // returns through the finally → broadcasts 'warm.done'
    }

    // Persist the exact live prefix (memory+board+date+MESSAGE block) that was prepended to the
    // current user message — so future turns reconstructing this row produce byte-identical
    // tokens and llama.cpp's KV prefix cache keeps hitting past this position.
    //
    // Awaited (not fire-and-forget) to avoid a race: if the user sends a second message before
    // this UPDATE commits, buildLlmPayload for that second turn would read the previous user
    // row without the injectedPrefix and reconstruct plain content, missing the cache.
    //
    // No `!compactMsg` guard: even when auto-compact fires, if our just-added userMsg survived
    // into the kept turns we still want its injectedPrefix saved. If it was swallowed into the
    // compact summary, the row is soft-deleted (excluded from future getMessages) — writing
    // metadata to it is harmless no-op.
    // userMsg is guaranteed non-null here: the warmup branch returned earlier, and the
    // non-warmup setup always stores the user message before reaching this point.
    // `visionFallbackPrefix` rides along in the same UPDATE when the vision-fallback path fired
    // (that branch sets BOTH lastUserMsgLivePrefix and lastUserMsgVisionPrefix). Persisting them
    // together — and merged via jsonb `||` (updateMessageMetadata) — lets toAiMessage reconstruct
    // `injectedPrefix + visionFallbackPrefix + content` byte-for-byte next turn, killing the
    // permanent KV-cache miss the vision-fallback turn used to introduce.
    if (lastUserMsgLivePrefix && userMsg) {
      try {
        await sessionMod.updateMessageMetadata(userMsg.id, {
          injectedPrefix: lastUserMsgLivePrefix,
          ...(lastUserMsgVisionPrefix ? { visionFallbackPrefix: lastUserMsgVisionPrefix } : {}),
        });
      } catch (err) {
        console.warn(`[agent] ${agentId} failed to persist injectedPrefix: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Persist the absolute paths of dumped user images so future turns can reconstruct
    // the same `_System note — uploaded images saved to disk_` footer in the user message.
    // Two reasons:
    //   1. KV cache stability: same paths → byte-identical content → llama.cpp prefix-hits
    //   2. Cross-turn referenceability: agent can call `skill_media-gen edit` on the same
    //      photo at turn N+5 ("redo it but bluer") without the user re-uploading.
    if (payload.userImagePaths.length > 0 && userMsg) {
      try {
        await sessionMod.updateMessageMetadata(userMsg.id, { userImagePaths: payload.userImagePaths });
      } catch (err) {
        console.warn(`[agent] ${agentId} failed to persist userImagePaths: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Notify web clients and Telegram when auto-compact fires
    if (compactMsg) {
      console.log(`[agent] ${agentId} auto-compact applied for session=${sessionId}`);
      chatBroadcast(sessionId, {
        type: 'session.message',
        sessionId,
        message: compactMsg,
      } satisfies WsServerMessage);
      onCompact?.(compactMsg.content);
    }
    if (sessionOptions?.toolsDisabled) {
      console.debug(`[run] ${agentId} tools disabled by session option`);
    }

    const maxToolTurns: number = maxToolTurnsOverride ?? toolDefaults?.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
    const maxReasoningCalls: number = toolDefaults?.maxReasoningCalls ?? 3;
    const maxReasoningInputChars: number = toolDefaults?.maxReasoningInputChars ?? 8000;
    let reasoningCallsUsed = 0;
    // Loop guard. Tracks consecutive identical tool_call signatures (name + JSON args)
    // across the dispatch loop and across tool turns within this run. Resets on signature
    // change or run end. When `consecutiveIdenticalCount` exceeds the threshold (strict
    // `>`), the dispatcher returns a soft-refuse message instead of executing the tool —
    // the model sees this in tool_result and is nudged to change approach.
    //
    // Default 5 → calls 1..5 with the same signature execute normally, the 6th hits the
    // soft-refuse. Undefined config field also resolves to 5 (loop guard ON by default).
    // Set 0 in mastermind.yml `defaults.toolDefaults.maxIdenticalToolCalls` (or "Max
    // identical tool calls = 0" via the Settings UI) to DISABLE the guard entirely.
    const maxIdenticalToolCalls: number = toolDefaults?.maxIdenticalToolCalls ?? 5;
    // Auto-abort escalation. When the model emits the same signature TWICE in a row
    // AFTER the loop guard already fired (consecutiveIdenticalCount > maxIdenticalToolCalls + 1
    // — first guard fire = warning, second = stuck), abort the run instead of letting the model
    // burn another stream cycle. Defaults true to "cut the grass". No-op when guard is off.
    const autoAbortOnLoopGuard: boolean = toolDefaults?.autoAbortOnLoopGuard ?? true;
    let lastToolCallSig: string | null = null;
    let consecutiveIdenticalCount = 0;
    const systemAccess = agentConfig.tools?.systemAccess ?? false;
    const allowedPathRoots = uniqueResolvedPaths([
      environmentPaths.workspace,
      environmentPaths.sharedMemory,
      environmentPaths.compactArchives,
      environmentPaths.agentsRoot,
      ...(environmentPaths.skillsDir ? [environmentPaths.skillsDir] : []),
      // userImagesDir defaults under sharedMemory but admin may point it elsewhere
      // (e.g. dedicated /var/cache/...) — must be in the allowlist so read_file /
      // edit_file don't reject paths the system prompt tells the agent to use.
      environmentPaths.userImagesDir,
    ]);
    // Queue of side-effects that tools want to run STRICTLY AFTER each tool_result has
    // been persisted. Drained inside the tool loop right after `addMessage('tool', ...)`.
    // Today's only producer is `send_to_user` (visible-content duplicate row); the queue
    // is generic so any future tool with the same KV-cache-ordering need just pushes here.
    const pendingPostToolResult: Array<() => Promise<void>> = [];

    // Compteur de spawns sub-agent — un par run de parent. Anti-runaway côté tool
    // (cf. ToolExecOptions.spawnSubagentsLimit). Lu+incrémenté dans executeSpawnSubagent.
    const spawnSubagentsCounter = { count: 0 };
    const spawnSubagentsLimit = mastermindConfig?.subagentDefaults?.maxSpawnsPerParentRun ?? 5;

    const toolExecOpts = {
      bashTimeoutMs: toolDefaults?.bashTimeoutMs,
      webFetchMaxChars: toolDefaults?.webFetchMaxChars,
      braveApiKey,
      systemAccess,
      allowedPathRoots,
      sharedMemoryDir: environmentPaths.sharedMemory,
      pendingPostToolResult,
      spawnSubagentsCounter,
      spawnSubagentsLimit,
      // Per-agent exec gate inputs: the gate in executeTool checks these against the
      // unified tool surface to soft-refuse calls to disabled tools or non-starred skills.
      agentConfig,
      ...(skillActionsMod ? { skillActionsMod } : {}),
      ...(codebaseSearchAvailable && codebaseSearchContext
        ? {
            codebaseSearch: {
              mastermindConfig: codebaseSearchContext.config,
              resolvePath: codebaseSearchContext.resolvePath,
              agentId,
            },
          }
        : {}),
      ...(reasoningAvailable && reasoningProvider
        ? {
            reasoningConfig: {
              statsUrl: reasoningProvider.statsUrl!,
              statsApiKey: reasoningProvider.statsApiKey || reasoningProvider.apiKey,
              maxInputChars: maxReasoningInputChars,
            },
          }
        : {}),
      ...(visionDescribeAvailable && reasoningProvider
        ? {
            visionConfig: {
              statsUrl: reasoningProvider.statsUrl!,
              statsApiKey: reasoningProvider.statsApiKey || reasoningProvider.apiKey,
            },
          }
        : {}),
      ...(memoryStoreMod?.isEnabled
        ? { memoryStore: { module: memoryStoreMod, agentId, excludeShared: agentConfig.excludeSharedMemory === true } }
        : {}),
      ...(codebaseSearchContext?.config.memoryStore?.enableDeduplication
        ? { enableDeduplication: true }
        : {}),
      ...(codebaseSearchContext?.config.memoryStore?.deduplicationThreshold != null
        ? { deduplicationThreshold: codebaseSearchContext.config.memoryStore.deduplicationThreshold }
        : {}),
      ...(codebaseSearchContext?.config.memoryStore?.bypassSignificanceFilter
        ? { bypassSignificanceFilter: true }
        : {}),
      ...(skillActionsMod?.isActive
        ? { skillActionsExecutor: (name: string, args: Record<string, unknown>, ctx?: { agentId: string; sessionId: string }) => skillActionsMod.execute(name, args, ctx) }
        : {}),
      currentAgentId: agentId,
      currentRunSource: source,
      visibleSource,
      // Override par tâche (run options scheduler) avec fallback sur le contexte de run
      // (escalades héritées) — consommé par send_to_user via resolveDelivery.
      taskDeliveryChannels: taskDeliveryChannels ?? runContext?.deliveryChannels,
      isSandboxActive: () => sandboxJobId !== null,
      // v3 : trigger de livraison du run courant — recalculé à l'exécution du tool car le
      // sandbox peut s'activer en plein run (flip via dispatch_sandbox_run). Couvre les crons
      // kind='task' (activeRunId présent SANS être proactif → 'task'), ce que `proactiveRunId`
      // seul (proactif uniquement) ne distinguait pas.
      currentRunTrigger: (): DeliveryTrigger => runKindTrigger({
        source,
        ...(proactivePhase ? { proactivePhase } : {}),
        ...(activeRunId ? { activeRunId } : {}),
        sandboxJobId,
      }),
      setRunSource: (newSource: MessageSource) => {
        const wasVisible = source === 'web' || source === 'telegram';
        const oldSource = source;
        source = newSource;
        console.log(`[run] ${agentId} source transition session=${sessionId} ${oldSource}→${newSource} visibleSource=${visibleSource}`);
        // On transition to a hidden mode (sandbox) from a visible one, finalize the
        // in-flight streaming display so the chat UI / Telegram stop showing a cursor.
        if (wasVisible && (newSource === 'sandbox' || newSource === 'proactive') && !hideStreamingFired) {
          hideStreamingFired = true;
          const finalText = currentTurnText;
          // Use the trigger row id as the message id — the same DB row stays addressable
          // post-refresh (no synthetic ghost id that vanishes on the next fetchMessages).
          const transitionMessageId = lastToolCallTurnRowId ?? `sandbox-transition-${Date.now()}`;
          // Synthetic chat.done — bypasses chatBroadcast so it still reaches the web UI
          // despite the new hidden source. Frontend uses this to clear isStreaming.
          ws.broadcast(sessionId, {
            type: 'chat.done',
            sessionId,
            agentId,
            messageId: transitionMessageId,
            content: finalText,
            partial: true,
          } satisfies WsServerMessage);
          // Bridge hook (Telegram) — finalize its live message, stop typing
          void Promise.resolve(onHideStreaming?.(finalText)).catch(err => {
            console.warn(`[run] onHideStreaming failed: ${err instanceof Error ? err.message : err}`);
          });
          // Stamp the trigger DB row so hydrateToolEvents stops filtering it on refresh.
          // Without this, fetchMessages() (fired on next agent.state='idle') would wipe the
          // trigger text from the UI — the row IS persisted, but tool_call_turn rows are
          // dropped by default for being "internal context".
          if (lastToolCallTurnRowId) {
            void sessionMod
              .updateMessageMetadata(lastToolCallTurnRowId, { sandbox_trigger: true })
              .catch(err => console.warn(`[run] sandbox_trigger stamp failed: ${err instanceof Error ? err.message : err}`));
          }
        }
      },
      setSandboxJobId: (jobId: string) => {
        sandboxJobId = jobId;
        console.log(`[run] ${agentId} sandbox tracking attached job=${jobId} session=${sessionId}`);
      },
      ...(schedulerMod ? { schedulerModule: schedulerMod } : {}),
      ...(asyncJobsMod ? { asyncJobsModule: asyncJobsMod } : {}),
      ...(boardMod ? { boardModule: boardMod } : {}),
      // ── Proactive module plumbing ──
      ...(isProactive && activeRunId ? { proactiveRunId: activeRunId } : {}),
      // Tout run piloté par le scheduler/proactive-source (activeRunId posé, y compris
      // les crons kind='task' en source='web') est un run d'ARRIÈRE-PLAN : policy.wake
      // peut s'y appliquer. Un chat interactif n'a jamais d'activeRunId.
      isBackgroundRun: !!activeRunId,
      sessionModule: sessionMod,
      telegramModule: telegramMod,
      pushModule: pushMod,
      ws,
      mastermindConfig,
      ...(codebaseSearchContext ? { resolveConfigPath: codebaseSearchContext.resolvePath } : {}),
      handlerAgentConfig: agentConfig,
      currentSessionId: sessionId,
      attachmentRoots: {
        workspace: environmentPaths.workspace,
        shared: environmentPaths.sharedMemory,
      },
      agentsList,
      ...(subAgentDelivery && subAgentDeliveryState && db
        ? { subAgentDelivery, subAgentDeliveryState, db }
        : {}),
      ...(subAgentToolCallsCounter
        ? { subAgentToolCallsCap: subAgentToolCallsCap ?? null, subAgentToolCallsCounter }
        : {}),
    };

    const providerTypeForLog = providerMod.getProviderType(effectiveModel);
    console.log(`[run] ${agentId} session=${sessionId} model=${effectiveModel} provider=${providerTypeForLog} tools=${availableTools.length} think=${reasoningEffort ?? 'off'}${proactivePhase ? ` proactivePhase=${proactivePhase} activeRunId=${activeRunId ?? '?'}` : ''}`);
    // Proactive runs: log the exact tool list so we can verify escalate_to_agent / send_to_user are exposed.
    if (proactivePhase) {
      const toolNames = availableTools.map(t => t.name).join(',');
      console.log(`[run] ${agentId} proactive tool surface: [${toolNames}]`);
    }

    let fullResponse = '';
    // When the final assistant message is rebuilt from accumulated <think> blocks (display
    // convenience — see the merge in the no-tool-call branch), `fullResponse` (what we persist
    // as the row CONTENT, for the UI) no longer matches the bytes the LLM slot actually streamed
    // for that final turn. Holding the raw streamed bytes here lets us persist them in the row
    // metadata so toAiMessage re-sends the EXACT cached sequence next turn (KV-cache prefix hit),
    // while the UI keeps rendering the merged content. Stays null on every turn where content ===
    // raw stream (no divergence → nothing extra to persist, toAiMessage falls back to content).
    let finalRawAssistantStream: string | null = null;
    let toolTurns = 0;
    let aborted = false;
    /** Collect tool events during the run for persistence in message metadata */
    const runToolEvents: ToolEventPayload[] = [];

    // ── DIRECT STREAM PATH ──────────────────────────────────────────────────────
    // When no tools are available (disabled or /tools off), stream directly —
    // single API call, tokens appear live, <think> blocks preserved.
    if (availableTools.length === 0) {
      broadcastAgentState('streaming');
      console.log(`[run] ${agentId} → direct stream (no tools)`);

      try {
        for await (const chunk of providerMod.stream(effectiveModel, {
          messages: messages as Parameters<typeof providerMod.stream>[1]['messages'],
          ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          reasoning: reasoningEnabled,
        }, signal)) {
          fullResponse += chunk;
          onChunk?.(chunk);
          chatBroadcast(sessionId, {
            type: 'chat.delta',
            sessionId,
            agentId,
            content: chunk,
          } satisfies WsServerMessage);
        }
      } catch (err) {
        if (signal?.aborted) {
          aborted = true;
          console.log(`[run] ${agentId} aborted during direct stream — ${fullResponse.length} chars accumulated`);
        } else {
          throw err;
        }
      }

      if (!aborted) {
        const hasThink = fullResponse.includes('<think>');
        const preview = fullResponse.slice(0, 200).replace(/\n/g, '↵');
        console.log(`[run] ${agentId} stream done: ${fullResponse.length} chars hasThink=${hasThink} preview="${preview}"`);
        // Empty-response guard (cf. tool-loop branch for rationale).
        if (fullResponse.length === 0) {
          console.warn(`[run] ${agentId} empty response from direct stream — 0 chunks received`);
          throw new Error('Réponse vide de Mercury (connexion interrompue pendant le prefill ?).');
        }
      }

    } else {
      // ── TOOL LOOP (streaming) ──────────────────────────────────────────────────
      // Single streamRich() call per turn: text chunks forwarded live via callback,
      // tool calls accumulated inline. No double-call, KV cache preserved.
      // Accumulate <think> blocks from tool turns so they survive into the final
      // assistant message (otherwise they'd be lost in the hidden tool_call_turn rows).
      const accumulatedThinkBlocks: string[] = [];
      while (toolTurns <= maxToolTurns) {
        if (signal?.aborted) {
          console.log(`[run] ${agentId} aborted before tool turn ${toolTurns}`);
          aborted = true;
          break;
        }

        broadcastAgentState('streaming');
        console.log(`[run] ${agentId} tool turn ${toolTurns}/${maxToolTurns} → streamRich starting (messages=${messages.length})`);

        if (subAgentJobId) {
          emitSubAgentEvent({
            type: 'subagent.run.turn',
            jobId: subAgentJobId,
            sessionId,
            agentId,
            turn: toolTurns,
            maxTurns: maxToolTurns,
          });
        }

        const turnText: string[] = [];
        currentTurnText = '';
        const t0 = Date.now();

        let rich: Awaited<ReturnType<typeof providerMod.streamRich>>;
        // Sub-agents skip streaming: their output isn't shown live anywhere
        // (final report goes to parent via submit_subagent_report). Streaming over
        // long sub-agent runs is fragile (SSE keepalive can mask upstream death,
        // httpx connection pool reuse can hang on half-closed sockets). Non-stream
        // gives proper request/response semantics and avoids the zombie-stream class
        // of bugs entirely.
        const useStream = source !== 'subagent';
        try {
          if (useStream) {
            rich = await providerMod.streamRich(effectiveModel, {
              messages: messages as Parameters<typeof providerMod.streamRich>[1]['messages'],
              ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
              tools: availableTools,
              ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
              reasoning: reasoningEnabled,
              ...(loraPayload ? { lora: loraPayload } : {}),
            }, (chunk) => {
              turnText.push(chunk);
              currentTurnText = turnText.join('');
              // Swallow chunk propagation when the run is hidden (proactive / sandbox).
              // The Telegram bridge + web UI shouldn't see background token flow mid-run.
              // turnText (line above) still accumulates for the final raw response.
              if (!isHiddenNow()) {
                onChunk?.(chunk);
                chatBroadcast(sessionId, {
                  type: 'chat.delta',
                  sessionId,
                  agentId,
                  content: chunk,
                } satisfies WsServerMessage);
              }
            }, signal);
          } else {
            rich = await providerMod.completeRich(effectiveModel, {
              messages: messages as Parameters<typeof providerMod.completeRich>[1]['messages'],
              ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
              tools: availableTools,
              ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
              reasoning: reasoningEnabled,
              ...(loraPayload ? { lora: loraPayload } : {}),
            });
            // Mirror the streaming path's accumulator so downstream code that reads
            // turnText/currentTurnText sees the same shape regardless of mode.
            if (rich.content) {
              turnText.push(rich.content);
              currentTurnText = rich.content;
            }
          }
        } catch (err) {
          if (signal?.aborted) {
            aborted = true;
            fullResponse = turnText.join('');
            console.log(`[run] ${agentId} aborted during ${useStream ? 'streamRich' : 'completeRich'} — ${fullResponse.length} chars accumulated`);
            break;
          }
          console.error(`[run] ${agentId} ${useStream ? 'streamRich' : 'completeRich'} error turn=${toolTurns} after ${Date.now() - t0}ms:`, err instanceof Error ? err.message : String(err));
          throw err;
        }

        const turnContent = turnText.join('');
        console.log(`[run] ${agentId} ${useStream ? 'streamRich' : 'completeRich'}: ${Date.now() - t0}ms text=${turnContent.length}chars toolCalls=${rich.toolCalls?.length ?? 0} finish=${rich.finishReason}${rich.usage ? ` usage=${rich.usage.promptTokens}in/${rich.usage.outputTokens}out cached=${rich.usage.cachedTokens ?? 0}` : ''}`);

        // Broadcast real token usage from the provider (Mercury force include_usage=true sur
        // ses 3 backends openrouter/llamacpp/ollama → on a les vraies tokens cloud ET locales,
        // pas besoin d'estimation chars/3.5 côté frontend).
        // Émis par tour : la jauge reflète ainsi le contexte réel après chaque tool turn.
        if (rich.usage && !isHiddenNow()) {
          ws.broadcastAll({
            type: 'provider.stats',
            agentId,
            sessionId,
            stats: {
              ts: new Date().toISOString(),
              promptTokens: rich.usage.promptTokens,
              outputTokens: rich.usage.outputTokens,
              ...(rich.usage.cachedTokens != null ? { cachedTokens: rich.usage.cachedTokens } : {}),
              ...(rich.usage.tokensPerSecond != null ? { tokensPerSecond: rich.usage.tokensPerSecond } : {}),
            },
          } satisfies WsServerMessage);
        }

        if (subAgentJobId && turnContent.length > 0) {
          emitSubAgentEvent({
            type: 'subagent.run.text',
            jobId: subAgentJobId,
            sessionId,
            agentId,
            turn: toolTurns,
            content: turnContent,
            finishReason: rich.finishReason,
          });
        }

        // Empty-response guard: provider returned 0 chunks AND no tool calls, no abort.
        // - finishReason='error' = OpenRouter/Mercury raised a structured upstream error
        //   (timeout, payment, server_error, …). The error chunk's message was already
        //   thrown by openai-compat.streamRich → caught by the outer try → here only
        //   reachable if Mercury fell through without raising. Surface the category in
        //   the error so the user sees what actually happened.
        // - Empty + finishReason='stop' = silent connection drop mid-prefill.
        if (!signal?.aborted && turnContent.length === 0 && (!rich.toolCalls || rich.toolCalls.length === 0)) {
          if (rich.finishReason === 'error') {
            console.warn(`[run] ${agentId} provider error finishReason — content empty, propagating`);
            throw new Error('Erreur upstream OpenRouter (timeout/billing/network).');
          }
          console.warn(`[run] ${agentId} empty response from provider — 0 chunks, no tool calls, finish=${rich.finishReason}`);
          throw new Error('Réponse vide de Mercury (connexion interrompue pendant le prefill ?).');
        }

        if (rich.toolCalls && rich.toolCalls.length > 0) {
          // Filter out any malformed tool calls (missing name — can happen with some providers)
          rich.toolCalls = rich.toolCalls.filter(tc => tc.name);
          if (rich.toolCalls.length === 0) {
            // All tool calls were invalid — treat as text-only response
            console.warn(`[run] ${agentId} all tool calls had empty names, treating as text response`);
            break;
          }
          // Capture any <think> blocks from this tool turn so they're not lost in the
          // hidden tool_call_turn DB row (they'll be merged into the final assistant message).
          const turnThinks = extractThinkContents(turnContent);
          if (turnThinks.length > 0) accumulatedThinkBlocks.push(...turnThinks);
          // CRITICAL — KV-cache parity with DB rebuild path.
          //
          // The in-memory `messages[]` array is mutated by every tool turn (push below),
          // and that same array is what the next iter sends to the LLM. When the run
          // ends and a NEW run starts (resume after sandbox, next user turn, etc.),
          // buildLlmPayload re-reads from DB and rebuilds via toAiMessage(stripThink).
          //
          // For the LLM's KV-cache to hit on the prefix, the bytes pushed in-memory here
          // MUST equal the bytes toAiMessage would return for the SAME persisted row.
          // DB stores `turnContent || ''` (line below — RAW, untrimmed). toAiMessage with
          // stripThink=false therefore returns raw content (with trailing `\n\n` etc.).
          //
          // `stripThinkBlocks()` calls `.trim()` internally (run.ts:107) — using its
          // output here when stripThink=false would diverge by exactly the trimmed
          // whitespace at every tool turn whose model output ended with `\n\n`. On a
          // hybrid Mamba/SSM model (full_attention_interval=4), llama.cpp can't restore
          // a recurrent checkpoint past that divergence point → forces full prompt
          // re-processing on the next run. Audit 2026-04-29 measured 30+ such
          // divergences in a single sandbox→resume cycle, costing ~5min of prefill.
          const modelTurnContent = ctx.stripThink
            ? stripThinkBlocks(turnContent)
            : (turnContent || ''); // mirrors toAiMessage(stripThink=false) for `m.content = turnContent || ''`
          // Tool-calling turn: add assistant turn with tool_calls, execute tools
          broadcastAgentState('thinking');

          const toolCallsForMsg = rich.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));

          // Text-extracted tool_call detection.
          //
          // Some models (notably this Qwen3.6-brain finetune, certain DeepSeek-R1 fine-tunes,
          // gpt-oss with some chat templates) don't emit native structured tool_calls — they
          // emit pseudo-XML markup INSIDE their content/reasoning_content like:
          //   <tool_call><function=bash><parameter=cmd>...</parameter></function></tool_call>
          // Mercury's text-extractor parses this markup into structured tool_calls and tags
          // each with a synthetic id `tc-text-N` (no native model id is available).
          //
          // The danger: if we persist BOTH the raw content (which still contains the XML
          // markup, since it was part of what the model emitted) AND the structured
          // tool_calls metadata, the chat template at next rebuild renders BOTH forms in
          // the prompt — once as the inline XML inside content, once as native
          // <tool_call>{json}</tool_call> blocks generated from tool_calls metadata. The
          // model originally streamed only the XML form, so the slot's KV-cache has only
          // those bytes. The duplicated rebuild diverges from the cache at the position
          // where the structured tool_calls are appended → forced full reprocess on
          // hybrid recurrent models (no checkpoint reachable past the divergence). Audit
          // 2026-05-02 measured a 77s reprocess caused exactly by this duplication after
          // a 2-tool-call assistant turn.
          //
          // Fix: when ALL tool_calls in this turn have synthetic `tc-text-` ids, drop the
          // structured tool_calls from the in-memory messages array AND from the DB
          // metadata. The content (with its inline XML markup) is the authoritative
          // representation — re-rendered as-is at the next turn it matches what the model
          // streamed, so the KV-cache hits cleanly. Dispatch is unchanged for THIS turn:
          // the rich.toolCalls loop below executes each call regardless of how it's
          // persisted. Tool_result messages still link via tool_call_id (stable across
          // both modes).
          //
          // Native tool_call models (Claude, GPT-4, standard Qwen3-Instruct, Llama-3.1+)
          // produce real model-generated ids that don't start with `tc-text-`, so the
          // discriminant naturally selects them out and the legacy persist path runs.
          //
          // KNOWN UNCOVERED EDGE CASE (audit 2026-05-02): a HYBRID turn with at least one
          // native tool_call AND at least one text-extracted (e.g. a model that emits both
          // formats in the same turn — we haven't seen this in production yet but it's
          // theoretically possible with some chat templates). `every()` returns false for
          // such turns → legacy path runs → the structured tool_calls (mix of native +
          // synthetic) are persisted, AND the content still contains the XML markup for
          // the text-extracted ones. Result: partial duplication for those tc-text-* calls.
          // Not handled here because the per-call fix (strip-XML-from-content for the
          // text-extracted indices) is fragile and the case is unobserved. Watch for
          // rebuild divergence on hybrid turns and add per-call handling
          // here if it ever shows up.
          const allTextExtracted = toolCallsForMsg.length > 0 && toolCallsForMsg.every(
            tc => typeof tc.id === 'string' && tc.id.startsWith('tc-text-'),
          );

          // SECOND DISCRIMINATOR (audit 2026-05-02 #2): Mercury proxy can parse XML
          // pseudo-format tool_calls SERVER-SIDE and emit them as "native"
          // delta.tool_calls with random/proxy-generated IDs (NOT `tc-text-`). In that
          // case the model's streamed tokens still contain the inline
          // `<tool_call>...</tool_call>` markup (carried back to us in `delta.content`
          // or `delta.reasoning_content`), while we'd render structured tool_calls at
          // next-turn rebuild → KV-cache divergence on the recurrent slot, full
          // reprocess (audit log 16:13:20 → 16:15:25 measured ~10 turns of identical
          // generation hash=efcc4468eea0 followed by a forced reprocess on resume).
          //
          // Heuristic: if the model's RAW stream contains the `<tool_call>` opener
          // ANYWHERE, drop structured tool_calls and persist content-only. The chat
          // template at rebuild renders the content verbatim (markup and all),
          // matching the original streamed bytes → KV-cache hit.
          //
          // CRITICAL #1: test against `turnContent` (RAW stream concatenation), NOT
          // `modelTurnContent` (which is stripThinkBlocks-trimmed when ctx.stripThink is
          // true). Small/fine-tuned models like Qwen3.6-brain often emit the XML INSIDE
          // `<think>` blocks (reasoning_content) — stripping think before the test would
          // hide the markup → kept structured tool_calls → KV divergence anyway.
          // Detecting on the raw stream catches the markup wherever the model placed
          // it (in content, in think, malformed in either).
          //
          // CRITICAL #2: regex stays PERMISSIVE on purpose. Small models malform their
          // tool_call markup constantly:
          //   - missing `</tool_call>` close, mismatched casing, stray whitespace
          //   - `<tool_call>\nname: bash\nargs:...` (YAML-ish freestyle)
          //   - `<tool_call> some prose then <function=...>`
          //   - `<tool_call>{"function":...}` (variant Hermes wrapping)
          // A stricter pattern (e.g. `/<tool_call>\s*(<function=|\{)/i`) would miss
          // these and leave the cache exposed. The opener alone is a strong-enough
          // signal — false positives (an agent literally writing `<tool_call>` in prose
          // while ALSO emitting real native tool_calls) are rare AND recoverable (one
          // reprocess), whereas false negatives on malformed markup are frequent AND
          // costly (every loop of a stuck small model = another reprocess). Trading off
          // in the user's favor: prefer over-drop.
          //
          // Why this is safe for clean-native models: standard providers (Claude, GPT,
          // Llama-3.1-Instruct, etc.) don't emit `<tool_call>` markup in content at all
          // — the tag literal won't appear → heuristic is a no-op for them.
          const rawStreamContent = turnContent || '';
          const contentHasInlineToolCallMarkup = /<tool_call>/i.test(rawStreamContent);

          const dropStructuredForKvParity = allTextExtracted || contentHasInlineToolCallMarkup;

          if (dropStructuredForKvParity) {
            const reason = allTextExtracted ? 'tc-text- ids' : 'inline <tool_call> markup in raw stream';
            console.debug(`[run] ${agentId} text-extracted tool_calls (${toolCallsForMsg.length}, via ${reason}) — persisting content only, dropping structured metadata for KV-cache parity`);
          }

          messages.push(dropStructuredForKvParity
            ? { role: 'assistant', content: modelTurnContent }
            : { role: 'assistant', content: modelTurnContent, tool_calls: toolCallsForMsg });

          // Persist assistant tool-call turn to DB so it survives across sessions.
          // Same allTextExtracted gate: skip tool_calls metadata so toAiMessage at next
          // rebuild renders content-only (matching what the model streamed).
          //
          // DEPENDENCY — DO NOT BREAK: this persists `turnContent` (= the RAW concatenated
          // streamed chunks, including any inline `<tool_call>...</tool_call>` XML markup the
          // model emitted in its reasoning_content). The `allTextExtracted` fix relies on
          // this rawness — at next-turn rebuild, the chat template renders the content
          // verbatim, which matches what the model originally streamed → KV-cache hit.
          //
          // If a future refactor swaps `turnContent` for `rich.content` (which is
          // `stripToolCallBlocks(textContent)` per mercury.ts:295-303 — stripped of the
          // XML markup), the persisted content would lose the markup AND we still skip
          // structured tool_calls (allTextExtracted gate) → the rebuilt prompt would have
          // NEITHER form of the tool_calls, and the model would see an assistant turn
          // with no tool invocation followed by tool_results. That's a contract violation
          // (tool_results without a matching tool_call) AND a cache divergence at the
          // assistant's content boundary.
          //
          // Rule: keep the DB persistence using `turnContent`. If you ever need cleaned
          // content for a different reason, store it in a SEPARATE metadata field, never
          // replacing the raw stream.
          const persistedTurn = await sessionMod.addMessage(sessionId, 'assistant', turnContent || '', source, {
            type: 'tool_call_turn',
            ...(dropStructuredForKvParity ? {} : { tool_calls: toolCallsForMsg }),
          });
          // Track the latest tool-call turn row id — setRunSource may stamp it as
          // `sandbox_trigger` if dispatch_sandbox_run fires during this same iteration.
          lastToolCallTurnRowId = persistedTurn.id;

          let toolIndex = 0;
          for (const toolCall of rich.toolCalls) {
            if (signal?.aborted) {
              console.log(`[run] ${agentId} aborted during tool execution (before ${toolCall.name})`);
              // Insert synthetic results for remaining tool calls to keep history coherent
              for (const remaining of rich.toolCalls.slice(toolIndex)) {
                const interruptMsg = '[Interrupted by user]';
                messages.push({ role: 'tool', content: interruptMsg, tool_call_id: remaining.id });
                await sessionMod.addMessage(sessionId, 'tool', interruptMsg, source, {
                  type: 'tool_result', tool_call_id: remaining.id, tool_name: remaining.name, interrupted: true,
                });
              }
              aborted = true;
              break;
            }

            console.log(`[run] ${agentId} tool.start: ${toolCall.name} args=${JSON.stringify(toolCall.arguments).slice(0, 120)}`);

            // Loop guard: track consecutive identical tool_calls (same name + same args
            // string-equal). Resets on signature change. When count exceeds the configured
            // threshold (defaults.toolDefaults.maxIdenticalToolCalls, default 5, 0 disables),
            // the dispatcher returns a soft-refuse message instead of executing — the model
            // sees this in the tool_result and gets a chance to break out of the loop on its
            // next turn. Stops pathological hammering (e.g. 12× identical `find` calls
            // in a loop) without aborting the run.
            const toolCallSig = `${toolCall.name}::${JSON.stringify(toolCall.arguments)}`;
            if (toolCallSig === lastToolCallSig) {
              consecutiveIdenticalCount++;
            } else {
              lastToolCallSig = toolCallSig;
              consecutiveIdenticalCount = 1;
            }
            const loopGuardActive = maxIdenticalToolCalls > 0 && consecutiveIdenticalCount > maxIdenticalToolCalls;

            // tool.start / tool.done are emitted regardless of loopGuardActive — the UI
            // needs to see that the model attempted a tool call (tool_call DID happen on
            // the LLM side and shows up in `messages[]`), even if we soft-refused execution.
            // The `[loop guard]` prefix in the output serves as the in-band marker for
            // observability/UI rendering — no separate WS schema change needed.
            chatBroadcast(sessionId, {
              type: 'tool.start',
              sessionId,
              agentId,
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              input: toolCall.arguments,
            } satisfies WsServerMessage);

            if (subAgentJobId) {
              emitSubAgentEvent({
                type: 'subagent.run.tool.start',
                jobId: subAgentJobId,
                sessionId,
                agentId,
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                input: toolCall.arguments as Record<string, unknown>,
              });
            }

            onToolCall?.({ type: 'start', name: toolCall.name, args: toolCall.arguments as Record<string, unknown> });

            const startTime = Date.now();
            let output: string;
            let toolError: string | undefined;

            // Auto-abort kicks in when the guard has fired AT LEAST ONCE before for this
            // signature AND we're seeing the same sig again (= the model ignored the
            // soft-refuse warning and is in token-level autopilot — no recovery expected
            // from another stream cycle). Strict `>` on (threshold + 1):
            //   threshold=5 → guard fires at 6 (warning), aborts at 7 (second offense).
            // Disabled when autoAbortOnLoopGuard=false OR when guard itself is disabled
            // (maxIdenticalToolCalls=0 — `loopGuardActive` is false then so we never enter
            // this branch anyway).
            const loopAutoAbortTrigger = loopGuardActive
              && autoAbortOnLoopGuard
              && consecutiveIdenticalCount > maxIdenticalToolCalls + 1;

            if (loopGuardActive) {
              // Hash truncated for log readability — full sig is in the soft-refuse message.
              const sigHash = toolCallSig.length > 24 ? toolCallSig.slice(0, 24) + '…' : toolCallSig;
              console.warn(`[run] ${agentId} loop guard fired: tool=${toolCall.name} consecutive=${consecutiveIdenticalCount} threshold=${maxIdenticalToolCalls} sig="${sigHash}"${loopAutoAbortTrigger ? ' → AUTO-ABORTING run' : ''}`);
              if (loopAutoAbortTrigger) {
                output = `[loop guard] Auto-abort: you called \`${toolCall.name}\` with the SAME arguments ${consecutiveIdenticalCount} times in a row, ignoring the previous soft-refuse warning. Run terminated to prevent infinite generation. Next user turn will start fresh — try a different approach if asked again.`;
              } else {
                output = `[loop guard] You have called \`${toolCall.name}\` with these exact arguments ${consecutiveIdenticalCount} times in a row. Same input always yields the same output. Either: (1) try a different approach — different command, different path, different tool, different parameters; or (2) if you already gathered enough information, stop calling tools and report findings to the user via send_to_user or your normal text reply.`;
              }
            } else if (toolCall.name === 'extended_reasoning' && reasoningCallsUsed >= maxReasoningCalls) {
              console.warn(`[run] ${agentId} extended_reasoning limit reached (${maxReasoningCalls} max)`);
              output = `[extended_reasoning] Limite atteinte : ${maxReasoningCalls} appel(s) maximum par run.`;
            } else {
              if (toolCall.name === 'extended_reasoning') reasoningCallsUsed++;
              try {
                output = await executeTool(toolCall, agentConfig.workspacePath, toolExecOpts);
              } catch (err) {
                toolError = err instanceof Error ? err.message : String(err);
                output = `Error: ${toolError}`;
                console.warn(`[run] ${agentId} tool.error: ${toolCall.name} error="${toolError}"`);
              }
            }

            const durationMs = Date.now() - startTime;
            console.log(`[run] ${agentId} tool.done: ${toolCall.name} ${durationMs}ms output=${output.slice(0, 120)}`);

            chatBroadcast(sessionId, {
              type: 'tool.done',
              sessionId,
              agentId,
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              durationMs,
              output,
              ...(toolError ? { error: toolError } : {}),
            } satisfies WsServerMessage);

            if (subAgentJobId) {
              emitSubAgentEvent({
                type: 'subagent.run.tool.done',
                jobId: subAgentJobId,
                sessionId,
                agentId,
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                durationMs,
                output,
                ...(toolError ? { error: toolError } : {}),
              });
            }

            onToolCall?.({ type: 'done', name: toolCall.name, args: toolCall.arguments as Record<string, unknown>, output, durationMs, error: toolError });

            // Track delivery: any successful send_to_user during this run. Consumed by:
            //  - the sandbox break-early path (only acts when source==='sandbox')
            //  - the sandbox safety net (only when source==='sandbox')
            //  - the Telegram fallback for scheduler/proactive runs landing in a TG session
            if (toolCall.name === 'send_to_user' && !toolError && output.startsWith('Sent to:')) {
              sendToUserCalled = true;
            }

            // Persist tool event for frontend metadata (capped to keep final msg lightweight)
            runToolEvents.push({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              input: toolCall.arguments,
              status: toolError ? 'error' : 'done',
              output: output.slice(0, 3000),
              durationMs,
              ...(toolError ? { error: toolError } : {}),
            });

            // KV-cache hygiene: the in-memory `messages` array drives the very next streamRich
            // (continuing the agentic loop), and at the NEXT user turn the same row is rebuilt
            // from DB via toAiMessage which applies the 12k char cap. If we push the raw output
            // here while the rebuild truncates, the same tool_result tokenises differently
            // between streams → llama.cpp's KV-cache prefix invalidates on every >12k tool
            // output. Truncate at push so intra-run and rebuild both see the same content.
            // DB still stores the full output (audit trail / UI / future replay) — only what
            // we hand to the LLM is capped.
            messages.push({ role: 'tool', content: truncateToolContentForLlm(output), tool_call_id: toolCall.id });

            // Persist tool result to DB (full output — no cap here)
            await sessionMod.addMessage(sessionId, 'tool', output, source, {
              type: 'tool_result',
              tool_call_id: toolCall.id,
              tool_name: toolCall.name,
              durationMs,
              ...(toolError ? { error: toolError } : {}),
            });

            // Drain deferred persistences — anything a tool pushed onto the queue must run
            // NOW so its `created_at` is strictly after the tool_result we just inserted.
            // Sequential await keeps the order tight; a failing closure logs but doesn't
            // break the run loop (it's already wrapped at push time, but defense-in-depth).
            // Today this fires for `send_to_user` chat delivery (visible-content duplicate).
            if (pendingPostToolResult.length > 0) {
              const drained = pendingPostToolResult.length;
              for (const fn of pendingPostToolResult) {
                try {
                  await fn();
                } catch (err) {
                  console.warn(`[run] ${agentId} pendingPostToolResult task failed: ${err instanceof Error ? err.message : err}`);
                }
              }
              pendingPostToolResult.length = 0;
              console.debug(`[run] ${agentId} drained ${drained} pendingPostToolResult task(s) after tool ${toolCall.name}`);
            }

            // Auto-abort escalation: tool_result has been persisted (model sees the
            // [loop guard] Auto-abort message in history on next resume), now break out
            // of the run cleanly. Insert synthetic results for any remaining tool calls
            // in this same turn to keep tool_call/tool_result pairing consistent (mirrors
            // the signal.aborted handler above). The user-facing fullResponse is a clean
            // summary (the verbose [loop guard] string above targets the model).
            if (loopAutoAbortTrigger) {
              for (const remaining of rich.toolCalls.slice(toolIndex + 1)) {
                const skipMsg = '[loop guard] Auto-abort upstream — tool not executed.';
                messages.push({ role: 'tool', content: skipMsg, tool_call_id: remaining.id });
                await sessionMod.addMessage(sessionId, 'tool', skipMsg, source, {
                  type: 'tool_result', tool_call_id: remaining.id, tool_name: remaining.name, interrupted: true,
                });
              }
              aborted = true;
              fullResponse = `🛑 Loop detected: \`${toolCall.name}\` was called ${consecutiveIdenticalCount}× in a row with identical arguments. The model didn't recover after the loop-guard warning, so the run was auto-aborted. Try a different question or rephrase if needed.`;
              break;
            }

            toolIndex++;
          }

          if (aborted) break;

          // Sandbox contract fulfilled: the agent just delivered via send_to_user. A next
          // streamRich would only ask "anything else?" and the model often returns an empty
          // turn (nothing more to say) which the empty-response guard treats as a Mercury
          // crash and surfaces as a task ERROR. Exit cleanly here — the deliverable already
          // reached the user, the audit job is marked done by the sandbox finalize block.
          // Scoped to sandbox: normal chat/task runs may legitimately continue after a
          // send_to_user (e.g. attach files, follow-up question).
          if (source === 'sandbox' && sendToUserCalled) {
            console.log(`[run] ${agentId} sandbox contract fulfilled (send_to_user delivered) — exiting loop after tool turn ${toolTurns}`);
            fullResponse = '[sandbox: delivered via send_to_user]';
            break;
          }

          toolTurns++;
          continue;
        }

        // No tool calls — final text response, already streamed live
        fullResponse = turnContent;
        // Merge accumulated <think> blocks from previous tool turns into the final message
        // so they're visible/collapsable in the chat (otherwise lost in hidden tool_call_turn rows).
        //
        // KV-CACHE PARITY (audit 2026-06-01 L1): the LLM slot streamed only THIS final turn's
        // bytes (`turnContent` — its own think + content). The merged blob below reorders and
        // re-joins earlier tool turns' think blocks with `\n\n---\n\n` separators and rebuilds the
        // content boundary (`'\n' + cleanContent`), so it does NOT match what was cached at the
        // final-assistant position. With the default stripThink=false, the next turn's
        // toAiMessage re-sends the persisted row content verbatim → if we persisted the merged
        // blob as content, the prefix would diverge right at the final assistant message and force
        // a reprocess on hybrid/recurrent local models (the exact cost the intra-loop
        // modelTurnContent mirroring already guards against). Fix: keep `fullResponse` = merged
        // (the UI reads think from m.content via splitThinkAndAnswer, and the prior-turn thinks are
        // only visible here since tool_call_turn rows are filtered out of the chat), but stash the
        // RAW streamed bytes so they get persisted in metadata and re-sent verbatim next turn. This
        // is the same "raw stream is authoritative for the LLM, derived view rides in metadata"
        // rule the tool-call-turn persistence already follows (run.ts ~2090).
        if (accumulatedThinkBlocks.length > 0) {
          const finalThinks = extractThinkContents(turnContent);
          const cleanContent = turnContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          const allThinks = [...accumulatedThinkBlocks, ...finalThinks];
          const mergedThink = allThinks.join('\n\n---\n\n');
          fullResponse = `<think>${mergedThink}</think>${cleanContent ? '\n' + cleanContent : ''}`;
          if (fullResponse !== turnContent) finalRawAssistantStream = turnContent;
        }
        const hasThink = fullResponse.includes('<think>');
        console.log(`[run] ${agentId} stream done: ${fullResponse.length} chars hasThink=${hasThink} toolTurns=${toolTurns} accumulatedThinks=${accumulatedThinkBlocks.length}`);

        // Capture reasoning traces (opt-in via agentConfig.captureReasoningTraces)
        if (hasThink && agentConfig.captureReasoningTraces && reasoningTraceStore) {
          const thinkMatch = fullResponse.match(/<think>([\s\S]*?)<\/think>/i);
          if (thinkMatch) {
            const conclusion = fullResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            reasoningTraceStore.insertNonBlocking({
              sessionId,
              agentId,
              query: content.slice(0, 500),
              reasoning: thinkMatch[1].trim(),
              conclusion: conclusion.slice(0, 500),
            });
          }
        }

        break;
      }

      if (!fullResponse && toolTurns >= maxToolTurns) {
        console.warn(`[run] ${agentId} max tool turns reached (${maxToolTurns}) without final response`);
        fullResponse = '[Max tool turns reached without a final response]';
        chatBroadcast(sessionId, {
          type: 'chat.delta',
          sessionId,
          agentId,
          content: fullResponse,
        } satisfies WsServerMessage);
      }
    }

    // Store assistant response (with tool events in metadata if any)
    if (aborted && !fullResponse.trim()) {
      // Nothing generated — skip saving empty message
      console.log(`[agent] run aborted ${agentId} session=${sessionId} — no content to save`);
      chatBroadcast(sessionId, {
        type: 'chat.done',
        sessionId,
        agentId,
        messageId: '',
        content: '',
        partial: true,
      } satisfies WsServerMessage);
      return '';
    }

    // ── Answer-in-think recovery ─────────────────────────────────────────────────
    // Known failure mode of persona / high-think-budget reasoning models (Qwen3.5-122B
    // w/ thinkBudget:high): the model writes its ENTIRE reply inside <think>…</think>
    // in a conversational register, closes the tag, and emits EOS with no visible answer.
    // The user sees "just a think block, no response". The empty-response guards above
    // (turnContent.length===0, max-tool-turns) don't catch it — the think text is non-empty,
    // only the post-</think> answer is empty.
    //
    // Recovery = PROMOTE: surface the think content as the visible answer (strip the tags).
    // For these turns the think IS the answer, so the user gets the right text instead of a
    // blank. We clear finalRawAssistantStream so the next-turn LLM rebuild (toAiMessage) and
    // the chat template see a clean answer-in-content turn — which also stops re-priming the
    // pattern in-context. One-time KV divergence at this position (acceptable: we're already
    // in a degenerate turn).
    if (!aborted && fullResponse.includes('<think>')) {
      const visibleAnswer = stripThinkBlocks(fullResponse)?.trim() ?? '';
      if (!visibleAnswer) {
        const promoted = extractThinkContents(fullResponse).join('\n\n').trim();
        if (promoted) {
          console.warn(`[run] ${agentId} session=${sessionId} answer-in-think recovery: visible answer empty, promoting ${promoted.length} chars of think → content`);
          fullResponse = promoted;
          finalRawAssistantStream = null;
        }
      }
    }

    const msgMetadata: Record<string, unknown> = {
      ...(runToolEvents.length > 0 ? { toolEvents: runToolEvents } : {}),
      ...(aborted ? { partial: true } : {}),
      // L1 KV-parity: when the final content is the merged-think display blob (≠ what the slot
      // streamed), carry the raw streamed bytes so toAiMessage re-sends them verbatim next turn.
      // The persisted `content` stays the merged view for the UI; the LLM rebuild reads this.
      ...(finalRawAssistantStream != null ? { rawAssistantStream: finalRawAssistantStream } : {}),
    };
    const assistantMsg = await sessionMod.addMessage(sessionId, 'assistant', fullResponse, source, Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined);

    // Broadcast completion (include tool events so frontend can persist them immediately)
    chatBroadcast(sessionId, {
      type: 'chat.done',
      sessionId,
      agentId,
      messageId: assistantMsg.id,
      content: fullResponse,
      ...(runToolEvents.length > 0 ? { toolEvents: runToolEvents } : {}),
      ...(aborted ? { partial: true } : {}),
    } satisfies WsServerMessage);

    console.log(`[agent] run ${aborted ? 'aborted (partial saved)' : 'complete'} ${agentId} session=${sessionId} responseLen=${fullResponse.length}`);

    // ── (B) Push mobile de fin pour une réponse INTERACTIVE (téléphone verrouillé) ───
    // Quand l'user a VERROUILLÉ le tel en cours de run, l'app est suspendue/verrouillée et rien
    // ne le prévient que l'agent a répondu (la Live Activity se termine en silence). Le bon signal
    // c'est le VIEWING : on pousse UNIQUEMENT si aucun client ne REGARDE la session (réellement
    // absent) → jamais de notif pendant qu'il regarde le stream web (pas de régression
    // "notif en pleine conversation", 2026-06-12). Skip si send_to_user a déjà livré (push propre).
    //
    // Route via executeDelivery (trigger='interactive', requested='auto', persistChat=false : la
    // réponse est DÉJÀ persistée par le run normal). resolveDelivery décide du réveil mobile :
    //  - agent legacy (mobile.triggers absent) : LEGACY_MOBILE inclut 'interactive' → mobile sonne ;
    //  - policy dont mobile.triggers EXCLUT 'interactive' : opt-out respecté → pas d'APNs.
    // Le gate VIEWING reste explicite ici (viewers===0) PAR DESIGN — c'est un filet présence, pas
    // le presenceDedup de policy (qu'on n'a pas à honorer pour décider de l'absence réelle).
    if (
      !aborted &&
      !sendToUserCalled &&
      !sandboxJobId &&
      !isHiddenNow() &&
      source !== 'proactive' &&
      // Réservé aux tours INTERACTIFS de l'utilisateur. Un run d'arrière-plan a un activeRunId
      // (tâche planifiée kind='task' source='web', escalade) : une tâche cron "check mails → RAS"
      // qui finit sans send_to_user ne doit JAMAIS réveiller le tel — c'est un déclenchement auto.
      !activeRunId &&
      (visibleSource === 'web' || isUnifiedSession) &&
      pushMod?.isEnabled() &&
      fullResponse.trim()
    ) {
      const viewers = ws.hasSessionViewers(sessionId);
      if (viewers === 0) {
        const preview = stripThinkBlocks(fullResponse)?.trim() ?? '';
        if (preview) {
          // Origine vocale + « masquer le transcript » : on notifie la fin de run mais le body
          // ne porte PAS la réponse en clair (en vocal on écoute le TTS). On garde un déclencheur
          // non-vide pour que la livraison parte (le gate `if (preview)` au-dessus reste honoré).
          const pushBody = hidePushTranscript ? '🎙️ Réponse vocale prête' : preview;
          await executeDelivery(
            {
              sessionId,
              handlerAgentConfig: agentConfig,
              content: pushBody,
              trigger: 'interactive',
              requested: { kind: 'auto' },
              ...(visibleSource ? { visibleSource } : {}),
              isUnifiedSession,
              // La réponse est déjà en chat (addMessage du run) → pas de duplicate.
              persistChat: false,
              // Le filet TG-native dédié (E) gère le leg Telegram sur une session TG ;
              // ici on ne veut que le réveil mobile.
              skipTelegram: true,
            },
            {
              sessionModule: sessionMod,
              ...(pushMod ? { pushModule: pushMod } : {}),
              ...(telegramMod ? { telegramModule: telegramMod } : {}),
              ws,
              ...(mastermindConfig ? { mastermindConfig } : {}),
            },
          ).then(r => console.log(`[run] interactive reply push (user away) agent=${agentId} session=${sessionId} delivered=[${r.delivered.join(',') || 'none'}]`))
           .catch(err => console.warn(`[run] interactive reply push failed: ${err instanceof Error ? err.message : err}`));
        }
      } else {
        console.debug(`[run] interactive reply mobile push skipped (${viewers} viewer(s) present) agent=${agentId} session=${sessionId}`);
      }
    }

    // Finalize any active sandbox tracking — done on clean finish, cancelled if aborted
    if (sandboxJobId && asyncJobsMod) {
      if (aborted) await asyncJobsMod.markSandboxCancelled(sandboxJobId).catch(() => {});
      else await asyncJobsMod.markSandboxDone(sandboxJobId).catch(() => {});

      // Sandbox safety net: the agent finished without calling send_to_user.
      //
      // Lightweight models often emit the deliverable as plain text at the end of a
      // sandbox run, forgetting the explicit tool call (the system prompt MANDATES it,
      // but smaller models slip). Their report is sitting RIGHT THERE in `fullResponse` —
      // we just deliver it ourselves through the same pipeline send_to_user uses, so
      // the user gets the message instead of an "orphan" warning.
      //
      // If there's no usable text either (truly empty run), fall back to the warning so
      // the user knows the run completed without producing anything.
      if (!aborted && !sendToUserCalled) {
        const cleanContent = stripThinkBlocks(fullResponse) ?? '';
        // Drop the synthetic marker we set when send_to_user already fired (would only
        // appear here if the contract-fulfilled path ran but flag detection failed, paranoid)
        const deliverableText =
          cleanContent && cleanContent !== '[sandbox: delivered via send_to_user]'
            ? cleanContent.trim()
            : '';

        if (deliverableText) {
          console.warn(`[run] ${agentId} sandbox finished WITHOUT send_to_user (job ${sandboxJobId}) — auto-delivering ${deliverableText.length} chars via delivery module`);
          // (C) Route via executeDelivery (trigger='sandbox') — corrige les bugs "sandbox ignore
          // policy/presence/tgMode/override par tâche" : le filet réutilise la MÊME résolution que
          // send_to_user (policy mobile/telegram triggers, presenceDedup, mode TG, override tâche),
          // au lieu des envois directs chat+TG+mobile inconditionnels d'avant. persistChat=true :
          // la ligne chat (source de vérité) n'est PAS encore en base pour ce run sandbox (le run
          // est hidden) → on la pose ici, marquée sandbox_autodeliver.
          await executeDelivery(
            {
              sessionId,
              handlerAgentConfig: agentConfig,
              content: deliverableText,
              trigger: 'sandbox',
              requested: { kind: 'auto' },
              taskChannels: taskDeliveryChannels ?? runContext?.deliveryChannels ?? null,
              ...(visibleSource ? { visibleSource } : {}),
              isUnifiedSession,
              persistChat: true,
              chatMetadata: { sandbox_autodeliver: true, sandbox_job_id: sandboxJobId },
              ...(visibleSource ? { chatSource: visibleSource } : {}),
            },
            {
              sessionModule: sessionMod,
              ...(pushMod ? { pushModule: pushMod } : {}),
              ...(telegramMod ? { telegramModule: telegramMod } : {}),
              ws,
              ...(mastermindConfig ? { mastermindConfig } : {}),
              ...(schedulerMod ? { schedulerModule: schedulerMod } : {}),
            },
          ).catch(err => console.warn(`[run] sandbox autodeliver failed: ${err instanceof Error ? err.message : err}`));
        } else {
          // Truly empty sandbox — no deliverable to forward, surface the warning.
          console.warn(`[run] ${agentId} sandbox finished EMPTY (job ${sandboxJobId}) — pushing orphan notice`);
          const noticeText = `⚠️ Sandbox terminée sans contenu livrable. (job ${sandboxJobId})`;
          try {
            const noticeMsg = await sessionMod.addMessage(
              sessionId,
              'assistant',
              noticeText,
              visibleSource,
              { sandbox_orphan: true, sandbox_job_id: sandboxJobId },
            );
            ws.broadcast(sessionId, {
              type: 'session.message',
              sessionId,
              message: noticeMsg,
            } satisfies WsServerMessage);
          } catch (err) {
            console.warn(`[run] sandbox-orphan chat notice failed: ${err instanceof Error ? err.message : err}`);
          }
          if (visibleSource === 'telegram' && telegramMod) {
            try {
              const tg = agentConfig.telegram;
              if (tg?.enabled && tg.chatIds?.length) {
                const botId = tg.botId ?? mastermindConfig?.telegram.bots[0]?.id;
                const bot = botId ? telegramMod.getBot(botId) : undefined;
                if (bot) {
                  for (const chatId of tg.chatIds) {
                    await bot.api.sendMessage(chatId, noticeText).catch(err =>
                      console.warn(`[run] sandbox-orphan telegram notice failed chatId=${chatId}: ${err instanceof Error ? err.message : err}`),
                    );
                  }
                }
              }
            } catch (err) {
              console.warn(`[run] sandbox-orphan telegram notice setup failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      }
    }

    // (D) Web safety net pour les runs d'ARRIÈRE-PLAN qui finissent sans `send_to_user` et qu'on
    // doit quand même livrer : handlers proactifs/escalades ET crons kind='task' (source='web'
    // avec activeRunId). Sans ce filet, le texte final persiste en base (hidden si proactif) et
    // l'utilisateur ne voit jamais la synthèse / le briefing. Mirroir du filet sandbox (C).
    //
    // Extension v3 (fix "cron kind='task' avec policy = silencieux") : avant, seul un run
    // source='proactive' && proactivePhase='handler' entrait ici → un cron kind='task' (source
    // 'web', activeRunId posé, NON proactif) qui oubliait send_to_user ne livrait rien malgré une
    // policy mobile/telegram. On couvre désormais aussi ce cas ; le `trigger` (runKindTrigger)
    // vaut 'proactive' OU 'task' selon le run, et resolveDelivery applique les triggers de policy.
    //
    // Gates :
    //  - run d'arrière-plan à livrer : (proactif handler) OU (cron kind='task' = web+activeRunId).
    //    Les watchers proactifs (proactivePhase='watcher') sont exclus (texte = raisonnement interne).
    //  - `visibleSource === 'web' || isUnifiedSession` — le fallback Telegram (E) couvre la session
    //    TG-native ; en unifié on entre AUSSI pour livrer chat + mobile (TG via E).
    //  - `!sendToUserCalled` — le chemin explicite a déjà livré.
    //  - `autoDeliver` — opt-out par tâche/source.
    const isBackgroundDeliverable =
      (source === 'proactive' && proactivePhase === 'handler') ||
      (source === 'web' && !!activeRunId && !isProactive);
    if (
      !aborted &&
      !sendToUserCalled &&
      autoDeliver &&
      isBackgroundDeliverable &&
      (visibleSource === 'web' || isUnifiedSession) &&
      fullResponse
    ) {
      const cleanContent = stripThinkBlocks(fullResponse)?.trim() ?? '';
      if (cleanContent) {
        // 'proactive' (handler) ou 'task' (cron kind='task') — le sandbox est géré en C.
        const bgTrigger = runKindTrigger({
          source,
          ...(proactivePhase ? { proactivePhase } : {}),
          ...(activeRunId ? { activeRunId } : {}),
          sandboxJobId,
        });
        console.warn(`[run] ${agentId} session=${sessionId} background (${bgTrigger}) finished WITHOUT send_to_user on web — auto-delivering ${cleanContent.length} chars via delivery module`);
        // Même pipe que send_to_user : ligne chat + leg mobile (presence) + leg Telegram
        // (direct/fallback) + audit proactif (markDelivered + proactive.alert), résolu par la
        // policy de l'agent (requested='auto', override tâche prioritaire). Cf. modules/delivery.
        await executeDelivery(
          {
            sessionId,
            handlerAgentConfig: agentConfig,
            content: cleanContent,
            trigger: bgTrigger,
            requested: { kind: 'auto' },
            taskChannels: taskDeliveryChannels ?? runContext?.deliveryChannels ?? null,
            ...(visibleSource ? { visibleSource } : {}),
            isUnifiedSession,
            ...(activeRunId ? { activeRunId } : {}),
            runContext: runContext ? { taskId: runContext.taskId, watcherAgentId: runContext.watcherAgentId } : null,
            chatMetadata: { proactive_autodeliver: true },
            ...(visibleSource ? { chatSource: visibleSource } : {}),
            // FIX KV-cache (bug hunt 2026-06-13) : ne persister la ligne chat QUE si celle du run
            // normal (run.ts:2488) est HIDDEN. Pour un run proactif (source='proactive') la ligne
            // 2488 est hidden → D pose la seule ligne visible (persistChat:true). Pour un cron
            // kind='task' (source='web') la ligne 2488 est DÉJÀ visible → D ne doit PAS la re-poster
            // (sinon 2 lignes assistant pour le même tour → doublon UI + préfixe KV invalidé à chaque
            // tour suivant car proactive_autodeliver n'est pas filtré par buildLlmPayload).
            persistChat: source === 'proactive',
            // Sur une session TG-native, le leg Telegram est assuré par le filet TG-native
            // dédié ci-dessous (E) → on le coupe ici pour éviter un double envoi.
            skipTelegram: visibleSource === 'telegram',
          },
          {
            sessionModule: sessionMod,
            ...(pushMod ? { pushModule: pushMod } : {}),
            ...(telegramMod ? { telegramModule: telegramMod } : {}),
            ws,
            ...(mastermindConfig ? { mastermindConfig } : {}),
            ...(schedulerMod ? { schedulerModule: schedulerMod } : {}),
          },
        ).catch(err => console.warn(`[run] background autodeliver failed: ${err instanceof Error ? err.message : err}`));
      }
    }

    // Telegram delivery fallback for non-sandbox runs landing in a Telegram-native session.
    //
    // Context: a scheduled task (cron) or a proactive run executes with source='web' (or
    // 'proactive') in a session like `{agent}-tg-{chat_id}`. The Telegram bridge is NOT
    // attached to chat.delta chunks for those runs (it only bridges Telegram inputs,
    // source='telegram'), so the agent MUST call `send_to_user` to reach Telegram.
    // Lightweight models routinely forget that step — the deliverable lands in the chat
    // UI but never on Telegram, leaving the user without their morning briefing.
    //
    // We mirror the sandbox safety net: if no send_to_user fired and we have a clean text
    // response, push it ourselves through the same `deliverToTelegram` helper. The chat UI
    // already shows the assistant message via the normal addMessage path, so we only need
    // the Telegram leg here.
    if (
      !aborted &&
      !sendToUserCalled &&
      autoDeliver &&
      source !== 'telegram' &&
      source !== 'sandbox' &&
      // Mirror the web fallback above: a watcher run's text is internal reasoning,
      // never deliverable. Without this guard a watcher landing in a TG session
      // would leak its raw scratchpad to Telegram via the auto-deliver path.
      proactivePhase !== 'watcher' &&
      visibleSource === 'telegram' &&
      fullResponse &&
      telegramMod &&
      mastermindConfig
    ) {
      const cleanContent = stripThinkBlocks(fullResponse)?.trim() ?? '';
      if (cleanContent) {
        // (E) Route via executeDelivery (plus de gate manuel `.wake.has('telegram')`) : on laisse
        // resolveDelivery décider de TOUS les canaux. Conséquence voulue : un override par tâche
        // ['mobile'] sur une session TG-native livre AUSSI le leg MOBILE (avant, ce filet ne savait
        // que parler Telegram → le mobile pinné était perdu). persistChat=false : la réponse est
        // déjà persistée par le run normal (addMessage ci-dessus). Le trigger (runKindTrigger) vaut
        // 'interactive'/'task'/'proactive' selon le run ; le mode TG/override tâche/presenceDedup de
        // la policy s'appliquent comme pour send_to_user.
        const tgTrigger = runKindTrigger({
          source,
          ...(proactivePhase ? { proactivePhase } : {}),
          ...(activeRunId ? { activeRunId } : {}),
          sandboxJobId,
        });
        console.warn(
          `[run] ${agentId} session=${sessionId} source=${source} trigger=${tgTrigger} finished WITHOUT send_to_user on a TG session — auto-delivering ${cleanContent.length} chars via delivery module`,
        );
        // Coordination D↔E (unifié + TG) : si D a déjà tourné (visibleSource='telegram' ET unifié),
        // il a fait l'audit proactif (markDelivered + proactive.alert) → E ne doit PAS le refaire,
        // on omet activeRunId/runContext. Sur une session TG-native PURE (non unifiée), D n'entre
        // pas → E porte l'audit.
        const eHandlesAudit = !isUnifiedSession;
        await executeDelivery(
          {
            sessionId,
            handlerAgentConfig: agentConfig,
            content: cleanContent,
            trigger: tgTrigger,
            requested: { kind: 'auto' },
            taskChannels: taskDeliveryChannels ?? runContext?.deliveryChannels ?? null,
            visibleSource,
            isUnifiedSession,
            ...(eHandlesAudit && activeRunId ? { activeRunId } : {}),
            ...(eHandlesAudit && runContext ? { runContext: { taskId: runContext.taskId, watcherAgentId: runContext.watcherAgentId } } : {}),
            // Déjà persisté par le run (addMessage) → pas de duplicate chat.
            persistChat: false,
            // Coordination D↔E mobile : en session unifiée, D porte le leg mobile → E ne fait QUE
            // Telegram (sinon 2 push APNs identiques). Sur une session TG-native PURE (non unifiée),
            // D n'entre pas → E porte le mobile aussi (skipMobile=false). Bug hunt 2026-06-13.
            skipMobile: isUnifiedSession,
          },
          {
            sessionModule: sessionMod,
            ...(pushMod ? { pushModule: pushMod } : {}),
            ...(telegramMod ? { telegramModule: telegramMod } : {}),
            ws,
            ...(mastermindConfig ? { mastermindConfig } : {}),
            ...(schedulerMod ? { schedulerModule: schedulerMod } : {}),
          },
        ).catch(err => console.warn(`[run] telegram autodeliver failed: ${err instanceof Error ? err.message : err}`));
      }
    }

    return fullResponse;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const isLlmCrash = errorMessage.includes('process_died') || errorMessage.includes('LLM backend error');
    console.error(`[run] ${agentId} error: ${errorMessage}`);
    chatBroadcast(sessionId, {
      type: 'chat.error',
      sessionId,
      agentId,
      error: isLlmCrash
        ? 'Le process LLM a crashé. Le modèle va se recharger automatiquement au prochain message.'
        : errorMessage,
    } satisfies WsServerMessage);
    // Sandbox failed → mark error with the underlying error message
    if (sandboxJobId && asyncJobsMod) {
      await asyncJobsMod.markSandboxError(sandboxJobId, errorMessage).catch(() => {});
    }
    throw err;
  } finally {
    broadcastAgentState('idle');
  }
}
