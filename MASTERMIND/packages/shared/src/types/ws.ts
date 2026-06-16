import type { ChatMessage, MessageImage } from './message.js';
import type { ProviderStats } from './provider.js';
import type { Severity } from './scheduledTask.js';
import type { WarRoomMessage, RoomStatus } from './warRoom.js';

/** Persisted tool event — stored in message metadata and sent with chat.done */
export interface ToolEventPayload {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'done' | 'error';
  output?: string;
  durationMs?: number;
  error?: string;
}

// Client -> Server
export type WsClientMessage =
  | {
      type: 'chat.send';
      agentId: string;
      sessionId: string;
      content: string;
      images?: MessageImage[];
      /**
       * Origine vocale (NCM) avec « masquer le transcript » actif : le réveil mobile
       * de fin de run (push APNs interactif) doit notifier SANS mettre la réponse en
       * clair dans le body (en vocal on écoute le TTS, on ne lit pas). La ligne chat
       * reste inchangée — seul le body de la notif est génériqué. Cf. run.ts bloc (B).
       */
      hideTranscript?: boolean;
    }
  | { type: 'session.subscribe'; sessionId: string }
  | { type: 'session.unsubscribe'; sessionId: string }
  /**
   * Présence "regarde l'écran" : le client signale qu'il REGARDE (true) ou ne regarde plus
   * (false) cette session — écran chat au premier plan + onglet/app visible. Distinct de
   * l'abonnement (`session.subscribe`) : pilote la presence dedup du push (un tel verrouillé
   * ou un onglet en fond émet viewing=false → le réveil mobile repart). Cf. ws.ts
   * hasSessionViewers (backend). Émis par le web (visibilitychange) et l'app iOS (scenePhase).
   */
  | { type: 'session.viewing'; sessionId: string; viewing: boolean }
  | { type: 'chat.abort'; agentId: string; sessionId: string }
  | { type: 'cache.warm'; agentId: string; sessionId: string };

// Server -> Client
export type WsServerMessage =
  | { type: 'chat.delta'; sessionId: string; agentId: string; content: string }
  | { type: 'chat.done'; sessionId: string; agentId: string; messageId: string; content: string; toolEvents?: ToolEventPayload[]; partial?: boolean }
  | { type: 'chat.error'; sessionId: string; agentId: string; error: string }
  | {
      type: 'agent.state'; agentId: string; state: string;
      /**
       * true = run d'arrière-plan (proactif/escalade/cron/sandbox). Permet aux clients
       * (mobile app) de ne démarrer une Live Activity QUE pour leurs propres runs ou les
       * runs d'arrière-plan — pas pour un run interactif lancé depuis un autre device
       * (session unifiée : taper sur le web ne doit pas allumer l'Island du téléphone).
       */
      background?: boolean;
    }
  /** Live agent config patch — émis quand un champ runtime-mutable change (UI agent config,
   *  /think, bouton Telegram). Le frontend merge dans son state local. */
  | { type: 'agent.config'; agentId: string; patch: AgentConfigPatch }
  | { type: 'session.message'; sessionId: string; message: ChatMessage }
  | { type: 'sessions.updated'; agentId: string }
  | { type: 'session.options'; sessionId: string; options: SessionOptionsPayload }
  | { type: 'tool.start'; sessionId: string; agentId: string; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | { type: 'tool.done'; sessionId: string; agentId: string; toolName: string; toolCallId: string; durationMs: number; output: string; error?: string }
  | { type: 'provider.stats'; agentId: string; sessionId: string; stats: ProviderStats }
  /** Timer global du warmup automatique — firesAt null = aucun warmup planifié */
  | { type: 'warmup.global.schedule'; firesAt: string | null }
  /** État de la queue globale de warmup */
  | { type: 'warmup.queue.update'; queue: string[]; processing: string | null }
  /** Warmup d'un agent terminé */
  | { type: 'warmup.agent.done'; agentId: string; completedAt: string }
  /** Consolidation mémoire — progression en temps réel */
  | { type: 'consolidation.progress'; runId: string; agentId: string | null; step: 'scoring' | 'clustering' | 'merging' | 'archiving'; stepNumber: number; totalSteps: number; detail?: string }
  | { type: 'consolidation.done'; runId: string; agentId: string | null; stats: { scored: number; clustersFound: number; merged: number; archived: number; errors: number } }
  | { type: 'consolidation.error'; runId: string; agentId: string | null; error: string }
  /** Scheduled tasks events */
  | { type: 'task.started'; taskId: string; runId: string; agentId: string }
  | { type: 'task.completed'; taskId: string; runId: string; agentId: string; result: string; durationMs: number }
  | { type: 'task.failed'; taskId: string; runId: string; agentId: string; error: string }
  | { type: 'tasks.updated' }
  /** War Room events */
  | { type: 'war-room.message'; roomId: string; message: WarRoomMessage }
  | { type: 'war-room.turn'; roomId: string; turnIndex: number; speaker: 'user' | string }
  | { type: 'war-room.agent.thinking'; roomId: string; agentId: string }
  | { type: 'war-room.agent.done'; roomId: string; agentId: string; passed: boolean }
  | { type: 'war-room.rooms.updated' }
  | { type: 'war-room.closed'; roomId: string; archivePath: string | null }
  | { type: 'war-room.status'; roomId: string; status: RoomStatus }
  /** Async jobs — long-running skill actions dispatched in the background */
  | { type: 'async_job.queued'; jobId: string; agentId: string; sessionId: string; toolName: string; createdAt: string }
  | { type: 'async_job.started'; jobId: string; agentId: string; startedAt: string }
  | { type: 'async_job.completed'; jobId: string; agentId: string; durationMs: number; outputCount: number }
  | { type: 'async_job.failed'; jobId: string; agentId: string; error: string; durationMs: number }
  | { type: 'async_job.cancelled'; jobId: string; agentId: string }
  | { type: 'async_jobs.updated' }
  /** Sub-agent live progress — emitted only for source='subagent' runs.
   *  Each event carries the parent jobId so the UI can scope updates to a specific run.
   *  These bypass the normal hidden-run swallowing so the sub-agent UI can show
   *  what's happening in real time. */
  | { type: 'subagent.run.turn'; jobId: string; sessionId: string; agentId: string; turn: number; maxTurns: number }
  | { type: 'subagent.run.tool.start'; jobId: string; sessionId: string; agentId: string; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | { type: 'subagent.run.tool.done'; jobId: string; sessionId: string; agentId: string; toolName: string; toolCallId: string; durationMs: number; output: string; error?: string }
  | { type: 'subagent.run.text'; jobId: string; sessionId: string; agentId: string; turn: number; content: string; finishReason: string }
  /** Proactive module events */
  | {
      type: 'proactive.alert';
      runId: string;
      sourceTaskId: string | null;
      watcherAgentId: string;
      handlerAgentId: string;
      severity: Severity;
      summary: string;
      /** 'running' = handler is processing, 'done' = handler finished, 'delivered' = send_to_user was called in proactive context */
      state: 'running' | 'done' | 'delivered';
      /** Notification subject (set when delivered via send_to_user). */
      subject?: string;
      /** User-facing content delivered via send_to_user (when state='delivered'). */
      content?: string;
      /** Channel used when state='delivered'. */
      /** Canaux effectivement livrés (csv : 'chat,telegram,mobile'). Legacy : enum unique. */
      channel?: string;
      /** Policy 'quiet' : carte persistée côté clients, mais AUCUN toast/banner. */
      silent?: boolean;
      /** Handler session id where the escalation was processed. */
      sessionId: string;
      timestamp: string;
    };

/** Options actives pour une session (transmises au frontend via WS).
 *  thinkBudget n'est plus ici — c'est désormais agent-level (single source of truth). */
export interface SessionOptionsPayload {
  modelOverride?: string;
  temperatureOverride?: number;
  toolsDisabled?: boolean;
}

/** Champs agent runtime-mutables propagés via `agent.config` WS message.
 *  Format extensible : on ajoute des champs au besoin pour que les clients ouverts
 *  sur AgentDetailPage / Gallery se mettent à jour sans refresh manuel. */
export interface AgentConfigPatch {
  thinkBudget?: 'off' | 'low' | 'medium' | 'high';
  model?: string;
  temperature?: number;
  enabled?: boolean;
  /** KV-cache + skill exposure flags (toggles dans le card "Modèle" d'Agent Settings) */
  lazySkills?: boolean;
  bypassUnifiedCache?: boolean;
  skillCallMode?: 'stub' | 'wildcard';
  excludeSharedMemory?: boolean;
  /** Policy de livraison — objet nettoyé persisté, ou null explicite = reset legacy. */
  delivery?: import('./agent.js').AgentDeliveryPolicy | null;
  unifiedSession?: boolean;
  loraScales?: number[];
  /** Compact quotidien + sous-config (skipWarmup, loraShuffle). Propagé après PUT config et après un shuffle. */
  dailyCompact?: import('./agent.js').AgentConfig['dailyCompact'];
}
