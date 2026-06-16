import { useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { api } from '../../lib/api';
import { wsClient } from '../../lib/ws';

/**
 * Live indicator shown in the agent header when a sandbox run is active.
 * Polls the /api/async-jobs list for the agent on mount + refreshes on any
 * `async_job.*` WS event. Tick every second for uptime display.
 */

interface AsyncJobLite {
  id: string;
  kind: 'shell' | 'sandbox_run';
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
}

export function SandboxIndicator({ agentId }: { agentId: string }) {
  const [activeJob, setActiveJob] = useState<AsyncJobLite | null>(null);
  const [, setNowTick] = useState(0);

  // Fetch the current active sandbox_run for this agent (if any)
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const jobs = await api.get<AsyncJobLite[]>(
          `/api/async-jobs?agentId=${encodeURIComponent(agentId)}&status=queued,running&limit=10`,
        );
        if (cancelled) return;
        const sandbox = jobs.find(j => j.kind === 'sandbox_run') ?? null;
        setActiveJob(sandbox);
      } catch {
        // silent — transient auth or network, try again on next WS event
      }
    };

    void refresh();

    const unsub = wsClient.subscribe((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; agentId?: string };
      if (!m.type?.startsWith('async_job')) return;
      if (m.agentId && m.agentId !== agentId && m.type !== 'async_jobs.updated') return;
      void refresh();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [agentId]);

  // 1Hz tick to update the uptime display
  useEffect(() => {
    if (!activeJob) return;
    const t = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [activeJob]);

  if (!activeJob) return null;

  const startMs = activeJob.startedAt
    ? new Date(activeJob.startedAt).getTime()
    : new Date(activeJob.createdAt).getTime();
  const elapsed = Date.now() - startMs;
  const label = activeJob.status === 'queued' ? 'Sandbox en file' : 'Sandbox en cours';

  return (
    <div
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 border border-primary/20 text-primary text-[11px] font-semibold"
      title={`Job ${activeJob.id.slice(0, 8)} — voir détails dans le tab Tâches`}
    >
      <Cpu size={11} className="animate-pulse" />
      <span>{label}</span>
      <span className="font-mono tabular-nums text-primary/70">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
