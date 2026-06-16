import fs from 'node:fs';
import type { Module, MastermindContext } from '@mastermind/shared';
import { ApnsClient, type ApnsPayload } from './apns.js';

/**
 * PushModule — canal "mobile" : pousse des notifs APNs to registered mobile devices
 * enregistrés. C'est le miroir de TelegramModule (cf. modules/telegram/index.ts) :
 * Telegram réveille le téléphone via son infra, ici c'est APNs. Le *contenu* d'un
 * `send_to_user` arrive déjà côté mobile app via le broadcast WS de la session (canal
 * `chat`, toujours inconditionnel) — ce module ne fournit que le **réveil** quand
 * l'app est en arrière-plan ou tuée.
 *
 * Registry des device tokens en DB (`push_devices`), alimenté par POST /api/push/register
 * depuis l'app iOS. Single-user : un push part vers TOUS les appareils actifs (pas de
 * mapping par-agent comme les chatIds Telegram — inutile ici).
 */

export interface PushDeviceRow {
  token: string;
  platform: string;
  agentId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface PushSendResult {
  attempted: number;
  delivered: number;
  pruned: number;
  errors: string[];
}

export interface PushStatus {
  enabled: boolean;
  configured: boolean;
  production: boolean;
  topic: string | null;
  deviceCount: number;
}

export class PushModule implements Module {
  name = 'push';
  private ctx!: MastermindContext;
  private client: ApnsClient | null = null;
  private production = false;
  private topic: string | null = null;

  /**
   * Tokens de push **Live Activity** (≠ device tokens), par session. Éphémère / en mémoire :
   * une activité ne vit que le temps d'un run, et un token ActivityKit n'est valide que pour
   * son activité. Alimenté par POST /api/push/liveactivity/register depuis mobile app, consommé par
   * `pushLiveActivityState` (hook dans broadcastAgentState côté run.ts). Perdu au restart = OK
   * (l'Island se périme via stale-date côté iOS).
   */
  private liveActivities = new Map<string, { token: string; agentId: string; startedAt: number }>();

  /**
   * Throttle des pushs de **progression de préfill** par session (epoch ms du dernier envoi).
   * Les frames stats Mercury arrivent en rafale ; on coalesce à ≈1 push / 1.5 s pour rester
   * loin du budget APNs tout en gardant une jauge qui avance, tel verrouillé. Purgé avec le token.
   */
  private lastProgressPush = new Map<string, number>();
  private static readonly PROGRESS_MIN_INTERVAL_MS = 1500;

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    this.buildFromConfig();
  }

  /**
   * Reconstruit le client APNs depuis `ctx.config.push` (lu À CHAUD). Appelé au boot et
   * à chaque save de la config UI (PUT /api/push/config) — miroir de telegramMod.restartAll().
   */
  reload(): void {
    this.client?.close();
    this.client = null;
    this.production = false;
    this.topic = null;
    this.buildFromConfig();
  }

  private buildFromConfig(): void {
    const cfg = this.ctx.config.push;
    if (!cfg?.enabled) {
      console.log('[push] disabled (config.push.enabled !== true) — registry still records tokens, no APNs sends');
      return;
    }
    const apns = cfg.apns;
    if (!apns?.keyId || !apns?.teamId || !apns?.topic) {
      console.warn('[push] enabled but apns.{keyId,teamId,topic} incomplete — APNs sends disabled');
      return;
    }
    let keyP8: string | undefined = apns.keyP8;
    if (!keyP8 && apns.keyPath) {
      try {
        keyP8 = fs.readFileSync(apns.keyPath, 'utf8');
        console.debug(`[push] loaded APNs key from ${apns.keyPath} (${keyP8.length} chars)`);
      } catch (err) {
        console.error(`[push] failed reading apns.keyPath="${apns.keyPath}": ${err instanceof Error ? err.message : err}`);
        return;
      }
    }
    if (!keyP8) {
      console.warn('[push] enabled but neither apns.keyP8 nor a readable apns.keyPath provided — APNs sends disabled');
      return;
    }
    try {
      this.production = !!apns.production;
      this.topic = apns.topic;
      this.client = new ApnsClient({
        keyP8,
        keyId: apns.keyId,
        teamId: apns.teamId,
        topic: apns.topic,
        production: this.production,
      });
      console.log(`[push] APNs ready topic=${apns.topic} prod=${this.production}`);
    } catch (err) {
      console.error(`[push] APNs client init failed (bad .p8 key?): ${err instanceof Error ? err.message : err}`);
      this.client = null;
    }
  }

  /** true si on peut effectivement envoyer (config OK + clé chargée). */
  isEnabled(): boolean {
    return this.client !== null;
  }

  // ── Registry ──────────────────────────────────────────────

  /** Upsert d'un device token (appelé par POST /api/push/register). Idempotent. */
  async registerDevice(token: string, platform: string, agentId?: string | null): Promise<void> {
    const t = token.trim();
    if (!t) throw new Error('empty device token');
    await this.ctx.db.query(
      `INSERT INTO push_devices (token, platform, agent_id, disabled, created_at, last_seen_at)
         VALUES ($1, $2, $3, false, NOW(), NOW())
       ON CONFLICT (token) DO UPDATE
         SET platform = EXCLUDED.platform,
             agent_id = EXCLUDED.agent_id,
             disabled = false,
             last_seen_at = NOW()`,
      [t, platform || 'ios', agentId ?? null],
    );
    console.log(`[push] device registered platform=${platform} agent=${agentId ?? '-'} token=…${t.slice(-8)}`);
  }

  async removeDevice(token: string): Promise<boolean> {
    const res = await this.ctx.db.query(`DELETE FROM push_devices WHERE token = $1`, [token.trim()]);
    const removed = (res.rowCount ?? 0) > 0;
    console.log(`[push] device unregister token=…${token.trim().slice(-8)} removed=${removed}`);
    return removed;
  }

  async listDevices(): Promise<PushDeviceRow[]> {
    const res = await this.ctx.db.query<{
      token: string; platform: string; agent_id: string | null; created_at: string; last_seen_at: string;
    }>(
      `SELECT token, platform, agent_id, created_at, last_seen_at
         FROM push_devices WHERE disabled = false ORDER BY last_seen_at DESC`,
    );
    return res.rows.map(r => ({
      token: r.token, platform: r.platform, agentId: r.agent_id,
      createdAt: r.created_at, lastSeenAt: r.last_seen_at,
    }));
  }

  async countActive(): Promise<number> {
    const res = await this.ctx.db.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM push_devices WHERE disabled = false`);
    return Number(res.rows[0]?.n ?? 0);
  }

  async getStatus(): Promise<PushStatus> {
    return {
      enabled: this.isEnabled(),
      configured: !!this.ctx.config.push?.apns?.keyId,
      production: this.production,
      topic: this.topic,
      deviceCount: await this.countActive().catch(() => 0),
    };
  }

  // ── Send ──────────────────────────────────────────────────

  /**
   * Pousse `payload` vers tous les appareils actifs. Best-effort, ne throw pas.
   * Purge (disabled=true) les tokens morts (410 Unregistered / BadDeviceToken).
   */
  async sendToAll(payload: ApnsPayload): Promise<PushSendResult> {
    const result: PushSendResult = { attempted: 0, delivered: 0, pruned: 0, errors: [] };
    if (!this.client) {
      result.errors.push('push not enabled');
      return result;
    }
    const devices = await this.listDevices();
    if (devices.length === 0) {
      console.debug('[push] sendToAll: 0 active device(s)');
      return result;
    }
    console.log(`[push] sendToAll devices=${devices.length} title="${payload.title.slice(0, 60)}"`);
    const deadTokens: string[] = [];
    for (const d of devices) {
      result.attempted++;
      const outcome = await this.client.send(d.token, payload);
      if (outcome.ok) {
        result.delivered++;
        console.debug(`[push] sent token=…${d.token.slice(-8)} apnsId=${outcome.apnsId ?? '-'}`);
      } else {
        result.errors.push(`…${d.token.slice(-8)}: ${outcome.reason}`);
        console.warn(`[push] send failed token=…${d.token.slice(-8)} status=${outcome.status} reason=${outcome.reason} dead=${outcome.dead}`);
        if (outcome.dead) deadTokens.push(d.token);
      }
    }
    if (deadTokens.length > 0) {
      try {
        const res = await this.ctx.db.query(
          `UPDATE push_devices SET disabled = true WHERE token = ANY($1::text[])`,
          [deadTokens],
        );
        result.pruned = res.rowCount ?? 0;
        console.log(`[push] pruned ${result.pruned} dead token(s)`);
      } catch (err) {
        console.warn(`[push] prune failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`[push] sendToAll done attempted=${result.attempted} delivered=${result.delivered} pruned=${result.pruned} errors=${result.errors.length}`);
    return result;
  }

  // ── Live Activity (Dynamic Island) push ───────────────────

  /** Enregistre/rafraîchit le push token d'une Live Activity pour une session (POST /api/push/liveactivity/register). */
  registerLiveActivity(sessionId: string, agentId: string, token: string, startedAt: number): void {
    const t = token.trim();
    if (!sessionId || !t) return;
    this.liveActivities.set(sessionId, { token: t, agentId, startedAt });
    console.log(`[push] LA token registered session=${sessionId} agent=${agentId} token=…${t.slice(-8)}`);
  }

  /**
   * Pousse l'état du run dans la Live Activity de la session (si un token est enregistré).
   * `idle`/`warm.done` → event `end` (retire l'activité après ~4 s). Sinon → `update`.
   * Best-effort, ne throw jamais. Purge le token sur réponse APNs "morte".
   */
  async pushLiveActivityState(sessionId: string, agentId: string, phase: string): Promise<void> {
    if (!this.client) return;
    const entry = this.liveActivities.get(sessionId);
    if (!entry || entry.agentId !== agentId) return;

    const isEnd = phase === 'idle' || phase === 'warm.done';
    // Mappe vers les phases connues du widget iOS (sandbox → thinking ; fin → done).
    const mappedPhase = isEnd ? 'done' : phase === 'sandbox' ? 'thinking' : phase;
    const now = Math.floor(Date.now() / 1000);
    // content-state DOIT matcher AgentActivityAttributes.ContentState. Sur push on ne porte
    // QUE l'état : le texte token-par-token ET le détail préfill/raisonnement (detail/progress,
    // champs optionnels iOS) restent l'update locale 1er plan — absents ici, décodés nil.
    const contentState = { phase: mappedPhase, tool: null, startedAt: entry.startedAt, preview: null };

    const outcome = isEnd
      ? await this.client.sendLiveActivity(entry.token, { event: 'end', contentState, timestamp: now, dismissalDate: now + 4 })
      : await this.client.sendLiveActivity(entry.token, { event: 'update', contentState, timestamp: now, staleDate: now + 600 });

    if (isEnd) {
      this.liveActivities.delete(sessionId);
      this.lastProgressPush.delete(sessionId);
    } else if (!outcome.ok && outcome.dead) {
      this.liveActivities.delete(sessionId);
      this.lastProgressPush.delete(sessionId);
      console.warn(`[push] LA token dead, purged session=${sessionId} reason=${outcome.reason}`);
    }
    if (!outcome.ok) {
      console.warn(`[push] LA ${isEnd ? 'end' : 'update'} failed session=${sessionId} phase=${mappedPhase} status=${outcome.status} reason=${outcome.reason}`);
    } else {
      console.debug(`[push] LA ${isEnd ? 'end' : 'update'} session=${sessionId} phase=${mappedPhase}`);
    }
  }

  /**
   * Pousse la **progression du préfill** (chargement modèle / prompt-processing X%) dans la
   * Live Activity, tel verrouillé / app suspendue — là où le moteur local de mobile app est gelé
   * (la jauge restait sinon figée jusqu'au retour au 1er plan). Alimenté par les frames stats
   * Mercury (SSE) côté agent module. Throttlé à ≈1/1.5 s par session, priorité APNs 5 (best-effort,
   * hors budget high-priority). La phase reste `thinking` ; on ne porte QUE detail + progress —
   * le texte de génération reste l'apanage de l'update locale 1er plan. Best-effort, ne throw jamais.
   */
  async pushLiveActivityProgress(
    sessionId: string,
    agentId: string,
    stats: { isLoading?: boolean; isPromptProcessing?: boolean; promptProcessingProgress?: number; promptProcessingTokens?: number },
  ): Promise<void> {
    if (!this.client) return;
    const entry = this.liveActivities.get(sessionId);
    if (!entry || entry.agentId !== agentId) return;

    const now = Date.now();
    const last = this.lastProgressPush.get(sessionId) ?? 0;
    if (now - last < PushModule.PROGRESS_MIN_INTERVAL_MS) return;
    this.lastProgressPush.set(sessionId, now);

    // Libellé aligné sur `ChatStore.prefillStatusLabel` (mobile app) pour un rendu cohérent
    // entre l'update locale et le push.
    let detail: string | null = null;
    let progress: number | null = null;
    if (stats.isLoading) {
      detail = 'chargement du modèle…';
    } else if (stats.isPromptProcessing) {
      if (typeof stats.promptProcessingProgress === 'number') {
        progress = Math.max(0, Math.min(100, Math.round(stats.promptProcessingProgress)));
        detail = `traitement du prompt… ${progress}%`;
      } else if (typeof stats.promptProcessingTokens === 'number') {
        const t = stats.promptProcessingTokens;
        const tok = t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`;
        detail = `traitement du prompt… ${tok}`;
      } else {
        detail = 'traitement du prompt…';
      }
    }
    // Ni loading ni prompt-processing → c'est un clear (premier token généré) : on retombe
    // sur le libellé générique de phase côté widget (detail/progress nil).

    const ts = Math.floor(now / 1000);
    const contentState = {
      phase: 'thinking',
      tool: null,
      startedAt: entry.startedAt,
      preview: null,
      detail,
      progress,
    };
    const outcome = await this.client.sendLiveActivity(entry.token, {
      event: 'update',
      contentState,
      timestamp: ts,
      staleDate: ts + 600,
      priority: '5',
    });
    if (!outcome.ok && outcome.dead) {
      this.liveActivities.delete(sessionId);
      this.lastProgressPush.delete(sessionId);
      console.warn(`[push] LA token dead (progress), purged session=${sessionId} reason=${outcome.reason}`);
    } else if (!outcome.ok) {
      console.warn(`[push] LA progress failed session=${sessionId} detail="${detail}" status=${outcome.status} reason=${outcome.reason}`);
    } else {
      console.debug(`[push] LA progress session=${sessionId} detail="${detail}" progress=${progress}`);
    }
  }

  async destroy(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.liveActivities.clear();
    this.lastProgressPush.clear();
  }
}
