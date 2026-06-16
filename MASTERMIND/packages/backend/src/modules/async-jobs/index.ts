import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  Module,
  MastermindContext,
  MessageAttachment,
  WsServerMessage,
} from '@mastermind/shared';
import type { AgentModule } from '../agent/index.js';
import type { SessionModule } from '../session/index.js';
import type { TelegramModule } from '../telegram/index.js';
import type { PushModule } from '../push/index.js';
import type { ConfigModule } from '../config/index.js';
import { deliverToChat, deliverToTelegram, deliverToMobile, type ResolvedAttachment } from '../delivery/index.js';
import type { SubAgentDeliveryContext, SubAgentDeliveryState } from '../agent/tools/submit_subagent_report.js';
import { formatSubAgentDuration } from '../agent/subagent-job-delivery.js';

/**
 * Async jobs module — fire-and-forget execution for three job kinds:
 *
 *  - `shell` : long-running skill action (Sora/Veo/image gen). Spawns a child process,
 *    collects stdout + outputs glob, delivers via deliverToChat+deliverToTelegram on
 *    completion. cancel() kills the child.
 *
 *  - `sandbox_run` : tracking row for an agent run flipped to source='sandbox' inline by
 *    `dispatch_sandbox_run`. The worker doesn't actually run anything for this kind —
 *    it's a UI metadata row (started_at / completed_at). cancel() aborts the agent run.
 *
 *  - `sub_agent` : a one-shot cloud sub-agent triggered by `spawn_subagent`. The worker
 *    invokes `agentMod.run(subAgentId, ..., 'subagent')` under timeout/iter/tool_calls/tokens
 *    caps. The sub-agent must call `submit_subagent_report({ markdown })` to finalise. On
 *    success the worker triggers a PARENT re-run with the markdown injected as a
 *    source='proactive' user message — the parent synthesises and calls send_to_user.
 *    See runSubAgent below for the full lifecycle.
 *
 * Restart recovery: on init(), any job still queued/running is marked error with
 * "interrupted by backend restart" and the agent (or parent for sub_agent jobs) gets
 * an alert. We explicitly do NOT auto-resume — external state may have continued
 * server-side and we can't reliably pick up where we left off.
 */

const MAX_CAPTURED_STREAM_BYTES = 1_000_000;
const MAX_QUEUE_SPECS = 1_000;
const CHILD_TERM_GRACE_MS = 2_000;
const CHILD_KILL_GRACE_MS = 1_000;
/** Défaut du cap de réinjection du rapport sub-agent (chars) — cf. reportInjectionMaxChars. */
const DEFAULT_REPORT_INJECTION_CHARS = 12_000;

/**
 * Wrapper prompt injecté en input du parent re-run après qu'un sub-agent a soumis son rapport.
 * Source='proactive' (handler phase) → stream non visible côté UI → le parent DOIT appeler
 * `send_to_user` pour livrer sa synthèse. On le rappelle explicitement dans le prompt pour
 * éviter le « le parent parle dans le vide » classique des modèles légers.
 */
function buildSubAgentReportInjection(args: {
  presetId: string;
  jobId: string;
  durationMs: number;
  capsHit: string | null | undefined;
  markdown: string;
  parentVisibleSource: 'web' | 'telegram';
  /** Cap de l'extrait réinjecté (chars). Au-delà : tronqué + pointeur drill-down. */
  maxMarkdownChars?: number;
  /** Canal push mobile actif (APNs) → suggère 'mobile' pour les sessions web. */
  pushEnabled?: boolean;
}): string {
  const status = args.capsHit ? `partial:${args.capsHit}` : 'ok';
  // Session telegram → telegram (legacy). Session web + push mobile actif → mobile
  // (replaces Telegram for auto-deliver). Otherwise chat (no wake).
  const channelHint = args.parentVisibleSource === 'telegram'
    ? 'telegram'
    : args.pushEnabled ? 'mobile' : 'chat';
  // Le parent doit SYNTHÉTISER, pas reproduire : on ne réinjecte qu'un extrait. Le rapport complet
  // reste en DB (async_jobs.result, cap 200k) consultable via le drill-down. Sans ce cap, un rapport
  // volumineux sur une session déjà chargée force un auto-compact (un appel LLM en plus, gratuit à éviter).
  const cap = args.maxMarkdownChars ?? DEFAULT_REPORT_INJECTION_CHARS;
  const markdown = args.markdown.length > cap
    ? args.markdown.slice(0, cap) + `\n\n*…[rapport tronqué à ${cap} chars pour la synthèse — rapport complet via le drill-down (job ${args.jobId})]*`
    : args.markdown;
  return [
    `[SUB_AGENT_REPORT preset=${args.presetId} job=${args.jobId} duration=${formatSubAgentDuration(args.durationMs)} status=${status}]`,
    '',
    markdown,
    '',
    '[END SUB_AGENT_REPORT]',
    '',
    `Le sub-agent ci-dessus vient de te livrer ce rapport (réponse à ta délégation \`spawn_subagent\`).`,
    `Synthétise-le en quelques phrases utiles pour l'utilisateur, puis livre via \`send_to_user\` :`,
    ``,
    `\`send_to_user(channel="${channelHint}", content="<ta synthèse>")\``,
    ``,
    `(channel="both" si tu veux pousser sur les deux canaux.)`,
    ``,
    `**IMPORTANT** : tu tournes en mode handler caché — ton stream n'arrive PAS à l'utilisateur. Sans \`send_to_user\` à la fin, ta synthèse part dans le vide. Ne réponds pas en texte plein, appelle l'outil.`,
  ].join('\n');
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/**
 * - `shell` (default) = skill-action exec in a child process. Collects output files,
 *   delivers via send-to-user semantics at completion.
 * - `sandbox_run` = a full agent run (with its own tool calls / reasoning) dispatched
 *   in the background. The agent calls `send_to_user` itself when done; the worker just
 *   tracks lifecycle.
 * - `sub_agent` = a one-shot cloud sub-agent run spawned by a parent agent via
 *   `spawn_subagent`. The worker invokes `agentMod.run(subAgentId, …, source='subagent')`
 *   under caps (timeout/iterations/tokens), captures the assistant's final text + full
 *   transcript, and re-injects the TL;DR section in the parent session via deliverToChat.
 */
export type JobKind = 'shell' | 'sandbox_run' | 'sub_agent';

/** Caps_hit non-null = pourquoi un sub-agent run s'est arrêté tôt. */
export type SubAgentCapsHit = 'iterations' | 'tool_calls' | 'tokens' | 'timeout' | 'restart';

export interface AsyncJob {
  id: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  kind: JobKind;
  status: JobStatus;
  result: string | null;
  outputFiles: MessageAttachment[] | null;
  error: string | null;
  caption: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  // Sub-agent run fields (NULL pour shell / sandbox_run)
  subAgentId: string | null;
  parentSessionId: string | null;
  parentAgentId: string | null;
  taskPrompt: string | null;
  capsHit: SubAgentCapsHit | null;
}

export interface EnqueueInput {
  agentId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Discriminator — drives the worker's execution strategy. Defaults to 'shell'. */
  kind?: JobKind;
  /** For kind='shell': fully interpolated shell command. Unused for 'sandbox_run' / 'sub_agent'. */
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** For kind='shell': glob relative to cwd used to collect output files. */
  outputsGlob: string;
  /**
   * For kind='shell': name of an arg whose value is the output file path.
   * Takes precedence over `outputsGlob` when set.
   */
  outputFromArg?: string;
  /** Optional caption for the completion message (shell jobs only). */
  caption: string;
  /** For kind='sandbox_run' / 'sub_agent': the task prompt passed to agentMod.run() as user content. */
  taskPrompt?: string;
  // Sub-agent run fields (only set when kind='sub_agent')
  subAgentId?: string;
  parentSessionId?: string;
  parentAgentId?: string;
}

/** Input du tool spawn_subagent — shape minimaliste, on remplit le reste avec des valeurs sentinelles. */
export interface EnqueueSubAgentInput {
  parentAgentId: string;
  parentSessionId: string;
  subAgentId: string;
  taskPrompt: string;
  /**
   * Native visible channel of the parent session ('web' | 'telegram'). Persisted into
   * args so runSubAgent can deliver the report to the parent session under the SAME
   * source as the parent — otherwise Telegram-originated parents get web-tagged messages
   * (mismatched audit + filtered out by source-aware loops).
   */
  parentVisibleSource?: 'web' | 'telegram';
}

interface RunningSpec extends EnqueueInput {
  jobId: string;
  startedAt: number;
  /** Set for kind='shell' runs — the spawned child process. Absent for sandbox_run. */
  process?: ChildProcess;
}

/**
 * Minimal glob → RegExp. Supports **, *, ?, and brace expansion `{a,b,c}` (used by
 * image-gen skills with patterns like `*.{png,jpg,webp}`).
 *
 * Uses control-char placeholders to protect glob metachars from regex escaping.
 */
function globToRegex(glob: string): RegExp {
  let pattern = glob.replace(/\\/g, '/');
  // Brace expansion: {a,b,c} → placeholder(a|b|c) that survives escaping
  pattern = pattern.replace(/\{([^{}]+)\}/g, (_, inner: string) => {
    return '\x01' + inner.split(',').map(s => s.trim()).join('\x02') + '\x03';
  });
  // Escape regex specials — NOT our placeholders, NOT * / ?
  pattern = pattern.replace(/[.+^$()|[\]\\]/g, '\\$&');
  // ** → cross-dir, * → single-segment, ? → single char
  pattern = pattern.replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
  // Restore brace expansion as regex alternation
  pattern = pattern.replace(/\x01/g, '(').replace(/\x02/g, '|').replace(/\x03/g, ')');
  return new RegExp(`^${pattern}$`);
}

/** Recursively walk a directory and yield files (absolute paths). Skips dot-dirs and node_modules. */
async function walkFiles(baseDir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await rec(baseDir);
  return out;
}

/** Find files under cwd matching the glob with mtime >= sinceMs. */
async function collectOutputs(cwd: string, glob: string, sinceMs: number): Promise<string[]> {
  const all = await walkFiles(cwd);
  const regex = globToRegex(glob);
  const picked: string[] = [];
  for (const abs of all) {
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    if (!regex.test(rel)) continue;
    try {
      const stat = await fs.stat(abs);
      if (stat.mtimeMs >= sinceMs) picked.push(abs);
    } catch {
      // ignore unreadable
    }
  }
  return picked;
}

/** Derive a MessageAttachmentKind + MIME from an extension. Mirrors deliver.ts's map. */
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};
function mimeFor(filename: string): string {
  return MIME_MAP[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
function kindOf(mime: string): MessageAttachment['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function rowToJob(r: Record<string, unknown>): AsyncJob {
  return {
    id: String(r['id']),
    agentId: String(r['agent_id']),
    sessionId: String(r['session_id']),
    toolName: String(r['tool_name']),
    args: (r['args'] ?? {}) as Record<string, unknown>,
    kind: (String(r['kind'] ?? 'shell') as JobKind),
    status: String(r['status']) as JobStatus,
    result: (r['result'] as string) ?? null,
    outputFiles: (r['output_files'] as MessageAttachment[] | null) ?? null,
    error: (r['error'] as string) ?? null,
    caption: (r['caption'] as string) ?? null,
    createdAt: new Date(r['created_at'] as string).toISOString(),
    startedAt: r['started_at'] ? new Date(r['started_at'] as string).toISOString() : null,
    completedAt: r['completed_at'] ? new Date(r['completed_at'] as string).toISOString() : null,
    cancelledAt: r['cancelled_at'] ? new Date(r['cancelled_at'] as string).toISOString() : null,
    subAgentId: (r['sub_agent_id'] as string | null) ?? null,
    parentSessionId: (r['parent_session_id'] as string | null) ?? null,
    parentAgentId: (r['parent_agent_id'] as string | null) ?? null,
    taskPrompt: (r['task_prompt'] as string | null) ?? null,
    capsHit: (r['caps_hit'] as SubAgentCapsHit | null) ?? null,
  };
}

function appendCapped(
  current: string,
  chunk: Buffer | string,
  currentBytes: number,
): { value: string; bytes: number; truncated: boolean } {
  if (currentBytes >= MAX_CAPTURED_STREAM_BYTES) {
    return { value: current, bytes: currentBytes, truncated: true };
  }
  const raw = String(chunk);
  const bytes = Buffer.byteLength(raw);
  const remaining = MAX_CAPTURED_STREAM_BYTES - currentBytes;
  if (bytes <= remaining) {
    return { value: current + raw, bytes: currentBytes + bytes, truncated: false };
  }
  let out = '';
  let used = 0;
  for (const ch of raw) {
    const chBytes = Buffer.byteLength(ch);
    if (used + chBytes > remaining) break;
    out += ch;
    used += chBytes;
  }
  return { value: current + out, bytes: currentBytes + used, truncated: true };
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<'closed' | 'timeout'> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve('closed');
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve('timeout');
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve('closed');
    };
    child.once('close', onClose);
  });
}

export class AsyncJobsModule implements Module {
  readonly name = 'async-jobs';

  private ctx!: MastermindContext;
  private tick: ReturnType<typeof setInterval> | null = null;
  private running: Map<string, RunningSpec> = new Map();
  /** In-memory specs for enqueued-but-not-yet-running jobs (survives only until pickup). */
  private queueSpecs: Map<string, EnqueueInput> = new Map();
  /** Busy flag so the ticker only picks one job at a time (sequential global worker). */
  private processing = false;

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;

    // Restart recovery — flag any queued/running jobs from the previous process as errored
    await this.recoverFromRestart();

    // Start the worker tick
    this.tick = setInterval(() => { void this.workerTick(); }, 2_000);
    console.log('[async-jobs] Worker started (2s tick)');
  }

  async destroy(): Promise<void> {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
    console.log(`[async-jobs] Destroy requested running=${this.running.size} queuedSpecs=${this.queueSpecs.size}`);
    this.queueSpecs.clear();
    const running = [...this.running.entries()];
    await Promise.all(running.map(([jobId, spec]) => this.terminateChild(jobId, spec, 'shutdown')));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async enqueue(input: EnqueueInput): Promise<{ jobId: string }> {
    if (this.queueSpecs.size >= MAX_QUEUE_SPECS) {
      throw new Error(`async job queue is full (${MAX_QUEUE_SPECS} pending specs)`);
    }
    const jobId = nanoid(12);
    const kind: JobKind = input.kind ?? 'shell';
    await this.ctx.db.query(
      `INSERT INTO async_jobs (id, agent_id, session_id, tool_name, args, kind, status, caption)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'queued', $7)`,
      [jobId, input.agentId, input.sessionId, input.toolName, JSON.stringify(input.args), kind, input.caption],
    );
    this.queueSpecs.set(jobId, { ...input, kind });
    this.ctx.ws.broadcastAll({
      type: 'async_job.queued',
      jobId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      createdAt: new Date().toISOString(),
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
    console.log(`[async-jobs] queued ${jobId} kind=${kind} tool=${input.toolName} agent=${input.agentId}`);
    return { jobId };
  }

  /**
   * Enqueue a sub-agent cloud run (kind='sub_agent'). The parent agent's session_id
   * is recorded in `parent_session_id`; `agent_id` is set to the SUB-AGENT id (the one
   * doing the work), so list/stats endpoints filter naturally by sub-agent.
   *
   * The sub-agent's transient session lives at `sessionId='sub-${jobId}'`. Once the run
   * completes, runSubAgent re-injects the TL;DR portion into `parent_session_id` via
   * deliverToChat (proactive-style injection). Caller doesn't block.
   */
  async enqueueSubAgent(input: EnqueueSubAgentInput): Promise<{ jobId: string }> {
    if (this.queueSpecs.size >= MAX_QUEUE_SPECS) {
      throw new Error(`async job queue is full (${MAX_QUEUE_SPECS} pending specs)`);
    }
    const jobId = nanoid(12);
    const subSessionId = `sub-${jobId}`;
    const args = {
      preset: input.subAgentId,
      prompt: input.taskPrompt,
      ...(input.parentVisibleSource ? { parent_visible_source: input.parentVisibleSource } : {}),
    };
    await this.ctx.db.query(
      `INSERT INTO async_jobs (
         id, agent_id, session_id, tool_name, args, kind, status, caption,
         sub_agent_id, parent_session_id, parent_agent_id, task_prompt
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, 'sub_agent', 'queued', $6, $7, $8, $9, $10)`,
      [
        jobId,
        input.subAgentId,                // agent_id = the sub-agent (worker)
        subSessionId,                    // session_id = transient sub-session
        'spawn_subagent',
        JSON.stringify(args),
        `Sub-agent ${input.subAgentId}`, // caption (default, can be overridden in TL;DR)
        input.subAgentId,
        input.parentSessionId,
        input.parentAgentId,
        input.taskPrompt.slice(0, 50_000),
      ],
    );
    // Build a minimal EnqueueInput so workerTick can pick it up; many fields are unused
    // for sub_agent jobs but we satisfy the type to avoid a separate spec map.
    const spec: EnqueueInput = {
      agentId: input.subAgentId,
      sessionId: subSessionId,
      toolName: 'spawn_subagent',
      args: args as Record<string, unknown>,
      kind: 'sub_agent',
      command: '',
      cwd: '',
      timeoutMs: 0,
      outputsGlob: '',
      caption: '',
      taskPrompt: input.taskPrompt,
      subAgentId: input.subAgentId,
      parentSessionId: input.parentSessionId,
      parentAgentId: input.parentAgentId,
    };
    this.queueSpecs.set(jobId, spec);
    this.ctx.ws.broadcastAll({
      type: 'async_job.queued',
      jobId,
      agentId: input.subAgentId,
      sessionId: subSessionId,
      toolName: 'spawn_subagent',
      createdAt: new Date().toISOString(),
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
    console.log(`[async-jobs] queued ${jobId} kind=sub_agent sub=${input.subAgentId} parent=${input.parentAgentId}/${input.parentSessionId} promptLen=${input.taskPrompt.length}`);
    return { jobId };
  }

  /**
   * Count sub-agent spawns over a rolling window (default 24h). Used by spawn_subagent to
   * enforce `subagentDefaults.maxSpawnsPerDay` — a soft anti-bug-loop ceiling on cumulative
   * spawns regardless of which parent triggered them. Counts every kind='sub_agent' row
   * created in the window, all statuses (queued/running/done/error/cancelled all consume
   * a slot — a runaway loop that errors out still counts).
   */
  async countSubAgentSpawnsSince(sinceMs: number): Promise<number> {
    const since = new Date(sinceMs).toISOString();
    const res = await this.ctx.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM async_jobs WHERE kind = 'sub_agent' AND created_at >= $1`,
      [since],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async list(filter?: { agentId?: string; status?: JobStatus[]; limit?: number }): Promise<AsyncJob[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.agentId) {
      // Inclut les sub-agent runs déclenchés par cet agent (parent_agent_id) pour qu'ils
      // apparaissent dans son onglet Tâches comme les sandbox runs. Les sub-agents eux-mêmes
      // ne peuvent pas spawn, donc parent_agent_id = leur id n'arrive jamais — l'OR n'ajoute
      // rien à leur listing (toujours filtrés par agent_id du sub-agent worker).
      params.push(filter.agentId);
      where.push(`(agent_id = $${params.length} OR parent_agent_id = $${params.length})`);
    }
    if (filter?.status && filter.status.length > 0) {
      params.push(filter.status);
      where.push(`status = ANY($${params.length})`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(filter?.limit ?? 100);
    const res = await this.ctx.db.query(
      `SELECT * FROM async_jobs ${whereSql} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    console.debug(`[async-jobs] list agent=${filter?.agentId ?? 'all'} status=${filter?.status?.join(',') ?? 'all'} limit=${filter?.limit ?? 100} rows=${res.rows.length}`);
    return res.rows.map(rowToJob);
  }

  async get(jobId: string): Promise<AsyncJob | null> {
    const res = await this.ctx.db.query(`SELECT * FROM async_jobs WHERE id = $1`, [jobId]);
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  async cancel(jobId: string): Promise<{ cancelled: boolean; reason?: string }> {
    const job = await this.get(jobId);
    if (!job) return { cancelled: false, reason: 'not found' };
    if (job.status !== 'queued' && job.status !== 'running') {
      return { cancelled: false, reason: `status is ${job.status}` };
    }
    await this.ctx.db.query(
      `UPDATE async_jobs SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
      [jobId],
    );
    this.queueSpecs.delete(jobId);

    if (job.kind === 'sandbox_run') {
      // Sandbox runs are inline with the agent's current run — aborting the agent
      // naturally aborts the sandbox work. The agent run's finalizer will see the
      // 'cancelled' status and skip re-marking.
      try {
        const agentMod = this.ctx.modules.tryGet<AgentModule>('agent');
        agentMod?.abort(job.agentId);
      } catch (err) {
        console.warn(`[async-jobs] sandbox abort failed for ${jobId}:`, err);
      }
    } else if (job.kind === 'sub_agent') {
      // Sub-agent runs are dispatched through agentMod.run(subAgentId, …) inside
      // runSubAgent's Promise.race. Aborting the sub-agent stops the LLM run; the
      // race's loser branch will see the abort and finalize as cancelled.
      try {
        const agentMod = this.ctx.modules.tryGet<AgentModule>('agent');
        const subAgentId = job.subAgentId ?? job.agentId;
        agentMod?.abort(subAgentId);
        console.log(`[async-jobs] sub_agent abort sent agent=${subAgentId} job=${jobId}`);
      } catch (err) {
        console.warn(`[async-jobs] sub_agent abort failed for ${jobId}:`, err);
      }
    } else {
      // Shell job — kill the child process if it's running
      const running = this.running.get(jobId);
      if (running) {
        void this.terminateChild(jobId, running, 'cancel');
      }
    }

    this.ctx.ws.broadcastAll({
      type: 'async_job.cancelled',
      jobId,
      agentId: job.agentId,
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
    console.log(`[async-jobs] cancelled ${jobId} (kind=${job.kind})`);
    return { cancelled: true };
  }

  // ── Worker ─────────────────────────────────────────────────────────────────

  private async workerTick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const res = await this.ctx.db.query(
        `SELECT id FROM async_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
      );
      const jobId = res.rows[0]?.id as string | undefined;
      if (!jobId) return;
      const spec = this.queueSpecs.get(jobId);
      if (!spec) {
        // Spec is lost (backend was restarted but the row survived without us). Abort it.
        console.warn(`[async-jobs] queued row ${jobId} has no in-memory spec; failing`);
        await this.failJob(jobId, 'job spec lost — likely backend restart');
        return;
      }
      this.queueSpecs.delete(jobId);
      await this.runJob(jobId, spec);
    } catch (err) {
      console.error('[async-jobs] worker tick error', err);
    } finally {
      this.processing = false;
    }
  }

  private async runJob(jobId: string, spec: EnqueueInput): Promise<void> {
    const startedAt = Date.now();
    await this.ctx.db.query(
      `UPDATE async_jobs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [jobId],
    );
    this.ctx.ws.broadcastAll({
      type: 'async_job.started',
      jobId,
      agentId: spec.agentId,
      startedAt: new Date(startedAt).toISOString(),
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);

    if ((spec.kind ?? 'shell') === 'sandbox_run') {
      // Sandbox runs are NOT spawned through the worker — they're just tracking rows
      // created by dispatch_sandbox_run tool which flips the current agentMod.run into
      // sandbox mode (source='sandbox'). If we ever see one in the queue, something
      // went wrong (legacy row from before the simplification) — mark error.
      const current = await this.get(jobId);
      if (current?.status === 'cancelled') {
        console.log(`[async-jobs] ${jobId} sandbox_run already cancelled — skipping legacy worker path`);
        return;
      }
      await this.failJob(jobId, 'sandbox_run job in queue is unexpected (legacy row?) — sandbox runs are now inline with the originating agent run', Date.now() - startedAt);
      return;
    }

    if ((spec.kind ?? 'shell') === 'sub_agent') {
      await this.runSubAgent(jobId, spec, startedAt);
      return;
    }

    console.log(`[async-jobs] running ${jobId} (${spec.toolName}) cmd=${spec.command.slice(0, 100)}`);

    // Merge env vars (inherit + override)
    const env = { ...process.env, ...(spec.env ?? {}) };
    // Run through bash -l -c so that ~-expansion, shell aliases and user rc files work
    // identically to the sync path (execBash). On Windows this requires WSL / Git Bash,
    // which the sync path already assumes — so we stay consistent.
    const child = spawn('bash', ['-l', '-c', spec.command], {
      cwd: spec.cwd,
      env,
      windowsHide: true,
    });
    console.debug(`[async-jobs] spawned ${jobId} pid=${child.pid ?? 'unknown'} cwd=${spec.cwd} timeoutMs=${spec.timeoutMs}`);

    this.running.set(jobId, { ...spec, jobId, startedAt, process: child });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout?.on('data', chunk => {
      const next = appendCapped(stdout, chunk, stdoutBytes);
      stdout = next.value;
      stdoutBytes = next.bytes;
      if (!stdoutTruncated && next.truncated) console.warn(`[async-jobs] ${jobId} stdout capture truncated at ${MAX_CAPTURED_STREAM_BYTES} bytes`);
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on('data', chunk => {
      const next = appendCapped(stderr, chunk, stderrBytes);
      stderr = next.value;
      stderrBytes = next.bytes;
      if (!stderrTruncated && next.truncated) console.warn(`[async-jobs] ${jobId} stderr capture truncated at ${MAX_CAPTURED_STREAM_BYTES} bytes`);
      stderrTruncated ||= next.truncated;
    });
    child.on('error', err => {
      console.warn(`[async-jobs] child process error ${jobId}: ${err.message}`);
    });

    const timeoutHandle = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, spec.timeoutMs);

    // Wait for the process to finish. We resolve on 'exit' (fires the instant the process
    // dies) rather than ONLY on 'close' — 'close' additionally waits for every inherited
    // stdio pipe to reach EOF, so a detached grandchild that inherited our stdout/stderr
    // write-end (background uploader, nohup, double-fork) keeps the pipe open and 'close'
    // NEVER fires even after SIGKILL kills the immediate bash child. That would hang this
    // await forever and — because the worker is strictly sequential (`processing` gates
    // workerTick, reset only after runJob returns) — wedge the ENTIRE async-jobs queue
    // (shell + sub_agent) until a backend restart. (audit M13)
    //
    // We still prefer 'close' when it arrives promptly so a fast-flushing child yields the
    // exact same {code, signal} as before; 'exit' is the floor that guarantees liveness.
    // A hard wall-clock deadline (timeout + grace) is a final backstop in case neither
    // event ever fires (e.g. SIGKILL somehow ineffective). stdout/stderr data listeners
    // live on the streams and keep capturing whatever was emitted before the process died.
    const exitInfo: { code: number | null; signal: NodeJS.Signals | null; wedged?: boolean } =
      await new Promise(resolve => {
      let settled = false;
      const finish = (
        info: { code: number | null; signal: NodeJS.Signals | null; wedged?: boolean },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        child.off('close', onClose);
        child.off('exit', onExit);
        resolve(info);
      };
      // 'close' = process exited AND all stdio EOF — most precise, take it when it comes.
      const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
        finish({ code, signal });
      // 'exit' = process terminated; stdio pipes may still be held open by grandchildren.
      // Give 'close' a brief grace to deliver any final buffered output, then settle with
      // the exit info so we never block on an inherited-fd EOF that may never come.
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        setTimeout(() => finish({ code, signal }), 1_000);
      };
      // Wall-clock backstop: timeoutMs already SIGKILLs the child above; allow a grace
      // window for that to land + 'exit'/'close' to fire, then force-resolve so the worker
      // can release `processing` and the job is failed instead of hanging the queue.
      const deadlineTimer = setTimeout(() => {
        finish({ code: null, signal: 'SIGKILL', wedged: true });
      }, spec.timeoutMs + CHILD_TERM_GRACE_MS + CHILD_KILL_GRACE_MS);
      child.once('close', onClose);
      child.once('exit', onExit);
    });
    clearTimeout(timeoutHandle);
    this.running.delete(jobId);
    if (exitInfo.wedged) {
      // The process never reported exit/close within the deadline — almost certainly a
      // detached grandchild holding the inherited stdout/stderr pipe open. Best-effort
      // re-kill (the child itself is likely already dead) and move on; the synthetic
      // SIGKILL exitInfo below routes this into failJob so the queue keeps draining.
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      console.warn(`[async-jobs] ${jobId} did not report exit within deadline (likely detached grandchild holding stdio) — force-failing to unblock queue`);
    }
    console.debug(`[async-jobs] child closed ${jobId} code=${exitInfo.code ?? 'null'} signal=${exitInfo.signal ?? 'none'} wedged=${exitInfo.wedged ? 'yes' : 'no'} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes}`);

    // Check if cancelled during run
    const job = await this.get(jobId);
    if (!job) {
      console.warn(`[async-jobs] ${jobId} disappeared from DB mid-run`);
      return;
    }
    if (job.status === 'cancelled') {
      console.log(`[async-jobs] ${jobId} cancelled — skipping delivery`);
      return;
    }

    const durationMs = Date.now() - startedAt;
    if (stdoutTruncated) stdout += `\n\n[stdout truncated after ${MAX_CAPTURED_STREAM_BYTES} bytes]`;
    if (stderrTruncated) stderr += `\n\n[stderr truncated after ${MAX_CAPTURED_STREAM_BYTES} bytes]`;
    const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();

    if (exitInfo.code !== 0) {
      const errMsg = exitInfo.signal
        ? `killed by signal ${exitInfo.signal}${exitInfo.signal === 'SIGKILL' && durationMs >= spec.timeoutMs - 1000 ? ' (timeout)' : ''}`
        : `exited with code ${exitInfo.code}`;
      await this.failJob(jobId, `${errMsg}\n${output.slice(0, 2000)}`, durationMs);
      return;
    }

    // Success — collect outputs and deliver
    await this.completeJob(jobId, spec, startedAt, durationMs, output);
  }

  private async terminateChild(jobId: string, spec: RunningSpec, reason: 'cancel' | 'shutdown'): Promise<void> {
    const child = spec.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch (err) {
      console.warn(`[async-jobs] SIGTERM failed for ${jobId} (${reason}):`, err);
    }
    const closedAfterTerm = await waitForChildClose(child, CHILD_TERM_GRACE_MS);
    if (closedAfterTerm === 'closed') return;
    try {
      child.kill('SIGKILL');
    } catch (err) {
      console.warn(`[async-jobs] SIGKILL failed for ${jobId} (${reason}):`, err);
    }
    const closedAfterKill = await waitForChildClose(child, CHILD_KILL_GRACE_MS);
    if (closedAfterKill === 'timeout') {
      console.warn(`[async-jobs] ${jobId} did not close after SIGKILL (${reason})`);
    }
  }

  // ── Sub-agent runs (cloud one-shot dispatched from `spawn_subagent`) ──
  //
  // Lifecycle (worker side):
  //   1. workerTick() picks the row → runJob() → branches to runSubAgent()
  //   2. Resolve sub-agent config (caps, model, system prompt, allowed tools)
  //   3. Create a transient session for the sub-agent (sessionId='sub-${jobId}')
  //   4. Invoke agentMod.run(subAgentId, …, source='subagent') under timeout/iter caps
  //   5. Sub-agent calls `submit_subagent_report({ markdown, [caps_hit] })` — finalize
  //      persists DB (result+caps_hit+status='done') and stashes markdown in deliveryState
  //   6. Post-loop: when state.completed=true, trigger a PARENT re-run via
  //      `agentMod.run(parentAgentId, parent_session, <wrapper prompt + markdown>,
  //      'proactive', { visibleSource })`. Parent runs in handler phase (hidden stream)
  //      and must call `send_to_user` to reach the user. Web safety net in run.ts catches
  //      the case where it forgets.
  //
  // If the run times out, throws, or returns empty without submit: failJob() with a
  // descriptive error, parent session gets a chat notice (source-aware + Telegram leg
  // when applicable). No parent re-run for failures by design — only successful submits
  // trigger synthesis.

  private async runSubAgent(jobId: string, spec: EnqueueInput, startedAtMs: number): Promise<void> {
    const subAgentId = spec.subAgentId ?? spec.agentId;
    const parentSessionId = spec.parentSessionId;
    const parentAgentId = spec.parentAgentId ?? '';
    const taskPrompt = (spec.taskPrompt ?? '').trim();

    if (!parentSessionId) {
      await this.failJob(jobId, 'sub-agent job missing parent_session_id', Date.now() - startedAtMs);
      return;
    }
    if (!taskPrompt) {
      await this.failJob(jobId, 'sub-agent job missing taskPrompt', Date.now() - startedAtMs);
      return;
    }

    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const subAgentConfig = agentMod.getAgent(subAgentId);
    if (!subAgentConfig) {
      await this.failJob(jobId, `sub-agent "${subAgentId}" not found in registry`, Date.now() - startedAtMs);
      return;
    }
    if (subAgentConfig.kind !== 'subagent') {
      await this.failJob(jobId, `agent "${subAgentId}" is not a sub-agent (kind=${subAgentConfig.kind ?? 'agent'})`, Date.now() - startedAtMs);
      return;
    }
    if (subAgentConfig.enabled === false) {
      await this.failJob(jobId, `sub-agent "${subAgentId}" is disabled`, Date.now() - startedAtMs);
      return;
    }

    // Resolve caps with global defaults fallback
    const globalCaps = this.ctx.config.subagentDefaults?.caps ?? {};
    const ownCaps = subAgentConfig.caps ?? {};
    const maxIterations = ownCaps.maxIterations ?? globalCaps.maxIterations ?? 15;
    const timeoutSeconds = ownCaps.timeoutSeconds ?? globalCaps.timeoutSeconds ?? 300;
    const maxOutputTokens = ownCaps.maxOutputTokens ?? globalCaps.maxOutputTokens ?? 8000;
    // Default to 30 (matches the comment in shared/types/config.ts SubAgentCaps.maxToolCalls).
    // Previously this fell back to `null` (= unlimited) which diverged from the documented
    // contract and let runaway sub-agents eat tools indefinitely.
    const maxToolCallsCap = ownCaps.maxToolCalls ?? globalCaps.maxToolCalls ?? 30;

    // P2.3 — maxToolCalls enforcé via toolExecOpts (compteur partagé). Quand le LLM
    // dépasse, executeTool soft-refuse avec rappel d'appeler submit_subagent_report.
    // submit_subagent_report ne compte pas contre ce cap.
    const subAgentToolCallsCounter = { count: 0 };

    // Override the sub-agent's max_completion_tokens for THIS run only. We mutate the
    // in-memory AgentConfig — it's per-process state and the next runSubAgent call
    // will overwrite it again. Restored to its original value in a finally block to
    // avoid persisted leak across runs (although same-value sub-agent runs make this
    // harmless in practice — defense in depth).
    const previousMaxCompletion = subAgentConfig.maxCompletionTokens;
    subAgentConfig.maxCompletionTokens = maxOutputTokens;

    console.log(`[async-jobs:sub_agent] start job=${jobId} sub=${subAgentId} parent=${parentAgentId}/${parentSessionId} maxIter=${maxIterations} maxOutput=${maxOutputTokens}t timeout=${timeoutSeconds}s promptLen=${taskPrompt.length}`);

    // Pre-create the transient sub-agent session in DB (agentMod.run uses getOrCreate
    // internally, but doing it here ensures the row exists for any concurrent reads).
    try {
      const sessionMod = this.ctx.modules.get<SessionModule>('session');
      await sessionMod.getOrCreate(spec.sessionId, subAgentId);
    } catch (err) {
      console.warn(`[async-jobs:sub_agent] ${jobId} session getOrCreate failed (non-fatal):`, err);
    }

    let finalText = '';
    let capsHit: SubAgentCapsHit | null = null;
    let runError: string | null = null;
    const runStartMs = Date.now();
    const subAgentDeliveryState: SubAgentDeliveryState = { completed: false };
    const parentVisibleSource: 'web' | 'telegram' =
      (spec.args?.['parent_visible_source'] === 'telegram') ? 'telegram' : 'web';
    // Resolve parent agent config locally — used post-loop to gate the parent re-run trigger
    // (must be enabled) and for the error-path Telegram alert leg below. NOT carried into the
    // delivery context: the worker drives the re-run, not the sub-agent's tool dispatch.
    const parentAgentConfig = parentAgentId ? agentMod.getAgent(parentAgentId) : undefined;
    const subAgentDelivery: SubAgentDeliveryContext = {
      jobId,
      parentSessionId,
      parentAgentId,
      parentVisibleSource,
      presetId: subAgentId,
      runStartedAtMs: runStartMs,
    };

    // Wall-clock + settle timer handles hoisted out of the try so the finally can clear
    // them unconditionally. Audit L11: if runPromise REJECTS before the timeout fires
    // (provider 5xx, "Réponse vide de Mercury", connection drop), `await Promise.race`
    // throws and any clearTimeout sitting inside the try body is skipped → the
    // timeoutSeconds-long timer (and the 2s settle timer) linger per failed run.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settleTimerId: ReturnType<typeof setTimeout> | undefined;
    try {
      // Wall-clock timeout via Promise.race — agentMod.run doesn't take a wall-clock cap
      // natively (only maxToolTurnsOverride for tool-loop budget).
      const runPromise = agentMod.run(subAgentId, spec.sessionId, taskPrompt, 'subagent', {
        maxToolTurnsOverride: maxIterations,
        activeRunId: jobId,
        subAgentDelivery,
        subAgentDeliveryState,
        subAgentToolCallsCap: maxToolCallsCap,
        subAgentToolCallsCounter,
      });
      const timeoutPromise = new Promise<'__timeout__'>((resolve) => {
        timeoutId = setTimeout(() => resolve('__timeout__'), timeoutSeconds * 1_000);
      });
      const winner = await Promise.race([runPromise, timeoutPromise]);
      if (winner === '__timeout__') {
        capsHit = 'timeout';
        try { agentMod.abort(subAgentId); } catch { /* ignore */ }
        // Allow any in-flight cleanup to settle
        try {
          const settlePromise = new Promise<string>((res) => {
            settleTimerId = setTimeout(() => res(''), 2000);
          });
          const settled = await Promise.race([runPromise.catch(() => ''), settlePromise]);
          finalText = String(settled ?? '');
        } catch {
          finalText = '';
        }
        console.warn(`[async-jobs:sub_agent] ${jobId} timeout after ${timeoutSeconds}s`);
      } else {
        finalText = String(winner ?? '');
      }
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      console.warn(`[async-jobs:sub_agent] ${jobId} run threw: ${runError.slice(0, 200)}`);
    } finally {
      // Always clear the timers regardless of success/throw — otherwise a rejected run
      // leaves a dangling wall-clock timer (and possibly the settle timer) keeping the
      // event loop work alive for up to timeoutSeconds. (audit L11)
      if (timeoutId) clearTimeout(timeoutId);
      if (settleTimerId) clearTimeout(settleTimerId);
      // Restore the sub-agent's original maxCompletionTokens. Two consecutive sub-agent
      // runs of the SAME preset would otherwise inherit the previous override (harmless
      // when caps don't change, but defense-in-depth — and the next run reapplies anyway).
      subAgentConfig.maxCompletionTokens = previousMaxCompletion;
    }

    const durationMs = Date.now() - runStartMs;

    // P2.3 — si le cap d'appels d'outils a été dépassé pendant le run, persister la cause
    // en capsHit (priorité existante : timeout > tool_calls > iterations > null). Le LLM peut
    // aussi le setter via submit_subagent_report.caps_hit (priorité absolue côté tool).
    if (
      !capsHit
      && maxToolCallsCap !== null
      && subAgentToolCallsCounter.count > maxToolCallsCap
    ) {
      capsHit = 'tool_calls';
      console.log(
        `[async-jobs:sub_agent] ${jobId} maxToolCalls cap hit ${subAgentToolCallsCounter.count}/${maxToolCallsCap}`,
      );
    }

    // Iterations cap auto-detection. runAgent (run.ts) substitutes the canonical sentinel
    // string `[Max tool turns reached without a final response]` as fullResponse when it
    // exits the tool loop with `toolTurns >= maxToolTurns` and no terminal text. If we see
    // that exact marker AND submit was never called, the run hit the iterations cap. Lower
    // priority than timeout/tool_calls so an explicit signal wins.
    if (
      !capsHit
      && !subAgentDeliveryState.completed
      && finalText.startsWith('[Max tool turns reached')
    ) {
      capsHit = 'iterations';
      console.log(`[async-jobs:sub_agent] ${jobId} maxIterations cap hit (turns >= ${maxIterations})`);
    }

    if (subAgentDeliveryState.completed) {
      if (capsHit) {
        await this.ctx.db.query(
          `UPDATE async_jobs SET caps_hit = $1 WHERE id = $2 AND caps_hit IS NULL`,
          [capsHit, jobId],
        ).catch(() => { /* non-fatal */ });
      }
      console.log(
        `[async-jobs:sub_agent] ${jobId} delivered via submit_subagent_report sub=${subAgentId} duration=${durationMs}ms capsHit=${capsHit ?? 'none'} finalTextLen=${finalText.length}`,
      );

      // ── Trigger parent re-run ────────────────────────────────────────────
      // Le markdown brut est injecté comme USER message (source='proactive') dans la session
      // parente. Le parent tourne en mode handler caché — son stream n'est pas broadcasté à
      // l'UI ; il doit explicitement appeler `send_to_user` pour livrer sa synthèse à l'user.
      // Le wrapper prompt rappelle cette consigne pour les modèles légers qui oublient.
      //
      // KV-cache : l'injection arrive en TAIL de l'historique parent (nouveau row created_at=NOW),
      // le slot grandit de la taille du markdown + memory prefix, pas de divergence préfixe.
      // Le `injectedPrefix` du nouveau message est persisté en metadata par runAgent → byte-stable
      // au prochain rebuild.
      //
      // Fire-and-forget : pas d'await — le worker doit pouvoir picker le job suivant. Le parent
      // run sera serialisé naturellement via runPromises (agent/index.ts:854-862) si déjà busy.
      const submittedMarkdown = subAgentDeliveryState.markdown;
      if (!parentAgentConfig) {
        console.warn(`[async-jobs:sub_agent] ${jobId} parent agent "${parentAgentId}" introuvable — markdown persisté mais aucune re-run déclenchée.`);
      } else if (parentAgentConfig.enabled === false) {
        console.warn(`[async-jobs:sub_agent] ${jobId} parent agent "${parentAgentId}" désactivé — markdown persisté mais aucune re-run déclenchée.`);
      } else if (!submittedMarkdown) {
        // Should never happen (state.completed=true implies markdown was stashed) but guard anyway.
        console.warn(`[async-jobs:sub_agent] ${jobId} state.completed=true sans markdown — re-run skipped.`);
      } else {
        const injection = buildSubAgentReportInjection({
          presetId: subAgentId,
          jobId,
          durationMs,
          capsHit: subAgentDeliveryState.capsHit ?? capsHit,
          markdown: submittedMarkdown,
          parentVisibleSource,
          maxMarkdownChars: this.ctx.config.subagentDefaults?.reportInjectionMaxChars ?? DEFAULT_REPORT_INJECTION_CHARS,
          pushEnabled: this.ctx.modules.tryGet<PushModule>('push')?.isEnabled() ?? false,
        });
        console.log(`[async-jobs:sub_agent] ${jobId} triggering parent re-run agent=${parentAgentId} session=${parentSessionId} visibleSource=${parentVisibleSource} injectionLen=${injection.length}`);
        void agentMod
          .run(parentAgentId, parentSessionId, injection, 'proactive', {
            visibleSource: parentVisibleSource,
          })
          .catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[async-jobs:sub_agent] ${jobId} parent re-run failed: ${errMsg}`);
            // Audit finding E — without a fallback, the user never learns the sub-agent
            // delivered (and that synthesis failed). Push a short notice on the parent's
            // visible channel so they can drill down via Tâches/Runs to read the raw report.
            const noticeContent = `⚠️ Le sub-agent \`${subAgentId}\` a livré son rapport mais l'agent parent n'a pas pu le synthétiser : ${errMsg.slice(0, 300)}. Le rapport complet est consultable via le drill-down (job ${jobId}).`;
            void deliverToChat({
              sessionModule: this.ctx.modules.get<SessionModule>('session'),
              ws: this.ctx.ws,
              sessionId: parentSessionId,
              content: noticeContent,
              source: parentVisibleSource,
              attachments: [],
              extraMetadata: { asyncJobId: jobId, asyncJobError: true, subAgentId, subAgentParentAgent: parentAgentId, reason: 'parent_rerun_failed' },
            }).catch((deliveryErr) => {
              console.error(`[async-jobs:sub_agent] ${jobId} re-run-failure notice deliver failed:`, deliveryErr);
            });
            // Telegram leg — bridge doesn't subscribe to session.message, push explicitly.
            if (
              parentVisibleSource === 'telegram'
              && parentAgentConfig?.telegram?.enabled
              && parentAgentConfig.telegram.chatIds?.length
            ) {
              const telegramMod = this.ctx.modules.tryGet<TelegramModule>('telegram');
              if (telegramMod) {
                void deliverToTelegram({
                  telegramModule: telegramMod,
                  mastermindConfig: this.ctx.config,
                  handlerAgentConfig: parentAgentConfig,
                  content: noticeContent,
                  attachments: [],
                  subject: '⚠️ Sub-agent — synthèse échouée',
                }).catch((tgErr) => {
                  console.warn(`[async-jobs:sub_agent] ${jobId} re-run-failure telegram leg failed: ${tgErr instanceof Error ? tgErr.message : tgErr}`);
                });
              }
            }
          });
      }
      return;
    }

    // Cancel-mid-flight guard. cancel() flips status to 'cancelled' and aborts the agentMod
    // run; that abort surfaces here as `runError`. Without this guard, failJob() below would
    // overwrite cancelled→error and the UI badge would clignote. Mirror the shell-job and
    // sandbox-run patterns where cancellation is terminal.
    {
      const cancelCheck = await this.ctx.db.query<{ status: string }>(
        `SELECT status FROM async_jobs WHERE id = $1`,
        [jobId],
      );
      if (cancelCheck.rows[0]?.status === 'cancelled') {
        console.log(`[async-jobs:sub_agent] ${jobId} already cancelled — skipping failJob`);
        await this.ctx.db.query(
          `UPDATE async_jobs SET session_id = $1, caps_hit = $2 WHERE id = $3 AND caps_hit IS NULL`,
          [parentSessionId, capsHit, jobId],
        ).catch(() => { /* non-fatal */ });
        return;
      }
    }

    if (!finalText.trim() && runError) {
      await this.ctx.db.query(
        `UPDATE async_jobs SET session_id = $1, caps_hit = $2 WHERE id = $3`,
        [parentSessionId, capsHit, jobId],
      ).catch(() => { /* non-fatal */ });
      await this.failJob(jobId, `sub-agent "${subAgentId}" run failed: ${runError.slice(0, 500)}`, durationMs);
      return;
    }

    const st = await this.ctx.db.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM async_jobs WHERE id = $1`,
      [jobId],
    );
    if (st.rows[0]?.status === 'done') {
      return;
    }
    if (st.rows[0]?.status === 'error') {
      // P1.1 — finalize a déjà loggé un message précis (ex: "parent delivery failed: ...").
      // Ne pas l'écraser, mais notifier le parent avec L'ERREUR RÉELLE pour qu'il sache
      // que la livraison a foiré (sinon silence côté user). Source = parent visible channel.
      const realError = (st.rows[0].error ?? 'unknown delivery error').trim();
      console.warn(
        `[async-jobs:sub_agent] ${jobId} job already finalized as error — preserving message + notifying parent: ${realError.slice(0, 200)}`,
      );
      const alertContent = `⚠️ Sub-agent \`${subAgentId}\` : ${realError.slice(0, 500)}`;
      try {
        await deliverToChat({
          sessionModule: this.ctx.modules.get<SessionModule>('session'),
          ws: this.ctx.ws,
          sessionId: parentSessionId,
          content: alertContent,
          source: parentVisibleSource,
          attachments: [],
          extraMetadata: { asyncJobId: jobId, asyncJobError: true, subAgentId, subAgentParentAgent: parentAgentId },
        });
      } catch (err) {
        console.error(`[async-jobs:sub_agent] ${jobId} parent failure-alert delivery also failed:`, err);
      }
      // Telegram leg — best-effort. Same rationale as finalizeSubAgentJobDelivery: bridge
      // doesn't subscribe to session.message broadcasts, so a Telegram parent never sees
      // the chat-only alert without an explicit push.
      if (
        parentVisibleSource === 'telegram'
        && parentAgentConfig?.telegram?.enabled
        && parentAgentConfig.telegram.chatIds?.length
      ) {
        try {
          const telegramMod = this.ctx.modules.tryGet<TelegramModule>('telegram');
          if (telegramMod) {
            await deliverToTelegram({
              telegramModule: telegramMod,
              mastermindConfig: this.ctx.config,
              handlerAgentConfig: parentAgentConfig,
              content: alertContent,
              attachments: [],
              subject: 'Sub-agent erreur',
            });
          }
        } catch (err) {
          console.warn(`[async-jobs:sub_agent] ${jobId} telegram alert leg failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
      return;
    }

    const errMsg =
      `Le sub-agent « ${subAgentId} » n'a pas appelé submit_subagent_report avec le rapport Markdown final. ` +
      `Sans cet outil, rien n'est livré au parent.${capsHit ? ` (arrêt partiel: ${capsHit})` : ''}`;
    await this.ctx.db.query(
      `UPDATE async_jobs SET session_id = $1, caps_hit = $2 WHERE id = $3`,
      [parentSessionId, capsHit, jobId],
    ).catch(() => { /* non-fatal */ });
    await this.failJob(jobId, errMsg, durationMs);
  }

  // ── Sandbox tracking (no worker spawn — the sandbox IS the current agentMod.run in 'sandbox' mode) ──
  // dispatch_sandbox_run flips the ongoing run's source to 'sandbox' and calls these helpers
  // to keep the UI in sync. No LLM calls happen here; this is just DB + WS plumbing.

  /**
   * Begin tracking a sandbox "run" for UI purposes. Creates an async_jobs row directly in
   * 'running' state (no queue — the work is already happening inline in the caller's
   * agentMod.run). Returns the new jobId that dispatch_sandbox_run surfaces to the agent.
   */
  async startSandboxTracking(input: { agentId: string; sessionId: string; task: string }): Promise<{ jobId: string }> {
    const jobId = nanoid(12);
    const now = new Date();
    await this.ctx.db.query(
      `INSERT INTO async_jobs (id, agent_id, session_id, tool_name, args, kind, status, started_at, caption)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'sandbox_run', 'running', NOW(), $6)`,
      [jobId, input.agentId, input.sessionId, 'dispatch_sandbox_run', JSON.stringify({ task: input.task }), 'Sandbox run'],
    );
    this.ctx.ws.broadcastAll({
      type: 'async_job.started',
      jobId,
      agentId: input.agentId,
      startedAt: now.toISOString(),
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
    console.log(`[async-jobs] sandbox started ${jobId} agent=${input.agentId} task="${input.task.slice(0, 80)}..."`);
    return { jobId };
  }

  /** Called when the agent run hosting the sandbox finishes normally (finish=stop or send_to_user called). */
  async markSandboxDone(jobId: string): Promise<void> {
    const job = await this.get(jobId);
    if (!job) return;
    if (job.status !== 'running') return; // already finalized (e.g. cancelled)
    const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
    const durationMs = Date.now() - startedAt;
    await this.ctx.db.query(
      `UPDATE async_jobs SET status = 'done', completed_at = NOW() WHERE id = $1`,
      [jobId],
    );
    this.ctx.ws.broadcastAll({
      type: 'async_job.completed',
      jobId,
      agentId: job.agentId,
      durationMs,
      outputCount: 0,
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
    console.log(`[async-jobs] sandbox ${jobId} done in ${durationMs}ms`);
  }

  /** Called when the host agent run is aborted (user sent a new message, UI cancel, etc). */
  async markSandboxCancelled(jobId: string): Promise<void> {
    const job = await this.get(jobId);
    if (!job) return;
    if (job.status !== 'running') return;
    await this.ctx.db.query(
      `UPDATE async_jobs SET status = 'cancelled', cancelled_at = NOW(), completed_at = NOW() WHERE id = $1`,
      [jobId],
    );
    this.ctx.ws.broadcastAll({
      type: 'async_job.cancelled',
      jobId,
      agentId: job.agentId,
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
    console.log(`[async-jobs] sandbox ${jobId} cancelled`);
  }

  /** Called when the host agent run errors mid-sandbox (provider failure, exception, etc). */
  async markSandboxError(jobId: string, error: string): Promise<void> {
    const job = await this.get(jobId);
    if (!job) return;
    if (job.status !== 'running') return;
    const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
    const durationMs = Date.now() - startedAt;
    await this.ctx.db.query(
      `UPDATE async_jobs SET status = 'error', error = $2, completed_at = NOW() WHERE id = $1`,
      [jobId, error],
    );
    this.ctx.ws.broadcastAll({
      type: 'async_job.failed',
      jobId,
      agentId: job.agentId,
      error,
      durationMs,
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
    console.warn(`[async-jobs] sandbox ${jobId} errored: ${error.slice(0, 200)}`);
  }

  private async completeJob(jobId: string, spec: EnqueueInput, startedAtMs: number, durationMs: number, output: string): Promise<void> {
    // Output discovery: if `outputFromArg` is set, take that arg's value as the output path
    // (absolute or relative to cwd). This handles skills that write to caller-specified
    // paths (e.g. media-gen writes to shared-memory/media/<filename>). Otherwise fall
    // back to globbing the cwd.
    let outputPaths: string[] = [];
    if (spec.outputFromArg) {
      const raw = spec.args[spec.outputFromArg];
      if (typeof raw === 'string' && raw.trim().length > 0) {
        const abs = path.isAbsolute(raw) ? raw : path.resolve(spec.cwd, raw);
        try {
          const stat = await fs.stat(abs);
          // Only accept files actually written (or touched) during this run
          if (stat.isFile() && stat.mtimeMs >= startedAtMs - 1000) {
            outputPaths = [abs];
          } else {
            console.warn(`[async-jobs] ${jobId} output_from_arg file ${abs} exists but mtime is older than started_at — skipping`);
          }
        } catch {
          console.warn(`[async-jobs] ${jobId} output_from_arg file not found at ${abs}`);
        }
      } else {
        console.warn(`[async-jobs] ${jobId} output_from_arg="${spec.outputFromArg}" but arg is missing/empty in args`);
      }
      console.log(`[async-jobs] ${jobId} done in ${durationMs}ms — output from arg "${spec.outputFromArg}": ${outputPaths.length} file(s)`);
    } else {
      outputPaths = await collectOutputs(spec.cwd, spec.outputsGlob, startedAtMs);
      console.log(`[async-jobs] ${jobId} done in ${durationMs}ms — ${outputPaths.length} output file(s) matched glob "${spec.outputsGlob}"`);
    }

    // Copy outputs into agent workspace under jobs/<jobId>/ so /api/files can serve them
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const agentConfig = agentMod.getAgent(spec.agentId);
    if (!agentConfig) {
      await this.failJob(jobId, `agent "${spec.agentId}" no longer exists`, durationMs);
      return;
    }
    const jobsDir = path.join(agentConfig.workspacePath, 'jobs', jobId);
    await fs.mkdir(jobsDir, { recursive: true });

    const resolved: ResolvedAttachment[] = [];
    const attachmentsMeta: MessageAttachment[] = [];
    for (const srcAbs of outputPaths) {
      const name = path.basename(srcAbs);
      const destAbs = path.join(jobsDir, name);
      try {
        await fs.copyFile(srcAbs, destAbs);
        const stat = await fs.stat(destAbs);
        const mime = mimeFor(name);
        const encodedRel = `jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(name)}`;
        const url = `/api/files/agent/${encodeURIComponent(spec.agentId)}/${encodedRel}`;
        const att: MessageAttachment = { kind: kindOf(mime), url, mime, name, size: stat.size };
        attachmentsMeta.push(att);
        resolved.push({ absPath: destAbs, url, mime, kind: att.kind, name, size: stat.size });
        console.debug(`[async-jobs] ${jobId} copied output name=${name} size=${stat.size} mime=${mime}`);
      } catch (err) {
        console.warn(`[async-jobs] ${jobId} failed to copy ${srcAbs}:`, err);
      }
    }

    // Deliver to chat (always)
    const caption = spec.caption || (attachmentsMeta.length > 0 ? 'Résultat prêt' : 'Tâche terminée');
    const deliveryErrors: string[] = [];
    try {
      console.debug(`[async-jobs] ${jobId} delivering chat captionLen=${caption.length} attachments=${resolved.length}`);
      await deliverToChat({
        sessionModule: this.ctx.modules.get<SessionModule>('session'),
        ws: this.ctx.ws,
        sessionId: spec.sessionId,
        content: caption,
        attachments: resolved,
        extraMetadata: { asyncJobId: jobId },
      });
    } catch (err) {
      console.error(`[async-jobs] ${jobId} chat delivery failed:`, err);
      deliveryErrors.push(`chat: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Deliver to Telegram if the agent has it configured — sauf si la policy v3 coupe le TG
    // sortant (delivery.telegram.mode='off'). Honoré ici aussi (bug hunt 2026-06-13 : ce chemin
    // bypassait resolveDelivery). On ne force PAS le modèle de triggers complet : un job de rendu
    // = "résultat prêt", livré largement, seul l'opt-out explicite 'off' le coupe.
    if (
      agentConfig.telegram?.enabled &&
      agentConfig.telegram.chatIds?.length &&
      agentConfig.delivery?.telegram?.mode !== 'off'
    ) {
      try {
        console.debug(`[async-jobs] ${jobId} delivering telegram chats=${agentConfig.telegram.chatIds.length} attachments=${resolved.length}`);
        const telegramMod = this.ctx.modules.get<TelegramModule>('telegram');
        const telegramResult = await deliverToTelegram({
          telegramModule: telegramMod,
          mastermindConfig: this.ctx.config,
          handlerAgentConfig: agentConfig,
          content: caption,
          attachments: resolved,
        });
        if (telegramResult.errors.length > 0) {
          deliveryErrors.push(...telegramResult.errors.map(e => `telegram ${e}`));
        }
        if (telegramResult.deliveredCount === 0) {
          deliveryErrors.push('telegram: no message or attachment was delivered');
        }
      } catch (err) {
        console.warn(`[async-jobs] ${jobId} telegram delivery failed:`, err);
        deliveryErrors.push(`telegram: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Mobile push (mobile app) — réveille le téléphone quand un job long (rendu média) finit
    // pendant que l'user est ailleurs. Best-effort : un échec de push ne fait PAS passer le
    // job en erreur (le chat reste la source de vérité, les pièces jointes y sont visibles).
    const pushMod = this.ctx.modules.tryGet<PushModule>('push');
    // Honore presenceDedup : si l'agent l'a activé ET qu'un client REGARDE la session, pas de
    // push (le résultat arrive sous ses yeux via la ligne chat). Bug hunt 2026-06-13.
    const dedup = agentConfig.delivery?.mobile?.presenceDedup === true;
    const viewing = dedup && this.ctx.ws.hasSessionViewers(spec.sessionId) > 0;
    if (pushMod?.isEnabled() && !viewing) {
      try {
        console.debug(`[async-jobs] ${jobId} delivering mobile push`);
        await deliverToMobile({
          pushModule: pushMod,
          content: caption,
          sessionId: spec.sessionId,
          agentId: spec.agentId,
        });
      } catch (err) {
        console.warn(`[async-jobs] ${jobId} mobile delivery failed:`, err);
      }
    }

    if (deliveryErrors.length > 0) {
      const error = `job completed but delivery failed: ${deliveryErrors.join(' | ')}`;
      await this.ctx.db.query(
        `UPDATE async_jobs SET status = 'error', result = $2, output_files = $3::jsonb, error = $4, completed_at = NOW() WHERE id = $1`,
        [jobId, output.slice(0, 50_000), JSON.stringify(attachmentsMeta), error],
      );
      this.ctx.ws.broadcastAll({
        type: 'async_job.failed',
        jobId,
        agentId: spec.agentId,
        error,
        durationMs,
      } satisfies WsServerMessage);
      console.warn(`[async-jobs] ${jobId} completed but delivery failed outputFiles=${attachmentsMeta.length}: ${deliveryErrors.join(' | ')}`);
    } else {
      await this.ctx.db.query(
        `UPDATE async_jobs SET status = 'done', result = $2, output_files = $3::jsonb, completed_at = NOW() WHERE id = $1`,
        [jobId, output.slice(0, 50_000), JSON.stringify(attachmentsMeta)],
      );
      this.ctx.ws.broadcastAll({
        type: 'async_job.completed',
        jobId,
        agentId: spec.agentId,
        durationMs,
        outputCount: attachmentsMeta.length,
      } satisfies WsServerMessage);
      console.log(`[async-jobs] ${jobId} completed delivery outputFiles=${attachmentsMeta.length} durationMs=${durationMs}`);
    }
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
  }

  private async failJob(jobId: string, error: string, durationMs = 0): Promise<void> {
    const job = await this.get(jobId);
    if (!job) return;
    await this.ctx.db.query(
      `UPDATE async_jobs SET status = 'error', error = $2, completed_at = NOW() WHERE id = $1`,
      [jobId, error],
    );
    console.warn(`[async-jobs] ${jobId} failed: ${error.slice(0, 200)}`);

    // Deliver an alert via the send_to_user pipe (chat + telegram if configured) — user was waiting
    try {
      const agentMod = this.ctx.modules.get<AgentModule>('agent');
      const workerAgentConfig = agentMod.getAgent(job.agentId);
      const isSubAgentJob = job.kind === 'sub_agent';
      const alertSessionId =
        isSubAgentJob && job.parentSessionId ? job.parentSessionId : job.sessionId;
      const telegramHandler =
        isSubAgentJob && job.parentAgentId
          ? agentMod.getAgent(job.parentAgentId) ?? workerAgentConfig
          : workerAgentConfig;
      // Source = parent visible channel for sub_agent jobs (read from args; fallback web).
      // Otherwise default = caller-set or web. Without this, telegram parents got web-tagged
      // alerts that the bridge couldn't surface.
      const subAgentParentVisible: 'web' | 'telegram' =
        isSubAgentJob && job.args?.['parent_visible_source'] === 'telegram' ? 'telegram' : 'web';
      const alertSource = isSubAgentJob ? subAgentParentVisible : 'web';
      const content = `⚠️ Génération échouée (${job.toolName}): ${error.slice(0, 500)}`;
      await deliverToChat({
        sessionModule: this.ctx.modules.get<SessionModule>('session'),
        ws: this.ctx.ws,
        sessionId: alertSessionId,
        content,
        source: alertSource,
        attachments: [],
        extraMetadata: { asyncJobId: jobId, asyncJobError: true },
      });
      if (telegramHandler?.telegram?.enabled && telegramHandler.telegram.chatIds?.length) {
        const telegramMod = this.ctx.modules.get<TelegramModule>('telegram');
        await deliverToTelegram({
          telegramModule: telegramMod,
          mastermindConfig: this.ctx.config,
          handlerAgentConfig: telegramHandler,
          content,
          attachments: [],
          subject: 'Génération échouée',
        });
      }
      // Mobile push (mobile app) — sauf sessions sub-agent telegram-native (compagne). Best-effort.
      const pushMod = this.ctx.modules.tryGet<PushModule>('push');
      if (pushMod?.isEnabled() && alertSource !== 'telegram') {
        try {
          await deliverToMobile({
            pushModule: pushMod,
            content,
            subject: 'Génération échouée',
            sessionId: alertSessionId,
            agentId: job.agentId,
          });
        } catch (err) {
          console.warn(`[async-jobs] ${jobId} mobile failure alert failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[async-jobs] ${jobId} failure delivery also failed:`, err);
    }

    this.ctx.ws.broadcastAll({
      type: 'async_job.failed',
      jobId,
      agentId: job.agentId,
      error,
      durationMs,
    } satisfies WsServerMessage);
    this.ctx.ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);
  }

  // ── Restart recovery ───────────────────────────────────────────────────────

  /**
   * On module init, mark any leftover queued/running jobs as errored and notify the
   * agent session. We deliberately do NOT auto-resume — external APIs (Sora, Veo)
   * may have continued running server-side but we can't reliably pick up their output.
   */
  private async recoverFromRestart(): Promise<void> {
    const res = await this.ctx.db.query(
      `SELECT id, agent_id, session_id, tool_name, kind, parent_session_id, parent_agent_id, sub_agent_id, args FROM async_jobs
       WHERE status IN ('queued', 'running')`,
    );
    if (res.rows.length === 0) return;
    console.log(`[async-jobs] recovering ${res.rows.length} interrupted job(s) from previous process`);
    for (const row of res.rows) {
      const jobId = String(row['id']);
      const rowKind = String(row['kind'] ?? 'shell') as JobKind;
      // Sub-agent jobs : flag caps_hit='restart' so the UI/stats reflect cause + redirect
      // the recovery alert to the PARENT session (sub-session is transient and the user
      // never sees it directly).
      if (rowKind === 'sub_agent' && row['parent_session_id']) {
        await this.ctx.db.query(
          `UPDATE async_jobs SET status = 'error', error = $2, caps_hit = 'restart', completed_at = NOW() WHERE id = $1`,
          [jobId, 'interrupted by backend restart'],
        );
        try {
          const subAgentId = String(row['sub_agent_id'] ?? row['agent_id']);
          const parentSessionId = String(row['parent_session_id']);
          const parentAgentId = row['parent_agent_id'] ? String(row['parent_agent_id']) : null;
          const args = (row['args'] ?? {}) as Record<string, unknown>;
          const recoverVisibleSource: 'web' | 'telegram' =
            args['parent_visible_source'] === 'telegram' ? 'telegram' : 'web';
          const content = `⚠️ Sub-agent \`${subAgentId}\` interrompu par un redémarrage du serveur. Tu peux relancer si besoin.`;
          await deliverToChat({
            sessionModule: this.ctx.modules.get<SessionModule>('session'),
            ws: this.ctx.ws,
            sessionId: parentSessionId,
            content,
            source: recoverVisibleSource,
            attachments: [],
            extraMetadata: { asyncJobId: jobId, asyncJobError: true, reason: 'restart', subAgentId },
          });
          // Telegram leg — bridge doesn't subscribe to session.message broadcasts; push explicitly.
          if (recoverVisibleSource === 'telegram' && parentAgentId) {
            const agentMod = this.ctx.modules.get<AgentModule>('agent');
            const parentCfg = agentMod.getAgent(parentAgentId);
            if (parentCfg?.telegram?.enabled && parentCfg.telegram.chatIds?.length) {
              try {
                const telegramMod = this.ctx.modules.get<TelegramModule>('telegram');
                await deliverToTelegram({
                  telegramModule: telegramMod,
                  mastermindConfig: this.ctx.config,
                  handlerAgentConfig: parentCfg,
                  content,
                  attachments: [],
                  subject: '⚠️ Sub-agent interrompu',
                });
              } catch (err) {
                console.warn(`[async-jobs] sub-agent recovery telegram leg failed for ${jobId}: ${err instanceof Error ? err.message : err}`);
              }
            }
          }
        } catch (err) {
          console.warn(`[async-jobs] sub-agent recovery notification failed for ${jobId}:`, err);
        }
        continue;
      }
      await this.ctx.db.query(
        `UPDATE async_jobs SET status = 'error', error = $2, completed_at = NOW() WHERE id = $1`,
        [jobId, 'interrupted by backend restart'],
      );
      try {
        const agentMod = this.ctx.modules.get<AgentModule>('agent');
        const agentConfig = agentMod.getAgent(String(row['agent_id']));
        if (!agentConfig) continue;
        const content = `⚠️ La tâche "${String(row['tool_name'])}" a été interrompue par un redémarrage du serveur. Relance-la si besoin.`;
        await deliverToChat({
          sessionModule: this.ctx.modules.get<SessionModule>('session'),
          ws: this.ctx.ws,
          sessionId: String(row['session_id']),
          content,
          attachments: [],
          extraMetadata: { asyncJobId: jobId, asyncJobError: true, reason: 'restart' },
        });
        if (agentConfig.telegram?.enabled && agentConfig.telegram.chatIds?.length) {
          const telegramMod = this.ctx.modules.get<TelegramModule>('telegram');
          await deliverToTelegram({
            telegramModule: telegramMod,
            mastermindConfig: this.ctx.config,
            handlerAgentConfig: agentConfig,
            content,
            attachments: [],
            subject: '⚠️ Tâche interrompue',
          });
        }
      } catch (err) {
        console.warn(`[async-jobs] recovery notification failed for ${jobId}:`, err);
      }
    }
  }
}
