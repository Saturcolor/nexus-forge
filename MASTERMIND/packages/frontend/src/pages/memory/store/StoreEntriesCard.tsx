import { useState, useCallback, useEffect } from 'react';
import { Database, RefreshCw, Search, ChevronLeft, ChevronRight, Pencil, Check, X, Trash2, Archive, RotateCcw, Loader2, Download } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../../lib/api';
import { cardCls, inputCls, btnSecondary, badgeCls, fmtRunAt } from '../types';
import type { MemoryEntry, AgentSummary } from '../types';

interface Props {
  agents: AgentSummary[];
  scopeFilter: string;
  setScopeFilter: (v: string) => void;
}

export function StoreEntriesCard({ agents, scopeFilter, setScopeFilter }: Props) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // Inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editDomain, setEditDomain] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Export
  const [exportIncludeArchived, setExportIncludeArchived] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportInfo, setExportInfo] = useState<string | null>(null);

  const loadEntries = useCallback(async (p = 1) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), limit: '20' });
      if (query.trim()) params.set('q', query.trim());
      if (scopeFilter === 'shared') {
        params.set('scope', 'shared');
      } else if (scopeFilter !== 'all') {
        params.set('scope', 'agent');
        params.set('agentId', scopeFilter);
      }
      if (domain.trim()) params.set('domain', domain.trim());
      if (showArchived) params.set('archived', 'true');
      const r = await api.get<{ entries: MemoryEntry[]; total: number; page: number; pages: number }>(`/api/memory-store/entries?${params.toString()}`);
      setEntries(r.entries);
      setTotal(r.total);
      setPage(r.page);
      setPages(r.pages);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query, scopeFilter, domain, showArchived]);

  const startEdit = (e: MemoryEntry) => { setEditingId(e.id); setEditText(e.text); setEditDomain(e.domain ?? ''); setEditTags(e.tags?.join(', ') ?? ''); };
  const cancelEdit = () => { setEditingId(null); setEditText(''); setEditDomain(''); setEditTags(''); };

  const saveEdit = async () => {
    if (!editingId) return;
    setEditSaving(true);
    try {
      const parsedTags = editTags.split(',').map(t => t.trim()).filter(Boolean);
      await api.put(`/api/memory-store/entries/${editingId}`, { text: editText, domain: editDomain.trim() || undefined, tags: parsedTags.length > 0 ? parsedTags : undefined });
      setEntries(prev => prev.map(e => e.id === editingId ? { ...e, text: editText, domain: editDomain.trim() || undefined, tags: parsedTags.length > 0 ? parsedTags : undefined } : e));
      setEditingId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditSaving(false);
    }
  };

  const deleteEntry = async (id: string) => {
    try {
      await api.delete(`/api/memory-store/entries/${id}`);
      setEntries(prev => prev.filter(e => e.id !== id));
      setTotal(prev => prev - 1);
      setDeleteConfirmId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportMarkdown = async () => {
    setExporting(true);
    setExportInfo(null);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; path: string; entryCount: number; bytes: number }>(
        '/api/memory-store/export',
        { includeArchived: exportIncludeArchived },
      );
      const kb = (r.bytes / 1024).toFixed(1);
      setExportInfo(`Exporte : ${r.path} (${r.entryCount} entrees, ${kb} Ko)`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const unarchive = async (id: string) => {
    try {
      await api.post(`/api/memory-consolidation/unarchive/${id}`);
      void loadEntries(page);
    } catch { /* ignore */ }
  };

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Database size={16} /> Parcourir les entrees
          {total > 0 && <span className="text-xs font-normal text-muted-foreground ml-1">({total})</span>}
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer shrink-0" title="Inclure entrees archivees et fusionnees">
            <input type="checkbox" checked={exportIncludeArchived} onChange={e => setExportIncludeArchived(e.target.checked)} className="rounded" />
            archivees
          </label>
          <button
            type="button"
            onClick={() => void exportMarkdown()}
            disabled={exporting}
            className={clsx(btnSecondary, 'text-xs')}
            title="Exporter tout (agent + shared) vers shared-memory/export/"
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Exporter .md
          </button>
          <button type="button" onClick={() => void loadEntries(page)} disabled={loading} className="text-muted-foreground hover:text-foreground" title="Actualiser">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {exportInfo && (
        <p className="text-xs text-theme-green mb-3 font-mono break-all">{exportInfo}</p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void loadEntries(1)}
          placeholder="Recherche semantique..."
          className={clsx(inputCls, 'flex-1 min-w-40')}
        />
        <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value)} className={inputCls + ' w-auto'}>
          <option value="all">Tous les scopes</option>
          <option value="shared">shared</option>
          {agents.map(a => (
            <option key={a.identity.id} value={a.identity.id}>{a.identity.name ?? a.identity.id}</option>
          ))}
        </select>
        <input value={domain} onChange={e => setDomain(e.target.value)} onKeyDown={e => e.key === 'Enter' && void loadEntries(1)} placeholder="Domaine..." className={clsx(inputCls, 'w-32')} />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer shrink-0">
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="rounded" />
          <Archive size={13} /> Archivees
        </label>
        <button type="button" onClick={() => void loadEntries(1)} className={btnSecondary}>
          <Search size={13} /> Chercher
        </button>
      </div>

      {error && <p className="text-xs text-theme-red mb-3">{error}</p>}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
          <Loader2 size={14} className="animate-spin" /> Chargement...
        </div>
      )}

      {!loading && entries.length === 0 && total === 0 && !query && scopeFilter === 'all' && !domain && (
        <p className="text-xs text-muted-foreground py-8 text-center">Selectionnez un scope ou entrez une recherche.</p>
      )}

      {!loading && entries.length === 0 && (query || scopeFilter !== 'all' || domain) && (
        <p className="text-xs text-muted-foreground py-6 text-center">Aucune entree pour ces criteres.</p>
      )}

      {!loading && entries.length > 0 && (
        <div className="space-y-2 max-h-[32rem] overflow-y-auto pr-1">
          {entries.map(entry => (
            <div key={entry.id} className="border border-border/50 rounded-xl p-3 bg-background">
              {editingId === entry.id ? (
                <div className="space-y-2">
                  <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={4} className={clsx(inputCls, 'font-mono resize-none')} />
                  <div className="flex items-center gap-2">
                    <input value={editDomain} onChange={e => setEditDomain(e.target.value)} placeholder="Domaine" className={clsx(inputCls, 'flex-1')} />
                    <input value={editTags} onChange={e => setEditTags(e.target.value)} placeholder="Tags (virgule)" className={clsx(inputCls, 'flex-1')} />
                    <button type="button" onClick={() => void saveEdit()} disabled={editSaving} className="p-1 text-theme-green hover:text-foreground disabled:opacity-50" title="Enregistrer">
                      {editSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    </button>
                    <button type="button" onClick={cancelEdit} className="p-1 text-muted-foreground hover:text-foreground" title="Annuler">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-foreground whitespace-pre-wrap flex-1 leading-relaxed">
                      {entry.text.length > 300 ? entry.text.slice(0, 300) + '...' : entry.text}
                    </p>
                    <div className="flex gap-1 shrink-0">
                      <button type="button" onClick={() => startEdit(entry)} className="p-1 text-muted-foreground hover:text-foreground" title="Modifier"><Pencil size={13} /></button>
                      {deleteConfirmId === entry.id ? (
                        <>
                          <button type="button" onClick={() => void deleteEntry(entry.id)} className="p-1 text-theme-red hover:text-foreground" title="Confirmer"><Check size={13} /></button>
                          <button type="button" onClick={() => setDeleteConfirmId(null)} className="p-1 text-muted-foreground hover:text-foreground" title="Annuler"><X size={13} /></button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setDeleteConfirmId(entry.id)} className="p-1 text-muted-foreground hover:text-theme-red" title="Supprimer"><Trash2 size={13} /></button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2 items-center">
                    {entry.similarity !== undefined && (
                      <span className={clsx(badgeCls, 'bg-primary/10 text-primary')}>{Math.round(entry.similarity * 100)}%</span>
                    )}
                    {entry.score != null && (
                      <span className={clsx(badgeCls,
                        entry.score >= 0.5 ? 'bg-theme-green/10 text-theme-green' :
                        entry.score >= 0.2 ? 'bg-theme-orange/10 text-theme-orange' :
                        'bg-theme-red/10 text-theme-red',
                      )}>score {entry.score.toFixed(2)}</span>
                    )}
                    {(entry.accessCount ?? 0) > 0 && (
                      <span className={clsx(badgeCls, 'bg-secondary text-muted-foreground')} title={entry.lastAccessedAt ? `Dernier acces : ${fmtRunAt(entry.lastAccessedAt)}` : undefined}>
                        {entry.accessCount}x
                      </span>
                    )}
                    {entry.mergeSourceIds && entry.mergeSourceIds.length > 0 && (
                      <span className={clsx(badgeCls, 'bg-primary/10 text-primary')}>fusionnee de {entry.mergeSourceIds.length}</span>
                    )}
                    {entry.archived && (
                      <button type="button" onClick={() => void unarchive(entry.id)} className={clsx(badgeCls, 'bg-theme-orange/10 text-theme-orange hover:bg-theme-orange/20 cursor-pointer')} title="Desarchiver">
                        <RotateCcw size={11} /> archivee
                      </button>
                    )}
                    {entry.scope === 'shared'
                      ? <span className={clsx(badgeCls, 'bg-secondary text-muted-foreground')}>shared</span>
                      : <span className={clsx(badgeCls, 'bg-secondary text-muted-foreground')}>{entry.agentId ? (agents.find(a => a.identity.id === entry.agentId)?.identity.name ?? entry.agentId) : 'agent'}</span>
                    }
                    {entry.domain && <span className={clsx(badgeCls, 'bg-secondary text-muted-foreground')}>{entry.domain}</span>}
                    {entry.tags && entry.tags.length > 0 && entry.tags.map(t => (
                      <span key={t} className={clsx(badgeCls, 'bg-primary/5 text-primary/70')}>#{t}</span>
                    ))}
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {new Date(entry.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button type="button" disabled={page <= 1 || loading} onClick={() => void loadEntries(page - 1)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
            <ChevronLeft size={14} /> Precedent
          </button>
          <span className="text-xs text-muted-foreground">Page {page} / {pages}</span>
          <button type="button" disabled={page >= pages || loading} onClick={() => void loadEntries(page + 1)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
            Suivant <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
