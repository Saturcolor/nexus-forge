import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Clock, Wifi, WifiOff, BookMarked, Database, Cpu, Send, Flame, X, BrainCircuit, CalendarClock, Plug, Bot } from 'lucide-react';
import { CsIndicesPanel } from './CsIndicesPanel';
import { clsx } from 'clsx';
import type { CodebaseSearchStatusResponse, ProactiveSource } from '@mastermind/shared';

interface AgentMeta { id: string; name: string; emoji: string; }

interface MemoryStoreStatus {
  enabled: boolean;
  total?: number;
  perAgent?: Record<string, number>;
  perScope?: Record<string, number>;
  perDomain?: Record<string, number>;
  lastEntryAt?: string | null;
  embeddingDimensions?: number;
}

interface DbStats {
  ok: boolean;
  sessions?: number;
  messages?: number;
  messagesCompacted?: number;
  reasoningTraces?: number;
  memories?: number;
  scheduledTasks?: number;
  activeJobs?: number;
  dbSize?: string | null;
  lastMessageAt?: string | null;
  lastSessionAt?: string | null;
}

interface StatusData {
  uptime: number;
  database: DbStats;
  providers: { id: string; type: string; reachable: boolean }[];
  telegram: { id: string; running: boolean; enabled: boolean }[];
  agents: { id: string; state: string }[];
  memoryStore?: MemoryStoreStatus;
}

interface HealthData {
  ok: boolean;
  version: string;
  uptime: number;
}

interface CsStatusRaw {
  enabled: boolean;
  resolvedIndices: Record<string, string>;
  resolvedDefaultDbPath?: string;
  resolvedEmbedSources?: Record<string, string>;
  lastEmbedRuns?: Record<string, {
    at: string;
    status: 'ok' | 'error' | 'running';
    message?: string;
    progress?: { phase: string; done: number; total: number };
  }>;
}

interface CsIndexInfo {
  key: string;
  sourcePath: string;
  dbPath: string;
  totalChunks?: number;
}

interface CsData {
  enabled: boolean;
  indexCount: number;
  totalChunks: number | null;
  runningPct: number | null;
  runningPhase: string | null;
  hasError: boolean;
  indices?: CsIndexInfo[];
  defaultDbPath?: string;
}

function parseCsData(s: CsStatusRaw, prevChunks: number | null, chunksMap: Map<string, number>): CsData {
  const indexCount =
    Object.keys(s.resolvedIndices).length + (s.resolvedDefaultDbPath ? 1 : 0);

  let runningPct: number | null = null;
  let runningPhase: string | null = null;
  let hasError = false;

  const runs = s.lastEmbedRuns ?? {};
  for (const run of Object.values(runs)) {
    if (run.status === 'error') hasError = true;
    if (run.status === 'running') {
      runningPhase = run.progress?.phase ?? 'indexing';
      if (run.progress && run.progress.total > 0) {
        runningPct = Math.round((run.progress.done / run.progress.total) * 100);
      } else {
        runningPct = -1;
      }
    }
  }

  const indices: CsIndexInfo[] = [];
  Object.entries(s.resolvedIndices).forEach(([key, dbPath]) => {
    const sourcePath = s.resolvedEmbedSources?.[key] ?? '';
    const totalChunks = chunksMap.get(key) ?? 0;
    indices.push({ key, sourcePath, dbPath, totalChunks });
  });
  if (s.resolvedDefaultDbPath) {
    const sourcePath = s.resolvedEmbedSources?.['default'] ?? '';
    const totalChunks = chunksMap.get('default') ?? 0;
    indices.push({ key: 'default', sourcePath, dbPath: s.resolvedDefaultDbPath, totalChunks });
  }

  return { 
    enabled: s.enabled, 
    indexCount, 
    totalChunks: prevChunks, 
    runningPct, 
    runningPhase, 
    hasError,
    indices,
    defaultDbPath: s.resolvedDefaultDbPath
  };
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatChunks(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function Sep() {
  return <div className="h-3 w-px bg-border/50 shrink-0 mx-0.5" />;
}

function ConnectivityBadge({
  online,
  version,
  liveUptime,
  wsConnected,
  lastLoadAt,
  onForceRefresh,
}: {
  online: boolean;
  version: string;
  liveUptime: number | null;
  wsConnected: boolean;
  lastLoadAt: Date | null;
  onForceRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          online
            ? 'bg-emerald-500/10 border-emerald-400/25 text-emerald-400 hover:bg-emerald-500/20'
            : 'bg-destructive/10 border-destructive/25 text-destructive',
          open && 'ring-1 ring-emerald-400/40',
        )}
        title="Connectivité backend"
      >
        {online ? <Wifi size={9} /> : <WifiOff size={9} />}
        <span>{online ? 'online' : 'offline'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-[9999] w-[260px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              {online ? <Wifi size={9} className="text-emerald-400" /> : <WifiOff size={9} className="text-destructive" />}
              Connectivité
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* HTTP status */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
            <span className="text-[10px] text-muted-foreground/60">HTTP /api/status</span>
            <span className={clsx('text-[11px] font-mono font-semibold', online ? 'text-emerald-400' : 'text-destructive')}>
              {online ? '● ok' : '● erreur'}
            </span>
          </div>

          {/* WS status */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
            <span className="text-[10px] text-muted-foreground/60">WebSocket</span>
            <span className={clsx('text-[11px] font-mono font-semibold', wsConnected ? 'text-emerald-400' : 'text-destructive')}>
              {wsConnected ? '● connecté' : '● disconnect'}
            </span>
          </div>

          {/* Backend meta */}
          <div className="px-3 py-2 space-y-1 border-b border-border/40">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/60">Version</span>
              <span className="text-[10px] font-mono text-foreground/70">{version || '—'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/60">Uptime</span>
              <span className="text-[10px] font-mono text-foreground/70 tabular-nums">
                {liveUptime !== null ? formatUptime(liveUptime) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground/60 shrink-0">Host</span>
              <span className="text-[10px] font-mono text-foreground/70 truncate" title={window.location.host}>
                {window.location.host}
              </span>
            </div>
            {lastLoadAt && (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground/60">Dernier poll</span>
                <span className="text-[10px] font-mono text-muted-foreground/50">il y a {formatAgo(lastLoadAt)}</span>
              </div>
            )}
          </div>

          {/* Force refresh */}
          <button
            onClick={() => { onForceRefresh(); }}
            className="w-full px-3 py-2 text-[10px] font-mono text-emerald-400/80 hover:text-emerald-400 hover:bg-emerald-500/5 transition-colors text-left"
          >
            ↻ Forcer un refresh
          </button>
        </div>
      )}
    </div>
  );
}

function DbBadge({ db }: { db: DbStats }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const { ok } = db;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          ok
            ? 'bg-blue-500/10 border-blue-400/25 text-blue-400 hover:bg-blue-500/20'
            : 'bg-destructive/10 border-destructive/25 text-destructive',
          open && 'ring-1 ring-blue-400/40',
        )}
      >
        <Database size={9} />
        <span>DB</span>
        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', ok ? 'bg-blue-400' : 'bg-destructive')} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999] w-[220px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Database size={9} className="text-blue-400" />
              Base de données
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* Status */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
            <span className="text-[10px] text-muted-foreground/60">Statut</span>
            <span className={clsx('text-[11px] font-mono font-semibold', ok ? 'text-blue-400' : 'text-destructive')}>
              {ok ? '● connectée' : '● erreur'}
            </span>
          </div>

          {/* DB size on disk */}
          {ok && db.dbSize != null && (
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
              <span className="text-[10px] text-muted-foreground/60">Taille</span>
              <span className="text-[11px] font-mono text-foreground/70 tabular-nums">{db.dbSize}</span>
            </div>
          )}

          {/* Table counts */}
          {ok && (
            <div className="px-3 py-2 space-y-1.5 border-b border-border/40">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block">Tables</span>
              {[
                { label: 'sessions', value: db.sessions },
                { label: 'messages', value: db.messages },
                { label: 'msgs compactés', value: db.messagesCompacted, hideZero: true },
                { label: 'reasoning traces', value: db.reasoningTraces },
                { label: 'mémoires', value: db.memories, hideZero: true },
                { label: 'tâches planifiées', value: db.scheduledTasks, hideZero: true },
              ].map(({ label, value, hideZero }) => value != null && !(hideZero && value === 0) && (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground/60">{label}</span>
                  <span className="text-[11px] font-mono text-foreground/70 tabular-nums">
                    {value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Last activity */}
          {ok && (db.lastMessageAt || db.lastSessionAt || (db.activeJobs ?? 0) > 0) && (
            <div className="px-3 py-2 space-y-1">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block">Activité</span>
              {db.lastMessageAt && (
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-muted-foreground/40">Dernier message</span>
                  <span className="text-[10px] font-mono text-muted-foreground/40">
                    il y a {formatAgo(new Date(db.lastMessageAt))}
                  </span>
                </div>
              )}
              {db.lastSessionAt && (
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-muted-foreground/40">Dernière session</span>
                  <span className="text-[10px] font-mono text-muted-foreground/40">
                    il y a {formatAgo(new Date(db.lastSessionAt))}
                  </span>
                </div>
              )}
              {(db.activeJobs ?? 0) > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-muted-foreground/40">Jobs actifs</span>
                  <span className="text-[10px] font-mono text-theme-orange/70 tabular-nums">{db.activeJobs}</span>
                </div>
              )}
            </div>
          )}

          {!ok && (
            <div className="px-3 py-3 text-[10px] text-destructive/60 text-center">
              Connexion impossible
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ProviderDetail {
  id: string;
  type: string;
  reachable: boolean;
  baseUrl?: string;
  modelsUrl?: string;
  statsUrl?: string;
}

interface ExposedModel { providerId: string; id: string; name: string; contextLength?: number }
interface EmbeddingChainEntry { priority?: number; dim?: number; backend?: string; model?: string; ok?: boolean }

function ProviderBadge({ provider }: { provider: ProviderDetail }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<ExposedModel[] | null>(null);
  const [chain, setChain] = useState<EmbeddingChainEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Lazy fetch des détails à l'ouverture (one-shot, pas de polling)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const m = await api.get<ExposedModel[]>(`/api/providers/${encodeURIComponent(provider.id)}/exposed-models`);
        if (!cancelled) setModels(m);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'fetch failed');
      }
      if (provider.type === 'mercury') {
        try {
          const c = await api.get<{ chain?: EmbeddingChainEntry[] } | EmbeddingChainEntry[]>(`/api/providers/${encodeURIComponent(provider.id)}/embedding-chain`);
          if (!cancelled) {
            const arr = Array.isArray(c) ? c : c.chain;
            setChain(arr ?? []);
          }
        } catch { /* best-effort, embedding chain optional */ }
      }
    })();
    return () => { cancelled = true; };
  }, [open, provider.id, provider.type]);

  const { id, type, reachable, baseUrl } = provider;
  const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          reachable
            ? 'bg-violet-500/10 border-violet-400/25 text-violet-400 hover:bg-violet-500/20'
            : 'bg-destructive/10 border-destructive/25 text-destructive',
          open && 'ring-1 ring-violet-400/40',
        )}
        title={`Provider ${id} (${type})`}
      >
        <Cpu size={9} />
        <span>{id}</span>
        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', reachable ? 'bg-violet-400' : 'bg-destructive')} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999] w-[280px] max-h-[420px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30 shrink-0">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Cpu size={9} className="text-violet-400" />
              {id}
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* Status + meta */}
          <div className="px-3 py-2 space-y-1.5 border-b border-border/40 shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/60">Statut</span>
              <span className={clsx('text-[11px] font-mono font-semibold', reachable ? 'text-violet-400' : 'text-destructive')}>
                {reachable ? '● reachable' : '● unreachable'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/60">Type</span>
              <span className="text-[10px] font-mono text-foreground/70">{type}</span>
            </div>
            {baseUrl && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground/60 shrink-0">Base URL</span>
                <span className="text-[10px] font-mono text-foreground/70 truncate" title={baseUrl}>{truncate(baseUrl, 32)}</span>
              </div>
            )}
          </div>

          {/* Modèles exposés */}
          <div className="overflow-y-auto flex-1">
            <div className="px-3 py-2 border-b border-border/40">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block mb-1.5">
                Modèles exposés {models && <span className="text-muted-foreground/40 normal-case font-mono">— {models.length}</span>}
              </span>
              {loadError ? (
                <span className="text-[10px] text-destructive/70">⚠ {loadError}</span>
              ) : !models ? (
                <span className="text-[10px] text-muted-foreground/40">chargement…</span>
              ) : models.length === 0 ? (
                <span className="text-[10px] text-muted-foreground/40">Aucun modèle exposé</span>
              ) : (
                <div className="space-y-0.5">
                  {models.slice(0, 8).map(m => (
                    <div key={m.id} className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-mono text-foreground/70 truncate" title={m.id}>{m.name || m.id}</span>
                      {m.contextLength && (
                        <span className="text-[9px] font-mono text-muted-foreground/40 shrink-0 tabular-nums">
                          {m.contextLength >= 1000 ? `${Math.round(m.contextLength / 1000)}k` : m.contextLength}
                        </span>
                      )}
                    </div>
                  ))}
                  {models.length > 8 && (
                    <span className="text-[9px] text-muted-foreground/35 italic">+ {models.length - 8} autres…</span>
                  )}
                </div>
              )}
            </div>

            {/* Embedding chain (Mercury) */}
            {type === 'mercury' && chain !== null && chain.length > 0 && (
              <div className="px-3 py-2">
                <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block mb-1.5">
                  Embedding chain
                </span>
                <div className="space-y-0.5">
                  {chain.map((e, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 text-[10px] font-mono text-foreground/70 truncate">
                        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', e.ok === false ? 'bg-destructive' : 'bg-violet-400/60')} />
                        <span className="truncate" title={e.model ?? e.backend ?? '?'}>{e.backend ?? e.model ?? '?'}</span>
                      </span>
                      {e.dim !== undefined && (
                        <span className="text-[9px] font-mono text-muted-foreground/40 shrink-0 tabular-nums">{e.dim}d</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface TelegramBotStatus { id: string; running: boolean; enabled: boolean }

function TelegramBadge({ bots }: { bots: TelegramBotStatus[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const enabled = bots.filter(b => b.enabled);
  const running = enabled.filter(b => b.running).length;
  const total = enabled.length;
  const allRunning = total > 0 && running === total;
  const someDown = total > 0 && running < total;

  // Couleurs : sky si tout tourne, destructive si au moins un down (visible alerte),
  // muted si rien d'activé (cas edge — le badge est juste pas affiché par StatusBar).
  const accent = allRunning
    ? 'bg-cyan-500/10 border-cyan-400/25 text-cyan-400 hover:bg-cyan-500/20'
    : someDown
      ? 'bg-destructive/10 border-destructive/25 text-destructive hover:bg-destructive/20'
      : 'bg-secondary/60 border-border/50 text-muted-foreground/50';
  const dotClass = allRunning
    ? 'bg-cyan-400 animate-pulse'
    : someDown
      ? 'bg-destructive'
      : 'bg-muted-foreground/30';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          accent,
          open && 'ring-1 ring-cyan-400/40',
        )}
        title={`${running}/${total} bot(s) Telegram en ligne`}
      >
        <Send size={9} />
        <span className="tabular-nums">{running}/{total}</span>
        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', dotClass)} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999] w-[240px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Send size={9} className="text-cyan-400" />
              Bots Telegram
              <span className="text-muted-foreground/60 font-mono normal-case tracking-normal">— {running}/{total}</span>
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* Bot list */}
          {enabled.length === 0 ? (
            <div className="px-3 py-3 text-[10px] text-muted-foreground/40 text-center">
              Aucun bot activé
            </div>
          ) : (
            <div className="py-1">
              {enabled.map(bot => (
                <div key={bot.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-secondary/30 transition-colors">
                  <span className="text-[11px] font-mono text-foreground/80 truncate max-w-[150px]" title={bot.id}>
                    {bot.id}
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span className={clsx(
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      bot.running ? 'bg-cyan-400 animate-pulse' : 'bg-destructive',
                    )} />
                    <span className={clsx(
                      'text-[10px] font-mono',
                      bot.running ? 'text-cyan-400' : 'text-destructive',
                    )}>
                      {bot.running ? 'online' : 'offline'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Footer hint when something is down */}
          {someDown && (
            <div className="px-3 py-1.5 border-t border-border/40 bg-secondary/20">
              <span className="text-[9px] text-muted-foreground/50">
                Bot(s) hors ligne — vérifie config / logs
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SandboxJobLite {
  id: string;
  agentId: string;
  sessionId: string;
  args: Record<string, unknown>;
  startedAt: string | null;
}

/** State label + dot color for the popup row. Matches AgentDetailPage convention so visual
 * cues stay consistent across the UI (sandbox=yellow, thinking=orange, streaming=green). */
function stateAppearance(state: string): { label: string; dotClass: string; textClass: string } {
  switch (state) {
    case 'streaming': return { label: 'streaming',  dotClass: 'bg-theme-green animate-pulse', textClass: 'text-theme-green' };
    case 'thinking':  return { label: 'thinking',   dotClass: 'bg-orange-400 animate-pulse',  textClass: 'text-orange-400' };
    case 'warming':   return { label: 'warming',    dotClass: 'bg-orange-400 animate-pulse',  textClass: 'text-orange-400' };
    case 'sandbox':   return { label: 'sandbox',    dotClass: 'bg-primary animate-pulse',     textClass: 'text-primary' };
    case 'error':     return { label: 'error',      dotClass: 'bg-destructive',               textClass: 'text-destructive' };
    default:          return { label: 'idle',       dotClass: 'bg-muted-foreground/30',       textClass: 'text-muted-foreground/50' };
  }
}

function AgentsBadge({
  agents,
  sandboxJobs,
  agentMeta,
  tick,
}: {
  agents: { id: string; state: string }[];
  sandboxJobs: SandboxJobLite[];
  agentMeta: Map<string, AgentMeta>;
  tick: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const total = agents.length;
  // "active" = tout sauf idle/error — englobe thinking, streaming, sandbox, warming.
  const active = agents.filter(a => a.state !== 'idle' && a.state !== 'error').length;
  const sandboxCount = agents.filter(a => a.state === 'sandbox').length;
  const sandboxJobsByAgent = useMemo(() => {
    const m = new Map<string, SandboxJobLite>();
    for (const j of sandboxJobs) m.set(j.agentId, j);
    return m;
  }, [sandboxJobs]);

  // Tri : actifs (non idle/error) en haut par priorité d'activité, puis idle.
  const STATE_PRIO: Record<string, number> = {
    sandbox: 0, streaming: 1, thinking: 2, warming: 3, error: 4, idle: 5,
  };
  const sortedAgents = useMemo(() => {
    void tick;
    return [...agents].sort((a, b) => {
      const pa = STATE_PRIO[a.state] ?? 5;
      const pb = STATE_PRIO[b.state] ?? 5;
      if (pa !== pb) return pa - pb;
      const na = agentMeta.get(a.id)?.name ?? a.id;
      const nb = agentMeta.get(b.id)?.name ?? b.id;
      return na.localeCompare(nb);
    });
  }, [agents, agentMeta, tick]);

  const formatJobDuration = (startedAt: string | null): string => {
    if (!startedAt) return '';
    const ms = Date.now() - new Date(startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          active > 0
            ? 'bg-yellow-500/10 border-yellow-400/25 text-yellow-400 hover:bg-yellow-500/20'
            : 'bg-secondary/60 border-border/50 text-muted-foreground/50 hover:text-muted-foreground/70',
          open && 'ring-1 ring-yellow-400/40',
        )}
        title={`${active} agent(s) actif(s) sur ${total} chargés${sandboxCount > 0 ? ` (${sandboxCount} en sandbox)` : ''}`}
      >
        <Bot size={9} />
        <span className={clsx(
          'w-1.5 h-1.5 rounded-full shrink-0',
          active > 0 ? 'bg-yellow-400 animate-pulse' : 'bg-muted-foreground/30'
        )} />
        <span className="tabular-nums">{total > 0 ? `${active} / ${total}` : '…'}</span>
        {sandboxCount > 0 && (
          <span className="text-primary tabular-nums">+{sandboxCount}🪁</span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999] w-[300px] max-h-[420px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30 shrink-0">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Bot size={9} className="text-yellow-400" />
              Agents
              <span className="text-muted-foreground/60 font-mono normal-case tracking-normal">
                — {active}/{total}{sandboxCount > 0 ? ` · ${sandboxCount} sandbox` : ''}
              </span>
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* Agents list */}
          <div className="overflow-y-auto flex-1">
            {sortedAgents.length === 0 ? (
              <div className="px-3 py-3 text-[10px] text-muted-foreground/40 text-center">
                Aucun agent chargé
              </div>
            ) : (
              <div className="py-1">
                {sortedAgents.map((a, i) => {
                  const meta = agentMeta.get(a.id);
                  const apper = stateAppearance(a.state);
                  const sbJob = a.state === 'sandbox' ? sandboxJobsByAgent.get(a.id) : undefined;
                  const taskText = sbJob && typeof sbJob.args['task'] === 'string' ? sbJob.args['task'] as string : '';
                  const isLastActive = i < sortedAgents.length - 1
                    && sortedAgents[i + 1].state === 'idle'
                    && a.state !== 'idle';

                  return (
                    <div
                      key={a.id}
                      className={clsx(
                        'px-3 py-1.5 hover:bg-secondary/30 transition-colors',
                        isLastActive && 'border-b border-border/30 mb-1 pb-2',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-[11px] truncate min-w-0">
                          <span className="shrink-0">{meta?.emoji ?? '🤖'}</span>
                          <span className={clsx(
                            'truncate',
                            a.state === 'idle' ? 'text-foreground/55' : 'text-foreground/85 font-medium',
                          )}>
                            {meta?.name ?? a.id}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', apper.dotClass)} />
                          <span className={clsx('text-[10px] font-mono', apper.textClass)}>{apper.label}</span>
                        </span>
                      </div>
                      {sbJob && (
                        <div className="mt-1 ml-6 text-[10px] text-muted-foreground/60 leading-tight">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate flex-1" title={taskText}>
                              {taskText || '(sandbox sans description)'}
                            </span>
                            <span className="font-mono text-primary/80 shrink-0">{formatJobDuration(sbJob.startedAt)}</span>
                          </div>
                          <div className="text-[9px] font-mono text-muted-foreground/35 mt-0.5">
                            job {sbJob.id}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer hint */}
          {sandboxCount > 0 && (
            <div className="px-3 py-1.5 border-t border-border/40 bg-secondary/20 shrink-0">
              <span className="text-[9px] text-muted-foreground/50">
                Détail sandbox : onglet Tâches → Audit
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtSecs(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatAgo(date: Date): string {
  const diff = Math.round((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}

function WarmupBadge({
  secondsLeft, processingAgent, queue, lastWarmupByAgent, agentMeta, tick,
}: {
  secondsLeft: number | null;
  processingAgent: string | null;
  queue: string[];
  lastWarmupByAgent: Map<string, Date>;
  agentMeta: Map<string, AgentMeta>;
  tick: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isWarming = processingAgent !== null;
  const idle = !isWarming && secondsLeft === null && queue.length === 0;
  const label = isWarming ? 'warm…' : secondsLeft !== null ? fmtSecs(secondsLeft) : 'warm';

  // Agents avec last warmup triés par date desc
  const lastWarmupEntries = useMemo(() => {
    void tick;
    return [...lastWarmupByAgent.entries()]
      .sort((a, b) => b[1].getTime() - a[1].getTime());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastWarmupByAgent, tick]);

  const globalLastWarmup = lastWarmupEntries[0]?.[1] ?? null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          isWarming
            ? 'bg-orange-500/15 border-orange-400/30 text-orange-400'
            : idle
              ? 'bg-secondary/40 border-border/40 text-muted-foreground/35 hover:text-muted-foreground/60'
              : 'bg-orange-500/8 border-orange-400/20 text-orange-300/70 hover:text-orange-300',
          open && 'ring-1 ring-orange-400/40',
        )}
      >
        <Flame size={9} className={clsx(isWarming && 'animate-pulse')} />
        <span className="tabular-nums">{label}</span>
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999] min-w-[200px] w-max max-w-[280px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Flame size={9} className="text-orange-400" />
              Auto-warmup
              {secondsLeft !== null && (
                <span className="text-orange-300/70 font-mono normal-case tracking-normal">— {fmtSecs(secondsLeft)}</span>
              )}
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* File d'attente */}
          {queue.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1">
                <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider">File d'attente</span>
              </div>
              <div className="pb-1">
                {queue.map((agentId, i) => {
                  const meta = agentMeta.get(agentId);
                  const isProcessing = agentId === processingAgent;
                  return (
                    <div key={agentId} className="flex items-center justify-between px-3 py-1 hover:bg-secondary/30 transition-colors">
                      <span className="flex items-center gap-1.5 text-[11px] text-foreground/80 font-medium truncate max-w-[160px]">
                        <span className="text-[9px] text-muted-foreground/40 tabular-nums w-3">{i + 1}.</span>
                        <span>{meta?.emoji ?? '🤖'}</span>
                        <span className="truncate">{meta?.name ?? agentId}</span>
                      </span>
                      {isProcessing && (
                        <span className="text-[10px] font-mono text-orange-400 animate-pulse shrink-0 ml-2">warm…</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Derniers warmups */}
          {lastWarmupEntries.length > 0 && (
            <>
              <div className={clsx('px-3 pt-2 pb-1', queue.length > 0 && 'border-t border-border/50')}>
                <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Derniers warmups</span>
              </div>
              <div className="pb-1">
                {lastWarmupEntries.map(([agentId, date]) => {
                  const meta = agentMeta.get(agentId);
                  return (
                    <div key={agentId} className="flex items-center justify-between px-3 py-1 hover:bg-secondary/30 transition-colors">
                      <span className="flex items-center gap-1.5 text-[11px] text-foreground/70 truncate max-w-[160px]">
                        <span>{meta?.emoji ?? '🤖'}</span>
                        <span className="truncate">{meta?.name ?? agentId}</span>
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0 ml-2">
                        il y a {formatAgo(date)}
                      </span>
                    </div>
                  );
                })}
                {globalLastWarmup && (
                  <div className="flex items-center justify-between px-3 py-1 border-t border-border/30 mt-0.5">
                    <span className="text-[9px] text-muted-foreground/40">Dernier global</span>
                    <span className="text-[10px] font-mono text-muted-foreground/40">il y a {formatAgo(globalLastWarmup)}</span>
                  </div>
                )}
              </div>
            </>
          )}

          {/* État vide */}
          {queue.length === 0 && lastWarmupEntries.length === 0 && (
            <div className="px-3 py-3 text-[10px] text-muted-foreground/40 text-center">
              Aucune activité récente
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VectorMemoryBadge({ ms, agentMeta }: { ms: MemoryStoreStatus; agentMeta: Map<string, AgentMeta> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!ms.enabled) return null;

  const total = ms.total ?? 0;
  const agentCount = ms.perScope?.['agent'] ?? 0;
  const sharedCount = ms.perScope?.['shared'] ?? 0;

  const lastEntryAgo = ms.lastEntryAt
    ? formatAgo(new Date(ms.lastEntryAt))
    : null;

  // Top agents by count, sorted desc
  const topAgents = Object.entries(ms.perAgent ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Top domains (excluding 'none'), sorted desc
  const topDomains = Object.entries(ms.perDomain ?? {})
    .filter(([k]) => k !== 'none')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          'bg-teal-500/10 border-teal-400/25 text-teal-400/70 hover:text-teal-400',
          open && 'ring-1 ring-teal-400/40',
        )}
        title="Mémoire vectorielle"
      >
        <BrainCircuit size={9} />
        <span className="tabular-nums">{total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total}</span>
        <span className="w-1.5 h-1.5 rounded-full bg-teal-400/70 shrink-0" />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999] w-[240px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <BrainCircuit size={9} className="text-teal-400" />
              Mémoire vectorielle
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* Total */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
            <span className="text-[10px] text-muted-foreground/60">Total</span>
            <span className="text-[11px] font-mono font-semibold text-foreground/80 tabular-nums">{total} entrée{total !== 1 ? 's' : ''}</span>
          </div>

          {/* Scopes */}
          {(agentCount > 0 || sharedCount > 0) && (
            <div className="px-3 py-2 border-b border-border/40 space-y-1.5">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Scopes</span>
              {agentCount > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground/60 w-14">🤖 agent</span>
                  <div className="flex-1 h-1 rounded-full bg-secondary/60 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-teal-400/60"
                      style={{ width: total > 0 ? `${Math.round((agentCount / total) * 100)}%` : '0%' }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-foreground/60 tabular-nums w-8 text-right">{agentCount}</span>
                </div>
              )}
              {sharedCount > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground/60 w-14">🌐 shared</span>
                  <div className="flex-1 h-1 rounded-full bg-secondary/60 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-cyan-400/60"
                      style={{ width: total > 0 ? `${Math.round((sharedCount / total) * 100)}%` : '0%' }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-foreground/60 tabular-nums w-8 text-right">{sharedCount}</span>
                </div>
              )}
            </div>
          )}

          {/* Per agent */}
          {topAgents.length > 0 && (
            <div className="px-3 py-2 border-b border-border/40">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block mb-1.5">Par agent</span>
              <div className="space-y-1">
                {topAgents.map(([agentId, count]) => {
                  const meta = agentMeta.get(agentId);
                  return (
                    <div key={agentId} className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[10px] text-foreground/70 truncate max-w-[150px]">
                        <span>{meta?.emoji ?? '🤖'}</span>
                        <span className="truncate">{meta?.name ?? agentId}</span>
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground/50 tabular-nums shrink-0 ml-2">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Per domain */}
          {topDomains.length > 0 && (
            <div className="px-3 py-2 border-b border-border/40">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block mb-1.5">Domaines</span>
              <div className="space-y-1">
                {topDomains.map(([domain, count]) => (
                  <div key={domain} className="flex items-center justify-between">
                    <span className="text-[10px] text-foreground/60 truncate max-w-[150px]">{domain}</span>
                    <span className="text-[10px] font-mono text-muted-foreground/50 tabular-nums shrink-0 ml-2">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer: last entry + dimensions */}
          <div className="px-3 py-2 space-y-1">
            {lastEntryAgo !== null && (
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-muted-foreground/40">Dernière écriture</span>
                <span className="text-[10px] font-mono text-muted-foreground/40">il y a {lastEntryAgo}</span>
              </div>
            )}
            {ms.embeddingDimensions && (
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-muted-foreground/40">Dimensions</span>
                <span className="text-[10px] font-mono text-muted-foreground/40">{ms.embeddingDimensions}d</span>
              </div>
            )}
            {total === 0 && (
              <p className="text-[10px] text-muted-foreground/35 text-center py-1">Aucune entrée pour l'instant</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryBadge({ cs }: { cs: CsData }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fermer si clic en dehors
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!cs.enabled) return null;

  if (cs.runningPct !== null) {
    const label = cs.runningPhase === 'chunking' ? 'chunk' : 'embed';
    const pct = cs.runningPct >= 0 ? `${cs.runningPct}%` : '…';
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono bg-amber-500/10 border-amber-400/25 text-amber-400">
        <BookMarked size={9} />
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
        <span className="tabular-nums">{label} {pct}</span>
      </span>
    );
  }

  const ok = !cs.hasError;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          ok
            ? 'bg-rose-500/10 border-rose-400/25 text-rose-400 hover:bg-rose-500/20'
            : 'bg-destructive/10 border-destructive/25 text-destructive',
          open && 'ring-1 ring-rose-400/40',
        )}
      >
        <BookMarked size={9} />
        <span className="tabular-nums">{cs.indexCount} idx</span>
        {cs.totalChunks !== null && (
          <span className="text-rose-400/60">{formatChunks(cs.totalChunks)}</span>
        )}
        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', ok ? 'bg-rose-400' : 'bg-destructive')} />
      </button>

      {open && cs.indices && (
        <CsIndicesPanel
          onClose={() => setOpen(false)}
          indices={cs.indices}
          totalChunks={cs.totalChunks}
        />
      )}
    </div>
  );
}

interface SchedulerStatus {
  total: number;
  enabled: number;
  running: number;
  nextRunAt: string | null;
  byAgent: Record<string, number>;
  lastCompleted: { name: string; agentId: string; durationMs: number; completedAt: string } | null;
  modules: Array<{ id: string; name: string; enabled: boolean; lastAlertAt?: string }>;
}

function SchedulerBadge({ data, agentMeta }: { data: SchedulerStatus; agentMeta: Map<string, AgentMeta> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const hasRunning = data.running > 0;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-colors cursor-pointer',
          hasRunning
            ? 'bg-amber-500/10 border-amber-400/25 text-amber-400'
            : 'bg-fuchsia-500/10 border-fuchsia-400/25 text-fuchsia-400/70 hover:text-fuchsia-400',
          open && 'ring-1 ring-fuchsia-400/40',
        )}
        title="Taches planifiees"
      >
        <CalendarClock size={9} />
        <span className="tabular-nums">{data.enabled}</span>
        {data.modules.length > 0 && (
          <span className="text-muted-foreground/40 tabular-nums">+{data.modules.filter(m => m.enabled).length}m</span>
        )}
        {hasRunning && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
        {!hasRunning && <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400/70 shrink-0" />}
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999] w-[240px]
          bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <CalendarClock size={9} className="text-fuchsia-400" />
              Taches planifiees
            </span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={10} />
            </button>
          </div>

          {/* Stats */}
          <div className="px-3 py-2 border-b border-border/40 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/60">Total</span>
              <span className="text-[11px] font-mono font-semibold text-foreground/80 tabular-nums">{data.total} tache{data.total !== 1 ? 's' : ''}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/60">Actives</span>
              <span className="text-[11px] font-mono text-foreground/80 tabular-nums">{data.enabled}</span>
            </div>
            {data.running > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-amber-400/80">En cours</span>
                <span className="text-[11px] font-mono text-amber-400 tabular-nums">{data.running}</span>
              </div>
            )}
          </div>

          {/* Next run */}
          {data.nextRunAt && (
            <div className="px-3 py-2 border-b border-border/40">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-muted-foreground/50">Prochain run</span>
                <span className="text-[10px] font-mono text-foreground/60">{new Date(data.nextRunAt).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</span>
              </div>
            </div>
          )}

          {/* Per agent */}
          {Object.keys(data.byAgent).length > 0 && (
            <div className="px-3 py-2 border-b border-border/40">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block mb-1.5">Par agent</span>
              <div className="space-y-1">
                {Object.entries(data.byAgent).sort((a, b) => b[1] - a[1]).map(([agentId, count]) => {
                  const meta = agentMeta.get(agentId);
                  return (
                    <div key={agentId} className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[10px] text-foreground/70 truncate max-w-[150px]">
                        <span>{meta?.emoji ?? '🤖'}</span>
                        <span className="truncate">{meta?.name ?? agentId}</span>
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground/50 tabular-nums shrink-0 ml-2">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Modules */}
          {data.modules.length > 0 && (
            <div className="px-3 py-2 border-b border-border/40">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block mb-1.5 flex items-center gap-1">
                <Plug size={8} className="text-muted-foreground/40" />
                Modules
              </span>
              <div className="space-y-1">
                {data.modules.map((mod) => (
                  <div key={mod.id} className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[10px] text-foreground/70 truncate max-w-[150px]">
                      <span className={clsx(
                        'w-1.5 h-1.5 rounded-full shrink-0',
                        mod.enabled ? 'bg-theme-green/70' : 'bg-muted-foreground/25'
                      )} />
                      <span className="truncate">{mod.name}</span>
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground/40 shrink-0 ml-2">
                      {mod.lastAlertAt ? formatAgo(new Date(mod.lastAlertAt)) : 'OK'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Last completed */}
          {data.lastCompleted && (
            <div className="px-3 py-2 space-y-1">
              <span className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider block">Derniere execution</span>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-foreground/60 truncate max-w-[140px]">{data.lastCompleted.name}</span>
                <span className="text-[10px] font-mono text-muted-foreground/40">{formatAgo(new Date(data.lastCompleted.completedAt))}</span>
              </div>
            </div>
          )}

          {data.total === 0 && (
            <div className="px-3 py-2">
              <p className="text-[10px] text-muted-foreground/35 text-center py-1">Aucune tache planifiee</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function StatusBar() {
  const [status, setStatus]   = useState<StatusData | null>(null);
  const [version, setVersion] = useState<string>('');
  const [online, setOnline]   = useState(true);
  const [cs, setCs]           = useState<CsData | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);

  // Live agent state map (overrides /api/status snapshot when WS events arrive). Keyed by
  // agentId, value is the broadcast `agent.state` ('idle' | 'thinking' | 'streaming' |
  // 'sandbox' | 'warming' | 'error'). The 'sandbox' value is only emitted by run.ts during
  // a sandbox-flipped run — it doesn't appear in the persisted /api/status snapshot.
  const [liveAgentStates, setLiveAgentStates] = useState<Map<string, string>>(new Map());

  // Currently running sandbox jobs — used to enrich the agents popup with task / duration.
  const [activeSandboxJobs, setActiveSandboxJobs] = useState<SandboxJobLite[]>([]);

  // Warmup global state
  const [globalFiresAt, setGlobalFiresAt]         = useState<Date | null>(null);
  const [warmupQueue, setWarmupQueue]               = useState<string[]>([]);
  const [processingAgent, setProcessingAgent]       = useState<string | null>(null);
  const [lastWarmupByAgent, setLastWarmupByAgent]   = useState<Map<string, Date>>(new Map());
  const [agentMeta, setAgentMeta]                   = useState<Map<string, AgentMeta>>(new Map());

  const chunksRef    = useRef<number | null>(null);
 const chunksMapRef = useRef<Map<string, number>>(new Map());
   const wasRunningRef = useRef(false);

    const [uptimeBase, setUptimeBase] = useState<{ base: number; at: number } | null>(null);
    const [tick, setTick] = useState(0);

    // Connectivity popup details
    const [lastLoadAt, setLastLoadAt] = useState<Date | null>(null);
    const [wsConnected, setWsConnected] = useState<boolean>(() => wsClient.isConnected());

    // Providers detail enrichis depuis /api/providers (one-shot au mount), keyed par id.
    // /api/status ne renvoie pas baseUrl/statsUrl/etc. — la route GET /api/providers oui (apiKey redacted).
    const [providersDetail, setProvidersDetail] = useState<Map<string, { type: string; baseUrl?: string; modelsUrl?: string; statsUrl?: string }>>(new Map());

   const loadCs = useCallback(async () => {
    try {
      const s = await api.get<CsStatusRaw>('/api/codebase-search/status');
      const data = parseCsData(s, chunksRef.current, chunksMapRef.current);
      setCs(data);
      const isRunning = data.runningPct !== null;
      if (wasRunningRef.current && !isRunning && s.enabled) {
        // Don't ask /stats?index=default unless the backend actually has a defaultDbPath
        // configured — otherwise the route returns 400 and spams the logs.
        const keys = [
          ...(s.resolvedDefaultDbPath ? ['default'] : []),
          ...Object.keys(s.resolvedIndices),
        ];
        const uniqueKeys = [...new Set(keys)];
        try {
          const results = await Promise.allSettled(
            uniqueKeys.map(k => api.get<{ totalChunks: number }>(`/api/codebase-search/stats?index=${k}`))
          );
          const total = results.reduce((sum, r) => r.status === 'fulfilled' ? sum + (r.value.totalChunks ?? 0) : sum, 0);
          chunksRef.current = total;
          setCs(prev => prev ? { ...prev, totalChunks: total } : prev);
        } catch { /* best-effort */ }
      }
      wasRunningRef.current = isRunning;
    } catch { /* optional */ }
  }, []);

  const loadChunks = useCallback(async (s: CsStatusRaw) => {
    if (!s.enabled) return;
    // Same rule as loadCs — only include 'default' when backend has a defaultDbPath.
    const keys = [
      ...(s.resolvedDefaultDbPath ? ['default'] : []),
      ...Object.keys(s.resolvedIndices),
    ];
    const uniqueKeys = [...new Set(keys)];
    try {
      const results = await Promise.allSettled(
        uniqueKeys.map(k => api.get<{ totalChunks: number }>(`/api/codebase-search/stats?index=${k}`))
      );
      const total = results.reduce((sum, r) => r.status === 'fulfilled' ? sum + (r.value.totalChunks ?? 0) : sum, 0);
      chunksRef.current = total;
      
      uniqueKeys.forEach((k, i) => {
        if (results[i]?.status === 'fulfilled') {
          chunksMapRef.current.set(k, results[i]!.value.totalChunks ?? 0);
        }
      });
      
      setCs(prev => prev ? { ...prev, totalChunks: total } : prev);
    } catch { /* best-effort */ }
  }, []);

  const loadScheduler = useCallback(async () => {
    try {
      const [tasks, runs, rawModules] = await Promise.all([
        api.get<Array<{ id: string; name: string; agentId: string; enabled: boolean; nextRunAt?: string; lastRunStatus?: string }>>('/api/scheduler/tasks'),
        api.get<Array<{ taskId: string; agentId: string; status: string; durationMs?: number; completedAt?: string }>>('/api/scheduler/runs?limit=5'),
        api.get<ProactiveSource[]>('/api/proactive/sources').catch(() => [] as ProactiveSource[]),
      ]);
      const modules = rawModules.map(m => ({ id: m.id, name: m.name, enabled: m.enabled, lastAlertAt: m.lastAlertAt }));

      const enabled = tasks.filter(t => t.enabled).length;
      const running = runs.filter(r => r.status === 'running').length;

      // Find nearest next run
      const nextRuns = tasks.filter(t => t.enabled && t.nextRunAt).map(t => t.nextRunAt!).sort();
      const nextRunAt = nextRuns[0] ?? null;

      // Count per agent
      const byAgent: Record<string, number> = {};
      for (const t of tasks.filter(t => t.enabled)) {
        byAgent[t.agentId] = (byAgent[t.agentId] ?? 0) + 1;
      }

      // Find last completed run with task name
      const lastDone = runs.find(r => r.status === 'completed' && r.completedAt);
      const taskForRun = lastDone ? tasks.find(t => t.id === lastDone.taskId) : null;
      const lastCompleted = lastDone && taskForRun ? {
        name: taskForRun.name,
        agentId: lastDone.agentId,
        durationMs: lastDone.durationMs ?? 0,
        completedAt: lastDone.completedAt!,
      } : null;

      setScheduler({ total: tasks.length, enabled, running, nextRunAt, byAgent, lastCompleted, modules });
    } catch { /* optional */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        api.get<StatusData>('/api/status'),
        api.get<HealthData>('/health').catch(() => null),
      ]);
      setStatus(s);
      setUptimeBase({ base: s.uptime, at: Date.now() });
      if (h) setVersion(h.version);
      setOnline(true);
      setLastLoadAt(new Date());
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadScheduler();
    const doCs = async () => {
      try {
        const s = await api.get<CsStatusRaw>('/api/codebase-search/status');
        const data = parseCsData(s, null, chunksMapRef.current);
        setCs(data);
        wasRunningRef.current = data.runningPct !== null;
        await loadChunks(s);
      } catch { /* optional */ }
    };
    void doCs();
  }, [load, loadChunks]);

  useEffect(() => { const id = setInterval(load, 10_000);  return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(loadCs, 2_000); return () => clearInterval(id); }, [loadCs]);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);

  // Subscribe au WS connection state pour le popup ConnectivityBadge
  useEffect(() => {
    setWsConnected(wsClient.isConnected());
    return wsClient.onConnectionChange(setWsConnected);
  }, []);

  // Fetch /api/providers une seule fois pour enrichir le ProviderBadge popover
  // (type / baseUrl / statsUrl). /api/status ne renvoie que { id, type, reachable }.
  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<Array<{ id: string; type: string; baseUrl?: string; modelsUrl?: string; statsUrl?: string }>>('/api/providers');
        const m = new Map<string, { type: string; baseUrl?: string; modelsUrl?: string; statsUrl?: string }>();
        for (const p of list) m.set(p.id, { type: p.type, baseUrl: p.baseUrl, modelsUrl: p.modelsUrl, statsUrl: p.statsUrl });
        setProvidersDetail(m);
      } catch { /* best-effort */ }
    })();
  }, []);

  // Fetch agent metadata (name + emoji) une seule fois
  useEffect(() => {
    api.get<Array<{ identity: { id: string; name: string; emoji: string } }>>('/api/agents')
      .then(list => {
        const m = new Map<string, AgentMeta>();
        for (const a of list) m.set(a.identity.id, { id: a.identity.id, name: a.identity.name, emoji: a.identity.emoji });
        setAgentMeta(m);
      })
      .catch(() => {/* best-effort */});
  }, []);

  // Initial fetch des sandbox jobs en cours — restaure le badge sur F5 si une sandbox tourne.
  const loadActiveSandboxJobs = useCallback(async () => {
    try {
      const jobs = await api.get<Array<{
        id: string;
        agentId: string;
        sessionId: string;
        kind: string;
        status: string;
        args: Record<string, unknown>;
        startedAt: string | null;
      }>>('/api/async-jobs?status=running&limit=50');
      const sandboxes: SandboxJobLite[] = jobs
        .filter(j => j.kind === 'sandbox_run')
        .map(j => ({ id: j.id, agentId: j.agentId, sessionId: j.sessionId, args: j.args, startedAt: j.startedAt }));
      setActiveSandboxJobs(sandboxes);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => { void loadActiveSandboxJobs(); }, [loadActiveSandboxJobs]);

  // Écoute les événements warmup global / agent state / async-jobs sur le WS
  useEffect(() => {
    return wsClient.subscribe((msg) => {
      if (msg.type === 'warmup.global.schedule') {
        const { firesAt } = msg as { firesAt: string | null };
        setGlobalFiresAt(firesAt ? new Date(firesAt) : null);
      }
      if (msg.type === 'warmup.queue.update') {
        const { queue, processing } = msg as { queue: string[]; processing: string | null };
        setWarmupQueue(queue);
        setProcessingAgent(processing);
      }
      if (msg.type === 'warmup.agent.done') {
        const { agentId, completedAt } = msg as { agentId: string; completedAt: string };
        setLastWarmupByAgent(prev => new Map(prev).set(agentId, new Date(completedAt)));
      }
      // Live agent state — capture le 'sandbox' qui n'apparaît pas dans /api/status (remap WS-only).
      // Note: `warm.done` est un signal one-shot (warmup terminé) émis par le backend en plus
      // de la transition `'warming' → 'idle'` côté `states` Map. Le useChat l'utilise pour skip
      // un refetch inutile, mais pour la StatusBar c'est fonctionnellement de l'idle. Sans cette
      // normalisation, le badge resterait "actif" jusqu'au prochain snapshot /api/status (10s).
      if (msg.type === 'agent.state') {
        const { agentId, state } = msg as { agentId: string; state: string };
        const normalized = state === 'warm.done' ? 'idle' : state;
        setLiveAgentStates(prev => {
          if (prev.get(agentId) === normalized) return prev;
          const next = new Map(prev);
          next.set(agentId, normalized);
          return next;
        });
      }
      // Sandbox lifecycle — refetch la liste depuis l'API sur n'importe quel event de cycle
      // de vie. Le payload WS ne contient pas le `kind` ni les `args` du job, donc on peut
      // pas trancher localement ; un GET filtré status=running est trivial et toujours
      // cohérent avec la DB.
      if (
        msg.type === 'async_job.started' ||
        msg.type === 'async_job.completed' ||
        msg.type === 'async_job.failed' ||
        msg.type === 'async_job.cancelled'
      ) {
        void loadActiveSandboxJobs();
        // Defensive clear: if the agent's liveAgentState is still 'sandbox' when an
        // async_job terminates for it, drop the override so the merged state falls back
        // to /api/status (which reports 'idle' — server-side state never holds 'sandbox').
        // Backstop for the case where the final `agent.state idle` WS event was lost
        // (tab backgrounded, disconnect blip) — without this the badge stays stuck on
        // 'sandbox' until the user reloads the page.
        if (
          msg.type === 'async_job.completed' ||
          msg.type === 'async_job.failed' ||
          msg.type === 'async_job.cancelled'
        ) {
          const { agentId } = msg as { agentId: string };
          setLiveAgentStates(prev => {
            if (prev.get(agentId) !== 'sandbox') return prev;
            const next = new Map(prev);
            next.delete(agentId);
            return next;
          });
        }
      }
      // Scheduler events → refresh
      if (msg.type === 'tasks.updated' || msg.type === 'task.started' || msg.type === 'task.completed' || msg.type === 'task.failed' || msg.type === 'proactive.alert') {
        void loadScheduler();
      }
    });
  }, [loadScheduler, loadActiveSandboxJobs]);

  // Countdown global vers le prochain warmup
  const warmupSecondsRemaining = useMemo(() => {
    void tick;
    if (!globalFiresAt) return null;
    const s = Math.round((globalFiresAt.getTime() - Date.now()) / 1000);
    return s > 0 ? s : null;
  }, [globalFiresAt, tick]);

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const liveUptime = uptimeBase ? uptimeBase.base + (Date.now() - uptimeBase.at) / 1000 : null;
  void tick;

  // Source of truth pour l'état affiché : /api/status (snapshot 10s) overridé par les events
  // WS `agent.state` (incluant le remap 'sandbox' que /api/status ne connaît pas).
  const mergedAgents = useMemo(() => {
    if (!status) return [];
    return status.agents.map(a => ({
      id: a.id,
      state: liveAgentStates.get(a.id) ?? a.state,
    }));
  }, [status, liveAgentStates]);
  const enabledTelegram = status?.telegram.filter(t => t.enabled) ?? [];

  return (
    // Wrap au lieu de hauteur fixe : sur viewport étroit, les badges débordaient
    // vers la droite et la clock était clippée. flex-wrap + min-h-8 fait monter
    // la barre sur 2-3 lignes au besoin sans rien perdre. `ml-auto` sur la clock
    // garantit qu'elle reste à droite sur sa ligne, quelle que soit la ligne.
    <div className="relative flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-1 min-h-8 border-t border-border bg-card shrink-0 select-none z-40">

      {/* Connectivity — bouton cliquable, popup détaillée */}
      <ConnectivityBadge
        online={online}
        version={version}
        liveUptime={liveUptime}
        wsConnected={wsConnected}
        lastLoadAt={lastLoadAt}
        onForceRefresh={() => { void load(); }}
      />

      {/* Version + uptime cachés sous 480px : info secondaire qui faisait wrap
          la barre sur mobile. Reste accessible dans le popup ConnectivityBadge. */}
      {version && (
        <span className="hidden min-[480px]:inline-block text-[10px] font-mono text-muted-foreground/35 shrink-0">v{version}</span>
      )}

      {liveUptime !== null && (
        <span className="hidden min-[480px]:flex items-center gap-1 text-[10px] font-mono text-muted-foreground/40 shrink-0">
          <Clock size={9} />
          <span className="tabular-nums">{formatUptime(liveUptime)}</span>
        </span>
      )}

      <Sep />

      {/* Infrastructure */}
      <DbBadge db={status?.database ?? { ok: false }} />

      {/* Providers / Telegram / Memory / Scheduler — info secondaire qui faisait
          wrap la StatusBar sur 2 lignes en mobile. Sur narrow on garde
          uniquement online + DB + Agents + Warmup ; le reste apparaît dès
          480px. Les infos cachées restent accessibles via les popups
          (ConnectivityBadge, DbBadge, AgentsBadge). */}
      <div className="hidden min-[480px]:contents">
        {status?.providers.map(p => {
          const detail = providersDetail.get(p.id);
          return (
            <ProviderBadge
              key={p.id}
              provider={{
                id: p.id,
                type: detail?.type ?? p.type,
                reachable: p.reachable,
                baseUrl: detail?.baseUrl,
                modelsUrl: detail?.modelsUrl,
                statsUrl: detail?.statsUrl,
              }}
            />
          );
        })}

        {enabledTelegram.length > 0 && (
          <>
            <Sep />
            <TelegramBadge bots={enabledTelegram} />
          </>
        )}
      </div>

      <Sep />

      {/* Agents — clickable popup with live state per agent + active sandbox jobs */}
      {status && (
        <AgentsBadge
          agents={mergedAgents}
          sandboxJobs={activeSandboxJobs}
          agentMeta={agentMeta}
          tick={tick}
        />
      )}

      {/* Auto-warmup — queue globale */}
      <Sep />
      <WarmupBadge
        secondsLeft={warmupSecondsRemaining}
        processingAgent={processingAgent}
        queue={warmupQueue}
        lastWarmupByAgent={lastWarmupByAgent}
        agentMeta={agentMeta}
        tick={tick}
      />

      {/* Memory / Vector memory / Scheduler — cachés sous 480px */}
      <div className="hidden min-[480px]:contents">
        {/* Codebase search index */}
        {cs?.enabled && (
          <>
            <Sep />
            <MemoryBadge cs={cs} />
          </>
        )}

        {/* Vector memory store */}
        {status?.memoryStore?.enabled && (
          <>
            <Sep />
            <VectorMemoryBadge ms={status.memoryStore} agentMeta={agentMeta} />
          </>
        )}

        {/* Scheduled tasks */}
        {scheduler && (
          <>
            <Sep />
            <SchedulerBadge data={scheduler} agentMeta={agentMeta} />
          </>
        )}
      </div>

      {/* Clock — cachée sous 480px (mobile) où elle pousse la barre à wrap sur 2
          lignes pour pas grand-chose ; l'utilisateur a déjà l'heure dans son OS.
          `ml-auto` colle à droite quand visible. */}
      <span className="hidden min-[480px]:inline-block ml-auto tabular-nums text-[10px] font-mono text-muted-foreground/40 shrink-0">{time}</span>
    </div>
  );
}
