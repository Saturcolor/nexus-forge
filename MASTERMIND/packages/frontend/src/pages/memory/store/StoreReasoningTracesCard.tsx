import { useState } from 'react';
import { Activity, Search, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../../lib/api';
import { cardCls, inputCls, btnSecondary } from '../types';
import type { AgentSummary } from '../types';

interface Trace {
  id: string;
  sessionId: string;
  query?: string;
  reasoning?: string;
  conclusion?: string;
  createdAt: string;
}

interface Props {
  agents: AgentSummary[];
  defaultAgentId: string;
}

export function StoreReasoningTracesCard({ agents, defaultAgentId }: Props) {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async (off = 0) => {
    if (!agentId.trim()) return;
    setLoading(true);
    try {
      const r = await api.get<{ traces: Trace[]; total: number }>(
        `/api/memory-store/reasoning-traces?agentId=${encodeURIComponent(agentId.trim())}&limit=10&offset=${off}`,
      );
      setTraces(r.traces);
      setTotal(r.total);
      setOffset(off);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  return (
    <div className={cardCls}>
      <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4">
        <Activity size={16} /> Traces de raisonnement
        <span className="text-xs font-normal text-muted-foreground">(opt-in via <code className="bg-secondary px-1 rounded-md">captureReasoningTraces: true</code>)</span>
      </h2>

      <div className="flex items-center gap-2 mb-3">
        {agents.length > 0 ? (
          <select value={agentId} onChange={e => setAgentId(e.target.value)} className={clsx(inputCls, 'flex-1')}>
            {agents.map(a => (
              <option key={a.identity.id} value={a.identity.id}>{a.identity.name ?? a.identity.id}</option>
            ))}
          </select>
        ) : (
          <input value={agentId} onChange={e => setAgentId(e.target.value)} onKeyDown={e => e.key === 'Enter' && void load(0)} placeholder="Agent ID" className={clsx(inputCls, 'flex-1')} />
        )}
        <button type="button" onClick={() => void load(0)} disabled={!agentId.trim() || loading} className={btnSecondary}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          Charger
        </button>
      </div>

      {traces.length === 0 && !loading && agentId && (
        <p className="text-xs text-muted-foreground py-4 text-center">Aucune trace pour cet agent.</p>
      )}

      {traces.length > 0 && (
        <div className="space-y-2">
          {traces.map(trace => (
            <div key={trace.id} className="border border-border/50 rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => setExpanded(expanded === trace.id ? null : trace.id)}
                className="w-full flex items-start justify-between gap-2 px-3 py-2 bg-background hover:bg-secondary/50 text-left"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground truncate">{trace.query ?? '(pas de query)'}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(trace.createdAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {trace.conclusion && <span className="ml-2 text-foreground/70">→ {trace.conclusion.slice(0, 60)}...</span>}
                  </p>
                </div>
                <ChevronRight size={14} className={clsx('shrink-0 mt-0.5 text-muted-foreground transition-transform', expanded === trace.id && 'rotate-90')} />
              </button>
              {expanded === trace.id && trace.reasoning && (
                <div className="px-3 py-2 bg-secondary/30 border-t border-border">
                  <p className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-relaxed">{trace.reasoning}</p>
                </div>
              )}
            </div>
          ))}

          {total > 10 && (
            <div className="flex items-center justify-between pt-1">
              <button type="button" disabled={offset === 0 || loading} onClick={() => void load(offset - 10)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
                <ChevronLeft size={14} /> Precedent
              </button>
              <span className="text-xs text-muted-foreground">{offset + 1}–{Math.min(offset + 10, total)} / {total}</span>
              <button type="button" disabled={offset + 10 >= total || loading} onClick={() => void load(offset + 10)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
                Suivant <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
