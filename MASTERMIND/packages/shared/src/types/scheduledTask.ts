export type ScheduleKind = 'once' | 'cron';
/** Canaux de réveil pour l'override de livraison par tâche/source. */
export type TaskDeliveryChannel = 'mobile' | 'telegram';
export type TaskRunStatus = 'running' | 'completed' | 'failed';
export type TaskKind = 'task' | 'proactive';
export type TaskRunKind = 'task' | 'proactive' | 'escalation';
export type Severity = 'low' | 'medium' | 'high';

export interface ScheduledTask {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  /** ISO datetime for one-shot tasks */
  scheduledAt?: string;
  /** 5-field cron expression for recurring tasks */
  cronExpression?: string;
  enabled: boolean;
  /** Delete the task automatically after execution */
  deleteAfterRun: boolean;
  createdBy: 'user' | 'agent';
  /** Pre-computed next execution time (ISO) */
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  createdAt: string;
  updatedAt: string;
  /** 'task' (normal scheduled) or 'proactive' (watcher that may escalate to handler) */
  kind: TaskKind;
  /** Handler agent used when a proactive watcher escalates. Required when kind='proactive'. */
  escalationAgentId?: string;
  /** Minimum severity required to trigger escalation. Defaults to 'medium'. */
  severityThreshold?: Severity;
  /**
   * When true (default), if the agent finishes the run without calling `send_to_user`,
   * the final text is auto-pushed to the visible channel (chat/Telegram) as a safety net.
   * When false, the run can finish silently — no message reaches the user unless the
   * agent explicitly calls `send_to_user`. Use false for noisy proactive watchers that
   * the agent should be free to terminate without user-facing output.
   */
  autoDeliver: boolean;
  /**
   * Override de canaux de réveil pour les livraisons de CETTE tâche (send_to_user +
   * safety nets). Prioritaire sur la policy `delivery` de l'agent ET sur l'arg `channel`
   * du LLM. `[]` = chat seul (aucun réveil). Undefined/null = pas d'override.
   */
  deliveryChannels?: TaskDeliveryChannel[] | null;
  /** ISO timestamp when the task was soft-deleted (corbeille). Undefined = active. */
  deletedAt?: string;
}

export interface TaskRun {
  id: string;
  taskId: string | null;
  /** Snapshot of task name at execution time (survives task deletion) */
  taskName?: string;
  agentId: string;
  sessionId: string;
  status: TaskRunStatus;
  prompt: string;
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** 'task' | 'proactive' | 'escalation' */
  kind: TaskRunKind;
  /** Parent run id for escalation runs (points to the watcher run that triggered them). */
  parentRunId?: string;
  /** Severity assigned by the watcher when it escalated. */
  severity?: Severity;
  /** True if a proactive run escalated to a handler. */
  escalated: boolean;
  /** True if the handler called send_to_user during this escalation run (user actually saw something). */
  delivered?: boolean;
  /** When the alert was acknowledged in the frontend (ISO). */
  acknowledgedAt?: string;
}

export interface CreateTaskInput {
  name: string;
  agentId: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  scheduledAt?: string;
  cronExpression?: string;
  deleteAfterRun?: boolean;
  createdBy?: 'user' | 'agent';
  kind?: TaskKind;
  escalationAgentId?: string;
  severityThreshold?: Severity;
  /** Defaults to true — see ScheduledTask.autoDeliver. */
  autoDeliver?: boolean;
  /** See ScheduledTask.deliveryChannels. */
  deliveryChannels?: TaskDeliveryChannel[] | null;
}

export interface UpdateTaskInput {
  name?: string;
  prompt?: string;
  scheduleKind?: ScheduleKind;
  scheduledAt?: string;
  cronExpression?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  kind?: TaskKind;
  escalationAgentId?: string;
  severityThreshold?: Severity;
  autoDeliver?: boolean;
  /** null = retire l'override (retour à la policy agent). */
  deliveryChannels?: TaskDeliveryChannel[] | null;
}
