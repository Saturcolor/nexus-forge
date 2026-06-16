import type {
  AgentConfig,
  DeliveryTrigger,
  DeliveryWakeChannel,
  MastermindConfig,
  MessageSource,
  WsServerMessage,
} from '@mastermind/shared';
import type { SessionModule } from '../session/index.js';
import type { TelegramModule } from '../telegram/index.js';
import type { PushModule } from '../push/index.js';
import type { SchedulerModule } from '../scheduler/index.js';
import type { WsManager } from '../../ws.js';
import { primaryTelegramChatId } from '../agent/sessionResolve.js';
import {
  deliverToChat,
  deliverToMobile,
  deliverToTelegram,
  type ResolvedAttachment,
} from './channels.js';
import {
  resolveDelivery,
  type RequestedChannels,
  type ResolvedDelivery,
} from './resolve.js';

/**
 * delivery/index — orchestrateur UNIQUE de livraison agent→utilisateur.
 *
 * Avant ce module, la séquence "ligne chat + leg mobile (presence) + leg Telegram
 * (direct/fallback) + audit proactif" était réécrite à l'identique dans send_to_user ET
 * dans l'auto-deliver proactif de run.ts (+ deux filets bricolés). `executeDelivery` la
 * porte une fois pour toutes : les appelants construisent un `DeliveryRequest` (le POURQUOI
 * de la livraison) et ce module décide (via resolve) + exécute (via channels) de façon
 * cohérente. Un seul endroit à toucher pour faire évoluer la presence, le fallback, l'audit.
 */

export type {
  RequestedChannels,
  ResolvedDelivery,
  ResolveDeliveryParams,
  DeliveryChannel,
} from './resolve.js';
export { resolveDelivery, parseRequestedChannels } from './resolve.js';
export { normalizeDeliveryPolicy } from './policy.js';
export {
  deliverToChat,
  deliverToMobile,
  deliverToTelegram,
  resolveAttachments,
  escapeHtml,
  type ResolvedAttachment,
  type DeliverChatOptions,
  type DeliverTelegramOptions,
  type DeliverMobileOptions,
  type TelegramDeliveryResult,
  type MobileDeliveryResult,
} from './channels.js';

/**
 * Mappe le « runKind » (sources/flags du run en cours) vers le `DeliveryTrigger` v3 que la
 * policy comprend. Source unique de vérité partagée par tous les chemins de livraison (send.ts,
 * filets run.ts). Priorité : sandbox > proactif > tâche cron > interactif.
 *  - `sandboxJobId` présent → 'sandbox' (job async dispatché).
 *  - `source === 'proactive'` → 'proactive' (handler proactif/escalade ; les watchers ne livrent pas).
 *  - `activeRunId` présent SANS être proactif → 'task' (cron kind='task', source 'web').
 *  - sinon → 'interactive' (l'utilisateur vient d'écrire ; le push est presence-gated).
 */
export function runKindTrigger(k: {
  source?: MessageSource;
  proactivePhase?: 'watcher' | 'handler';
  activeRunId?: string | null;
  sandboxJobId?: string | null;
}): DeliveryTrigger {
  if (k.sandboxJobId) return 'sandbox';
  if (k.source === 'proactive') return 'proactive';
  if (k.activeRunId) return 'task';
  return 'interactive';
}

export interface DeliveryDeps {
  sessionModule: SessionModule;
  pushModule?: PushModule;
  telegramModule?: TelegramModule;
  ws: WsManager;
  /** Requis pour le leg Telegram. Absent => leg Telegram ignoré (best-effort). */
  mastermindConfig?: MastermindConfig;
  /** Requis pour l'audit proactif (markDelivered) quand `activeRunId` est fourni. */
  schedulerModule?: SchedulerModule;
}

export interface DeliveryRequest {
  sessionId: string;
  handlerAgentConfig: AgentConfig;
  content: string;
  subject?: string;
  attachments?: ResolvedAttachment[];
  /**
   * Type de run qui déclenche cette livraison (v3). Calculé en amont via `runKindTrigger`
   * (ou 'interactive' pour un send_to_user en chat). Pilote la résolution des canaux ET
   * l'audit proactif (markDelivered + proactive.alert quand activeRunId est fourni).
   */
  trigger: DeliveryTrigger;
  /** Souhait du LLM (send_to_user). `{ kind:'auto' }` pour les auto-deliver/filets. */
  requested: RequestedChannels;
  /** Override de canaux hérité de la tâche/source planifiée (UI). Prioritaire sur tout. */
  taskChannels?: DeliveryWakeChannel[] | null;
  /** Tag de source de la session (web/telegram). PUR tag — plus de routage caché ici. */
  visibleSource?: MessageSource;
  /** Session unifiée `{agent}-unified` → push TG restreint au DM owner (groupes isolés). */
  isUnifiedSession?: boolean;
  /** Run proactif/escalade actif — déclenche markDelivered + broadcast `proactive.alert`. */
  activeRunId?: string;
  /** Contexte du run (taskId / watcherAgentId) pour la carte `proactive.alert`. */
  runContext?: { taskId?: string | null; watcherAgentId?: string | null } | null;
  /**
   * Persiste la ligne chat visible. true par défaut. Les filets dont la réponse est DÉJÀ
   * persistée par le run normal (TG-native, push interactif) passent `false`.
   */
  persistChat?: boolean;
  /** Métadonnées extra de la ligne chat (delivered_via_send_to_user, proactive_autodeliver…). */
  chatMetadata?: Record<string, unknown>;
  /** Source pour la persistance chat (défaut = visibleSource). */
  chatSource?: MessageSource;
  /**
   * Supprime le leg Telegram DIRECT. Utilisé par l'auto-deliver proactif (D) sur une session
   * TG-native, où le leg Telegram est assuré par le filet TG-native dédié (E) — évite un
   * double envoi. D et E se coordonnent via ce flag (D skip TG, E livre TG).
   */
  skipTelegram?: boolean;
  /**
   * Supprime le leg MOBILE (symétrique de skipTelegram). En session unifiée + TG-fallback, D et
   * E s'exécutent tous deux : D porte le leg mobile, E ne fait QUE le leg Telegram → E passe
   * `skipMobile:true` pour éviter un 2e push APNs identique (bug hunt 2026-06-13).
   */
  skipMobile?: boolean;
  /**
   * File différée (ToolExecOptions.pendingPostToolResult) : la ligne chat est posée APRÈS le
   * tool_result correspondant (hygiène KV-cache). Absent = persistance inline.
   */
  pendingPostToolResult?: Array<() => Promise<void>>;
}

export interface DeliveryResult {
  delivered: Array<'chat' | 'telegram' | 'mobile'>;
  errors: string[];
  routing: ResolvedDelivery;
}

/**
 * Exécute une livraison de bout en bout : résolution des canaux → ligne chat (source de
 * vérité) → leg mobile (presence-gated) → leg Telegram (direct ou fallback mobile-injoignable)
 * → side-effects d'audit proactif. Best-effort par leg : un canal qui échoue n'empêche pas
 * les autres. Ne throw jamais ; les erreurs partielles sont remontées dans `result.errors`.
 */
export async function executeDelivery(req: DeliveryRequest, deps: DeliveryDeps): Promise<DeliveryResult> {
  const handlerAgentId = req.handlerAgentConfig.identity.id;
  const attachments = req.attachments ?? [];
  const { content, subject } = req;

  // v3 : le trigger est calculé en amont (runKindTrigger) et passé tel quel à resolveDelivery.
  const routing = resolveDelivery({
    requested: req.requested,
    taskChannels: req.taskChannels ?? null,
    policy: req.handlerAgentConfig.delivery,
    trigger: req.trigger,
    visibleSource: req.visibleSource,
  });

  console.log(
    `[delivery] start agent=${handlerAgentId} session=${req.sessionId} trigger=${req.trigger} ` +
    `requested=${req.requested.kind === 'set' ? req.requested.raw : 'auto'} ` +
    `resolved=[${[...routing.wake].join(',') || 'chat-only'}] origin=${routing.origin}${routing.rescued ? '(rescued)' : ''} ` +
    `tgFallback=${routing.telegramFallback} presenceDedup=${routing.presenceDedup} ` +
    `contentLen=${content.length} attachments=${attachments.length} activeRun=${req.activeRunId ?? 'none'}`,
  );

  const errors: string[] = [];
  const delivered: Array<'chat' | 'telegram' | 'mobile'> = [];

  // ── Ligne chat (source de vérité) ──
  // FIX delivered_channels : la closure lit `delivered` à l'EXÉCUTION. Sur le chemin DIFFÉRÉ
  // (pendingPostToolResult) elle tourne après les legs → liste complète. Sur le chemin INLINE,
  // on ne l'exécute QU'APRÈS les legs mobile/telegram (drainChat() en fin de fonction) pour la
  // même raison — avant ce fix l'inline persistait `delivered_channels: []` systématiquement.
  let drainChat: (() => Promise<void>) | null = null;
  if (req.persistChat !== false) {
    const chatSource = req.chatSource ?? req.visibleSource;
    const deliverFn = async (): Promise<void> => {
      await deliverToChat({
        sessionModule: deps.sessionModule,
        ws: deps.ws,
        sessionId: req.sessionId,
        content,
        attachments,
        ...(chatSource ? { source: chatSource } : {}),
        extraMetadata: {
          ...(req.chatMetadata ?? {}),
          delivered_channels: delivered.filter(c => c !== 'chat'),
        },
      });
    };
    if (req.pendingPostToolResult) {
      req.pendingPostToolResult.push(async () => {
        try { await deliverFn(); }
        catch (err) { console.warn(`[delivery] deferred chat delivery failed session=${req.sessionId}: ${err instanceof Error ? err.message : err}`); }
      });
      delivered.push('chat');
    } else {
      // Différé localement jusqu'après les legs (cf. drainChat() ci-dessous).
      drainChat = async () => {
        try { await deliverFn(); delivered.push('chat'); }
        catch (err) {
          console.warn(`[delivery] chat delivery failed session=${req.sessionId}: ${err instanceof Error ? err.message : err}`);
          errors.push(`chat: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
    }
  }

  // ── Leg MOBILE d'abord (le fallback Telegram dépend de son résultat) ──
  // `mobileReached` = quelqu'un a eu l'info côté mobile : push livré OU supprimé par presence
  // dedup (un client regarde déjà). Dans les deux cas le fallback TG n'a pas à sonner.
  let mobileAttempted = false;
  let mobileReached = false;
  if (!req.skipMobile && routing.wake.has('mobile')) {
    // Intention enregistrée AVANT le gate pushMod : push absent/désactivé = "tenté mais
    // injoignable" → le fallback TG doit pouvoir prendre le relais.
    mobileAttempted = true;
    // Presence dedup basée sur le VIEWING réel (premier plan + écran chat), pas l'abonnement —
    // un tel verrouillé/onglet en fond ne supprime plus le réveil (fix bug de livraison du briefing).
    // Un trigger 'interactive' est TOUJOURS presence-gaté (indépendamment de presenceDedup) : par
    // définition l'utilisateur vient d'écrire et la réponse streame sous ses yeux → on ne sonne le
    // tel QUE s'il est absent (viewers===0). Sans ce gate forcé, un send_to_user(auto) en pleine
    // conversation web réveillait le mobile (régression 2026-06-12 réintroduite, bug hunt 2026-06-13).
    const presenceGate = routing.presenceDedup || req.trigger === 'interactive';
    const watchers = presenceGate ? deps.ws.hasSessionViewers(req.sessionId) : 0;
    if (watchers > 0) {
      console.log(`[delivery] mobile push suppressed (presence dedup, ${watchers} client(s)) agent=${handlerAgentId} session=${req.sessionId}`);
      mobileReached = true;
    } else if (deps.pushModule?.isEnabled()) {
      try {
        const r = await deliverToMobile({ pushModule: deps.pushModule, content, subject, sessionId: req.sessionId, agentId: handlerAgentId });
        errors.push(...r.errors.map(e => `mobile ${e}`));
        if (r.deliveredCount > 0) { delivered.push('mobile'); mobileReached = true; }
        else { errors.push('mobile: no device reached (none registered or all failed)'); }
      } catch (err) {
        console.warn(`[delivery] mobile delivery failed agent=${handlerAgentId}: ${err instanceof Error ? err.message : err}`);
        errors.push(`mobile: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Leg TELEGRAM : direct (wake) ou fallback (mobile injoignable) ──
  const telegramDirect = !req.skipTelegram && routing.wake.has('telegram');
  const telegramViaFallback = routing.telegramFallback && mobileAttempted && !mobileReached;
  if ((telegramDirect || telegramViaFallback) && deps.mastermindConfig) {
    // FIX primaryChatId undefined → blast : en session unifiée on RESTREINT au DM owner. Si le
    // primaryChatId est undefined (agent unifié sans owner résolu), on NE livre PAS aux groupes
    // (un targetChatId undefined spreadé ferait sauter le filtre → blast tous les chatIds). On
    // ne spread `targetChatId` QUE quand il est défini ; en unifié sans pid, on skip le leg TG.
    const pid = req.isUnifiedSession ? primaryTelegramChatId(req.handlerAgentConfig) : undefined;
    if (req.isUnifiedSession && pid === undefined) {
      console.warn(`[delivery] telegram leg skipped (unified session without resolvable primaryChatId) agent=${handlerAgentId} session=${req.sessionId}`);
    } else {
      try {
        const telegramResult = await deliverToTelegram({
          telegramModule: deps.telegramModule,
          mastermindConfig: deps.mastermindConfig,
          handlerAgentConfig: req.handlerAgentConfig,
          content,
          attachments,
          ...(subject ? { subject } : {}),
          ...(pid !== undefined ? { targetChatId: pid } : {}),
        });
        errors.push(...telegramResult.errors.map(e => `telegram ${e}`));
        if (telegramResult.deliveredCount > 0) delivered.push('telegram');
        else errors.push('telegram: no message or attachment was delivered');
      } catch (err) {
        console.warn(`[delivery] telegram delivery failed agent=${handlerAgentId} (${telegramDirect ? 'direct' : 'fallback'}): ${err instanceof Error ? err.message : err}`);
        errors.push(`telegram: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Ligne chat INLINE : persistée APRÈS les legs (delivered_channels complet). ──
  if (drainChat) await drainChat();

  // ── Audit proactif (auto quand activeRunId est fourni) ──
  // markDelivered + broadcast proactive.alert sont déclenchés UNIQUEMENT après que la ligne chat
  // soit (ou sera) committée :
  //  - chemin INLINE : drainChat() ci-dessus a déjà committé → on émet directement ;
  //  - chemin DIFFÉRÉ (pendingPostToolResult) : la ligne chat est committée plus tard par run.ts ;
  //    on POUSSE l'audit en queue APRÈS la closure chat pour éviter la race "client reçoit
  //    proactive.alert → fetch REST → message encore absent" (fix audit).
  if (req.activeRunId && deps.schedulerModule) {
    const activeRunId = req.activeRunId;
    const schedulerModule = deps.schedulerModule;
    const emitAudit = async (): Promise<void> => {
      // On audit dès qu'au moins un canal (chat inclus) a porté l'info ; rien livré = pas d'alerte.
      if (delivered.length === 0) return;
      try { await schedulerModule.markDelivered(activeRunId); }
      catch (err) { console.warn(`[delivery] markDelivered failed: ${err instanceof Error ? err.message : err}`); }
      // Policy proactiveAlerts : 'all' (défaut) = toast+carte ; 'quiet' = carte silencieuse ; 'off' = rien.
      const alertMode = req.handlerAgentConfig.delivery?.proactiveAlerts ?? 'all';
      if (alertMode !== 'off') {
        deps.ws.broadcastAll({
          type: 'proactive.alert',
          runId: activeRunId,
          sourceTaskId: req.runContext?.taskId ?? null,
          watcherAgentId: req.runContext?.watcherAgentId ?? handlerAgentId,
          handlerAgentId,
          severity: 'medium',
          summary: subject ?? (content || attachments.map(r => r.name).join(', ')).slice(0, 120),
          state: 'delivered',
          sessionId: req.sessionId,
          subject,
          content,
          channel: delivered.join(','),
          ...(alertMode === 'quiet' ? { silent: true } : {}),
          timestamp: new Date().toISOString(),
        } satisfies WsServerMessage);
      }
    };
    if (req.pendingPostToolResult) {
      // Après la closure chat déjà poussée plus haut → l'alert part une fois le message committé.
      req.pendingPostToolResult.push(async () => {
        try { await emitAudit(); }
        catch (err) { console.warn(`[delivery] deferred proactive audit failed: ${err instanceof Error ? err.message : err}`); }
      });
    } else {
      await emitAudit();
    }
  }

  console.log(`[delivery] done agent=${handlerAgentId} delivered=${delivered.join(',') || 'none'} attachments=${attachments.length} errors=${errors.length}`);
  return { delivered, errors, routing };
}
