import { Activity, RefreshCw, Settings, Save, FolderOpen, Clock, Cpu, Plus, Trash2, Play, CheckCircle2, XCircle, Loader2, Cable, AlertTriangle, Cloud } from 'lucide-react';
import { clsx } from 'clsx';
import type { CodebaseSearchStatusResponse, CodebaseSearchStatsResponse, CsForm, IndexEntry, MercuryChainSnapshot } from './types';
import { fmtRunAt } from './types';

interface Props {
  status: CodebaseSearchStatusResponse | null;
  loadingStatus: boolean;
  stats: CodebaseSearchStatsResponse | null;
  statsError: string | null;
  loadingStats: boolean;
  statusError: string | null;
  // Config form
  csForm: CsForm;
  setCsForm: (fn: (f: CsForm) => CsForm) => void;
  configLoading: boolean;
  configSaving: boolean;
  configError: string | null;
  configOk: string | null;
  // Index
  selectedIndex: string;
  setSelectedIndex: (v: string) => void;
  indexOptions: string[];
  // Embed
  embedBusy: Record<string, boolean>;
  embedAllBusy: boolean;
  // Handlers
  onRefreshStatus: () => void;
  onRefreshStats: () => void;
  onRefreshConfig: () => void;
  onSave: () => void;
  onRunEmbed: (indexKey?: string, mode?: 'full' | 'incremental') => void;
  updateEntry: (id: string, field: keyof Omit<IndexEntry, 'id'>, value: string) => void;
  addEntry: () => void;
  removeEntry: (id: string) => void;
  // Mercury embedding broker (optionnel)
  mercuryChain?: MercuryChainSnapshot | null;
  /** Toggle global force-cloud — appel direct sans passer par Enregistrer (pour réactivité). */
  onToggleForceCloud?: (value: boolean) => Promise<void> | void;
}

export function MemoryConfigTab({
  status, loadingStatus, stats, statsError, loadingStats, statusError,
  csForm, setCsForm, configLoading, configSaving, configError, configOk,
  selectedIndex, setSelectedIndex, indexOptions,
  embedBusy, embedAllBusy,
  onRefreshStatus, onRefreshStats, onRefreshConfig, onSave, onRunEmbed,
  updateEntry, addEntry, removeEntry,
  mercuryChain,
  onToggleForceCloud,
}: Props) {
  const chainHomogeneous = !mercuryChain
    ? true
    : (() => {
        const dims = mercuryChain.entries.map(e => e.dim).filter((d): d is number => typeof d === 'number');
        if (dims.length === 0) return true;
        if (mercuryChain.expectedDim != null) return dims.every(d => d === mercuryChain.expectedDim);
        return dims.every(d => d === dims[0]);
      })();
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-4xl mx-auto w-full">

      {/* Runtime status card */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground flex items-center gap-2"><Activity size={15} /> Etat runtime</h2>
          <button type="button" onClick={onRefreshStatus} className="p-1.5 rounded text-muted-foreground hover:bg-secondary" title="Rafraichir">
            <RefreshCw size={13} className={loadingStatus ? 'animate-spin' : ''} />
          </button>
        </div>
        {loadingStatus && <p className="text-xs text-muted-foreground">Chargement...</p>}
        {statusError && <p className="text-xs text-destructive">{statusError}</p>}
        {status && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className={clsx('w-2 h-2 rounded-full shrink-0', status.enabled ? 'bg-theme-green' : 'bg-destructive')} />
                <span className="text-muted-foreground">Active :</span>
                <span className={status.enabled ? 'text-theme-green' : 'text-destructive'}>{status.enabled ? 'oui' : 'non'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={clsx('w-2 h-2 rounded-full shrink-0', status.embeddingBrokerActive ? 'bg-theme-green' : 'bg-destructive')} />
                <span className="text-muted-foreground">Broker Mercury :</span>
                <span className={status.embeddingBrokerActive ? 'text-theme-green' : 'text-destructive'}>{status.embeddingBrokerActive ? 'actif' : 'inactif'}</span>
              </div>
              {typeof status.embedJobCount === 'number' && (
                <div className="col-span-2 text-muted-foreground">Jobs resolus : <span className="font-mono text-foreground">{status.embedJobCount}</span></div>
              )}
              <div className="col-span-2 text-muted-foreground">
                Cron : {status.embedCronEnabled
                  ? <span className="text-theme-green">active{typeof status.embedCronHourUtc === 'number' ? ` (${status.embedCronHourUtc}h UTC)` : ''}</span>
                  : <span>desactive</span>}
                {status.allowUiIndex === false && <span className="text-destructive ml-2">(index UI refusee)</span>}
              </div>
            </div>
            {status.enabled && (
              <div className="text-[10px] font-mono text-muted-foreground space-y-0.5 border-t border-border pt-2">
                {status.resolvedDefaultDbPath && <p className="truncate">Index defaut : {status.resolvedDefaultDbPath}</p>}
                {Object.entries(status.resolvedIndices).map(([k, v]) => (
                  <p key={k} className="truncate"><span className="text-primary">{k}</span> → {v}</p>
                ))}
              </div>
            )}
            {status.enabled && (status.embedJobCount ?? 0) === 0 && (
              <div className="text-xs border border-theme-orange/40 bg-theme-orange/10 rounded-lg p-2 text-foreground">
                <strong className="font-medium">Aucun job d'embedding configure.</strong> Definissez au moins un index avec un dossier source ci-dessous.
              </div>
            )}

            {/* Per-index embed table */}
            {status.enabled && status.allowUiIndex !== false && Object.keys(status.resolvedEmbedSources ?? {}).length > 0 && (
              <div className="border-t border-border pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-foreground">Embedding par index</p>
                  <div className="flex items-center gap-1">
                    <button type="button" disabled={embedAllBusy || Object.values(embedBusy).some(Boolean)} onClick={() => onRunEmbed(undefined, 'full')} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40 transition-colors" title="Reindexation complete">
                      {embedAllBusy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Tous
                    </button>
                    <button type="button" disabled={embedAllBusy || Object.values(embedBusy).some(Boolean)} onClick={() => onRunEmbed(undefined, 'incremental')} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40 transition-colors" title="Mise a jour incrementale">
                      <RefreshCw size={12} /> Tous (↑)
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {Object.entries(status.resolvedEmbedSources).map(([key, srcPath]) => {
                    const run = status.lastEmbedRuns?.[key];
                    const isRunning = run?.status === 'running' || embedBusy[key] === true;
                    const busy = isRunning || embedAllBusy;
                    const progress = isRunning ? run?.progress : undefined;
                    const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : undefined;

                    return (
                      <div key={key} className={clsx('rounded-xl px-3 py-2 border transition-colors',
                        isRunning ? 'border-primary/40 bg-primary/5' : run?.status === 'ok' ? 'border-theme-green/30 bg-theme-green/5' : run?.status === 'error' ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-secondary/30',
                      )}>
                        <div className="flex items-center gap-3">
                          <span className="shrink-0">
                            {isRunning ? <Loader2 size={14} className="animate-spin text-primary" /> : run?.status === 'ok' ? <CheckCircle2 size={14} className="text-theme-green" /> : run?.status === 'error' ? <XCircle size={14} className="text-destructive" /> : <span className="w-3.5 h-3.5 rounded-full border-2 border-muted-foreground/30 inline-block" />}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="text-xs font-mono font-medium text-foreground">{key}</span>
                              {!isRunning && run?.at && <span className="text-[10px] text-muted-foreground truncate">{fmtRunAt(run.at)}</span>}
                              {isRunning && progress && <span className="text-[10px] text-primary font-medium">{progress.phase === 'chunking' ? 'Analyse' : 'Embedding'} {progress.done}/{progress.total}{pct !== undefined && <> — {pct}%</>}</span>}
                              {isRunning && !progress && <span className="text-[10px] text-primary">Demarrage...</span>}
                            </div>
                            <p className="text-[10px] font-mono text-muted-foreground truncate">{srcPath}</p>
                            {run?.status === 'error' && run.message && <p className="text-[10px] text-destructive mt-0.5 truncate">{run.message}</p>}
                          </div>
                          {isRunning ? (
                            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-primary/10 text-primary"><Loader2 size={11} className="animate-spin" /> En cours...</span>
                          ) : (
                            <div className="shrink-0 flex items-center gap-1">
                              <button type="button" disabled={busy} onClick={() => onRunEmbed(key, 'full')} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted border border-border/50 disabled:opacity-40 transition-colors" title="Reindexation complete"><Play size={11} /> Full</button>
                              <button type="button" disabled={busy} onClick={() => onRunEmbed(key, 'incremental')} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted border border-border/50 disabled:opacity-40 transition-colors" title="Mise a jour incrementale"><RefreshCw size={11} /> Incre</button>
                            </div>
                          )}
                        </div>
                        {isRunning && (
                          <div className="mt-2">
                            <div className="w-full h-1 rounded-full bg-primary/15 overflow-hidden">
                              {pct !== undefined ? <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} /> : <div className="h-full w-1/3 rounded-full bg-primary animate-pulse" />}
                            </div>
                            {progress && <p className="text-[10px] text-muted-foreground mt-1">{progress.phase === 'chunking' ? 'Lecture et decoupage des fichiers...' : 'Generation des embeddings...'}</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {status.enabled && status.allowUiIndex !== false && Object.keys(status.resolvedEmbedSources ?? {}).length === 0 && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">Aucun dossier source configure — ajoutez des index dans la configuration ci-dessous.</p>
              </div>
            )}
          </>
        )}
        {!status && !loadingStatus && (
          <p className="text-xs text-muted-foreground">Activez codebase search dans la configuration ci-dessous puis enregistrez.</p>
        )}
      </div>

      {/* Override runtime global : force cloud */}
      {mercuryChain && (
        <div className={clsx(
          'rounded-xl border p-3 flex items-center justify-between gap-3',
          csForm.embeddingForceCloud
            ? 'border-theme-orange/50 bg-theme-orange/10'
            : 'border-border/50 bg-card',
        )}>
          <div className="flex items-center gap-2 min-w-0">
            <Cable size={15} className={csForm.embeddingForceCloud ? 'text-theme-orange' : 'text-muted-foreground'} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground m-0">
                Mode cloud-only {csForm.embeddingForceCloud && <span className="text-[10px] font-bold uppercase ml-1 px-1.5 py-0.5 rounded bg-theme-orange/30 text-theme-orange">actif</span>}
              </p>
              <p className="text-[11px] text-muted-foreground m-0 truncate">
                {csForm.embeddingForceCloud
                  ? 'Tous les embeds Mastermind passent cloud — local skippé pour libérer le GPU.'
                  : 'Force tous les embeds (memory, search, cron) à passer par cloud — utile quand tu veux libérer le GPU pour le chat.'}
              </p>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={csForm.embeddingForceCloud}
              onChange={async e => {
                const next = e.target.checked;
                setCsForm(f => ({ ...f, embeddingForceCloud: next }));
                if (onToggleForceCloud) await onToggleForceCloud(next);
              }}
              className="rounded border-border"
            />
          </label>
        </div>
      )}

      {/* Mercury embedding broker — chaine ordonnée */}
      {mercuryChain && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
              <Cable size={15} /> Embeddings via Mercury
            </h2>
            <span className="text-[10px] text-muted-foreground font-mono">{mercuryChain.providerId}</span>
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            Tous les appels d'embedding (memory-store + codebase-search) sont routés vers Mercury, qui gère la chaine en cascade.
            La clé OpenRouter n'est plus nécessaire côté Mastermind — Mercury la détient.
          </p>
          {mercuryChain.error && (
            <p className="text-xs text-destructive border border-destructive/30 rounded-lg p-2 m-0">
              Mercury injoignable : {mercuryChain.error}
            </p>
          )}
          {!chainHomogeneous && (
            <div className="text-xs border border-theme-orange/40 bg-theme-orange/10 rounded-lg p-2 text-foreground flex items-start gap-2">
              <AlertTriangle size={14} className="text-theme-orange shrink-0 mt-0.5" />
              <span>
                <strong className="font-medium">Dimensions hétérogènes</strong> détectées dans la chaine
                {mercuryChain.expectedDim ? <> (DB attend <code className="bg-secondary px-1 rounded">{mercuryChain.expectedDim}</code>)</> : null}.
                Mastermind refusera de réinitialiser memory-store tant que la chaine n'est pas cohérente.
              </span>
            </div>
          )}
          {mercuryChain.entries.length === 0 && !mercuryChain.error && (
            <p className="text-xs text-muted-foreground italic m-0">
              Chaine vide — configure un modèle local et/ou cloud dans <strong>Mercury → Models → Chaine embedding</strong>.
            </p>
          )}
          {mercuryChain.entries.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border bg-secondary/30">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-secondary/60">
                    <th className="p-2 font-medium text-muted-foreground border-b border-border w-12 text-center">Prio</th>
                    <th className="p-2 font-medium text-muted-foreground border-b border-border">ID</th>
                    <th className="p-2 font-medium text-muted-foreground border-b border-border">Backend</th>
                    <th className="p-2 font-medium text-muted-foreground border-b border-border">Modèle</th>
                    <th className="p-2 font-medium text-muted-foreground border-b border-border w-16 text-right">Dim</th>
                  </tr>
                </thead>
                <tbody>
                  {mercuryChain.entries.map(e => (
                    <tr key={e.id}>
                      <td className="p-2 border-b border-border/50 text-center font-mono text-foreground">{e.priority}</td>
                      <td className="p-2 border-b border-border/50 font-mono text-foreground">{e.id}</td>
                      <td className="p-2 border-b border-border/50">
                        <span className={clsx(
                          'px-1.5 py-0.5 rounded text-[9px] font-bold uppercase',
                          e.backend === 'llamacpp'
                            ? 'bg-theme-green/20 text-theme-green border border-theme-green/30'
                            : 'bg-primary/20 text-primary border border-primary/30',
                        )}>
                          {e.backend === 'llamacpp' ? 'local' : 'cloud'}
                        </span>
                      </td>
                      <td className="p-2 border-b border-border/50 font-mono text-muted-foreground truncate max-w-[16rem]" title={e.model}>{e.model}</td>
                      <td className={clsx(
                        'p-2 border-b border-border/50 text-right font-mono tabular-nums',
                        typeof e.dim === 'number' && mercuryChain.expectedDim != null && e.dim !== mercuryChain.expectedDim
                          ? 'text-destructive font-bold'
                          : 'text-muted-foreground',
                      )}>
                        {e.dim ?? '?'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground m-0">
            Édition de la chaine : ouvre l'UI Mercury → onglet <strong>Models</strong> → carte <strong>Chaine embedding</strong>.
          </p>
        </div>
      )}

      {/* Stats card */}
      {status?.enabled && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">Statistiques index</h2>
            <div className="flex items-center gap-2">
              <select value={selectedIndex} onChange={e => setSelectedIndex(e.target.value)} className="text-xs bg-secondary border border-border rounded-lg px-2 py-1 text-foreground">
                {indexOptions.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              <button type="button" onClick={onRefreshStats} className="p-1.5 rounded text-muted-foreground hover:bg-secondary border border-border/50" title="Rafraichir">
                <RefreshCw size={12} className={loadingStats ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
          {loadingStats && <p className="text-xs text-muted-foreground">Chargement...</p>}
          {statsError && <p className="text-xs text-destructive">{statsError}</p>}
          {stats && !statsError && (
            <div className="text-xs space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Chunks :</span>
                <span className="font-mono font-medium">{stats.totalChunks.toLocaleString()}</span>
              </div>
              <p className="font-mono text-muted-foreground truncate text-[10px]">{stats.dbPath}</p>
              <div className="mt-2">
                <span className="text-muted-foreground">Extensions (top 12) :</span>
                <ul className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-1 font-mono">
                  {Object.entries(stats.extensions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ext, n]) => (
                    <li key={ext} className="text-[10px]"><span className="text-primary">{ext}</span> <span className="text-muted-foreground">{n}</span></li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Configuration form */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground flex items-center gap-2"><Settings size={15} /> Configuration</h2>
          <button type="button" onClick={onRefreshConfig} className="p-1.5 rounded text-muted-foreground hover:bg-secondary text-xs flex items-center gap-1" title="Recharger">
            <RefreshCw size={13} className={configLoading ? 'animate-spin' : ''} /> Recharger
          </button>
        </div>

        {configError && <div className="text-sm text-destructive border border-destructive/30 rounded-xl p-3">{configError}</div>}
        {configOk && <div className="text-sm text-theme-green border border-theme-green/30 rounded-xl p-3">{configOk}</div>}

        {configLoading ? (
          <p className="text-xs text-muted-foreground px-1">Chargement config...</p>
        ) : (
          <div className="space-y-4">
            {/* Enable toggle */}
            <div className="rounded-xl border border-border/50 bg-card px-4 py-3">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm font-medium text-foreground">Activer codebase search</span>
                <input type="checkbox" checked={csForm.enabled} onChange={e => setCsForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded border-border" />
              </label>
            </div>

            {/* Indexes */}
            <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5"><FolderOpen size={12} /> Index</p>
              <p className="text-[11px] text-muted-foreground -mt-1">Chaque entree definit un index distinct. Utilisez la cle <code className="bg-secondary px-1 rounded-md">default</code> pour l'index principal.</p>
              <div className="grid gap-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-1" style={{ gridTemplateColumns: '1fr 2fr 2fr 28px' }}>
                <span>Nom</span><span>Dossier source</span><span>Chemin LanceDB</span><span />
              </div>
              <div className="space-y-2">
                {csForm.indexEntries.map(entry => (
                  <div key={entry.id} className="grid gap-2 items-center" style={{ gridTemplateColumns: '1fr 2fr 2fr 28px' }}>
                    <input value={entry.key} onChange={e => updateEntry(entry.id, 'key', e.target.value)} placeholder="default" className="bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs font-mono text-foreground w-full focus:outline-none focus:border-ring" />
                    <input value={entry.sourcePath} onChange={e => updateEntry(entry.id, 'sourcePath', e.target.value)} placeholder="/chemin/vers/repo" className="bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs font-mono text-foreground w-full focus:outline-none focus:border-ring" />
                    <input value={entry.dbPath} onChange={e => updateEntry(entry.id, 'dbPath', e.target.value)} placeholder="/chemin/vers/index.db" className="bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs font-mono text-foreground w-full focus:outline-none focus:border-ring" />
                    <button type="button" onClick={() => removeEntry(entry.id)} disabled={csForm.indexEntries.length === 1} className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:pointer-events-none transition-colors" title="Supprimer"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={addEntry} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"><Plus size={13} /> Ajouter un index</button>
            </div>

            {/* Automation */}
            <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5"><Clock size={12} /> Automatisation</p>
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={csForm.embedCronEnabled} onChange={e => setCsForm(f => ({ ...f, embedCronEnabled: e.target.checked }))} className="rounded border-border" />
                <span className="text-sm text-foreground">Embedding automatique (cron quotidien)</span>
              </label>
              {csForm.embedCronEnabled && (
                <div className="flex flex-col gap-3 ml-6">
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground">Heure UTC (0–23)</label>
                      <input type="number" min={0} max={23} value={csForm.embedCronHourUtc} onChange={e => setCsForm(f => ({ ...f, embedCronHourUtc: Number(e.target.value) }))} className="w-20 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs font-mono text-foreground" />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground">Mode</label>
                      <select value={csForm.embedCronMode} onChange={e => setCsForm(f => ({ ...f, embedCronMode: e.target.value as 'full' | 'incremental' }))} className="bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground">
                        <option value="full">Complet (full)</option>
                        <option value="incremental">Incremental</option>
                      </select>
                    </div>
                  </div>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={csForm.embedCronCloudOnly}
                      onChange={e => setCsForm(f => ({ ...f, embedCronCloudOnly: e.target.checked }))}
                      className="rounded border-border mt-0.5"
                    />
                    <div className="min-w-0">
                      <span className="text-sm text-foreground flex items-center gap-1.5"><Cloud size={12} /> Cron → cloud only</span>
                      <p className="text-[11px] text-muted-foreground m-0">Daily embed skips local GPU (frees it for other background jobs at night).</p>
                    </div>
                  </label>
                </div>
              )}
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={csForm.allowUiIndex} onChange={e => setCsForm(f => ({ ...f, allowUiIndex: e.target.checked }))} className="rounded border-border" />
                <span className="text-sm text-foreground">Autoriser le declenchement depuis l'UI</span>
              </label>
            </div>

            {/* Advanced */}
            <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5"><Cpu size={12} /> Avance</p>
              <div>
                <label className="text-xs text-muted-foreground">Fichier JSON d'options supplementaires</label>
                <input value={csForm.configPath} onChange={e => setCsForm(f => ({ ...f, configPath: e.target.value }))} className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-ring" placeholder="Chemin relatif au YAML ou absolu (optionnel)" />
              </div>
            </div>

            {/* Save */}
            <div className="flex justify-end pt-1">
              <button type="button" disabled={configSaving} onClick={onSave} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50">
                <Save size={15} /> {configSaving ? 'Enregistrement...' : 'Enregistrer'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
