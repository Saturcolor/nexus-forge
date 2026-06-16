import type { WsServerMessage } from '@mastermind/shared';
import { clientLogger } from './clientLogger';

type MessageHandler = (data: WsServerMessage) => void;

const MAX_OUTBOX_MESSAGES = 200;
const MAX_ACTIVE_SUBSCRIPTIONS = 100;

type ConnectionListener = (connected: boolean) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private connectionListeners = new Set<ConnectionListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  // Queue of outbound messages until the socket is OPEN.
  // This avoids losing `session.subscribe` (and thus chat updates) during initial connect.
  private outbox: string[] = [];
  // Track active session subscriptions so we can re-subscribe after reconnect.
  private activeSubscriptions = new Set<string>();
  // Session actuellement REGARDÉE (présence). Distinct de l'abonnement : pilote la dédup du
  // push mobile côté backend (un tel verrouillé regardant la session ne doit pas re-sonner).
  // Ré-émis après reconnexion WS, sinon le backend retombe à viewers=0 et pousse un push
  // injustifié pendant qu'on regarde encore. Miroir de ce que fait l'app iOS.
  private viewedSessionId: string | null = null;
  private manualClose = false;
  // Ref-count of live consumers that called connect(). The socket is a process-wide
  // singleton shared by many always-on features (StatusBar, proactive alerts, useAgents,
  // War Room, Scheduler...). We only tear it down once the LAST consumer releases, so a
  // single page unmounting (e.g. leaving Chat) never kills the app-wide connection.
  // React StrictMode note: a single component's dev double-mount transiently drops the count
  // to 0 (a real teardown) then back to 1, so the socket is closed and reopened — teardown()
  // deliberately preserves outbox/subscriptions so the reopen restores them seamlessly.
  private consumers = 0;
  private notifyConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected);
  }

  constructor() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${protocol}//${window.location.host}/ws`;
  }

  /**
   * Register a consumer and ensure the socket is open. Ref-counted: each connect() must be
   * paired with a release() (or a disconnect() force-close). Safe to call from many
   * components — the underlying socket is opened at most once.
   */
  connect(): void {
    this.consumers += 1;
    clientLogger.debug('ws', 'consumer acquired', { consumers: this.consumers });
    this.openSocket();
  }

  /** Open the underlying socket if not already open/connecting. Does NOT touch the ref-count
   *  (used by both connect() and the auto-reconnect path). */
  private openSocket(): void {
    if (this.consumers === 0) {
      clientLogger.debug('ws', 'openSocket skipped — no consumers');
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      clientLogger.debug('ws', 'connect skipped', { readyState: this.ws.readyState });
      return;
    }

    this.manualClose = false;
    clientLogger.info('ws', 'connect start', { url: this.url });
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      clientLogger.info('ws', 'connected', { outbox: this.outbox.length, subscriptions: this.activeSubscriptions.size });
      this.notifyConnection(true);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Flush queued payloads.
      if (this.outbox.length > 0) {
        for (const payload of this.outbox) {
          this.ws?.send(payload);
        }
        clientLogger.debug('ws', 'outbox flushed', { count: this.outbox.length });
        this.outbox = [];
      }

      // Re-subscribe to all active sessions after reconnect.
      for (const sessionId of this.activeSubscriptions) {
        this.ws?.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
      }
      if (this.activeSubscriptions.size > 0) {
        clientLogger.debug('ws', 'subscriptions restored', { count: this.activeSubscriptions.size });
      }

      // Ré-émet la présence « viewing » après reconnexion : sinon le backend, ayant vu le
      // socket tomber, repasse à viewers=0 et envoie un push mobile alors qu'on regarde encore
      // la session. On ne ré-émet que si on regarde toujours quelque chose.
      if (this.viewedSessionId) {
        this.ws?.send(JSON.stringify({ type: 'session.viewing', sessionId: this.viewedSessionId, viewing: true }));
        clientLogger.debug('ws', 'viewing presence restored', { sessionId: this.viewedSessionId });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        clientLogger.debug('ws', 'message received', { type: data?.type ?? 'unknown' });
        for (const handler of this.handlers) {
          handler(data);
        }
      } catch (err) {
        clientLogger.warn('ws', 'message parse/dispatch failed', { error: err instanceof Error ? err.message : String(err) });
      }
    };

    this.ws.onclose = (event) => {
      this.notifyConnection(false);
      if (this.manualClose) return;
      // Clean closes (browser idle, tab backgrounded, server graceful shutdown) come
      // through with wasClean=true — typically code=1000 (normal) or 1005 (no status).
      // The reconnect kicks in automatically; no need to escalate to a warn that gets
      // shipped to the server log ingest.
      const isCleanClose = event.wasClean && (event.code === 1000 || event.code === 1005);
      const logFn = isCleanClose ? clientLogger.debug : clientLogger.warn;
      logFn.call(clientLogger, 'ws', 'disconnected, reconnecting', { code: event.code, reason: event.reason, wasClean: event.wasClean });
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      clientLogger.warn('ws', 'socket error');
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clientLogger.debug('ws', 'reconnect already scheduled');
      return;
    }
    clientLogger.debug('ws', 'reconnect scheduled', { delayMs: 2000 });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reconnect must NOT re-increment the consumer ref-count.
      this.openSocket();
    }, 2000);
  }

  send(data: unknown): void {
    // Track session subscriptions so we can restore them on reconnect.
    if (data && typeof data === 'object') {
      const msg = data as Record<string, unknown>;
      if (msg.type === 'session.subscribe' && typeof msg.sessionId === 'string') {
        if (this.activeSubscriptions.size >= MAX_ACTIVE_SUBSCRIPTIONS && !this.activeSubscriptions.has(msg.sessionId)) {
          clientLogger.warn('ws', 'active subscription limit reached; dropping subscribe', { sessionId: msg.sessionId, count: this.activeSubscriptions.size });
          return;
        }
        this.activeSubscriptions.add(msg.sessionId);
        clientLogger.debug('ws', 'session subscribed', { sessionId: msg.sessionId, count: this.activeSubscriptions.size });
      } else if (msg.type === 'session.unsubscribe' && typeof msg.sessionId === 'string') {
        this.activeSubscriptions.delete(msg.sessionId);
        clientLogger.debug('ws', 'session unsubscribed', { sessionId: msg.sessionId, count: this.activeSubscriptions.size });
      } else if (msg.type === 'session.viewing' && typeof msg.sessionId === 'string') {
        // Mémorise la dernière session regardée pour pouvoir la ré-émettre après reconnexion.
        // viewing:true → set ; viewing:false → clear (mais seulement si c'est bien la session
        // courante qu'on cesse de regarder, pour ne pas effacer une autre présence en vol).
        if (msg.viewing === true) {
          this.viewedSessionId = msg.sessionId;
        } else if (this.viewedSessionId === msg.sessionId) {
          this.viewedSessionId = null;
        }
      }
    }
    const payload = JSON.stringify(data);
    const type = data && typeof data === 'object' ? String((data as Record<string, unknown>).type ?? 'unknown') : 'unknown';
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      clientLogger.debug('ws', 'message sent', { type, bytes: payload.length });
    }
    else {
      this.outbox.push(payload);
      if (this.outbox.length > MAX_OUTBOX_MESSAGES) {
        this.outbox.splice(0, this.outbox.length - MAX_OUTBOX_MESSAGES);
        clientLogger.warn('ws', 'outbox truncated', { max: MAX_OUTBOX_MESSAGES });
      }
      clientLogger.debug('ws', 'message queued', { type, outbox: this.outbox.length, readyState: this.ws?.readyState ?? -1 });
    }
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    clientLogger.debug('ws', 'handler subscribed', { handlers: this.handlers.size });
    return () => {
      this.handlers.delete(handler);
      clientLogger.debug('ws', 'handler unsubscribed', { handlers: this.handlers.size });
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }

  /**
   * Release a consumer registered via connect(). Decrements the ref-count and only
   * performs the real teardown once the LAST consumer is gone. Page-scoped components
   * MUST use this (not disconnect()) in their unmount cleanup, so leaving one page never
   * kills the app-wide socket that other always-on features still depend on.
   */
  release(): void {
    if (this.consumers === 0) {
      clientLogger.debug('ws', 'release with no consumers; ignored');
      return;
    }
    this.consumers -= 1;
    clientLogger.debug('ws', 'consumer released', { consumers: this.consumers });
    if (this.consumers === 0) {
      clientLogger.info('ws', 'last consumer released — tearing down socket', { subscriptions: this.activeSubscriptions.size, outbox: this.outbox.length });
      this.teardown();
    }
  }

  /** Force-close the socket regardless of ref-count (e.g. logout). Resets consumers to 0 and
   *  fully clears pending state (outbox + subscriptions) — unlike the ref-count teardown. */
  disconnect(): void {
    clientLogger.info('ws', 'manual disconnect (force-close)', { subscriptions: this.activeSubscriptions.size, outbox: this.outbox.length });
    this.consumers = 0;
    this.outbox = [];
    this.activeSubscriptions.clear();
    this.viewedSessionId = null;
    this.teardown();
  }

  /** Close the underlying socket WITHOUT discarding outbox/activeSubscriptions, so a later
   *  connect()/reconnect restores the queued sends and re-subscribes. Full state reset
   *  (outbox + subscriptions) lives in disconnect() — the explicit logout path. */
  private teardown(): void {
    this.manualClose = true;
    clientLogger.debug('ws', 'socket teardown', { subscriptions: this.activeSubscriptions.size, outbox: this.outbox.length });
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export const wsClient = new WebSocketClient();
