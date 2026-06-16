import { randomBytes } from 'node:crypto';
import type {
  Module,
  MastermindContext,
  WsServerMessage,
  ProactiveSource,
  ProactiveAlert,
  ProactiveIngestPayload,
  CreateSourceInput,
  UpdateSourceInput,
  Severity,
} from '@mastermind/shared';
import type { AgentModule } from '../agent/index.js';
import type { SessionModule } from '../session/index.js';
import type { SchedulerModule } from '../scheduler/index.js';

function genId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export class ProactiveSourceModule implements Module {
  name = 'proactive-source';
  private ctx!: MastermindContext;

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    // Auto-flush agent sessions older than 24h at startup
    await this.autoFlushStaleSessions();
    console.log('[proactive-source] Initialized');
  }

  /**
   * Flush messages older than 24h from sessions used by proactive source agents.
   * Called at startup and piggybacked on the scheduler tick (every 30s, but only
   * actually flushes once per hour to avoid hammering the DB).
   */
  private lastAutoFlush = 0;
  async autoFlushStaleSessions(): Promise<void> {
    // Guard: may be called by scheduler tick before this module is initialized
    if (!this.ctx) return;
    const now = Date.now();
    // Only run once per hour
    if (now - this.lastAutoFlush < 3600_000) return;
    this.lastAutoFlush = now;

    try {
      const sources = await this.listSources();
      const sessionMod = this.ctx.modules.get<SessionModule>('session');

      // Collect the shortest (most aggressive) retention per agent across all its sources.
      const agentRetention = new Map<string, number>();
      for (const source of sources) {
        if (!source.enabled || source.contextRetentionHours <= 0) continue;
        const current = agentRetention.get(source.agentId);
        if (current === undefined || source.contextRetentionHours < current) {
          agentRetention.set(source.agentId, source.contextRetentionHours);
        }
      }

      for (const [agentId, retentionHours] of agentRetention) {
        const sessions = await sessionMod.listByAgent(agentId);
        for (const session of sessions) {
          // Scope the flush to the proactive pipeline's own background-feed messages.
          // listByAgent returns ALL of the agent's sessions (no proactive/kind filter), and
          // proactive dispatch reuses the agent's most-recent session (which can be the
          // interactive chat session) — so prune ONLY agent-side background sources
          // ('proactive', 'sandbox', same set hidden from chat history via excludeProactive),
          // never human ('web'/'telegram') or human-facing ('subagent') messages. Otherwise a
          // single agent backing both an aggressive alert feed AND normal chat would have its
          // user conversation hard-deleted by the shortest source retention.
          const res = await this.ctx.db.query(
            `DELETE FROM messages
              WHERE session_id = $1
                AND source IN ('proactive', 'sandbox')
                AND created_at < NOW() - INTERVAL '1 hour' * $2`,
            [session.id, retentionHours],
          );
          const count = res.rowCount ?? 0;
          if (count > 0) {
            console.log(`[proactive-source] auto-flush: cleared ${count} proactive/sandbox messages older than ${retentionHours}h from session ${session.id} (agent=${agentId})`);
          }
        }
      }
    } catch (err) {
      console.warn('[proactive-source] auto-flush error:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Sources CRUD ───────────────────────────────────────────

  async createSource(input: CreateSourceInput): Promise<ProactiveSource> {
    const id = genId('src');
    const { rows } = await this.ctx.db.query<SourceRow>(
      `INSERT INTO proactive_sources (id, name, kind, enabled, agent_id, prompt, config, rate_limit_minutes, context_retention_hours, auto_deliver, delivery_channels)
       VALUES ($1, $2, 'webhook', true, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        id,
        input.name.trim(),
        input.agentId,
        input.prompt?.trim() ?? '',
        JSON.stringify(input.config ?? {}),
        input.rateLimitMinutes ?? 5,
        input.contextRetentionHours ?? 24,
        input.autoDeliver ?? true,
        input.deliveryChannels != null
          ? JSON.stringify(input.deliveryChannels.filter(v => v === 'mobile' || v === 'telegram'))
          : null,
      ],
    );
    console.log(`[proactive-source] created source ${id} "${input.name}" agent=${input.agentId}`);
    return rowToSource(rows[0]);
  }

  async listSources(): Promise<ProactiveSource[]> {
    const { rows } = await this.ctx.db.query<SourceRow>(
      `SELECT * FROM proactive_sources ORDER BY created_at DESC`,
    );
    return rows.map(rowToSource);
  }

  async getSource(id: string): Promise<ProactiveSource | null> {
    const { rows } = await this.ctx.db.query<SourceRow>(
      `SELECT * FROM proactive_sources WHERE id = $1`, [id],
    );
    return rows[0] ? rowToSource(rows[0]) : null;
  }

  async updateSource(id: string, input: UpdateSourceInput): Promise<ProactiveSource | null> {
    const existing = await this.getSource(id);
    if (!existing) return null;

    const name = input.name ?? existing.name;
    const enabled = input.enabled ?? existing.enabled;
    const agentId = input.agentId ?? existing.agentId;
    const prompt = input.prompt ?? existing.prompt;
    const config = input.config ?? existing.config;
    const rateLimitMinutes = input.rateLimitMinutes ?? existing.rateLimitMinutes;
    const contextRetentionHours = input.contextRetentionHours ?? existing.contextRetentionHours;
    const autoDeliver = input.autoDeliver ?? existing.autoDeliver;
    // undefined = conserve l'existant ; null explicite = retire l'override ; array = remplace.
    const deliveryChannels = input.deliveryChannels === undefined
      ? (existing.deliveryChannels ?? null)
      : input.deliveryChannels;

    const { rows } = await this.ctx.db.query<SourceRow>(
      `UPDATE proactive_sources SET name=$1, enabled=$2, agent_id=$3, prompt=$4, config=$5, rate_limit_minutes=$6, context_retention_hours=$7, auto_deliver=$8, delivery_channels=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [name, enabled, agentId, prompt, JSON.stringify(config), rateLimitMinutes, contextRetentionHours, autoDeliver, deliveryChannels != null ? JSON.stringify(deliveryChannels.filter(v => v === 'mobile' || v === 'telegram')) : null, id],
    );
    return rows[0] ? rowToSource(rows[0]) : null;
  }

  async deleteSource(id: string): Promise<boolean> {
    const res = await this.ctx.db.query(`DELETE FROM proactive_sources WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async toggleSource(id: string, enabled: boolean): Promise<ProactiveSource | null> {
    const { rows } = await this.ctx.db.query<SourceRow>(
      `UPDATE proactive_sources SET enabled=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [enabled, id],
    );
    return rows[0] ? rowToSource(rows[0]) : null;
  }

  // ── Alerts history ─────────────────────────────────────────

  async listAlerts(sourceId?: string, limit = 50): Promise<ProactiveAlert[]> {
    const where = sourceId ? `WHERE source_id = $1` : '';
    const params = sourceId ? [sourceId, limit] : [limit];
    const limitIdx = sourceId ? '$2' : '$1';
    const { rows } = await this.ctx.db.query<AlertRow>(
      `SELECT * FROM proactive_alerts ${where} ORDER BY created_at DESC LIMIT ${limitIdx}`,
      params,
    );
    return rows.map(rowToAlert);
  }

  // ── Webhook ingest ─────────────────────────────────────────

  /**
   * Called by the webhook route when an external app pushes an alert.
   * Validates the source, applies rate-limit, logs the alert, and dispatches
   * an agent run if the source is enabled and not rate-limited.
   */
  async ingest(payload: ProactiveIngestPayload): Promise<{
    accepted: boolean;
    reason?: string;
    alertId?: string;
  }> {
    const source = await this.getSource(payload.source);
    if (!source) {
      return { accepted: false, reason: `source "${payload.source}" not found` };
    }
    if (!source.enabled) {
      return { accepted: false, reason: `source "${payload.source}" is disabled` };
    }

    const severity: Severity = (['low', 'medium', 'high'].includes(payload.severity)
      ? payload.severity : 'medium') as Severity;
    const state = payload.state === 'resolved' ? 'resolved' : 'triggered';

    // Rate-limit claim: atomic check-and-set to avoid a check-then-act TOCTOU.
    // rateLimitMinutes = 0 means no server-side rate-limit (emitter handles its own debounce);
    // in that case the condition is always satisfied and the claim always succeeds.
    // Otherwise we conditionally bump last_alert_at = NOW() ONLY if the cooldown has elapsed,
    // evaluated against the committed row (not the stale snapshot read at the top). Two
    // concurrent webhooks for the same source race on this single statement: exactly one
    // takes the row (rowCount=1) and proceeds to insert+dispatch; the loser sees rowCount=0
    // and is rejected, so the cooldown can no longer be bypassed under burst.
    const claim = await this.ctx.db.query(
      `UPDATE proactive_sources
          SET last_alert_at = NOW()
        WHERE id = $1
          AND (rate_limit_minutes = 0
               OR last_alert_at IS NULL
               OR last_alert_at < NOW() - INTERVAL '1 minute' * rate_limit_minutes)
      RETURNING id`,
      [source.id],
    );
    if ((claim.rowCount ?? 0) === 0) {
      // Lost the claim: the cooldown is still active (re-derive remaining from the freshest
      // last_alert_at for the log/response; best-effort, the rejection itself is authoritative).
      let remaining = source.rateLimitMinutes * 60;
      if (source.lastAlertAt) {
        const elapsed = Date.now() - new Date(source.lastAlertAt).getTime();
        remaining = Math.max(1, Math.ceil((source.rateLimitMinutes * 60_000 - elapsed) / 1000));
      }
      console.debug(`[proactive-source] rate-limited source=${source.name} remaining=~${remaining}s`);
      return { accepted: false, reason: `rate-limited: ~${remaining}s remaining (cooldown ${source.rateLimitMinutes}min)` };
    }

    // Insert alert log
    const alertId = genId('pa');
    await this.ctx.db.query(
      `INSERT INTO proactive_alerts (id, source_id, severity, title, message, metric, value, threshold, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        alertId,
        source.id,
        severity,
        payload.title.slice(0, 200),
        payload.message.slice(0, 2000),
        payload.metric ?? null,
        payload.value ?? null,
        payload.threshold ?? null,
        state,
      ],
    );

    // (last_alert_at was already claimed atomically above, before the cooldown decision.)

    // Dispatch agent run
    try {
      const runId = await this.dispatchToAgent(source, payload, severity, state, alertId);
      await this.ctx.db.query(
        `UPDATE proactive_alerts SET dispatched = true, run_id = $1 WHERE id = $2`,
        [runId, alertId],
      );
      console.log(`[proactive-source] alert ${alertId} dispatched to agent ${source.agentId} run=${runId}`);
      return { accepted: true, alertId };
    } catch (err) {
      console.error(`[proactive-source] dispatch failed for alert ${alertId}:`, err instanceof Error ? err.message : String(err));
      return { accepted: true, reason: `dispatch failed: ${err instanceof Error ? err.message : String(err)}`, alertId };
    }
  }

  // ── Agent dispatch ─────────────────────────────────────────

  private async dispatchToAgent(
    source: ProactiveSource,
    payload: ProactiveIngestPayload,
    severity: Severity,
    state: string,
    alertId: string,
  ): Promise<string> {
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const sessionMod = this.ctx.modules.get<SessionModule>('session');

    // Reuse the agent's most recent session for cache benefit
    const sessions = await sessionMod.listByAgent(source.agentId);
    const sessionId = sessions.length > 0
      ? sessions[0].id
      : `proactive-${source.id}-${Date.now()}`;
    if (sessions.length === 0) {
      await sessionMod.getOrCreate(sessionId, source.agentId);
    }

    // Build prompt for the agent — custom source prompt + structured alert data
    const stateLabel = state === 'resolved' ? 'RESOLU' : 'DECLENCHEE';
    const lines: string[] = [];

    // Prepend custom source instructions if defined
    if (source.prompt.trim()) {
      lines.push(source.prompt.trim(), '', '---', '');
    }

    lines.push(
      `[ALERTE PROACTIVE — ${stateLabel} — severity=${severity}]`,
      `Source: ${source.name} (${source.id})`,
      '',
      `**${payload.title}**`,
      '',
      payload.message,
    );
    if (payload.metric) lines.push('', `Metrique: ${payload.metric} = ${payload.value ?? '?'} (seuil: ${payload.threshold ?? '?'})`);
    if (state === 'resolved') {
      lines.push('', 'L\'alerte est resolue — la metrique est revenue sous le seuil. Notifie l\'utilisateur si pertinent.');
    } else if (!source.prompt.trim()) {
      // Only add generic instructions if no custom prompt is set
      lines.push(
        '',
        'Evalue cette alerte et decide si elle merite d\'interrompre l\'utilisateur.',
        'Si oui, appelle send_to_user avec un message clair. Si non, termine silencieusement.',
        'Tu peux aussi appeler escalate_to_agent si tu estimes qu\'un autre agent doit traiter.',
      );
    }

    const prompt = lines.join('\n');

    // Create a task_run row for audit
    const runId = genId('run');
    await this.ctx.db.query(
      `INSERT INTO task_runs (id, task_id, task_name, agent_id, session_id, status, prompt, started_at, kind)
       VALUES ($1, NULL, $2, $3, $4, 'running', $5, NOW(), 'proactive')`,
      [runId, `[${source.name}] ${payload.title}`.slice(0, 200), source.agentId, sessionId, prompt],
    );

    // Fire-and-forget: dispatch the agent run asynchronously
    const startTime = Date.now();
    setImmediate(async () => {
      const schedulerMod = this.ctx.modules.get<SchedulerModule>('scheduler');
      // Whether THIS dispatch acquired the agent reservation (release exactly our own claim).
      let reservedAgent = false;
      try {
        // Mark live so the periodic zombie sweep won't false-fail a long alert run — inside the
        // try so it always pairs with markRunDone in the finally (no leak if anything below throws).
        schedulerMod.markRunLive(runId);
        // Wait until the agent is FREE — idle AND not reserved by a scheduled task / escalation.
        // Consulting runningAgents (not just getState) closes the TOCTOU where a scheduled tick
        // reserved the agent but agentMod hasn't flipped state→thinking yet. Mirrors the escalation
        // dispatch gate so a webhook alert and a scheduled run for the same agent queue instead of
        // aborting each other (agentMod.run aborts any in-flight run for the agent).
        let waited = 0;
        while (
          (agentMod.getState(source.agentId) !== 'idle' || schedulerMod.isAgentReserved(source.agentId))
          && waited < 120_000
        ) {
          await new Promise(r => setTimeout(r, 5_000));
          waited += 5_000;
        }
        // Reserve iff free; if still busy after 2min we dispatch anyway (alert must eventually
        // fire) — reservedAgent stays false so finally never frees someone else's claim.
        reservedAgent = schedulerMod.reserveAgent(source.agentId);
        if (!reservedAgent) {
          console.warn(`[proactive-source] agent ${source.agentId} still busy after 2min — dispatching alert ${runId} anyway (may preempt an in-flight run)`);
        }

        const result = await agentMod.run(source.agentId, sessionId, prompt, 'proactive', {
          activeRunId: runId,
          autoDeliver: source.autoDeliver,
          ...(source.deliveryChannels != null ? { deliveryChannels: source.deliveryChannels } : {}),
        });

        const durationMs = Date.now() - startTime;
        await this.ctx.db.query(
          `UPDATE task_runs SET status='completed', result=$1, completed_at=NOW(), duration_ms=$2 WHERE id=$3`,
          [result.slice(0, 10_000), durationMs, runId],
        );
      } catch (err) {
        const durationMs = Date.now() - startTime;
        await this.ctx.db.query(
          `UPDATE task_runs SET status='failed', error=$1, completed_at=NOW(), duration_ms=$2 WHERE id=$3`,
          [err instanceof Error ? err.message : String(err), durationMs, runId],
        );
      } finally {
        schedulerMod.markRunDone(runId);
        if (reservedAgent) schedulerMod.releaseAgent(source.agentId);
      }
    });

    return runId;
  }
}

// ── Row types ────────────────────────────────────────────────

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  agent_id: string;
  prompt: string;
  config: Record<string, unknown>;
  rate_limit_minutes: number;
  context_retention_hours: number;
  auto_deliver: boolean | null;
  /** JSONB array — pg renvoie le tableau parsé. */
  delivery_channels: string[] | null;
  last_alert_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToSource(row: SourceRow): ProactiveSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as 'webhook',
    enabled: row.enabled,
    agentId: row.agent_id,
    prompt: row.prompt ?? '',
    config: row.config ?? {},
    rateLimitMinutes: row.rate_limit_minutes,
    contextRetentionHours: row.context_retention_hours ?? 24,
    autoDeliver: row.auto_deliver ?? true,
    deliveryChannels: Array.isArray(row.delivery_channels)
      ? row.delivery_channels.filter((v): v is 'mobile' | 'telegram' => v === 'mobile' || v === 'telegram')
      : null,
    lastAlertAt: row.last_alert_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface AlertRow {
  id: string;
  source_id: string;
  severity: string;
  title: string;
  message: string;
  metric: string | null;
  value: number | null;
  threshold: number | null;
  state: string;
  dispatched: boolean;
  run_id: string | null;
  created_at: Date;
}

function rowToAlert(row: AlertRow): ProactiveAlert {
  return {
    id: row.id,
    sourceId: row.source_id,
    severity: row.severity as Severity,
    title: row.title,
    message: row.message,
    metric: row.metric ?? undefined,
    value: row.value ?? undefined,
    threshold: row.threshold ?? undefined,
    state: row.state as 'triggered' | 'resolved',
    dispatched: row.dispatched,
    runId: row.run_id ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}
