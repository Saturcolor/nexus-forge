import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import type { WebSocketManager } from '@mastermind/shared';

interface ConnectedClient {
  ws: WebSocket;
  /** Sessions dont ce client reçoit les updates (deltas, messages). */
  subscriptions: Set<string>;
  /**
   * Sessions que ce client REGARDE ACTIVEMENT (écran chat au premier plan + onglet/app visible).
   * Sous-ensemble sémantique de `subscriptions` : un client peut rester abonné (reçoit les
   * updates) tout en n'étant PAS en train de regarder (onglet en fond, app suspendue, tel
   * verrouillé). C'est CE signal — pas l'abonnement — qui pilote la presence dedup du push
   * (sinon un tel verrouillé avale le réveil, cf. bug de livraison du briefing). Alimenté par
   * le message client `session.viewing`. Les clients qui ne l'émettent pas (build legacy) sont
   * traités comme "non-regardants" → le push n'est jamais supprimé à tort (fail-safe).
   */
  viewingSessions: Set<string>;
}

const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;

/** Best-effort parse of sessionId/agentId from the start of a raw `chat.send` JSON (for errors before full parse). */
function extractChatSendMeta(raw: Buffer): { sessionId: string; agentId: string } {
  const head = raw.subarray(0, Math.min(raw.length, 24_000)).toString('utf8');
  const sessionId = /"sessionId"\s*:\s*"([^"\\]*)"/.exec(head)?.[1] ?? '';
  const agentId = /"agentId"\s*:\s*"([^"\\]*)"/.exec(head)?.[1] ?? '';
  return { sessionId, agentId };
}

// Cap inbound WS payloads. Chat messages with images embed base64 data URLs in
// the JSON body — without a cap, a single huge image lets a client OOM the Node
// process: JSON.parse allocates a large string, and the dump path adds another
// copy. Application-level caps (`chatImageLimits`) reject heavy images after parse.
// Must exceed the largest JSON we still parse for validation: a ~15 MiB binary
// image is ~20 MiB in base64, plus `chat.send` envelope — we reject over
// `MAX_USER_CHAT_IMAGE_DECODED_BYTES` in index.ts with `chat.error` before
// dumping. The frame cap prevents runaway multi‑hundred‑MB payloads from OOM.
const WS_MAX_PAYLOAD_BYTES = 28 * 1024 * 1024;

function isSessionScopedBroadcast(data: unknown): data is { type?: string; sessionId: string } {
  if (!data || typeof data !== 'object') return false;
  const maybe = data as { type?: unknown; sessionId?: unknown };
  if (typeof maybe.sessionId !== 'string') return false;
  // Proactive alerts are dashboard/global notifications even though they include a handler session.
  return maybe.type !== 'proactive.alert';
}

export class WsManager implements WebSocketManager {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ConnectedClient>();
  private onMessage: ((client: WebSocket, data: unknown) => void) | null = null;
  private nextClientId = 1;

  constructor(server: Server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      // Cap at the protocol layer too — `ws` lib enforces this on raw frames
      // before our handler even runs, so we never allocate the giant buffer.
      maxPayload: WS_MAX_PAYLOAD_BYTES,
    });

    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      const clientId = this.nextClientId++;
      const client: ConnectedClient = { ws, subscriptions: new Set(), viewingSessions: new Set() };
      this.clients.set(ws, client);
      console.log(`[ws] client #${clientId} connected (${this.clients.size} total)`);
      let interval: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        client.subscriptions.clear();
        client.viewingSessions.clear();
        this.clients.delete(ws);
      };

      ws.on('message', (raw) => {
        try {
          // Defensive cap (the `ws` lib's maxPayload should already gate, but
          // belt-and-suspenders for any case where the raw arrives via a
          // different code path — e.g. concatenated frames).
          const rawSize = (raw as Buffer).byteLength ?? raw.toString().length;
          if (rawSize > WS_MAX_PAYLOAD_BYTES) {
            console.warn(`[ws] #${clientId} payload too large (${rawSize}B > ${WS_MAX_PAYLOAD_BYTES}B), dropping`);
            const meta = extractChatSendMeta(raw as Buffer);
            const errPayload = {
              type: 'chat.error' as const,
              sessionId: meta.sessionId,
              agentId: meta.agentId,
              error:
                `Message WebSocket trop volumineux (max ${Math.round(WS_MAX_PAYLOAD_BYTES / (1024 * 1024))} Mo). ` +
                'Réduis la taille des images et réessaie.',
            };
            try {
              if (meta.sessionId) this.broadcast(meta.sessionId, errPayload);
              else this.send(ws, errPayload);
            } catch { /* socket may be closing */ }
            return;
          }
          const data = JSON.parse(raw.toString()) as { type?: string; sessionId?: string };
          if (data.type === 'session.subscribe' && data.sessionId) {
            if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT && !client.subscriptions.has(data.sessionId)) {
              console.warn(`[ws] #${clientId} subscription limit reached; ignoring ${data.sessionId}`);
              return;
            }
            client.subscriptions.add(data.sessionId);
            console.debug(`[ws] #${clientId} session.subscribe ${data.sessionId}`);
          } else if (data.type === 'session.unsubscribe' && data.sessionId) {
            client.subscriptions.delete(data.sessionId);
            client.viewingSessions.delete(data.sessionId);
            console.debug(`[ws] #${clientId} session.unsubscribe ${data.sessionId}`);
          } else if (data.type === 'session.viewing' && data.sessionId) {
            // Présence "regarde l'écran" (premier plan + chat visible). Pilote la presence
            // dedup du push : tant qu'un client regarde, on ne sonne pas le tel ; dès qu'il
            // passe en fond / se verrouille, il émet viewing=false et le réveil repart.
            const viewing = (data as { viewing?: unknown }).viewing === true;
            if (viewing) client.viewingSessions.add(data.sessionId);
            else client.viewingSessions.delete(data.sessionId);
            console.debug(`[ws] #${clientId} session.viewing ${data.sessionId} viewing=${viewing}`);
          } else if (data.type) {
            const extra = data.sessionId ? ` sessionId=${data.sessionId}` : '';
            console.debug(`[ws] #${clientId} msg type=${data.type}${extra}`);
          }
          this.onMessage?.(ws, data);
        } catch {
          console.warn(`[ws] #${clientId} malformed message`);
        }
      });

      ws.on('close', () => {
        cleanup();
        console.log(`[ws] client #${clientId} disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        cleanup();
        console.warn(`[ws] client #${clientId} error:`, (err as Error).message);
      });

      // Keepalive
      interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          cleanup();
        }
      }, 30000);
    });
  }

  setMessageHandler(handler: (client: WebSocket, data: unknown) => void): void {
    this.onMessage = handler;
  }

  /** Broadcast to all clients subscribed to a session */
  broadcast(room: string, data: unknown): void {
    const msg = JSON.stringify(data);
    for (const client of [...this.clients.values()]) {
      if (client.subscriptions.has(room) && client.ws.readyState === WebSocket.OPEN) {
        this.safeSend(client.ws, msg);
      }
    }
  }

  /** Broadcast to ALL connected clients */
  broadcastAll(data: unknown): void {
    if (isSessionScopedBroadcast(data)) {
      this.broadcast(data.sessionId, data);
      return;
    }
    const msg = JSON.stringify(data);
    for (const client of [...this.clients.values()]) {
      if (client.ws.readyState === WebSocket.OPEN) {
        this.safeSend(client.ws, msg);
      }
    }
  }

  /** Send to a specific client */
  send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      this.safeSend(ws, JSON.stringify(data));
    }
  }

  /**
   * Nombre de clients vivants (socket OPEN) ABONNÉS à une session (reçoivent les updates).
   * ⚠️ "abonné" ≠ "regarde l'écran" : un onglet en fond ou une app suspendue reste abonné.
   * Pour la presence dedup du push, utiliser `hasSessionViewers` (signal "regarde vraiment").
   * Conservé pour les usages non-dedup (diagnostic, comptage de connexions).
   */
  hasSessionSubscribers(sessionId: string): number {
    let n = 0;
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(sessionId) && client.ws.readyState === WebSocket.OPEN) n++;
    }
    return n;
  }

  /**
   * Nombre de clients vivants (socket OPEN) qui REGARDENT ACTIVEMENT une session (écran chat
   * au premier plan + onglet/app visible) — la vraie presence pour le dedup de push : si
   * quelqu'un regarde, le contenu arrive sous ses yeux via la ligne chat, inutile de sonner.
   * Un tel verrouillé / une app en fond / un onglet caché ne comptent PAS (ils ont émis
   * `session.viewing` viewing=false, ou n'émettent rien = build legacy traité comme absent).
   * C'est le fix du bug "briefing avalé" : avant, l'abonnement résiduel
   * d'un tel verrouillé supprimait le réveil.
   */
  hasSessionViewers(sessionId: string): number {
    let n = 0;
    for (const client of this.clients.values()) {
      if (client.viewingSessions.has(sessionId) && client.ws.readyState === WebSocket.OPEN) n++;
    }
    return n;
  }

  /** Subscribe a client to a session room */
  subscribe(ws: WebSocket, sessionId: string): void {
    const client = this.clients.get(ws);
    if (!client) return;
    if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT && !client.subscriptions.has(sessionId)) return;
    client.subscriptions.add(sessionId);
  }

  close(): void {
    for (const client of [...this.clients.keys()]) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.wss.close();
  }

  private safeSend(ws: WebSocket, msg: string): void {
    try {
      ws.send(msg);
    } catch (err) {
      this.clients.delete(ws);
      console.warn('[ws] send failed:', (err as Error).message);
    }
  }
}
