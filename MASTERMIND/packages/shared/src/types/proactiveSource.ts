import type { Severity, TaskDeliveryChannel } from './scheduledTask.js';

export interface ProactiveSource {
  id: string;
  name: string;
  kind: 'webhook';
  enabled: boolean;
  agentId: string;
  /** Custom instructions prepended to every alert dispatched to the agent. */
  prompt: string;
  config: Record<string, unknown>;
  rateLimitMinutes: number;
  /** Context retention in hours — messages older than this are auto-flushed. 0 = no auto-flush. */
  contextRetentionHours: number;
  /**
   * When true (default), if the agent finishes the alert run without calling `send_to_user`,
   * the final text is auto-pushed to the visible channel as a safety net. When false, the
   * agent can terminate the alert silently — useful for noisy sources where most alerts
   * should be triaged invisibly.
   */
  autoDeliver: boolean;
  /** Override de canaux de réveil pour les runs de CETTE source — cf. ScheduledTask.deliveryChannels. */
  deliveryChannels?: TaskDeliveryChannel[] | null;
  lastAlertAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveAlert {
  id: string;
  sourceId: string;
  severity: Severity;
  title: string;
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  state: 'triggered' | 'resolved';
  dispatched: boolean;
  runId?: string;
  createdAt: string;
}

export interface CreateSourceInput {
  name: string;
  agentId: string;
  prompt?: string;
  config?: Record<string, unknown>;
  rateLimitMinutes?: number;
  contextRetentionHours?: number;
  /** Defaults to true — see ProactiveSource.autoDeliver. */
  autoDeliver?: boolean;
  /** See ProactiveSource.deliveryChannels. */
  deliveryChannels?: TaskDeliveryChannel[] | null;
}

export interface UpdateSourceInput {
  name?: string;
  enabled?: boolean;
  agentId?: string;
  prompt?: string;
  config?: Record<string, unknown>;
  rateLimitMinutes?: number;
  contextRetentionHours?: number;
  autoDeliver?: boolean;
  /** null = retire l'override (retour à la policy agent). */
  deliveryChannels?: TaskDeliveryChannel[] | null;
}

/** Payload expected on POST /api/proactive/ingest from external apps (Nexus Monitor, Mailmind, etc.) */
export interface ProactiveIngestPayload {
  /** Must match a proactive_sources.id */
  source: string;
  severity: Severity;
  title: string;
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  /** 'triggered' = seuil franchi, 'resolved' = retour à la normale */
  state?: 'triggered' | 'resolved';
  timestamp?: string;
}
