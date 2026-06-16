import fs from 'node:fs';
import path from 'node:path';
import type { AutoWarmupConfig } from '@mastermind/shared';

type WarmupFn         = (agentId: string, sessionId: string) => Promise<void>;
type GetStateFn       = (agentId: string) => string;
type GetStarredFiles  = (agentId: string) => string[];
type ListSessionsFn   = (agentId: string) => Promise<Array<{ id: string; updatedAt: string }>>;
type ScheduleBroadcast = (firesAt: string | null) => void;
type QueueBroadcast    = (queue: string[], processing: string | null) => void;
type AgentDoneBroadcast = (agentId: string, completedAt: string) => void;

/**
 * Queue globale de warmup KV-cache.
 *
 * Un seul timer global (resetté à chaque activité agent ou file-change).
 * Quand le timer expire, la queue est traitée séquentiellement.
 * Un agent réactivé pendant qu'il est déjà dans la queue est déplacé en fin de queue.
 */
export class GlobalWarmupQueue {
  private queue: string[]                 = [];   // agentIds dans l'ordre de traitement
  private processing: string | null       = null; // agent en cours de warmup
  private isProcessingQueue               = false;
  private lastWarmup                      = new Map<string, Date>();  // agentId → dernière complétion

  // Session la plus récente connue par agent (évite un aller-retour DB au moment du warmup)
  private sessionByAgent = new Map<string, { sessionId: string; updatedAt: number }>();

  private globalTimer: ReturnType<typeof setTimeout> | null = null;
  private globalFiresAt: Date | null = null;

  // File watchers
  private fileWatchers = new Map<string, fs.FSWatcher>();
  private fileDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private fileToAgents = new Map<string, Set<string>>();

  private get enabled()       { return this.cfg.enabled !== false; }
  private get idleMs()        { return (this.cfg.globalWarmupIdleMinutes ?? 25) * 60_000; }
  private get fileDebounceMs(){ return (this.cfg.fileDebounceSeconds ?? 3) * 1_000; }
  private get activityWindowMs(){ return (this.cfg.recentActivityHours ?? 24) * 3_600_000; }

  constructor(
    private cfg: AutoWarmupConfig,
    private warmupFn: WarmupFn,
    private getState: GetStateFn,
    private getStarredFiles: GetStarredFiles,
    private listSessionsByAgent: ListSessionsFn,
    private sharedMemoryDir: string,
    private onSchedule?: ScheduleBroadcast,
    private onQueueUpdate?: QueueBroadcast,
    private onAgentDone?: AgentDoneBroadcast,
  ) {}

  // ─── API publique ────────────────────────────────────────────────────────────

  /**
   * Appelé après chaque run réussi.
   * Enregistre la session active de l'agent pour les warmups déclenchés par file-change.
   * Remet le timer à zéro uniquement si la queue n'est pas vide (pour retarder un warmup déjà planifié).
   */
  notifyActivity(agentId: string, sessionId: string): void {
    if (!this.enabled) return;
    this.sessionByAgent.set(agentId, { sessionId, updatedAt: Date.now() });
    // Reset le timer seulement si quelque chose est déjà en queue
    // (préserve le comportement "reset auto si message envoyé pendant l'attente")
    if (this.queue.length > 0) {
      this.resetGlobalTimer();
    }
  }

  /** Reconstruire les watchers pour un agent (init, changement de config, ajout d'agent). */
  updateWatchedFiles(agentId: string): void {
    for (const [fpath, agents] of this.fileToAgents) {
      agents.delete(agentId);
      if (agents.size === 0) {
        this.stopWatcher(fpath);
        this.fileToAgents.delete(fpath);
      }
    }
    if (!this.enabled) return;
    for (const relPath of this.getStarredFiles(agentId)) {
      if (!relPath) continue;
      const abs = path.join(this.sharedMemoryDir, relPath);
      if (!this.fileToAgents.has(abs)) this.fileToAgents.set(abs, new Set());
      this.fileToAgents.get(abs)!.add(agentId);
      this.startWatcher(abs);
    }
  }

  /** Nettoyer toutes les ressources d'un agent supprimé. */
  removeAgent(agentId: string): void {
    console.debug(`[autoWarmup] removeAgent ${agentId}`);
    const idx = this.queue.indexOf(agentId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      this.onQueueUpdate?.(this.queue, this.processing);
    }
    this.sessionByAgent.delete(agentId);
    this.lastWarmup.delete(agentId);
    for (const [fpath, agents] of this.fileToAgents) {
      agents.delete(agentId);
      if (agents.size === 0) {
        this.stopWatcher(fpath);
        this.fileToAgents.delete(fpath);
      }
    }
  }

  /** Mettre à jour la config à chaud (SettingsPage). */
  updateConfig(cfg: AutoWarmupConfig): void {
    Object.assign(this.cfg, cfg);
  }

  /** Libérer toutes les ressources (shutdown). */
  destroy(): void {
    if (this.globalTimer !== null) clearTimeout(this.globalTimer);
    for (const t of this.fileDebounce.values()) clearTimeout(t);
    for (const w of this.fileWatchers.values()) w.close();
    this.globalTimer = null;
    this.globalFiresAt = null;
    this.queue = [];
    this.processing = null;
    this.isProcessingQueue = false;
    this.fileDebounce.clear();
    this.fileWatchers.clear();
    this.fileToAgents.clear();
    this.sessionByAgent.clear();
    this.lastWarmup.clear();
  }

  // ─── Timer global ────────────────────────────────────────────────────────────

  /**
   * Déplace l'agent en fin de queue (le retire de sa position actuelle si présent).
   * Diffuse l'état de la queue au frontend.
   */
  private pushToBack(agentId: string): void {
    const idx = this.queue.indexOf(agentId);
    if (idx !== -1) this.queue.splice(idx, 1);
    this.queue.push(agentId);
    this.onQueueUpdate?.(this.queue, this.processing);
  }

  /**
   * Retire l'agent qu'on vient de traiter, par IDENTITÉ et seulement s'il est toujours en tête.
   *
   * `processQueue` lit `queue[0]` puis `await warmupFn(...)` (plusieurs secondes). Pendant cet
   * await, des mutateurs synchrones (`pushToBack` sur file-change, `removeAgent` sur delete/config)
   * peuvent réordonner ou retirer la tête. Un `queue.shift()` positionnel évincerait alors le
   * MAUVAIS agent (le suivant, jamais warm → perdu silencieusement). On ne retire donc que si la
   * tête est encore l'agent traité :
   *   - tête inchangée            → on la retire (cas nominal) ;
   *   - `removeAgent` l'a splicé  → la tête est déjà l'agent suivant, on n'y touche pas ;
   *   - `pushToBack` l'a déplacé  → re-warm légitime demandé pendant le warmup, on le laisse en
   *                                 queue (et on ne touche pas la nouvelle tête).
   */
  private dequeueHead(agentId: string): void {
    if (this.queue[0] === agentId) {
      this.queue.shift();
    } else {
      console.debug(`[autoWarmup] dequeueHead: head moved during await (expected ${agentId}, got ${this.queue[0] ?? '∅'}) — leaving queue intact`);
    }
    this.onQueueUpdate?.(this.queue, this.processing);
  }

  /** Remet le timer global à zéro. Toute activité (run ou file-change) appelle cette méthode. */
  private resetGlobalTimer(): void {
    if (this.globalTimer !== null) clearTimeout(this.globalTimer);
    const delay = this.idleMs;
    this.globalFiresAt = new Date(Date.now() + delay);
    const timer = setTimeout(() => void this.processQueue(), delay);
    if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();
    this.globalTimer = timer;
    this.onSchedule?.(this.globalFiresAt.toISOString());
  }

  // ─── Traitement de la queue ──────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      console.debug('[autoWarmup] processQueue re-entry blocked');
      return;
    }
    this.isProcessingQueue = true;
    try {
    this.globalTimer    = null;
    this.globalFiresAt  = null;
    this.onSchedule?.(null);
    console.debug(`[autoWarmup] processQueue start: ${this.queue.length} agent(s) in queue: ${this.queue.join(', ')}`);

    while (this.queue.length > 0) {
      if (!this.enabled) break;

      const agentId = this.queue[0];

      // Agent occupé (conversation en cours) — skip, sera re-ajouté après son run
      if (this.getState(agentId) !== 'idle') {
        console.debug(`[autoWarmup] skip ${agentId}: state=${this.getState(agentId)}`);
        this.dequeueHead(agentId);
        continue;
      }

      const sessionId = await this.bestSession(agentId);
      if (!sessionId) {
        console.debug(`[autoWarmup] skip ${agentId}: no recent session`);
        // Aucune session récente — inutile de warmer
        this.dequeueHead(agentId);
        continue;
      }

      this.processing = agentId;
      this.onQueueUpdate?.(this.queue, this.processing);
      console.log(`[autoWarmup] Queue warmup: ${agentId} / ${sessionId}`);

      try {
        await this.warmupFn(agentId, sessionId);
        const completedAt = new Date();
        this.lastWarmup.set(agentId, completedAt);
        this.onAgentDone?.(agentId, completedAt.toISOString());
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[autoWarmup] Queue warmup failed (${agentId}): ${msg}`);
      }

      this.processing = null;
      this.dequeueHead(agentId);
    }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Retourne la session la plus récente pour un agent.
   * Priorité : mémoire (dernière activité connue) → DB en fallback.
   */
  private async bestSession(agentId: string): Promise<string | null> {
    const inMem = this.sessionByAgent.get(agentId);
    if (inMem && (Date.now() - inMem.updatedAt) < this.activityWindowMs) {
      return inMem.sessionId;
    }
    try {
      const all = await this.listSessionsByAgent(agentId);
      const cutoff = Date.now() - this.activityWindowMs;
      const sorted = all
        .filter(s => new Date(s.updatedAt).getTime() > cutoff)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      return sorted[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  // ─── File watchers ───────────────────────────────────────────────────────────

  private startWatcher(abs: string): void {
    if (this.fileWatchers.has(abs)) return;
    try {
      const w = fs.watch(abs, { persistent: false }, () => this.onFileChange(abs));
      w.on('error', () => {
        console.warn(`[autoWarmup] Watcher error, stopping: ${abs}`);
        this.stopWatcher(abs);
      });
      this.fileWatchers.set(abs, w);
      console.log(`[autoWarmup] Watching: ${abs}`);
    } catch (err) {
      console.debug(`[autoWarmup] startWatcher failed ${abs}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private stopWatcher(abs: string): void {
    this.fileWatchers.get(abs)?.close();
    this.fileWatchers.delete(abs);
    clearTimeout(this.fileDebounce.get(abs));
    this.fileDebounce.delete(abs);
  }

  private onFileChange(abs: string): void {
    console.debug(`[autoWarmup] file change detected: ${path.basename(abs)}`);
    clearTimeout(this.fileDebounce.get(abs));
    const t = setTimeout(() => void this.fireFileWarmup(abs), this.fileDebounceMs);
    this.fileDebounce.set(abs, t);
  }

  private async fireFileWarmup(abs: string): Promise<void> {
    if (!this.enabled) return;
    const agentIds = this.fileToAgents.get(abs) ?? new Set<string>();
    for (const agentId of agentIds) {
      // N'ajouter à la queue que si l'agent a une session récente
      const sessionId = await this.bestSession(agentId);
      if (!sessionId) continue;
      this.pushToBack(agentId);
      this.resetGlobalTimer();
      console.log(`[autoWarmup] File change queued: ${agentId} (${path.basename(abs)})`);
    }
  }
}
