import { Search, Database, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import type { CodebaseSearchStatusResponse, CodebaseSearchSearchResponse } from './types';
import { inputCls, btnPrimary, badgeCls } from './types';

interface Props {
  status: CodebaseSearchStatusResponse | null;
  loadingStatus: boolean;
  indexOptions: string[];
  selectedIndex: string;
  setSelectedIndex: (v: string) => void;
  query: string;
  setQuery: (v: string) => void;
  searchType: 'vector' | 'hybrid';
  setSearchType: (v: 'vector' | 'hybrid') => void;
  limit: number;
  setLimit: (v: number) => void;
  filePattern: string;
  setFilePattern: (v: string) => void;
  extensions: string;
  setExtensions: (v: string) => void;
  searching: boolean;
  searchResult: CodebaseSearchSearchResponse | null;
  searchError: string | null;
  onSearch: () => void;
  onSwitchToConfig: () => void;
}

export function MemorySearchTab({
  status, loadingStatus, indexOptions, selectedIndex, setSelectedIndex,
  query, setQuery, searchType, setSearchType, limit, setLimit,
  filePattern, setFilePattern, extensions, setExtensions,
  searching, searchResult, searchError, onSearch, onSwitchToConfig,
}: Props) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="border-b border-border bg-card/50 shrink-0">
        <div className="max-w-4xl mx-auto w-full px-6 py-3 space-y-2">
          {/* Search bar */}
          <div className="flex items-center gap-2">
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Requete semantique..."
              className="flex-1 min-w-0 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
              onKeyDown={e => e.key === 'Enter' && onSearch()}
            />
            <button
              type="button" disabled={searching || !query.trim() || !status?.enabled}
              onClick={onSearch}
              className={clsx(btnPrimary, 'px-4 py-2 text-sm shrink-0')}
            >
              <Search size={14} className={searching ? 'animate-spin' : ''} />
              {searching ? 'Recherche...' : 'Chercher'}
            </button>
          </div>
          {/* Options row */}
          <div className="flex items-center gap-3 flex-wrap">
            {status?.enabled && indexOptions.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Index</span>
                <select value={selectedIndex} onChange={e => setSelectedIndex(e.target.value)} className={clsx(inputCls, 'w-auto py-1 text-[11px]')}>
                  {indexOptions.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Type</span>
              <select value={searchType} onChange={e => setSearchType(e.target.value as 'vector' | 'hybrid')} className={clsx(inputCls, 'w-auto py-1 text-[11px]')}>
                <option value="vector">vector</option>
                <option value="hybrid">hybrid</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Limite</span>
              <input
                type="number" min={1} max={20} value={limit}
                onChange={e => setLimit(Number(e.target.value) || 10)}
                className={clsx(inputCls, 'w-14 py-1 font-mono text-[11px]')}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Fichier</span>
              <input
                value={filePattern} onChange={e => setFilePattern(e.target.value)}
                placeholder="ex: src/**/*.ts"
                className={clsx(inputCls, 'w-32 py-1 font-mono text-[11px]')}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Ext</span>
              <input
                value={extensions} onChange={e => setExtensions(e.target.value)}
                placeholder="ts,tsx,py"
                className={clsx(inputCls, 'w-24 py-1 font-mono text-[11px]')}
              />
            </div>
            <p className="text-[10px] text-muted-foreground ml-auto">
              Necessite une cle embeddings — 20 resultats max
            </p>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto w-full px-6 py-5">
          {searchError && (
            <div className="text-sm text-destructive border border-destructive/30 rounded-xl p-3 mb-4">{searchError}</div>
          )}

          {!loadingStatus && !status?.enabled && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
              <Database size={36} className="text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">Codebase search n'est pas active.</p>
              <button type="button" onClick={onSwitchToConfig} className="text-xs text-primary hover:underline">
                Ouvrir la Configuration →
              </button>
            </div>
          )}

          {loadingStatus && (
            <div className="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
              <RefreshCw size={14} className="animate-spin" /> Chargement...
            </div>
          )}

          {!loadingStatus && status?.enabled && !searchResult && !searching && !searchError && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
              <Search size={36} className="text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">Saisissez une requete pour explorer le codebase indexe.</p>
            </div>
          )}

          {searching && (
            <div className="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
              <RefreshCw size={14} className="animate-spin" /> Recherche en cours...
            </div>
          )}

          {searchResult && !searching && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {searchResult.hits.length} resultat(s) — index <span className="text-primary font-mono">{searchResult.index}</span>
                </p>
              </div>

              {searchResult.hits.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">Aucun resultat pour cette requete.</p>
              )}

              {searchResult.hits.map((h, i) => (
                <div key={`${h.filePath}-${h.startLine}-${i}`} className="rounded-xl border border-border/50 bg-card overflow-hidden">
                  {/* Header */}
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-secondary/30 border-b border-border/30">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="text-xs font-mono text-theme-green truncate">
                        {h.filePath}<span className="text-muted-foreground">:{h.startLine}–{h.endLine}</span>
                      </span>
                      {h.name && (
                        <span className={clsx(badgeCls, 'bg-primary/10 text-primary font-mono')}>
                          {h.type ?? 'symbol'}: {h.name}
                        </span>
                      )}
                    </div>
                    {typeof h.relevanceScore === 'number' && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <div className="w-14 h-1.5 rounded-full bg-secondary overflow-hidden">
                          <div
                            className={clsx('h-full rounded-full transition-all', h.relevanceScore >= 0.7 ? 'bg-theme-green' : h.relevanceScore >= 0.4 ? 'bg-theme-orange' : 'bg-destructive')}
                            style={{ width: `${Math.round(h.relevanceScore * 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono w-8 text-right">{Math.round(h.relevanceScore * 100)}%</span>
                      </div>
                    )}
                  </div>
                  {/* Code preview */}
                  <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed px-4 py-3 overflow-x-auto max-h-48">
                    {h.contentPreview}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
