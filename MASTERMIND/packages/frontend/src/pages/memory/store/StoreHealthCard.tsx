import { useState, useEffect, useCallback } from 'react';
import { Heart, RefreshCw, Play, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../../lib/api';
import { wsClient } from '../../../lib/ws';
import { cardCls, inputCls, btnSecondary, fmtRunAt } from '../types';
import type { MemoryHealthStats, AgentSummary } from '../types';
import type { WsServerMessage } from '@mastermind/shared';

const STEP_LABELS: Record<string, string> = {
  scoring: 'Scoring',
  clustering: 'Clustering',
  merging: 'Merge LLM',
  archiving: 'Archivage',
};

interface Props {
  agents: AgentSummary[];
  onConsolidated: () => void;
}

export function StoreHealthCard({ agents, onConsolidated }: Props) {
  const [selectedAgent, setSelectedAgent] = useState('all');
  const [stats, setStats] = useState<MemoryHealthStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Real-time progress via WebSocket
  const [progressStep, setProgressStep] = useState<string | null>(null);
  const [progressStepNum, setProgressStepNum] = useState(0);
  const [progressTotal, setProgressTotal] = useState(4);
  const [progressDetail, setProgressDetail] = useState<string | null>(null);

  const agentIdParam = selectedAgent !== 'all' && selectedAgent !== 'shared' ? selectedAgent : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (agentIdParam) params.set('agentId', agentIdParam);
      const h = await api.get<MemoryHealthStats>(`/api/memory-consolidation/health?${params.toString()}`);
      setStats(h);
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [agentIdParam]);

  useEffect(() => { void load(); }, [load]);

  // Listen for WS consolidation progress
  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsServerMessage) => {
      if (msg.type === 'consolidation.progress') {
        setConsolidating(true);
        setProgressStep(msg.step);
        setProgressStepNum(msg.stepNumber);
        setProgressTotal(msg.totalSteps);
        setProgressDetail(msg.detail ?? null);
      } else if (msg.type === 'consolidation.done') {
        setConsolidating(false);
        setProgressStep(null);
        setProgressDetail(null);
        setResult(`OK — ${msg.stats.scored} scorees, ${msg.stats.merged} fusionnees, ${msg.stats.archived} archivees`);
        void load();
        onConsolidated();
      } else if (msg.type === 'consolidation.error') {
        setConsolidating(false);
        setProgressStep(null);
        setProgressDetail(null);
        setResult(`Erreur : ${msg.error}`);
      }
    });
    return unsub;
  }, [load, onConsolidated]);

  const triggerConsolidation = async () => {
    setConsolidating(true);
    setResult(null);
    setProgressStep(null);
    setProgressDetail(null);
    try {
      await api.post('/api/memory-consolidation/run', agentIdParam ? { agentId: agentIdParam } : {});
      // completion handled by WS consolidation.done
    } catch (e: unknown) {
      setConsolidating(false);
      setResult(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const pct = progressTotal > 0 ? Math.round((progressStepNum / progressTotal) * 100) : 0;

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Heart size={16} /> Sante memoire
        </h2>
        <div className="flex items-center gap-2">
          <select value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)} className={clsx(inputCls, 'w-auto text-[11px] py-1')}>
            <option value="all">Tous les agents</option>
            {agents.map(a => (
              <option key={a.identity.id} value={a.identity.id}>{a.identity.name ?? a.identity.id}</option>
            ))}
          </select>
          <button type="button" onClick={() => void load()} disabled={loading} className="text-muted-foreground hover:text-foreground" title="Actualiser">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: 'actives', value: stats.active },
              { label: 'archivees', value: stats.archived },
              { label: 'jamais accedees', value: stats.neverAccessed },
              { label: 'score moyen', value: stats.avgScore != null ? stats.avgScore.toFixed(2) : '\u2014' },
              { label: 'total', value: stats.total },
            ].map(s => (
              <div key={s.label} className="bg-secondary rounded-lg p-3 text-center">
                <div className="text-lg font-semibold text-foreground">{s.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {stats.lastConsolidationRun && !consolidating && (
            <div className="text-xs text-muted-foreground">
              Derniere consolidation : {fmtRunAt(stats.lastConsolidationRun.startedAt)}
              {' — '}
              <span className={stats.lastConsolidationRun.status === 'completed' ? 'text-theme-green' : stats.lastConsolidationRun.status === 'error' ? 'text-theme-red' : 'text-theme-orange'}>
                {stats.lastConsolidationRun.status}
              </span>
              {stats.lastConsolidationRun.stats && (
                <span className="ml-2">
                  ({stats.lastConsolidationRun.stats.scored} scorees, {stats.lastConsolidationRun.stats.merged} fusionnees, {stats.lastConsolidationRun.stats.archived} archivees)
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {!stats && !loading && <p className="text-xs text-muted-foreground">Aucune donnee de sante disponible.</p>}

      {/* Progress bar during consolidation */}
      {consolidating && progressStep && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-foreground font-medium">
              <Loader2 size={12} className="inline animate-spin mr-1.5" />
              {STEP_LABELS[progressStep] ?? progressStep} ({progressStepNum}/{progressTotal})
            </span>
            <span className="text-muted-foreground font-mono">{pct}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          {progressDetail && (
            <p className="text-[11px] text-muted-foreground">{progressDetail}</p>
          )}
        </div>
      )}

      {/* Trigger + result */}
      <div className="flex items-center gap-3 mt-4">
        <button type="button" disabled={consolidating} onClick={() => void triggerConsolidation()} className={btnSecondary}>
          {consolidating ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {consolidating ? 'En cours...' : 'Lancer la consolidation memoire'}
        </button>
        {!consolidating && result && (
          <span className={clsx('text-xs', result.startsWith('Erreur') ? 'text-theme-red' : 'text-theme-green')}>{result}</span>
        )}
      </div>
    </div>
  );
}
