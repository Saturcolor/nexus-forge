import { useSyncExternalStore, useCallback } from 'react';
import type { Severity, WsServerMessage } from '@mastermind/shared';
import { wsClient } from './ws';
import { api } from './api';

/**
 * In-memory store for proactive alerts. Listens to `proactive.alert` WS events
 * and tracks unread/acknowledged state. Persists acknowledged run ids in
 * localStorage so reload does not re-flash past notifications.
 */

export interface ProactiveAlertEntry {
  runId: string;
  sourceTaskId: string | null;
  watcherAgentId: string;
  handlerAgentId: string;
  severity: Severity;
  summary: string;
  state: 'running' | 'done' | 'delivered';
  subject?: string;
  content?: string;
  /** Canaux livrés (csv 'chat,telegram,mobile' depuis le backend ; enum legacy possible). */
  channel?: string;
  /** Policy 'quiet' : carte persistée, mais AUCUN toast (ProactiveToast skip). */
  silent?: boolean;
  sessionId: string;
  timestamp: string;
}

const ACK_STORAGE_KEY = 'mastermind.proactive.acked';

function loadAckedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(ACK_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveAckedIds(ids: Set<string>): void {
  try {
    // Cap to last 500 to avoid unbounded growth.
    const arr = Array.from(ids).slice(-500);
    localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify(arr));
  } catch {
    /* quota exceeded — non-fatal */
  }
}

class ProactiveAlertsStore {
  private alerts: ProactiveAlertEntry[] = [];
  private acked = loadAckedIds();
  private listeners = new Set<() => void>();
  private snapshot: { alerts: ProactiveAlertEntry[]; unreadCount: number } = {
    alerts: [],
    unreadCount: 0,
  };

  constructor() {
    wsClient.subscribe((msg: WsServerMessage) => {
      if (msg.type !== 'proactive.alert') return;
      const entry: ProactiveAlertEntry = {
        runId: msg.runId,
        sourceTaskId: msg.sourceTaskId,
        watcherAgentId: msg.watcherAgentId,
        handlerAgentId: msg.handlerAgentId,
        severity: msg.severity,
        summary: msg.summary,
        state: msg.state,
        subject: msg.subject,
        content: msg.content,
        channel: msg.channel,
        silent: msg.silent,
        sessionId: msg.sessionId,
        timestamp: msg.timestamp,
      };
      // Upsert by runId — later states (running → done/delivered) overwrite earlier.
      const idx = this.alerts.findIndex(a => a.runId === entry.runId);
      if (idx >= 0) {
        this.alerts[idx] = entry;
      } else {
        this.alerts.unshift(entry);
        // Cap to 100 in memory
        if (this.alerts.length > 100) this.alerts.length = 100;
      }
      this.publish();
    });
  }

  private publish(): void {
    const unreadCount = this.alerts.filter(a =>
      a.state === 'delivered' && !this.acked.has(a.runId),
    ).length;
    this.snapshot = { alerts: [...this.alerts], unreadCount };
    for (const l of this.listeners) l();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  getSnapshot = () => this.snapshot;

  acknowledge(runId: string): void {
    if (this.acked.has(runId)) return;
    this.acked.add(runId);
    saveAckedIds(this.acked);
    // Fire-and-forget backend ack (audit only). Use the shared API client so the
    // Authorization header is attached — a bare fetch() is rejected 401 by the
    // /api/* auth middleware and the ack is never recorded.
    api.post(`/api/scheduler/alerts/${encodeURIComponent(runId)}/ack`).catch(() => { /* non-fatal */ });
    this.publish();
  }

  acknowledgeAll(): void {
    let changed = false;
    for (const a of this.alerts) {
      if (a.state === 'delivered' && !this.acked.has(a.runId)) {
        this.acked.add(a.runId);
        changed = true;
        api.post(`/api/scheduler/alerts/${encodeURIComponent(a.runId)}/ack`).catch(() => { /* non-fatal */ });
      }
    }
    if (changed) {
      saveAckedIds(this.acked);
      this.publish();
    }
  }

  isAcked(runId: string): boolean {
    return this.acked.has(runId);
  }
}

export const proactiveAlertsStore = new ProactiveAlertsStore();

export function useProactiveAlerts() {
  const snapshot = useSyncExternalStore(
    proactiveAlertsStore.subscribe,
    proactiveAlertsStore.getSnapshot,
    proactiveAlertsStore.getSnapshot,
  );
  const acknowledge = useCallback((runId: string) => proactiveAlertsStore.acknowledge(runId), []);
  const acknowledgeAll = useCallback(() => proactiveAlertsStore.acknowledgeAll(), []);
  return { ...snapshot, acknowledge, acknowledgeAll };
}
