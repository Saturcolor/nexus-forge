import type { AgentConfig, DeliveryTrigger, MastermindConfig, MessageSource } from '@mastermind/shared';
import type { SchedulerModule } from '../../scheduler/index.js';
import type { SessionModule } from '../../session/index.js';
import type { TelegramModule } from '../../telegram/index.js';
import type { PushModule } from '../../push/index.js';
import type { WsManager } from '../../../ws.js';
import {
  executeDelivery,
  parseRequestedChannels,
  resolveAttachments,
  type ResolvedAttachment,
} from '../../delivery/index.js';
import { isUnifiedSessionId } from '../sessionResolve.js';

export interface SendOptions {
  sessionModule: SessionModule;
  telegramModule?: TelegramModule;
  /** Canal push mobile (APNs). Absent => mobile delivery indisponible. */
  pushModule?: PushModule;
  ws: WsManager;
  mastermindConfig: MastermindConfig;
  /** The agent doing the sending (for Telegram chatIds + workspace URL). */
  handlerAgentConfig: AgentConfig;
  /** Handler session id where the chat message is inserted. */
  sessionId: string;
  /** Absolute roots used to resolve attachment paths safely. */
  attachmentRoots?: { workspace: string; shared: string };
  /**
   * Scheduler module — required when `activeRunId` is set so the call can update the
   * run audit trail (markDelivered) and publish a `proactive.alert` event.
   */
  schedulerModule?: SchedulerModule;
  /**
   * If set, the call is part of a proactive/escalation run. `executeDelivery` transparently
   * broadcasts a `proactive.alert` and calls `scheduler.markDelivered` in that case.
   * When unset (normal chat), these side-effects are skipped.
   */
  activeRunId?: string;
  /**
   * Native source of the session — 'web' for UI chat, 'telegram' for Telegram-bridged
   * sessions. Used to tag the delivered message so it matches its neighbours in the
   * thread even when the current run has flipped to 'sandbox' or 'proactive'.
   */
  visibleSource?: MessageSource;
  /**
   * Override de canaux de réveil hérité de la tâche/source planifiée (configuré en UI).
   * Prioritaire sur la policy `delivery` de l'agent ET sur l'arg `channel` du LLM.
   */
  taskDeliveryChannels?: Array<'mobile' | 'telegram'>;
  /**
   * Type de run (v3) déterminant quels canaux la policy réveille en mode auto. Calculé par
   * l'appelant (tools/index.ts) via `runKindTrigger(source/proactivePhase/activeRunId/sandbox)`.
   *  - 'interactive' : l'utilisateur vient d'écrire (push presence-gated) — défaut si omis.
   *  - 'proactive' / 'task' / 'sandbox' : runs d'arrière-plan.
   * Un `channel` explicite du LLM (requested) reste prioritaire ; ce trigger ne pilote QUE
   * la résolution auto.
   */
  runTrigger?: DeliveryTrigger;
  /**
   * Mutable queue forwarded from `ToolExecOptions.pendingPostToolResult`. When provided,
   * the visible-content duplicate row (assistant message mirroring `args.content`) is
   * NOT persisted inline — it's deferred via this queue and run.ts persists it AFTER the
   * matching tool_result. This guarantees the next turn's history reads as
   * [assistant tool_call][tool_result][assistant duplicate] instead of inserting the
   * duplicate midstream and invalidating llama.cpp's KV-cache prefix.
   *
   * When unset (proactive runs without a tool dispatcher around them, tests, etc.),
   * delivery falls back to inline persistence via `deliverToChat` — same as before.
   */
  pendingPostToolResult?: Array<() => Promise<void>>;
}

/**
 * Deliver content + optional file attachments to the user — the single channel for any
 * agent-to-user message beyond the regular streaming reply.
 *
 * This is now a thin adapter over the central `executeDelivery` (modules/delivery) : it
 * parses the tool args, resolves attachments, and hands a normalized `DeliveryRequest`
 * (trigger 'explicit') to the orchestrator. The channel resolution, the chat/mobile/telegram
 * legs, the presence dedup, the Telegram fallback and the proactive audit side-effects all
 * live in one place — shared with the run.ts auto-deliver path.
 */
export async function executeSendToUser(
  args: Record<string, unknown>,
  opts: SendOptions,
): Promise<string> {
  const startedAt = Date.now();
  const content = String(args['content'] ?? '').trim();
  const subject = typeof args['subject'] === 'string' ? args['subject'] : undefined;
  const requested = parseRequestedChannels(args['channel']);
  const handlerAgentId = opts.handlerAgentConfig.identity.id;

  const rawAttachments = Array.isArray(args['attachments']) ? (args['attachments'] as unknown[]) : [];
  const attachmentSpecs = rawAttachments.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  if (!content && attachmentSpecs.length === 0) {
    console.warn(`[tool:send_to_user] rejected empty agent=${handlerAgentId} session=${opts.sessionId}`);
    return 'send_to_user: "content" or "attachments" is required.';
  }

  // Resolve attachment path specs (caller responsibility — executeDelivery takes resolved files).
  const preErrors: string[] = [];
  let resolved: ResolvedAttachment[] = [];
  if (attachmentSpecs.length > 0) {
    if (!opts.attachmentRoots) {
      console.warn(`[tool:send_to_user] attachments unavailable agent=${handlerAgentId} specs=${attachmentSpecs.length}`);
      return 'send_to_user: attachment support unavailable (missing path roots).';
    }
    const r = await resolveAttachments(attachmentSpecs, opts.attachmentRoots, handlerAgentId);
    resolved = r.resolved;
    preErrors.push(...r.errors.map(e => `attachment ${e}`));
    if (resolved.length === 0 && r.errors.length > 0) {
      console.warn(`[tool:send_to_user] all attachments failed agent=${handlerAgentId} errors=${r.errors.length}`);
      return `send_to_user: no attachments could be resolved — ${r.errors.join(' | ')}`;
    }
  }

  const runCtx = opts.activeRunId && opts.schedulerModule
    ? opts.schedulerModule.getRunContext(opts.activeRunId)
    : undefined;

  // v3 : le trigger encode le type de run (interactive/proactive/task/sandbox). Le LLM peut
  // toujours forcer un canal via `channel` (requested) — prioritaire sur la résolution auto.
  const trigger: DeliveryTrigger = opts.runTrigger ?? 'interactive';

  const result = await executeDelivery(
    {
      sessionId: opts.sessionId,
      handlerAgentConfig: opts.handlerAgentConfig,
      content,
      ...(subject ? { subject } : {}),
      attachments: resolved,
      trigger,
      requested,
      taskChannels: opts.taskDeliveryChannels ?? null,
      ...(opts.visibleSource ? { visibleSource: opts.visibleSource } : {}),
      isUnifiedSession: isUnifiedSessionId(handlerAgentId, opts.sessionId),
      ...(opts.activeRunId ? { activeRunId: opts.activeRunId } : {}),
      runContext: runCtx ? { taskId: runCtx.taskId, watcherAgentId: runCtx.watcherAgentId } : null,
      // La ligne chat est un DUPLICATE visible du content du tool_call : marquée pour que
      // buildLlmPayload la filtre de l'historique reconstruit (le LLM a déjà le content via
      // les args du tool_call) et pour que l'UI affiche le badge "envoyé · <canaux>".
      chatMetadata: {
        ...(opts.activeRunId ? { proactiveTrigger: opts.activeRunId } : {}),
        ...(subject ? { subject } : {}),
        delivered_via_send_to_user: true,
      },
      ...(opts.visibleSource ? { chatSource: opts.visibleSource } : {}),
      ...(opts.pendingPostToolResult ? { pendingPostToolResult: opts.pendingPostToolResult } : {}),
    },
    {
      sessionModule: opts.sessionModule,
      ...(opts.pushModule ? { pushModule: opts.pushModule } : {}),
      ...(opts.telegramModule ? { telegramModule: opts.telegramModule } : {}),
      ws: opts.ws,
      mastermindConfig: opts.mastermindConfig,
      ...(opts.schedulerModule ? { schedulerModule: opts.schedulerModule } : {}),
    },
  );

  const errors = [...preErrors, ...result.errors];
  const delivered = result.delivered;

  if (delivered.length === 0 && errors.length > 0) {
    console.warn(`[tool:send_to_user] failed agent=${handlerAgentId} errors=${errors.join(' | ')} ms=${Date.now() - startedAt}`);
    return `send_to_user failed: ${errors.join(' | ')}`;
  }
  const attachSuffix = resolved.length > 0 ? ` with ${resolved.length} attachment(s)` : '';
  const errSuffix = errors.length > 0 ? ` (partial failures: ${errors.join(' | ')})` : '';
  console.log(`[tool:send_to_user] done agent=${handlerAgentId} delivered=${delivered.join(',') || 'none'} attachments=${resolved.length} errors=${errors.length} ms=${Date.now() - startedAt}`);
  return `Sent to: ${delivered.join(', ')}${attachSuffix}${errSuffix}`;
}
