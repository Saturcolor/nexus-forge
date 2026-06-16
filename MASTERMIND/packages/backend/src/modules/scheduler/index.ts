import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type {
  Module,
  MastermindContext,
  WsServerMessage,
  ScheduledTask,
  TaskRun,
  CreateTaskInput,
  UpdateTaskInput,
  TaskKind,
  TaskRunKind,
  Severity,
} from '@mastermind/shared';
import type { AgentModule } from '../agent/index.js';
import type { SessionModule } from '../session/index.js';
import { unifiedSessionId, primaryTelegramChatId } from '../agent/sessionResolve.js';
import type { BoardModule } from '../board/index.js';
import type { ProactiveSourceModule } from '../proactive-source/index.js';

const TICK_INTERVAL_MS = 30_000;

export function generateSchedulerId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function generateId(prefix: string): string {
  return generateSchedulerId(prefix);
}

/**
 * Context passed to a running task — picked up by tools (escalate_to_agent, send_to_user)
 * that need to know which proactive pipeline they're part of.
 */
export interface ProactiveRunContext {
  taskId: string | null;
  runId: string;
  kind: TaskRunKind;
  /** Handler agent the watcher should escalate to (from the scheduled_tasks row). */
  escalationAgentId?: string;
  severityThreshold: Severity;
  watcherAgentId: string;
  /** For escalation runs, reference to the parent (watcher) run. */
  parentRunId?: string;
  /**
   * autoDeliver flag inherited from the originating ScheduledTask. Propagated to
   * escalation runs so a user who silenced the watcher also silences the handler
   * dispatched from `escalate_to_agent`. Undefined for ad-hoc escalations (chat,
   * push alerts) — those default to true at run.ts.
   */
  autoDeliver?: boolean;
  /**
   * Override de canaux de réveil hérité de la tâche/source (UI). Prioritaire sur la
   * policy `delivery` de l'agent ET sur le souhait `channel` du LLM dans send_to_user.
   * Propagé aux runs d'escalade comme autoDeliver. Undefined = pas d'override.
   */
  deliveryChannels?: Array<'mobile' | 'telegram'>;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export function meetsSeverity(actual: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[threshold];
}

export class SchedulerModule implements Module {
  name = 'scheduler';
  private ctx!: MastermindContext;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;
  /** Tasks currently executing — prevents double-trigger (keyed by task.id) */
  private running = new Set<string>();
  /**
   * Agents currently executing a scheduled task — prevents two DIFFERENT tasks
   * targeting the SAME agent from being dispatched concurrently. Without this,
   * the second task's agentMod.run() calls abort(agentId) on the first task's
   * in-flight run (agent/index.ts:980), silently cutting short a watcher mid-check
   * (recorded as a successful no-op). Keyed by agentId; reserved at dispatch
   * (tick / runNow / executeTask) and released in executeTask's finally.
   * Escalation dispatches (triggerEscalation/dispatch) ALSO participate: they poll until
   * the handler is idle AND not in this Set, then reserve it for the duration of the
   * handler run (released in the dispatch finally, only if that dispatch acquired it).
   * This stops a scheduled task and an escalation handler for the same agent from
   * preempting each other through agentMod.run()@980 (formerly an open P3).
   */
  private runningAgents = new Set<string>();
  /** Active proactive run context by runId — looked up by tools (escalate_to_agent, send_to_user). */
  private activeRunContexts = new Map<string, ProactiveRunContext>();
  /**
   * Escalations queued during a watcher run, waiting for that watcher to fully finish
   * before the handler is actually dispatched. Keyed by the watcher's parentRunId.
   * Flushed in executeTask's finally block so the watcher gets uncontested Mercury bandwidth
   * to complete its post-tool turn before the handler takes over.
   */
  private pendingEscalations = new Map<string, Array<{ runId: string; dispatch: () => Promise<void> }>>();

  /**
   * Run ids CURRENTLY executing in-memory — watcher/task runs (executeTask) and escalation
   * handler runs (triggerEscalation dispatch). The periodic zombie sweep excludes these so a
   * legitimately long run (>30min) isn't false-marked 'failed' mid-flight (then flipped back to
   * 'completed' when it finishes). NOT consulted by the init-time cleanupZombieRuns, which
   * correctly blanket-fails ALL 'running' rows after a restart (their runs died with the process).
   * Residual: proactive-source push runs aren't registered here (separate module) — they're
   * single-shot alert evals that ~never reach 30min, and the sweep self-heals if one does.
   */
  private liveRunIds = new Set<string>();

  /** Returns the proactive context for a currently-running run, or undefined. */
  getRunContext(runId: string): ProactiveRunContext | undefined {
    return this.activeRunContexts.get(runId);
  }

  // ── Cooperative agent reservation ───────────────────────────
  // Shared with proactive-source so a webhook alert and a scheduled task / escalation handler
  // for the SAME agent QUEUE instead of aborting each other (agentMod.run aborts any in-flight
  // run for the agent). The tick + escalation dispatch already honour runningAgents; these expose
  // the same gate to the proactive-source module. NOTE: this only coordinates scheduler-owned and
  // proactive-source dispatch — it does NOT gate ad-hoc user chats (those bypass runningAgents),
  // which would need a reservation gate inside agentMod itself.
  isAgentReserved(agentId: string): boolean {
    return this.runningAgents.has(agentId);
  }
  /** Reserve the agent iff free. Returns false if already reserved — caller must NOT release. */
  reserveAgent(agentId: string): boolean {
    if (this.runningAgents.has(agentId)) return false;
    this.runningAgents.add(agentId);
    return true;
  }
  releaseAgent(agentId: string): void {
    this.runningAgents.delete(agentId);
  }
  /** Register/unregister a run as in-memory-live so the periodic zombie sweep won't false-fail it. */
  markRunLive(runId: string): void {
    this.liveRunIds.add(runId);
  }
  markRunDone(runId: string): void {
    this.liveRunIds.delete(runId);
  }

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    await this.cleanupZombieRuns();
    this.startTicker();
    console.log('[scheduler] Initialized');
  }

  async destroy(): Promise<void> {
    this.stopTicker();
    this.running.clear();
    this.runningAgents.clear();
    this.activeRunContexts.clear();
    this.pendingEscalations.clear();
  }

  // ── Ticker ──────────────────────────────────────────────────

  private startTicker(): void {
    this.tickTimer = setInterval(() => {
      this.tick().catch(err => console.error('[scheduler] tick error:', err.message));
    }, TICK_INTERVAL_MS);
    // Also run once immediately to catch up missed tasks on startup
    this.tick().catch(err => console.error('[scheduler] initial tick error:', err.message));
  }

  private stopTicker(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // Periodic zombie cleanup: runs stuck in 'running' for over 30min are likely dead.
  private lastZombieCleanup = 0;
  private async periodicZombieCleanup(): Promise<void> {
    const now = Date.now();
    if (now - this.lastZombieCleanup < 3600_000) return; // once per hour
    this.lastZombieCleanup = now;
    try {
      // Exclude runs we KNOW are alive in-memory (long handler/watcher runs >30min) so we don't
      // false-fail them mid-flight. Empty array → `id <> ALL('{}')` is true for all rows = no-op.
      const live = [...this.liveRunIds];
      const res = await this.ctx.db.query(
        `UPDATE task_runs SET status = 'failed', error = 'Stuck run cleaned up (running > 30min)', completed_at = NOW()
         WHERE status = 'running' AND started_at < NOW() - INTERVAL '30 minutes' AND id <> ALL($1::text[]) RETURNING id`,
        [live],
      );
      if (res.rowCount && res.rowCount > 0) {
        console.log(`[scheduler] Periodic zombie cleanup: marked ${res.rowCount} stuck run(s) as failed`);
      }
    } catch (err) {
      console.warn('[scheduler] Periodic zombie cleanup error:', (err as Error).message);
    }
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress) {
      console.debug('[scheduler] tick skipped (previous tick still running)');
      return;
    }
    const tickStartedAt = Date.now();
    this.tickInProgress = true;
    try {
    // Piggyback board purge on the scheduler tick (every 30s)
    const boardMod = this.ctx.modules.tryGet<BoardModule>('board');
    if (boardMod) boardMod.purgeExpired().catch(() => { /* non-fatal */ });

    // Piggyback proactive source session auto-flush (runs once per hour internally)
    const proactiveSrcMod = this.ctx.modules.tryGet<ProactiveSourceModule>('proactive-source');
    if (proactiveSrcMod) proactiveSrcMod.autoFlushStaleSessions().catch(() => { /* non-fatal */ });

    // Piggyback zombie run cleanup (once per hour, marks runs stuck > 30min as failed)
    this.periodicZombieCleanup().catch(() => { /* non-fatal */ });

    const { rows } = await this.ctx.db.query<ScheduledTaskRow>(
      `SELECT * FROM scheduled_tasks WHERE enabled = true AND next_run_at <= NOW() AND deleted_at IS NULL`,
    );
    console.debug(`[scheduler] tick scanned due=${rows.length} running=${this.running.size}`);
    if (rows.length > 0) {
      console.log(`[scheduler] tick: ${rows.length} task(s) due, ${this.running.size} already running`);
    }
    for (const row of rows) {
      if (this.running.has(row.id)) {
        console.debug(`[scheduler] tick: skipping ${row.id} (already running)`);
        continue;
      }
      const task = rowToTask(row);
      // Per-agent guard: don't dispatch a task whose agent is already running another
      // scheduler task — agentMod.run() would abort the in-flight run (agent/index.ts:980),
      // silently preempting it. Leave next_run_at untouched (we never entered executeTask)
      // so this task stays due and is retried on the next tick once the agent is free.
      if (this.runningAgents.has(task.agentId)) {
        console.log(`[scheduler] tick: deferring task "${task.name}" (${task.id}) — agent ${task.agentId} already running another task`);
        continue;
      }
      this.running.add(task.id);
      this.runningAgents.add(task.agentId);
      console.log(`[scheduler] tick: dispatching task "${task.name}" (${task.id})`);
      this.executeTask(task, true).catch(err =>
        console.error(`[scheduler] executeTask ${task.id} error:`, err.message),
      );
    }
    } finally {
      console.debug(`[scheduler] tick complete ms=${Date.now() - tickStartedAt}`);
      this.tickInProgress = false;
    }
  }

  // ── Execution ───────────────────────────────────────────────

  private async executeTask(task: ScheduledTask, alreadyReserved = false): Promise<void> {
    if (!alreadyReserved) {
      if (this.running.has(task.id)) throw new Error(`Task ${task.id} is already running`);
      if (this.runningAgents.has(task.agentId)) throw new Error(`Agent ${task.agentId} is already running another scheduled task`);
      this.running.add(task.id);
      this.runningAgents.add(task.agentId);
    }
    const runId = generateId('run');
    const startTime = Date.now();
    const isProactive = task.kind === 'proactive';
    let advisoryLockHeld = false;
    let advisoryClient: import('pg').PoolClient | undefined;
    let runInserted = false;
    let flushEscalations = false;

    try {
      advisoryClient = await this.ctx.db.connect();
      const lock = await advisoryClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [task.id],
      );
      advisoryLockHeld = lock.rows[0]?.locked === true;
      if (!advisoryLockHeld) {
        console.debug(`[scheduler] skipping ${task.id} (advisory lock held elsewhere)`);
        return;
      }
      console.debug(`[scheduler] advisory lock acquired task=${task.id} run=${runId}`);

      const agentMod = this.ctx.modules.get<AgentModule>('agent');
      const sessionMod = this.ctx.modules.get<SessionModule>('session');

      const agentCfg = agentMod.getAgent(task.agentId);

      // Session cible. En mode unifié, la tâche s'exécute TOUJOURS dans la session
      // cross-plateforme `{agent}-unified` (le briefing atterrit dans l'historique unifié
      // et la livraison reste cohérente cross-device). Sinon, on réutilise la session la
      // plus récente pour bénéficier du prompt cache, avec fallback création si aucune.
      let sessionId: string;
      if (agentCfg?.unifiedSession) {
        sessionId = unifiedSessionId(task.agentId);
        await sessionMod.getOrCreate(sessionId, task.agentId);
        console.log(`[scheduler] Using unified session ${sessionId} for task "${task.name}"`);
      } else {
        const existingSessions = await sessionMod.listByAgent(task.agentId);
        sessionId = existingSessions.length > 0
          ? existingSessions[0].id
          : `task-${task.id}-${Date.now()}`;
        if (existingSessions.length > 0) {
          console.log(`[scheduler] Reusing session ${sessionId} for task "${task.name}"`);
        } else {
          await sessionMod.getOrCreate(sessionId, task.agentId);
          console.log(`[scheduler] Created new session ${sessionId} for task "${task.name}" (no existing session)`);
        }
      }

      const runKind: TaskRunKind = isProactive ? 'proactive' : 'task';

      // Insert task run (task_name snapshot survives task deletion)
      await this.ctx.db.query(
        `INSERT INTO task_runs (id, task_id, task_name, agent_id, session_id, status, prompt, started_at, kind)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, NOW(), $7)`,
        [runId, task.id, task.name, task.agentId, sessionId, task.prompt, runKind],
      );
      runInserted = true;
      this.liveRunIds.add(runId);

      // Register proactive context so tools called during this run can escalate.
      if (isProactive) {
        this.activeRunContexts.set(runId, {
          taskId: task.id,
          runId,
          kind: 'proactive',
          escalationAgentId: task.escalationAgentId,
          severityThreshold: task.severityThreshold ?? 'medium',
          watcherAgentId: task.agentId,
          autoDeliver: task.autoDeliver,
          ...(task.deliveryChannels != null ? { deliveryChannels: task.deliveryChannels } : {}),
        });
        this.pendingEscalations.set(runId, []);
        console.debug(`[scheduler] proactive context registered run=${runId} watcher=${task.agentId} handler=${task.escalationAgentId ?? 'none'} threshold=${task.severityThreshold ?? 'medium'}`);
      }

      // Broadcast start
      this.ctx.ws.broadcastAll({
        type: 'task.started',
        taskId: task.id,
        runId,
        agentId: task.agentId,
      } satisfies WsServerMessage);

      console.log(`[scheduler] Executing ${runKind} task "${task.name}" (${task.id}) for agent ${task.agentId} in session ${sessionId}`);

      // Wrap prompt with structured header so the agent knows this is a scheduled
      // execution (not a user message) and has temporal context to resolve relative dates.
      const wrappedPrompt = this.buildScheduledTaskPrompt(task);
      // Detect Telegram-native sessions by sessionId convention (`<agent>-tg-<chatId>`).
      // When set as visibleSource, run.ts uses it as a fallback channel: if the agent
      // forgets to call send_to_user during this proactive/web run, the final text is
      // auto-pushed to Telegram so the user actually gets their scheduled briefing.
      const isTelegramSession = sessionId.includes('-tg-');
      // Mode unifié LEGACY (aucune policy `delivery` configurée) : la session `{agent}-unified`
      // n'a plus de `-tg-` dans l'id, mais le DM Telegram owner y est folded — on garde TG
      // comme canal fallback pour qu'un briefing proactif atteigne l'utilisateur, il y était
      // historiquement. DÈS QU'UNE policy `delivery` existe sur l'agent, elle prend la main :
      // on ne force plus visibleSource='telegram' (qui détournait aussi le default de
      // send_to_user vers TG) — le routage passe par resolveDelivery (policy/override tâche).
      const unifiedTelegramFallback =
        !!agentCfg?.unifiedSession &&
        agentCfg.delivery === undefined &&
        agentCfg.telegram?.enabled === true &&
        primaryTelegramChatId(agentCfg) !== undefined;
      const deliverViaTelegram = isTelegramSession || unifiedTelegramFallback;
      // Proactive runs use source='proactive' → persisted messages are hidden from chat UI.
      const result = await agentMod.run(task.agentId, sessionId, wrappedPrompt, isProactive ? 'proactive' : 'web', {
        activeRunId: runId,
        autoDeliver: task.autoDeliver,
        ...(task.deliveryChannels != null ? { deliveryChannels: task.deliveryChannels } : {}),
        ...(deliverViaTelegram ? { visibleSource: 'telegram' } : {}),
      });
      flushEscalations = true;
      if (isProactive) {
        const preview = result.slice(0, 300).replace(/\n/g, '↵');
        const escalatedRow = await this.ctx.db.query<{ escalated: boolean }>(
          'SELECT escalated FROM task_runs WHERE id = $1',
          [runId],
        );
        const didEscalate = escalatedRow.rows[0]?.escalated ?? false;
        console.log(`[scheduler] proactive run ${runId} finished: ${result.length} chars, escalated=${didEscalate}, preview="${preview}"`);
      }

      const durationMs = Date.now() - startTime;

      // Update run as completed
      await this.ctx.db.query(
        `UPDATE task_runs SET status = 'completed', result = $1, completed_at = NOW(), duration_ms = $2 WHERE id = $3`,
        [result, durationMs, runId],
      );
      console.debug(`[scheduler] run row completed run=${runId} durationMs=${durationMs}`);

      // Update task
      const nextRunAt = this.computeNextRun(task);
      const enabled = task.scheduleKind === 'once' ? false : task.enabled;
      await this.ctx.db.query(
        `UPDATE scheduled_tasks SET last_run_at = NOW(), last_run_status = 'completed',
         next_run_at = $1, enabled = $2, updated_at = NOW() WHERE id = $3`,
        [nextRunAt?.toISOString() ?? null, enabled, task.id],
      );
      console.debug(`[scheduler] task state updated task=${task.id} nextRun=${nextRunAt?.toISOString() ?? 'none'} enabled=${enabled}`);

      // Broadcast completion
      this.ctx.ws.broadcastAll({
        type: 'task.completed',
        taskId: task.id,
        runId,
        agentId: task.agentId,
        result: result.slice(0, 2000),
        durationMs,
      } satisfies WsServerMessage);
      this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);

      console.log(`[scheduler] Task "${task.name}" completed in ${durationMs}ms`);

      // Note: pas d'écho post-run vers Telegram. L'agent contrôle la livraison via
      // `send_to_user` (qui respecte le canal natif de la session). Si l'agent ne
      // pousse rien, c'est qu'il n'avait rien à dire — pas de spam de "Tache terminee".

      // Auto-delete task after execution if requested (soft-delete → corbeille)
      if (task.deleteAfterRun) {
        await this.ctx.db.query(
          `UPDATE scheduled_tasks SET deleted_at = NOW(), enabled = false, next_run_at = NULL, updated_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`,
          [task.id],
        );
        console.log(`[scheduler] Task "${task.name}" (${task.id}) auto-deleted after execution (soft, restorable from corbeille)`);
        this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Task "${task.name}" failed:`, errorMsg);

      if (runInserted) {
        await this.ctx.db.query(
          `UPDATE task_runs SET status = 'failed', error = $1, completed_at = NOW(), duration_ms = $2 WHERE id = $3`,
          [errorMsg, durationMs, runId],
        );
        console.debug(`[scheduler] run row failed run=${runId} durationMs=${durationMs}`);
      }

      // Update task status
      const nextRunAt = this.computeNextRun(task);
      const enabled = task.scheduleKind === 'once' ? false : task.enabled;
      await this.ctx.db.query(
        `UPDATE scheduled_tasks SET last_run_at = NOW(), last_run_status = 'failed',
         next_run_at = $1, enabled = $2, updated_at = NOW() WHERE id = $3`,
        [nextRunAt?.toISOString() ?? null, enabled, task.id],
      );
      console.debug(`[scheduler] task failure state updated task=${task.id} nextRun=${nextRunAt?.toISOString() ?? 'none'} enabled=${enabled}`);

      this.ctx.ws.broadcastAll({
        type: 'task.failed',
        taskId: task.id,
        runId,
        agentId: task.agentId,
        error: errorMsg,
      } satisfies WsServerMessage);
      this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);

      // Note: les erreurs ne sont plus poussées d'office sur Telegram. Le statut "failed"
      // remonte via task.failed (UI) ; un agent peut être chaîné si besoin de notification.
    } finally {
      this.running.delete(task.id);
      this.runningAgents.delete(task.agentId);
      this.activeRunContexts.delete(runId);
      this.liveRunIds.delete(runId);
      if (advisoryClient) {
        if (advisoryLockHeld) {
          await advisoryClient.query('SELECT pg_advisory_unlock(hashtext($1))', [task.id])
            .then(() => console.debug(`[scheduler] advisory lock released task=${task.id} run=${runId}`))
            .catch(err => console.warn(`[scheduler] advisory unlock failed task=${task.id}: ${err instanceof Error ? err.message : err}`));
        }
        advisoryClient.release();
      }
      // Flush any escalations queued during this watcher run. The watcher is now fully
      // idle (post-tool turn completed, state=idle), so the handler can take Mercury
      // without fighting for bandwidth. Dispatched async so finally can return.
      await this.flushPendingEscalations(runId, flushEscalations);
    }
  }

  /**
   * Flush escalations queued under `parentRunId` (drains pendingEscalations + deletes the key).
   * Called from executeTask's finally (watcher runs) AND the escalation dispatch's finally
   * (chained/grandchild escalations — without this, a handler that itself calls escalate_to_agent
   * would never have its child dispatched: the dispatch was queued under the handler's runId but
   * only executeTask used to flush, and handler runs don't go through executeTask).
   * ALWAYS dispatches the queued escalations async. By the time one sits in this queue it is
   * already COMMITTED (handler row inserted 'running', parent flagged escalated=true, a
   * `proactive.alert state=running` broadcast to clients) — so a parent that fails/aborts AFTER
   * queuing must NOT drop it (that silently loses a notification the system already decided to
   * send). `didComplete` only tags the log line; the handler is a different agent and runs
   * independently of the parent's tail.
   */
  private async flushPendingEscalations(parentRunId: string, didComplete: boolean): Promise<void> {
    const pending = this.pendingEscalations.get(parentRunId) ?? [];
    this.pendingEscalations.delete(parentRunId);
    if (!pending || pending.length === 0) return;
    // Always dispatch — see method doc. A parent that failed/aborted after queuing an escalation
    // (e.g. watcher's post-tool turn throws, or the watcher gets aborted by a fresh run dispatched
    // to its agent) must still hand off the already-committed escalation. Each dispatch's own
    // finally marks its row completed/failed and cleans up its run context, so nothing lingers.
    if (!didComplete) {
      console.warn(`[scheduler] run ${parentRunId} did not complete cleanly — dispatching ${pending.length} already-committed escalation(s) anyway (handler runs independently)`);
    } else {
      console.log(`[scheduler] flushing ${pending.length} queued escalation(s) after run ${parentRunId} finished`);
    }
    setImmediate(async () => {
      for (const { dispatch } of pending) {
        try {
          await dispatch();
        } catch (err) {
          console.error('[scheduler] queued escalation dispatch failed:', err instanceof Error ? err.message : String(err));
        }
      }
    });
  }

  // ── Cron helpers ────────────────────────────────────────────

  computeNextRun(task: Pick<ScheduledTask, 'scheduleKind' | 'scheduledAt' | 'cronExpression'>): Date | null {
    if (task.scheduleKind === 'once') {
      if (!task.scheduledAt) return null;
      const d = new Date(task.scheduledAt);
      return d > new Date() ? d : null;
    }
    if (!task.cronExpression) return null;
    try {
      const interval = CronExpressionParser.parse(task.cronExpression, { currentDate: new Date(), tz: 'Europe/Paris' });
      return interval.next().toDate();
    } catch {
      return null;
    }
  }

  /** Validate a cron expression — throws if invalid */
  validateCron(expression: string): void {
    CronExpressionParser.parse(expression, { tz: 'Europe/Paris' });
  }

  // ── Zombie cleanup ──────────────────────────────────────────

  private async cleanupZombieRuns(): Promise<void> {
    const res = await this.ctx.db.query(
      `UPDATE task_runs SET status = 'failed', error = 'Server restarted during execution', completed_at = NOW()
       WHERE status = 'running' RETURNING id`,
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`[scheduler] Cleaned up ${res.rowCount} zombie run(s)`);
    }
  }

  // ── CRUD ────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<ScheduledTask> {
    // Validate cron expression if provided
    if (input.cronExpression) {
      this.validateCron(input.cronExpression);
    }

    const kind: TaskKind = input.kind ?? 'task';
    if (kind === 'proactive') {
      if (!input.escalationAgentId) {
        throw new Error('proactive tasks require an escalationAgentId (handler agent)');
      }
      if (input.escalationAgentId === input.agentId) {
        throw new Error('escalationAgentId must differ from the watcher agentId');
      }
    }

    const id = generateId('task');
    const nextRunAt = this.computeNextRun({
      scheduleKind: input.scheduleKind,
      scheduledAt: input.scheduledAt,
      cronExpression: input.cronExpression,
    });

    const { rows } = await this.ctx.db.query<ScheduledTaskRow>(
      `INSERT INTO scheduled_tasks (id, name, agent_id, prompt, schedule_kind, scheduled_at, cron_expression, delete_after_run, created_by, next_run_at, kind, escalation_agent_id, severity_threshold, auto_deliver, delivery_channels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        id,
        input.name,
        input.agentId,
        input.prompt,
        input.scheduleKind,
        input.scheduledAt ?? null,
        input.cronExpression ?? null,
        input.deleteAfterRun ?? false,
        input.createdBy ?? 'user',
        nextRunAt?.toISOString() ?? null,
        kind,
        input.escalationAgentId ?? null,
        input.severityThreshold ?? 'medium',
        input.autoDeliver ?? true,
        input.deliveryChannels != null ? JSON.stringify(parseDeliveryChannels(input.deliveryChannels) ?? []) : null,
      ],
    );

    this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);
    console.log(`[scheduler] Created task "${input.name}" (${id}) kind=${kind}/${input.scheduleKind} nextRun=${nextRunAt?.toISOString() ?? 'none'}`);
    return rowToTask(rows[0]);
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    const { rows } = await this.ctx.db.query<ScheduledTaskRow>(
      `SELECT * FROM scheduled_tasks WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async listTasks(agentId?: string, kind?: TaskKind): Promise<ScheduledTask[]> {
    const conditions: string[] = ['deleted_at IS NULL'];
    const values: unknown[] = [];
    if (agentId) {
      values.push(agentId);
      conditions.push(`agent_id = $${values.length}`);
    }
    if (kind) {
      values.push(kind);
      conditions.push(`kind = $${values.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const { rows } = await this.ctx.db.query<ScheduledTaskRow>({
      text: `SELECT * FROM scheduled_tasks ${where} ORDER BY created_at DESC`,
      values,
    });
    return rows.map(rowToTask);
  }

  /** List soft-deleted tasks (corbeille). */
  async listDeletedTasks(): Promise<ScheduledTask[]> {
    const { rows } = await this.ctx.db.query<ScheduledTaskRow>(
      `SELECT * FROM scheduled_tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    );
    console.debug(`[scheduler] listDeletedTasks count=${rows.length}`);
    return rows.map(rowToTask);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<ScheduledTask | null> {
    const existing = await this.getTask(id);
    if (!existing) {
      console.warn(`[scheduler] updateTask not found id=${id}`);
      return null;
    }

    if (input.cronExpression) {
      this.validateCron(input.cronExpression);
    }

    const merged = { ...existing, ...input };

    if (merged.kind === 'proactive') {
      if (!merged.escalationAgentId) {
        throw new Error('proactive tasks require an escalationAgentId (handler agent)');
      }
      if (merged.escalationAgentId === merged.agentId) {
        throw new Error('escalationAgentId must differ from the watcher agentId');
      }
    }

    const nextRunAt = this.computeNextRun({
      scheduleKind: merged.scheduleKind,
      scheduledAt: merged.scheduledAt,
      cronExpression: merged.cronExpression,
    });

    const { rows } = await this.ctx.db.query<ScheduledTaskRow>(
      `UPDATE scheduled_tasks SET
         name = $1, prompt = $2, schedule_kind = $3, scheduled_at = $4,
         cron_expression = $5, enabled = $6, delete_after_run = $7,
         next_run_at = $8, kind = $9, escalation_agent_id = $10, severity_threshold = $11,
         auto_deliver = $12, delivery_channels = $13,
         updated_at = NOW()
       WHERE id = $14 RETURNING *`,
      [
        merged.name,
        merged.prompt,
        merged.scheduleKind,
        merged.scheduledAt ?? null,
        merged.cronExpression ?? null,
        merged.enabled,
        merged.deleteAfterRun,
        nextRunAt?.toISOString() ?? null,
        merged.kind,
        merged.escalationAgentId ?? null,
        merged.severityThreshold ?? 'medium',
        merged.autoDeliver ?? true,
        // `input.deliveryChannels === null` = retrait explicite de l'override (merged porte
        // alors null) ; undefined dans input = conserve l'existant via le merge.
        merged.deliveryChannels != null ? JSON.stringify(parseDeliveryChannels(merged.deliveryChannels) ?? []) : null,
        id,
      ],
    );

    this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);
    console.log(`[scheduler] Updated task "${merged.name}" (${id}) enabled=${merged.enabled} nextRun=${nextRunAt?.toISOString() ?? 'none'}`);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  /** Soft-delete: move task to corbeille (restorable). Disables scheduling immediately. */
  async deleteTask(id: string): Promise<boolean> {
    const res = await this.ctx.db.query(
      `UPDATE scheduled_tasks
         SET deleted_at = NOW(), enabled = false, next_run_at = NULL, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (res.rowCount && res.rowCount > 0) {
      this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);
      console.log(`[scheduler] Soft-deleted task ${id} (corbeille)`);
      return true;
    }
    console.warn(`[scheduler] deleteTask not found or already deleted id=${id}`);
    return false;
  }

  /** Restore a soft-deleted task. Recomputes next_run_at; leaves it disabled so the user re-enables intentionally. */
  async restoreTask(id: string): Promise<ScheduledTask | null> {
    const { rows: existing } = await this.ctx.db.query<ScheduledTaskRow>(
      `SELECT * FROM scheduled_tasks WHERE id = $1 AND deleted_at IS NOT NULL`,
      [id],
    );
    if (!existing[0]) {
      console.warn(`[scheduler] restoreTask not found or not deleted id=${id}`);
      return null;
    }
    const task = rowToTask(existing[0]);
    const nextRunAt = this.computeNextRun({
      scheduleKind: task.scheduleKind,
      scheduledAt: task.scheduledAt,
      cronExpression: task.cronExpression,
    });
    const { rows } = await this.ctx.db.query<ScheduledTaskRow>(
      `UPDATE scheduled_tasks
         SET deleted_at = NULL, next_run_at = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [nextRunAt?.toISOString() ?? null, id],
    );
    this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);
    console.log(`[scheduler] Restored task ${id} nextRun=${nextRunAt?.toISOString() ?? 'none'}`);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  /** Permanent delete from the corbeille. Only works on already-soft-deleted rows. */
  async purgeTask(id: string): Promise<boolean> {
    const res = await this.ctx.db.query(
      `DELETE FROM scheduled_tasks WHERE id = $1 AND deleted_at IS NOT NULL`,
      [id],
    );
    if (res.rowCount && res.rowCount > 0) {
      this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);
      console.log(`[scheduler] Purged task ${id} (permanent delete)`);
      return true;
    }
    console.warn(`[scheduler] purgeTask not found or not in corbeille id=${id}`);
    return false;
  }

  async toggleTask(id: string, enabled: boolean): Promise<ScheduledTask | null> {
    const task = await this.getTask(id);
    if (!task) {
      console.warn(`[scheduler] toggleTask not found id=${id}`);
      return null;
    }

    const nextRunAt = enabled ? this.computeNextRun(task) : null;
    const { rows } = await this.ctx.db.query<ScheduledTaskRow>(
      `UPDATE scheduled_tasks SET enabled = $1, next_run_at = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [enabled, nextRunAt?.toISOString() ?? null, id],
    );

    this.ctx.ws.broadcastAll({ type: 'tasks.updated' } satisfies WsServerMessage);
    console.log(`[scheduler] Toggled task ${id} enabled=${enabled} nextRun=${nextRunAt?.toISOString() ?? 'none'}`);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  /** Trigger immediate execution of a task (manual run) */
  async runNow(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    if (this.running.has(id)) throw new Error(`Task ${id} is already running`);
    // Per-agent guard: refuse to start if the agent is already running another scheduler
    // task — otherwise agentMod.run() would abort that in-flight run (agent/index.ts:980).
    if (this.runningAgents.has(task.agentId)) {
      throw new Error(`Agent ${task.agentId} is already running another scheduled task; try again shortly`);
    }
    this.running.add(id);
    this.runningAgents.add(task.agentId);
    console.log(`[scheduler] runNow requested task=${id} agent=${task.agentId}`);
    this.executeTask(task, true).catch(err =>
      console.error(`[scheduler] runNow ${id} error:`, err.message),
    );
  }

  async getTaskRuns(taskId: string, limit = 20): Promise<TaskRun[]> {
    const { rows } = await this.ctx.db.query<TaskRunRow>(
      `SELECT * FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [taskId, limit],
    );
    return rows.map(rowToRun);
  }

  async getRecentRuns(limit = 50): Promise<TaskRun[]> {
    const { rows } = await this.ctx.db.query<TaskRunRow>(
      `SELECT * FROM task_runs ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(rowToRun);
  }

  // ── Proactive helpers ──────────────────────────────────────

  /**
   * Create an escalation run in the background. Called by the `escalate_to_agent` tool
   * from within a proactive watcher run. Reuses the handler's most recent session so
   * the existing prompt cache is preserved (no reprocessing). Runs asynchronously —
   * the watcher does NOT wait for the handler to finish before returning control.
   *
   * Returns the new run id so the caller can thread it through task_runs.
   */
  async triggerEscalation(params: {
    parentRunId: string;
    watcherAgentId: string;
    watcherTaskId: string | null;
    handlerAgentId: string;
    summary: string;
    context?: string;
    severity: Severity;
  }): Promise<string> {
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const sessionMod = this.ctx.modules.get<SessionModule>('session');

    // Reuse handler's most recent session for prompt cache benefit
    const handlerSessions = await sessionMod.listByAgent(params.handlerAgentId);
    const handlerSessionId = handlerSessions.length > 0
      ? handlerSessions[0].id
      : `proactive-${params.handlerAgentId}-${Date.now()}`;
    if (handlerSessions.length === 0) {
      await sessionMod.getOrCreate(handlerSessionId, params.handlerAgentId);
      console.log(`[scheduler] triggerEscalation: created fresh session ${handlerSessionId} (handler had none)`);
    } else {
      console.log(`[scheduler] triggerEscalation: reusing session ${handlerSessionId} (cache preserved)`);
    }

    const runId = generateId('run');
    const handlerPrompt = this.buildHandlerPrompt(params.summary, params.context, params.severity);

    // Derive a human label for the escalation run so the history view shows what it
    // handled instead of "(supprimee)". Prefer the parent watcher's task name (makes the
    // trigger legible in the flat history list); fall back to the summary for ad-hoc
    // escalations (chat / push) whose parentRunId has no task_runs row.
    const { rows: parentRows } = await this.ctx.db.query<{ task_name: string | null }>(
      `SELECT task_name FROM task_runs WHERE id = $1`,
      [params.parentRunId],
    );
    const escalationName = (parentRows[0]?.task_name
      ? `↳ ${parentRows[0].task_name}`
      : `Escalade: ${params.summary}`).slice(0, 200);
    console.debug(`[scheduler] triggerEscalation: run=${runId} name="${escalationName}" parentRun=${params.parentRunId} parentNamed=${!!parentRows[0]?.task_name}`);

    // Insert escalation run row
    await this.ctx.db.query(
      `INSERT INTO task_runs (id, task_id, task_name, agent_id, session_id, status, prompt, started_at, kind, parent_run_id, severity)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, NOW(), 'escalation', $7, $8)`,
      [
        runId,
        params.watcherTaskId,
        escalationName,
        params.handlerAgentId,
        handlerSessionId,
        handlerPrompt,
        params.parentRunId,
        params.severity,
      ],
    );

    // Mark parent run as escalated
    await this.ctx.db.query(
      `UPDATE task_runs SET escalated = true, severity = $1 WHERE id = $2`,
      [params.severity, params.parentRunId],
    );

    // Broadcast alert — state='running'. Policy delivery.proactiveAlerts du handler :
    // 'quiet' = broadcast avec flag silent (carte sans toast), 'off' = pas de broadcast.
    const escAlertMode = agentMod.getAgent(params.handlerAgentId)?.delivery?.proactiveAlerts ?? 'all';
    if (escAlertMode !== 'off') {
      this.ctx.ws.broadcastAll({
        type: 'proactive.alert',
        runId,
        sourceTaskId: params.watcherTaskId,
        watcherAgentId: params.watcherAgentId,
        handlerAgentId: params.handlerAgentId,
        severity: params.severity,
        summary: params.summary,
        state: 'running',
        sessionId: handlerSessionId,
        ...(escAlertMode === 'quiet' ? { silent: true } : {}),
        timestamp: new Date().toISOString(),
      } satisfies WsServerMessage);
    }

    // Inherit autoDeliver from the parent watcher's run context (if scheduler-managed).
    // Ad-hoc escalations (chat-triggered, push alerts) have no parent context here →
    // remains undefined → run.ts defaults to true (legacy behaviour).
    const parentContext = this.activeRunContexts.get(params.parentRunId);
    const inheritedAutoDeliver = parentContext?.autoDeliver;
    // L'override de canaux suit la même règle d'héritage que autoDeliver : une tâche
    // épinglée "mobile seul" garde ce routage quand son watcher escalade vers un handler.
    const inheritedDeliveryChannels = parentContext?.deliveryChannels;

    // Register context for the handler run so send_to_user can match it back
    this.activeRunContexts.set(runId, {
      taskId: params.watcherTaskId,
      runId,
      kind: 'escalation',
      watcherAgentId: params.watcherAgentId,
      severityThreshold: 'low', // handler is unconstrained
      parentRunId: params.parentRunId,
      autoDeliver: inheritedAutoDeliver,
      ...(inheritedDeliveryChannels != null ? { deliveryChannels: inheritedDeliveryChannels } : {}),
    });

    // Build the dispatch closure but DON'T fire it yet. It will be flushed from
    // executeTask's finally block once the watcher has fully finished its own run
    // (including the post-tool turn that generates the final text). This avoids
    // Mercury GPU contention between the watcher's tail and the handler's head.
    const dispatch = async () => {
      const startTime = Date.now();
      let handlerCompleted = false;
      // Whether THIS dispatch acquired the runningAgents reservation for the handler.
      // Released in finally only if we acquired it, so we never free a slot a concurrent
      // scheduled task still holds (Set membership is shared with executeTask — H6).
      let reservedHandler = false;
      try {
        // Register THIS run as live only once it's actually executing (not while queued), paired
        // with the delete in this same finally — so a throw in triggerEscalation before the
        // dispatch is ever scheduled can't leak the id and permanently shield a stuck row.
        this.liveRunIds.add(runId);
        // Wait until the handler agent is free before claiming it. "Free" = idle AND not
        // reserved by a scheduled task (runningAgents). Polling getState() alone is NOT
        // enough: a scheduled task reserves runningAgents at dispatch (tick/runNow) but
        // agentMod only flips state→thinking once its run() actually starts, leaving a
        // window where getState()==='idle' yet a task is about to preempt. Honouring
        // runningAgents here closes that window symmetrically with the tick guard (which
        // defers a task whose agent is in runningAgents) — so a scheduled task and an
        // escalation handler for the SAME agent no longer preempt each other (audit
        // carry-over / the P3 noted at runningAgents' declaration). The handler agent
        // differs from the watcher (enforced at create/update), and this dispatch is
        // flushed AFTER the watcher released its own reservation, so no self-deadlock.
        let waited = 0;
        while (
          (agentMod.getState(params.handlerAgentId) !== 'idle' || this.runningAgents.has(params.handlerAgentId))
          && waited < 120_000
        ) {
          await new Promise(r => setTimeout(r, 5_000));
          waited += 5_000;
        }
        const stillBusy = agentMod.getState(params.handlerAgentId) !== 'idle' || this.runningAgents.has(params.handlerAgentId);
        if (stillBusy) {
          console.warn(`[scheduler] escalation ${runId}: handler ${params.handlerAgentId} still busy after 2min (state=${agentMod.getState(params.handlerAgentId)} reserved=${this.runningAgents.has(params.handlerAgentId)}), dispatching anyway`);
        }

        // Reserve the handler in runningAgents so a scheduled tick won't dispatch another
        // task to it mid-run (and abort us via agentMod.run()@980). Acquire only if free,
        // and remember whether WE acquired so the finally releases exactly our own claim.
        if (!this.runningAgents.has(params.handlerAgentId)) {
          this.runningAgents.add(params.handlerAgentId);
          reservedHandler = true;
        }

        console.log(`[scheduler] escalation ${runId}: dispatching handler=${params.handlerAgentId} session=${handlerSessionId}`);
        const result = await agentMod.run(
          params.handlerAgentId,
          handlerSessionId,
          handlerPrompt,
          'proactive',
          {
            activeRunId: runId,
            ...(inheritedAutoDeliver !== undefined ? { autoDeliver: inheritedAutoDeliver } : {}),
            ...(inheritedDeliveryChannels != null ? { deliveryChannels: inheritedDeliveryChannels } : {}),
          },
        );
        // Handler turn finished cleanly → any escalation it chained (queued under THIS runId)
        // is safe to flush. Mirrors executeTask setting flushEscalations after run() returns.
        handlerCompleted = true;

        const durationMs = Date.now() - startTime;
        await this.ctx.db.query(
          `UPDATE task_runs SET status = 'completed', result = $1, completed_at = NOW(), duration_ms = $2 WHERE id = $3`,
          [result.slice(0, 10_000), durationMs, runId],
        );

        // Broadcast final state — même gate policy que le state='running' ci-dessus.
        const doneAlertMode = agentMod.getAgent(params.handlerAgentId)?.delivery?.proactiveAlerts ?? 'all';
        if (doneAlertMode !== 'off') {
          this.ctx.ws.broadcastAll({
            type: 'proactive.alert',
            runId,
            sourceTaskId: params.watcherTaskId,
            watcherAgentId: params.watcherAgentId,
            handlerAgentId: params.handlerAgentId,
            severity: params.severity,
            summary: params.summary,
            state: 'done',
            sessionId: handlerSessionId,
            ...(doneAlertMode === 'quiet' ? { silent: true } : {}),
            timestamp: new Date().toISOString(),
          } satisfies WsServerMessage);
        }
        console.log(`[scheduler] escalation ${runId}: handler finished in ${durationMs}ms, ${result.length} chars`);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] escalation ${runId} failed:`, errorMsg);
        await this.ctx.db.query(
          `UPDATE task_runs SET status = 'failed', error = $1, completed_at = NOW(), duration_ms = $2 WHERE id = $3`,
          [errorMsg, durationMs, runId],
        );
      } finally {
        this.activeRunContexts.delete(runId);
        this.liveRunIds.delete(runId);
        // Release our handler reservation (only if WE acquired it) BEFORE flushing chained
        // escalations, so a grandchild handler doesn't wait on / skip past our own stale
        // claim. Symmetric with executeTask releasing runningAgents in its finally.
        if (reservedHandler) this.runningAgents.delete(params.handlerAgentId);
        // Flush escalations the handler itself chained (grandchild escalations queued under
        // this runId). Without this they'd never dispatch — only executeTask used to flush,
        // and handler runs don't go through executeTask → handoff lost + leaked run context.
        await this.flushPendingEscalations(runId, handlerCompleted);
      }
    };

    // If the parent run is a scheduler-managed run, queue the dispatch so it fires
    // AFTER the watcher finishes (avoids Mercury contention during the watcher's post-tool turn).
    // If it's an ad-hoc escalation (from chat, push alert, etc.), fire immediately via setImmediate
    // since there's no executeTask finally block to flush the queue.
    const isSchedulerRun = this.activeRunContexts.has(params.parentRunId);
    if (isSchedulerRun) {
      const queue = this.pendingEscalations.get(params.parentRunId) ?? [];
      queue.push({ runId, dispatch });
      this.pendingEscalations.set(params.parentRunId, queue);
      console.log(`[scheduler] escalation ${runId} queued for handler=${params.handlerAgentId} (waiting for watcher ${params.parentRunId} to finish)`);
    } else {
      console.log(`[scheduler] escalation ${runId} dispatching immediately for handler=${params.handlerAgentId} (ad-hoc, no scheduler run to wait for)`);
      setImmediate(() => dispatch().catch(err =>
        console.error(`[scheduler] ad-hoc escalation ${runId} failed:`, err instanceof Error ? err.message : String(err)),
      ));
    }

    return runId;
  }

  /** Mark an escalation run as delivered (called from send_to_user tool). */
  async markDelivered(runId: string): Promise<void> {
    await this.ctx.db.query(
      `UPDATE task_runs SET delivered = true WHERE id = $1`,
      [runId],
    );
  }

  private buildScheduledTaskPrompt(task: ScheduledTask): string {
    const fmtDate = (iso: string | Date) =>
      new Date(iso).toLocaleString('fr-FR', {
        timeZone: 'Europe/Paris',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    return [
      '[SCHEDULED_TASK]',
      `Task: ${task.name}`,
      `Scheduled at: ${fmtDate(task.createdAt)}`,
      `Executing now: ${fmtDate(new Date())}`,
      '---',
      'This is an automated task execution, not a user message.',
      'The prompt below was written at scheduling time — relative dates refer to that moment.',
      'Execute the task NOW. Do not re-schedule it. Do not greet or address the user conversationally.',
      '---',
      task.prompt,
    ].join('\n');
  }

  private buildHandlerPrompt(summary: string, context: string | undefined, severity: Severity): string {
    const lines: string[] = [
      `[ESCALADE PROACTIVE — severity=${severity}]`,
      '',
      `Un agent watcher a detecte quelque chose qui merite ton attention:`,
      '',
      summary,
    ];
    if (context) {
      lines.push('', 'Contexte detaille:', context);
    }
    lines.push(
      '',
      'Evalue si cela justifie d interrompre l utilisateur. Si oui, appelle send_to_user avec un message clair et actionnable.',
      'Si non, termine simplement ta reponse sans appeler send_to_user — rien ne sera affiche a l utilisateur.',
      'Important: ton raisonnement et le resultat brut de ce turn sont caches dans l historique chat.',
    );
    return lines.join('\n');
  }

  /** List recent proactive/escalation runs for the Proactive tab audit view. */
  async listAlerts(limit = 50): Promise<TaskRun[]> {
    const { rows } = await this.ctx.db.query<TaskRunRow>(
      `SELECT * FROM task_runs WHERE kind IN ('proactive', 'escalation') ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(rowToRun);
  }

  /** Mark an alert as acknowledged (user saw it in the UI). */
  async ackAlert(runId: string): Promise<boolean> {
    const res = await this.ctx.db.query(
      `UPDATE task_runs SET acknowledged_at = NOW() WHERE id = $1 AND acknowledged_at IS NULL`,
      [runId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

// ── Row types & mapping ────────────────────────────────────────

interface ScheduledTaskRow {
  id: string;
  name: string;
  agent_id: string;
  prompt: string;
  schedule_kind: string;
  scheduled_at: Date | null;
  cron_expression: string | null;
  enabled: boolean;
  delete_after_run: boolean;
  created_by: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_run_status: string | null;
  created_at: Date;
  updated_at: Date;
  kind: string;
  escalation_agent_id: string | null;
  severity_threshold: string | null;
  auto_deliver: boolean | null;
  /** JSONB array — pg renvoie déjà le tableau parsé ('["mobile"]' → ['mobile']). */
  delivery_channels: string[] | null;
  deleted_at: Date | null;
}

/** Filtre défensif des canaux JSONB (une row legacy/corrompue ne doit jamais jeter). */
function parseDeliveryChannels(raw: unknown): Array<'mobile' | 'telegram'> | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((v): v is 'mobile' | 'telegram' => v === 'mobile' || v === 'telegram');
  return out;
}

function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    prompt: row.prompt,
    scheduleKind: row.schedule_kind as ScheduledTask['scheduleKind'],
    scheduledAt: row.scheduled_at?.toISOString(),
    cronExpression: row.cron_expression ?? undefined,
    enabled: row.enabled,
    deleteAfterRun: row.delete_after_run,
    createdBy: row.created_by as ScheduledTask['createdBy'],
    nextRunAt: row.next_run_at?.toISOString(),
    lastRunAt: row.last_run_at?.toISOString(),
    lastRunStatus: row.last_run_status ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    kind: (row.kind as TaskKind | null) ?? 'task',
    escalationAgentId: row.escalation_agent_id ?? undefined,
    severityThreshold: (row.severity_threshold as Severity | null) ?? 'medium',
    autoDeliver: row.auto_deliver ?? true,
    deliveryChannels: parseDeliveryChannels(row.delivery_channels),
    deletedAt: row.deleted_at?.toISOString(),
  };
}

interface TaskRunRow {
  id: string;
  task_id: string | null;
  task_name: string | null;
  agent_id: string;
  session_id: string;
  status: string;
  prompt: string;
  result: string | null;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  kind: string | null;
  parent_run_id: string | null;
  severity: string | null;
  escalated: boolean | null;
  delivered: boolean | null;
  acknowledged_at: Date | null;
}

function rowToRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name ?? undefined,
    agentId: row.agent_id,
    sessionId: row.session_id,
    status: row.status as TaskRun['status'],
    prompt: row.prompt,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    durationMs: row.duration_ms ?? undefined,
    kind: (row.kind as TaskRunKind | null) ?? 'task',
    parentRunId: row.parent_run_id ?? undefined,
    severity: (row.severity as Severity | null) ?? undefined,
    escalated: row.escalated ?? false,
    delivered: row.delivered ?? false,
    acknowledgedAt: row.acknowledged_at?.toISOString(),
  };
}
