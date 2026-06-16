import { Search, MessageSquare, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { inputCls, btnPrimary, badgeCls, fmtRunAt } from './types';
import type { SessionSearchHit, AgentSummary } from './types';

interface Props {
  query: string;
  setQuery: (v: string) => void;
  agentId: string;
  setAgentId: (v: string) => void;
  agents: AgentSummary[];
  limit: number;
  setLimit: (v: number) => void;
  searching: boolean;
  results: SessionSearchHit[] | null;
  error: string | null;
  onSearch: () => void;
}

/**
 * Recherche plein-texte user-facing dans l'historique des conversations (mirroir UX du
 * codebase-search et de la mémoire vectorielle). Tape l'endpoint GET /api/sessions/search,
 * lui-même adossé au même moteur FTS que le tool agent `session_search`.
 */
export function SessionSearchTab({
  query, setQuery, agentId, setAgentId, agents, limit, setLimit,
  searching, results, error, onSearch,
}: Props) {
  const maxRank = results && results.length ? Math.max(...results.map(r => r.rank || 0), 0.000001) : 1;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="border-b border-border bg-card/50 shrink-0">
        <div className="max-w-4xl mx-auto w-full px-6 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Rechercher dans l'historique des conversations… (guillemets = phrase exacte, OR, -exclure)"
              className="flex-1 min-w-0 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
              onKeyDown={e => { if (e.key === 'Enter' && !searching && query.trim()) onSearch(); }}
            />
            <button
              type="button" disabled={searching || !query.trim()}
              onClick={onSearch}
              className={clsx(btnPrimary, 'px-4 py-2 text-sm shrink-0')}
            >
              <Search size={14} className={searching ? 'animate-spin' : ''} />
              {searching ? 'Recherche...' : 'Chercher'}
            </button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Agent</span>
              <select value={agentId} onChange={e => setAgentId(e.target.value)} className={clsx(inputCls, 'w-auto py-1 text-[11px]')}>
                <option value="">Tous</option>
                {agents.map(a => (
                  <option key={a.identity.id} value={a.identity.id}>{a.identity.name ?? a.identity.id}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Limite</span>
              <input
                type="number" min={1} max={50} value={limit}
                onChange={e => setLimit(Math.min(50, Math.max(1, Number(e.target.value) || 20)))}
                className={clsx(inputCls, 'w-14 py-1 font-mono text-[11px]')}
              />
            </div>
            <p className="text-[10px] text-muted-foreground ml-auto">
              Recherche plein-texte (français) sur les messages — 50 résultats max
            </p>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto w-full px-6 py-5">
          {error && (
            <div className="text-sm text-destructive border border-destructive/30 rounded-xl p-3 mb-4">{error}</div>
          )}

          {!results && !searching && !error && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
              <MessageSquare size={36} className="text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">Cherchez dans tout ce qui a été dit dans les conversations passées.</p>
            </div>
          )}

          {searching && (
            <div className="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
              <RefreshCw size={14} className="animate-spin" /> Recherche en cours...
            </div>
          )}

          {results && !searching && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{results.length} message(s) trouvé(s)</p>

              {results.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">Aucun message pour cette requête.</p>
              )}

              {results.map((h, i) => (
                <div key={`${h.id}-${i}`} className="rounded-xl border border-border/50 bg-card overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-secondary/30 border-b border-border/30">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className={clsx(badgeCls, 'bg-primary/10 text-primary font-mono')}>{h.role}</span>
                      <span className="text-xs text-muted-foreground">{fmtRunAt(h.createdAt)}</span>
                      <span className="text-[10px] font-mono text-muted-foreground/60 truncate">session {h.sessionId}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0" title={`pertinence ${h.rank}`}>
                      <div className="w-14 h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full rounded-full bg-theme-green transition-all" style={{ width: `${Math.round((h.rank / maxRank) * 100)}%` }} />
                      </div>
                    </div>
                  </div>
                  <p className="text-[12px] text-muted-foreground whitespace-pre-wrap leading-relaxed px-4 py-3">{h.snippet}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
