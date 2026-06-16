import type { Severity } from '@mastermind/shared';
import { meetsSeverity, type SchedulerModule } from '../../scheduler/index.js';

export interface EscalateOptions {
  schedulerModule: SchedulerModule;
  /** Run id when called from a scheduled proactive watcher. Undefined in chat / push / ad-hoc. */
  activeRunId?: string;
  /** Current agent id (caller). */
  watcherAgentId: string;
}

function normalizeSeverity(raw: unknown): Severity {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  return 'medium';
}

/**
 * Hand off a situation to another agent. Available from any context (chat, push, proactive).
 * In a scheduled proactive watcher run, the target is auto-resolved from the task config and
 * the severity threshold is enforced; outside that, target_agent_id must be passed explicitly.
 * Non-blocking: dispatches an asynchronous handler run via SchedulerModule.triggerEscalation
 * and returns immediately.
 */
export async function executeEscalateToAgent(
  args: Record<string, unknown>,
  opts: EscalateOptions,
): Promise<string> {
  const summary = String(args['summary'] ?? '').trim();
  const context = typeof args['context'] === 'string' ? args['context'] : undefined;
  const severity = normalizeSeverity(args['severity']);
  console.log(`[tool:escalate] start agent=${opts.watcherAgentId} run=${opts.activeRunId ?? '-'} severity=${severity} summaryLen=${summary.length} contextLen=${context?.length ?? 0}`);

  if (!summary) {
    console.warn(`[tool:escalate] rejected missing summary agent=${opts.watcherAgentId} run=${opts.activeRunId ?? '-'}`);
    return 'escalate_to_agent: "summary" is required.';
  }

  // Try to get run context (available during scheduled proactive runs).
  // If not available (chat, push-based alert, etc.), use the target_agent_id from args.
  const runCtx = opts.activeRunId ? opts.schedulerModule.getRunContext(opts.activeRunId) : undefined;
  console.debug(`[tool:escalate] context run=${opts.activeRunId ?? '-'} found=${!!runCtx} handler=${runCtx?.escalationAgentId ?? 'arg'} threshold=${runCtx?.severityThreshold ?? 'none'}`);

  // Severity threshold check (only when in a scheduled proactive run with a configured threshold).
  if (runCtx && !meetsSeverity(severity, runCtx.severityThreshold)) {
    console.log(`[tool:escalate] runId=${opts.activeRunId} severity=${severity} below threshold=${runCtx.severityThreshold} → skipped`);
    return `Not escalated: severity "${severity}" is below the task threshold "${runCtx.severityThreshold}". Logged for audit.`;
  }

  // Resolve the handler agent: from run context (scheduled proactive) or from explicit args.
  const handlerAgentId = runCtx?.escalationAgentId ?? (typeof args['target_agent_id'] === 'string' ? String(args['target_agent_id']).trim() : '');
  if (!handlerAgentId) {
    console.warn(`[tool:escalate] rejected no handler agent=${opts.watcherAgentId} run=${opts.activeRunId ?? '-'}`);
    return 'escalate_to_agent: no target agent. Either configure escalationAgentId on the proactive task, or pass target_agent_id explicitly.';
  }

  try {
    const startedAt = Date.now();
    const newRunId = await opts.schedulerModule.triggerEscalation({
      parentRunId: opts.activeRunId ?? `adhoc-${Date.now()}`,
      watcherAgentId: opts.watcherAgentId,
      watcherTaskId: runCtx?.taskId ?? null,
      handlerAgentId,
      summary,
      context,
      severity,
    });
    console.log(`[tool:escalate] success agent=${opts.watcherAgentId} handler=${handlerAgentId} parentRun=${opts.activeRunId ?? '-'} newRun=${newRunId} severity=${severity} ms=${Date.now() - startedAt}`);
    return `Escalated to "${handlerAgentId}" (run ${newRunId}, severity=${severity}). The handler will process this asynchronously and decide whether to notify the user.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tool:escalate] triggerEscalation failed:`, msg);
    return `escalate_to_agent failed: ${msg}`;
  }
}
