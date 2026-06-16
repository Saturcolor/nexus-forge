import { useEffect, useState, useCallback, useMemo } from 'react';
import { Loader, CheckCircle2, XCircle, Clock, Ban, X, RefreshCw, Cpu, Terminal, Bot } from 'lucide-react';
import type { MessageAttachment } from '@mastermind/shared';
import { api } from '../../lib/api';
import { wsClient } from '../../lib/ws';
import { SandboxAuditPanel } from './SandboxAuditPanel';

/**
 * Async jobs tab — live tracker for long-running skill actions (Sora Pro video, Veo 3,
 * image gen), sandbox runs, and sub-agent spawns triggered by this agent. Fetches
 * /api/async-jobs?agentId=X (the backend list inclut désormais les rows où
 * parent_agent_id = X, donc les sub-agents spawnés par cet agent apparaissent ici).
 */

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
type JobKind = 'shell' | 'sandbox_run' | 'sub_agent';

interface AsyncJob {
  id: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  kind: JobKind;
  status: JobStatus;
  result: string | null;
  outputFiles: MessageAttachment[] | null;
  error: string | null;
  caption: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** Sub-agent fields — null pour les jobs shell/sandbox. */
  subAgentId: string | null;
  parentSessionId: string | null;
  parentAgentId: string | null;
  taskPrompt: string | null;
  capsHit: string | null;
}

export interface AgentJobsTabProps {
  /** Selected agent — filter jobs to this agent only. */
  selectedAgentId: string;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${String(mm).padStart(2, '0')}m`;
}

function KindIcon({ kind }: { kind: JobKind }) {
  if (kind === 'sandbox_run') {
    return <Cpu size={12} className="text-theme-green shrink-0" aria-label="sandbox run" />;
  }
  if (kind === 'sub_agent') {
    return <Bot size={12} className="text-violet-400 shrink-0" aria-label="sub-agent run" />;
  }
  return <Terminal size={12} className="text-muted-foreground shrink-0" aria-label="shell job" />;
}

function StatusBadge({ status }: { status: JobStatus }) {
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary/15 text-primary">
        <Loader size={10} className="animate-spin" />
        Running
      </span>
    );
  }
  if (status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-secondary text-muted-foreground">
        <Clock size={10} />
        Queued
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-theme-green/15 text-theme-green">
        <CheckCircle2 size={10} />
        Done
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-destructive/15 text-destructive">
        <XCircle size={10} />
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-muted-foreground/15 text-muted-foreground">
      <Ban size={10} />
      Cancelled
    </span>
  );
}

export function AgentJobsTab({ selectedAgentId }: AgentJobsTabProps) {
  const [jobs, setJobs] = useState<AsyncJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 1Hz tick to re-render live uptimes without refetching. */
  const [, setNowTick] = useState(0);
  /** Job currently opened in the audit panel (id) — null = panel closed. */
  const [auditJobId, setAuditJobId] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<AsyncJob[]>(`/api/async-jobs?agentId=${encodeURIComponent(selectedAgentId)}&limit=50`);
      setJobs(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId]);

  useEffect(() => { void fetchJobs(); }, [fetchJobs]);

  // Subscribe to async_job.* events for live updates
  useEffect(() => {
    const unsub = wsClient.subscribe((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; agentId?: string };
      if (!m.type) return;
      if (
        m.type === 'async_job.queued' ||
        m.type === 'async_job.started' ||
        m.type === 'async_job.completed' ||
        m.type === 'async_job.failed' ||
        m.type === 'async_job.cancelled' ||
        m.type === 'async_jobs.updated'
      ) {
        // Simplest correct approach: refetch on any change affecting this agent
        // (or on generic `async_jobs.updated` which has no agentId).
        if (!m.agentId || m.agentId === selectedAgentId) {
          void fetchJobs();
        }
      }
    });
    return unsub;
  }, [selectedAgentId, fetchJobs]);

  // 1Hz tick for live uptime on running jobs
  useEffect(() => {
    const hasRunning = jobs.some(j => j.status === 'running' || j.status === 'queued');
    if (!hasRunning) return;
    const t = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [jobs]);

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await api.post(`/api/async-jobs/${jobId}/cancel`);
      // The WS event will trigger a refetch; no need to call fetchJobs here
    } catch (err) {
      console.error('[jobs] cancel failed', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const { active, finished } = useMemo(() => {
    const active: AsyncJob[] = [];
    const finished: AsyncJob[] = [];
    for (const j of jobs) {
      if (j.status === 'queued' || j.status === 'running') active.push(j);
      else finished.push(j);
    }
    return { active, finished };
  }, [jobs]);

  const now = Date.now();

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <div className="bg-card rounded-xl border border-border/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Tâches en cours</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Exécutions asynchrones de compétences longues (génération vidéo/image). Les résultats arrivent dans le chat quand c'est prêt.
              </p>
            </div>
            <button
              onClick={() => void fetchJobs()}
              disabled={loading}
              className="shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:border-ring text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Recharger
            </button>
          </div>
          {error && <p className="text-xs text-destructive mt-2">Erreur: {error}</p>}
        </div>

        {/* Active */}
        <div className="bg-card rounded-xl border border-border/60 p-4 space-y-2">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
            Actives ({active.length})
          </p>
          {active.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Aucune tâche en cours.</p>
          ) : (
            <div className="space-y-1">
              {active.map(j => {
                const startMs = j.startedAt ? new Date(j.startedAt).getTime() : new Date(j.createdAt).getTime();
                const elapsed = now - startMs;
                const label = j.kind === 'sub_agent'
                  ? `${j.subAgentId ?? j.toolName} ${j.taskPrompt ? `— ${j.taskPrompt.slice(0, 60)}${j.taskPrompt.length > 60 ? '…' : ''}` : ''}`
                  : j.toolName.replace(/^skill_/, '');
                return (
                  <div
                    key={j.id}
                    className="flex items-center gap-3 py-2 px-2 rounded hover:bg-secondary/30 transition-colors cursor-pointer"
                    onClick={() => setAuditJobId(j.id)}
                    title={j.taskPrompt ?? 'Voir le détail'}
                  >
                    <KindIcon kind={j.kind} />
                    <StatusBadge status={j.status} />
                    <span className="font-mono text-xs text-foreground truncate flex-1" title={j.toolName}>
                      {label}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {formatElapsed(elapsed)}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground/60">
                      {j.id.slice(0, 6)}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); void cancelJob(j.id); }}
                      className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Annuler"
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* History */}
        <div className="bg-card rounded-xl border border-border/60 p-4 space-y-2">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
            Historique ({finished.length})
          </p>
          {finished.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Aucune tâche terminée.</p>
          ) : (
            <div className="space-y-1">
              {finished.map(j => {
                const durationMs =
                  j.completedAt && j.startedAt
                    ? new Date(j.completedAt).getTime() - new Date(j.startedAt).getTime()
                    : null;
                const label = j.kind === 'sub_agent'
                  ? `${j.subAgentId ?? j.toolName} ${j.taskPrompt ? `— ${j.taskPrompt.slice(0, 60)}${j.taskPrompt.length > 60 ? '…' : ''}` : ''}`
                  : j.toolName.replace(/^skill_/, '');
                return (
                  <div
                    key={j.id}
                    className="flex items-center gap-3 py-2 px-2 rounded hover:bg-secondary/30 transition-colors cursor-pointer"
                    onClick={() => setAuditJobId(j.id)}
                    title={j.error ?? j.taskPrompt ?? j.result?.slice(0, 200) ?? 'Voir le détail'}
                  >
                    <KindIcon kind={j.kind} />
                    <StatusBadge status={j.status} />
                    <span className="font-mono text-xs text-foreground truncate flex-1" title={j.toolName}>
                      {label}
                    </span>
                    {j.capsHit && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
                        {j.capsHit}
                      </span>
                    )}
                    {j.outputFiles && j.outputFiles.length > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {j.outputFiles.length} fichier{j.outputFiles.length > 1 ? 's' : ''}
                      </span>
                    )}
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {durationMs != null ? formatElapsed(durationMs) : '—'}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground/60">
                      {j.id.slice(0, 6)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {auditJobId && (
        <SandboxAuditPanel jobId={auditJobId} onClose={() => setAuditJobId(null)} />
      )}
    </div>
  );
}
