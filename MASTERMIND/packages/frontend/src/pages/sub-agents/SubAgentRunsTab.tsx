import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Clock, CheckCircle2, XCircle, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { wsClient } from '../../lib/ws';
import { SubAgentRunDetail } from './SubAgentRunDetail';

export interface SubAgentRunsTabProps {
  subAgentId: string;
}

interface SubAgentRun {
  id: string;
  agent_id: string;
  sub_agent_id: string;
  parent_session_id: string | null;
  parent_agent_id: string | null;
  task_prompt: string | null;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  result: string | null;
  error: string | null;
  caps_hit: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface SubAgentStats {
  subAgentId: string;
  windowDays: number;
  total: number;
  byStatus: Array<{
    status: string;
    count: number;
    avgDurationMs: number | null;
    lastRunAt: string | null;
  }>;
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return "à l'instant";
  if (diffMs < 3600_000) return `il y a ${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `il y a ${Math.floor(diffMs / 3600_000)}h`;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function StatusBadge({ status, capsHit }: { status: string; capsHit: string | null }) {
  if (status === 'done' && !capsHit) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">
        <CheckCircle2 size={10} />
        ok
      </span>
    );
  }
  if (status === 'done' && capsHit) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">
        <AlertTriangle size={10} />
        partial:{capsHit}
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 animate-pulse">
        <Clock size={10} />
        running
      </span>
    );
  }
  if (status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-500">
        <Clock size={10} />
        queued
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">
        <XCircle size={10} />
        error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-500">
      {status}
    </span>
  );
}

/**
 * Historique des runs cloud pour un preset sub-agent (stats 30j + liste + drill-down audit).
 */
export function SubAgentRunsTab({ subAgentId }: SubAgentRunsTabProps) {
  const [runs, setRuns] = useState<SubAgentRun[]>([]);
  const [stats, setStats] = useState<SubAgentStats | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [drilldownJobId, setDrilldownJobId] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!subAgentId) return;
    try {
      const [runsList, s] = await Promise.all([
        api.get<SubAgentRun[]>(`/api/sub-agents/${encodeURIComponent(subAgentId)}/runs?limit=100`),
        api.get<SubAgentStats>(`/api/sub-agents/${encodeURIComponent(subAgentId)}/stats?days=30`),
      ]);
      setRuns(runsList);
      setStats(s);
    } catch (err) {
      console.error('[SubAgentRunsTab] runs/stats failed:', err);
    }
  }, [subAgentId]);

  useEffect(() => {
    if (!subAgentId) return;
    setLoadingRuns(true);
    void fetchRuns().finally(() => setLoadingRuns(false));
  }, [subAgentId, fetchRuns]);

  // Live updates: refetch on async_job lifecycle events touching this preset.
  // Backend's async_job events carry agentId=subAgentId for kind='sub_agent' rows.
  useEffect(() => {
    if (!subAgentId) return;
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
        if (!m.agentId || m.agentId === subAgentId) {
          void fetchRuns();
        }
      }
    });
    return unsub;
  }, [subAgentId, fetchRuns]);

  const doneCount = stats?.byStatus.find(s => s.status === 'done')?.count ?? 0;
  const errorCount = stats?.byStatus.find(s => s.status === 'error')?.count ?? 0;
  const avgDurationMs = stats?.byStatus.find(s => s.status === 'done')?.avgDurationMs ?? null;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-card border border-border/60 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Runs (30j)</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{stats?.total ?? 0}</div>
          </div>
          <div className="bg-card border border-border/60 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Taux succès</div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {stats?.total ? Math.round((doneCount / stats.total) * 100) : 0}%
              {errorCount > 0 && (
                <span className="ml-2 text-[11px] text-destructive font-normal">({errorCount} err)</span>
              )}
            </div>
          </div>
          <div className="bg-card border border-border/60 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Durée moy.</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{formatDuration(avgDurationMs)}</div>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground mb-2">Runs récents</h3>
          {loadingRuns ? (
            <div className="text-sm text-muted-foreground py-4">Chargement…</div>
          ) : runs.length === 0 ? (
            <div className="text-sm text-muted-foreground italic py-4">Aucun run pour ce sub-agent.</div>
          ) : (
            <div className="border border-border/60 rounded-lg overflow-hidden">
              {runs.map(run => {
                const durMs =
                  run.completed_at && run.started_at
                    ? new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()
                    : null;
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setDrilldownJobId(run.id)}
                    className="w-full text-left px-3 py-2 border-b border-border/30 last:border-b-0 hover:bg-secondary/40 transition-colors flex items-center gap-3"
                  >
                    <span className="font-mono text-[10px] text-muted-foreground/60 w-20 shrink-0">
                      {run.id.slice(0, 8)}
                    </span>
                    <StatusBadge status={run.status} capsHit={run.caps_hit} />
                    <span className="text-xs text-muted-foreground w-16 shrink-0">{formatDuration(durMs)}</span>
                    <span className="text-xs text-foreground truncate flex-1">
                      {run.task_prompt?.slice(0, 120) ?? '—'}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 shrink-0">{formatDate(run.created_at)}</span>
                    <ChevronRight size={14} className="text-muted-foreground/40 shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {drilldownJobId && (
        <SubAgentRunDetail jobId={drilldownJobId} onClose={() => setDrilldownJobId(null)} />
      )}
    </div>
  );
}
