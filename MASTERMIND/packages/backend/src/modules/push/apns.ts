import http2 from 'node:http2';
import crypto from 'node:crypto';

/**
 * Client APNs minimal, zéro-dépendance (node:http2 + node:crypto). Auth par
 * **provider token** (JWT ES256 signé avec la clé .p8 AuthKey) — le mode moderne
 * recommandé par Apple : une clé sert tous les bundles d'une team, pas de certif
 * à renouveler. Mirror "transport" de ce que grammy fait pour Telegram (cf.
 * deliverToTelegram dans modules/delivery/channels.ts) : ici c'est l'infra Apple qui
 * réveille le téléphone quand mobile app est en arrière-plan.
 *
 * Sandbox vs prod : un build installé via Xcode (dev / Personal Team) émet un
 * **device token sandbox** → il FAUT taper api.sandbox.push.apple.com, sinon
 * Apple répond 400 BadDeviceToken / 403. TestFlight + App Store = prod. Piloté
 * par `production` dans la config.
 */

const HOST_PROD = 'api.push.apple.com';
const HOST_SANDBOX = 'api.sandbox.push.apple.com';
const PORT = 443;

/** Le JWT APNs est valide ≤ 1h ; Apple impose un refresh entre 20 et 60 min. On régénère à 50 min. */
const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface ApnsConfig {
  /** Contenu PEM de la clé .p8 (AuthKey_XXXX.p8). */
  keyP8: string;
  /** Key ID (10 car.) affiché dans le portail Apple à côté de la clé. */
  keyId: string;
  /** Team ID (10 car.) du compte Apple Developer. */
  teamId: string;
  /** apns-topic = bundle id de l'app (ex. com.example.myapp). */
  topic: string;
  /** true = api.push.apple.com (TestFlight/App Store), false = sandbox (build Xcode dev). */
  production: boolean;
}

export interface ApnsPayload {
  title: string;
  body: string;
  /** Clés custom hors `aps` (sessionId, agentId, runId…) pour le deep-link côté app. */
  data?: Record<string, unknown>;
  /** Badge à afficher sur l'icône. Omis = inchangé. */
  badge?: number;
  /** Regroupement des notifs dans le centre de notif iOS. */
  threadId?: string;
}

export type ApnsSendOutcome =
  | { ok: true; status: number; apnsId?: string }
  /** `dead` = token à purger (désinstallé / mauvais env). */
  | { ok: false; status: number; reason: string; dead: boolean };

/** Reasons APNs qui signifient "ce device token est définitivement mort, purge-le". */
const DEAD_REASONS = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic', 'TopicDisallowed']);

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export class ApnsClient {
  private readonly cfg: ApnsConfig;
  private readonly host: string;
  private readonly privateKey: crypto.KeyObject;
  private cachedJwt: { token: string; mintedAt: number } | null = null;
  private session: http2.ClientHttp2Session | null = null;

  constructor(cfg: ApnsConfig) {
    this.cfg = cfg;
    this.host = cfg.production ? HOST_PROD : HOST_SANDBOX;
    // Throws tôt (au boot du module) si la .p8 est corrompue — mieux qu'un crash au premier push.
    this.privateKey = crypto.createPrivateKey(cfg.keyP8);
    console.log(`[apns] client init host=${this.host} keyId=${cfg.keyId} team=${cfg.teamId} topic=${cfg.topic} prod=${cfg.production}`);
  }

  /** JWT provider token (ES256). Mis en cache ~50 min — Apple rejette un refresh trop fréquent (TooManyProviderTokenUpdates). */
  private mintJwt(): string {
    const now = Date.now();
    if (this.cachedJwt && now - this.cachedJwt.mintedAt < TOKEN_TTL_MS) {
      return this.cachedJwt.token;
    }
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.cfg.keyId }));
    const iat = Math.floor(now / 1000);
    const payload = base64url(JSON.stringify({ iss: this.cfg.teamId, iat }));
    const signingInput = `${header}.${payload}`;
    // ECDSA P-256 + SHA-256, signature au format JOSE (r||s, 64 octets) via dsaEncoding ieee-p1363.
    const sig = crypto.sign('sha256', Buffer.from(signingInput), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    const token = `${signingInput}.${base64url(sig)}`;
    this.cachedJwt = { token, mintedAt: now };
    console.debug(`[apns] minted provider JWT iat=${iat}`);
    return token;
  }

  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    console.debug(`[apns] opening http2 session → ${this.host}`);
    const s = http2.connect(`https://${this.host}:${PORT}`);
    s.on('error', err => console.warn(`[apns] http2 session error: ${err instanceof Error ? err.message : err}`));
    s.on('goaway', () => console.debug('[apns] http2 GOAWAY — session will be recreated on next send'));
    s.on('close', () => console.debug('[apns] http2 session closed'));
    this.session = s;
    return s;
  }

  /** Envoie une notif alerte à UN device token. Best-effort, ne throw jamais (renvoie un outcome). */
  async send(deviceToken: string, payload: ApnsPayload): Promise<ApnsSendOutcome> {
    const aps: Record<string, unknown> = {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
    };
    if (typeof payload.badge === 'number') aps['badge'] = payload.badge;
    if (payload.threadId) aps['thread-id'] = payload.threadId;
    const bodyBuf = Buffer.from(JSON.stringify({ aps, ...(payload.data ?? {}) }));
    return this.post(deviceToken, this.cfg.topic, 'alert', '10', bodyBuf);
  }

  /**
   * Pousse une update (ou un `end`) de **Live Activity** vers le push token d'UNE activité
   * (≠ device token). push-type = `liveactivity`, topic = `<bundleId>.push-type.liveactivity`.
   * `contentState` DOIT correspondre aux propriétés de `AgentActivityAttributes.ContentState`
   * côté iOS (phase/tool/startedAt/preview, + detail/progress OPTIONNELS) — décodé tel quel
   * par ActivityKit. Les transitions d'état (`pushLiveActivityState`) ne portent que la phase ;
   * la progression de préfill (`pushLiveActivityProgress`) porte en plus detail/progress pour que
   * la jauge avance tel verrouillé. Le texte de génération reste l'apanage de l'update locale 1er plan.
   */
  async sendLiveActivity(
    activityToken: string,
    opts: {
      event: 'update' | 'end';
      contentState: Record<string, unknown>;
      timestamp?: number;        // secondes unix ; défaut = maintenant
      staleDate?: number;        // secondes unix ; au-delà l'Island est "périmée"
      dismissalDate?: number;    // secondes unix ; pour `end`, quand retirer l'activité
      priority?: '5' | '10';     // 10 = immédiat (transitions d'état) ; 5 = best-effort, hors
                                 // budget « high-priority » d'APNs (updates fréquentes de progression).
    },
  ): Promise<ApnsSendOutcome> {
    const aps: Record<string, unknown> = {
      timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
      event: opts.event,
      'content-state': opts.contentState,
    };
    if (typeof opts.staleDate === 'number') aps['stale-date'] = opts.staleDate;
    if (typeof opts.dismissalDate === 'number') aps['dismissal-date'] = opts.dismissalDate;
    const bodyBuf = Buffer.from(JSON.stringify({ aps }));
    const topic = `${this.cfg.topic}.push-type.liveactivity`;
    return this.post(activityToken, topic, 'liveactivity', opts.priority ?? '10', bodyBuf);
  }

  /** POST HTTP/2 vers APNs (mutualisé alert + liveactivity). Best-effort, ne throw jamais. */
  private post(token: string, topic: string, pushType: string, priority: string, bodyBuf: Buffer): Promise<ApnsSendOutcome> {
    let jwt: string;
    try {
      jwt = this.mintJwt();
    } catch (err) {
      return Promise.resolve({ ok: false, status: 0, reason: `jwt mint failed: ${err instanceof Error ? err.message : err}`, dead: false });
    }

    return new Promise<ApnsSendOutcome>(resolve => {
      let session: http2.ClientHttp2Session;
      try {
        session = this.getSession();
      } catch (err) {
        resolve({ ok: false, status: 0, reason: `session: ${err instanceof Error ? err.message : err}`, dead: false });
        return;
      }

      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': pushType,
        'apns-priority': priority,
        'content-type': 'application/json',
        'content-length': bodyBuf.length,
      });

      let status = 0;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];

      req.on('response', headers => {
        status = Number(headers[':status'] ?? 0);
        const id = headers['apns-id'];
        apnsId = Array.isArray(id) ? id[0] : (id as string | undefined);
      });
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('error', err => {
        // Une session morte invalide le cache pour forcer une reconnexion au prochain envoi.
        this.session = null;
        resolve({ ok: false, status: 0, reason: `request: ${err instanceof Error ? err.message : err}`, dead: false });
      });
      req.on('end', () => {
        if (status === 200) {
          resolve({ ok: true, status, ...(apnsId ? { apnsId } : {}) });
          return;
        }
        let reason = `http ${status}`;
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(raw) as { reason?: string };
          if (parsed.reason) reason = parsed.reason;
        } catch {
          if (raw) reason = raw.slice(0, 200);
        }
        const dead = status === 410 || DEAD_REASONS.has(reason);
        resolve({ ok: false, status, reason, dead });
      });

      req.setTimeout(15_000, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        resolve({ ok: false, status: 0, reason: 'timeout', dead: false });
      });

      req.end(bodyBuf);
    });
  }

  close(): void {
    if (this.session && !this.session.destroyed) {
      this.session.close();
    }
    this.session = null;
  }
}
