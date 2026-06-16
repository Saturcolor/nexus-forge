import { useState, useCallback, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Database, RefreshCw, X, ChevronDown, Eye, EyeOff, Search } from 'lucide-react'
import { clsx } from 'clsx'
import type { Config, ModelsCacheState, CachedModelEntry } from '../../../api/admin'
import * as api from '../../../api/admin'
import { useRefreshCacheMutation, useModelMapping, QUERY_KEYS } from '../../../api/queries'
import { Spinner } from '../../ui/Spinner'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Badge } from '../../ui/Badge'
import { inputCls, groupCls, formatDT } from './shared'

type ModelsCardProps = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
}

/* ── Visibility toggle row ─────────────────────────────────── */
function ModelRow({
  name, hidden, onToggle,
}: { name: string; hidden: boolean; onToggle: () => void }) {
  return (
    <div className={clsx(
      'flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-colors group/row',
      hidden
        ? 'bg-background/30 border-border/30'
        : 'bg-background/60 border-border/40',
    )}>
      <button
        type="button"
        onClick={onToggle}
        title={hidden ? 'Rendre visible' : 'Masquer'}
        className={clsx(
          'shrink-0 transition-colors',
          hidden
            ? 'text-muted-foreground/30 hover:text-primary'
            : 'text-primary/70 hover:text-primary',
        )}
      >
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      <code className={clsx(
        'text-[11px] font-mono flex-1 min-w-0 truncate',
        hidden ? 'text-muted-foreground/40 line-through' : 'text-foreground',
      )}>
        {name}
      </code>
    </div>
  )
}

/* ── Backend group ─────────────────────────────────────────── */
function BackendGroup({
  backend, models, hiddenSet, onToggle, defaultOpen,
}: {
  backend: string
  models: CachedModelEntry[]
  hiddenSet: Set<string>
  onToggle: (name: string) => void
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hiddenCount = models.filter(m => hiddenSet.has(m.name)).length

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-[10px] font-semibold text-muted-foreground hover:text-foreground transition-colors w-fit"
      >
        <ChevronDown size={11} className={clsx('transition-transform duration-150', !open && '-rotate-90')} />
        <span className="uppercase tracking-wider">{backend}</span>
        <span className="font-normal text-muted-foreground/50">
          {models.length} · {hiddenCount > 0 ? `${hiddenCount} masqués` : 'tous visibles'}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 pl-4">
          {models.map(m => (
            <ModelRow
              key={m.name}
              name={m.name}
              hidden={hiddenSet.has(m.name)}
              onToggle={() => onToggle(m.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Main card ─────────────────────────────────────────────── */
export function ModelsCard({ config, updateField }: ModelsCardProps) {
  const refreshCacheMutation = useRefreshCacheMutation()
  const queryClient = useQueryClient()
  const [cacheState, setCacheState] = useState<ModelsCacheState | null>(null)
  const [allModels, setAllModels] = useState<CachedModelEntry[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  const [backendRawOpen, setBackendRawOpen] = useState(false)
  const [manualInput, setManualInput] = useState('')
  const [search, setSearch] = useState('')

  // Mapping diagnostic — fetché paresseusement via le hook partagé seulement quand la section est ouverte.
  const { data: mapping = null } = useModelMapping(diagOpen)

  const hiddenModels: string[] = Array.isArray(config.hidden_models) ? config.hidden_models : []
  const hiddenSet = useMemo(() => new Set(hiddenModels), [hiddenModels])

  const loadCache = useCallback(async () => {
    try { setCacheState(await api.getCacheState()) } catch { setCacheState(null) }
    try {
      const res = await api.getCacheModels()
      setAllModels(res.models ?? [])
    } catch { setAllModels([]) }
  }, [])

  useEffect(() => { loadCache() }, [loadCache])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshCacheMutation.mutateAsync()
      await loadCache()
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.modelMapping }) // invalidate diagnostic
    } finally {
      setRefreshing(false)
    }
  }

  const toggleHidden = (name: string) => {
    if (hiddenSet.has(name)) {
      updateField('hidden_models', hiddenModels.filter(x => x !== name))
    } else {
      updateField('hidden_models', [...hiddenModels, name])
    }
  }

  const addManual = () => {
    const name = manualInput.trim()
    if (name && !hiddenSet.has(name)) updateField('hidden_models', [...hiddenModels, name])
    setManualInput('')
  }

  // Group models by backend, filter by search
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q ? allModels.filter(m => m.name.toLowerCase().includes(q)) : allModels
    const map = new Map<string, CachedModelEntry[]>()
    for (const m of filtered) {
      const b = m.backend ?? 'unknown'
      if (!map.has(b)) map.set(b, [])
      map.get(b)!.push(m)
    }
    // Sort: small backends first, openrouter last
    return [...map.entries()].sort(([a], [b]) => {
      if (a === 'openrouter') return 1
      if (b === 'openrouter') return -1
      return a.localeCompare(b)
    })
  }, [allModels, search])

  const hiddenNotInCache = hiddenModels.filter(name => !allModels.some(m => m.name === name))

  return (
    <Card>
      <CardHeader title="Modèles" icon={<Database size={13} />} />
      <CardBody className="!py-4 flex flex-col gap-5">

        {/* ── Cache stat + TTL + refresh ── */}
        <div className="flex items-center gap-3 px-3 py-2.5 bg-background/60 border border-border/40 rounded-lg">
          <div className="flex-1 min-w-0">
            {cacheState ? (
              <span className="text-[11px] text-foreground">
                <span className="font-semibold">{cacheState.count}</span>
                <span className="text-muted-foreground"> modèle{cacheState.count !== 1 ? 's' : ''}</span>
                {cacheState.updated_at && (
                  <span className="text-muted-foreground/60"> · {formatDT(cacheState.updated_at)}</span>
                )}
                {hiddenModels.length > 0 && (
                  <span className="text-muted-foreground/50"> · {hiddenModels.length} masqués</span>
                )}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground/50">Cache vide</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground/60">TTL</span>
              <input
                type="number"
                min={0}
                value={config.models_cache_ttl_seconds ?? 60}
                onChange={e => updateField('models_cache_ttl_seconds', Number(e.target.value))}
                title="0 = rafraîchir à chaque GET /api/tags"
                className="w-14 px-2 py-1 bg-background border border-border/60 rounded text-[11px] text-foreground text-right focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
              <span className="text-[10px] text-muted-foreground/60">s</span>
            </div>
            <Button variant="subtle" size="sm" disabled={refreshing} onClick={handleRefresh}>
              <RefreshCw size={11} className={clsx(refreshing && 'animate-spin')} />
              {refreshing ? 'Rafraîchissement…' : 'Rafraîchir'}
            </Button>
          </div>
        </div>

        {/* ── Visibilité ── */}
        <div className="flex flex-col gap-3">
          <span className={groupCls}>Visibilité</span>

          {allModels.length === 0 ? (
            <div className="flex justify-center py-4"><Spinner /></div>
          ) : (
            <>
              {/* Search */}
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none" />
                <input
                  type="search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Filtrer les modèles…"
                  className="w-full pl-7 pr-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>

              {/* Groups */}
              {grouped.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50">Aucun modèle ne correspond.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {grouped.map(([backend, models]) => (
                    <BackendGroup
                      key={backend}
                      backend={backend}
                      models={models}
                      hiddenSet={hiddenSet}
                      onToggle={toggleHidden}
                      defaultOpen={backend !== 'openrouter' && models.length <= 30}
                    />
                  ))}
                </div>
              )}

              {/* Models hidden but not in cache (manual entries) */}
              {hiddenNotInCache.length > 0 && !search && (
                <div className="flex flex-col gap-1.5 pt-1 border-t border-border/40">
                  <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest">
                    Masqués hors cache ({hiddenNotInCache.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {hiddenNotInCache.map(m => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-secondary border border-border/60 rounded-full text-[10px] text-muted-foreground/60"
                      >
                        <code className="font-mono">{m}</code>
                        <button
                          type="button"
                          onClick={() => updateField('hidden_models', hiddenModels.filter(x => x !== m))}
                          className="text-muted-foreground/40 hover:text-destructive transition-colors"
                        >
                          <X size={9} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Manual add */}
              <div className="flex gap-2 pt-1">
                <input
                  type="text"
                  value={manualInput}
                  onChange={e => setManualInput(e.target.value)}
                  placeholder="Masquer un modèle hors cache…"
                  className={inputCls + ' flex-1'}
                  onKeyDown={e => { if (e.key === 'Enter') addManual() }}
                />
                <Button variant="subtle" size="sm" onClick={addManual}>Masquer</Button>
              </div>
            </>
          )}
        </div>

        {/* ── Diagnostic ── */}
        <div className="border-t border-border/40 pt-3 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setDiagOpen(o => !o)}
            className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors w-fit"
          >
            <ChevronDown size={11} className={clsx('transition-transform duration-200', !diagOpen && '-rotate-90')} />
            Diagnostic
            <span className="text-muted-foreground/40 font-normal">· mapping & backends raw</span>
          </button>

          {diagOpen && (
            <div className="flex flex-col gap-4">
              {mapping ? (
                <>
                  {(mapping.from_config.length > 0 || mapping.from_cache.length > 0) ? (
                    <div className="overflow-x-auto border border-border/60 rounded-lg">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr>
                            {['Canonique', 'Backend', 'ID backend', ''].map((h, i) => (
                              <th key={i} className="px-3 py-2 bg-background/80 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/60">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {mapping.from_config.map((row, i) => (
                            <tr key={`cfg-${i}`} className="border-b border-border/40 last:border-0">
                              <td className="px-3 py-1.5"><code className="font-mono text-[11px] text-foreground">{row.canonical}</code></td>
                              <td className="px-3 py-1.5 text-[11px] text-foreground">{row.backend}</td>
                              <td className="px-3 py-1.5"><code className="font-mono text-[11px] text-foreground">{row.backend_model_id}</code></td>
                              <td className="px-3 py-1.5"><Badge tone="primary">config</Badge></td>
                            </tr>
                          ))}
                          {mapping.from_cache
                            .filter(r => !mapping.from_config.some(c => c.canonical === r.canonical))
                            .map((row, i) => (
                              <tr key={`cache-${i}`} className="border-b border-border/40 last:border-0">
                                <td className="px-3 py-1.5"><code className="font-mono text-[11px] text-muted-foreground">{row.canonical}</code></td>
                                <td className="px-3 py-1.5 text-[11px] text-muted-foreground">{row.backend}</td>
                                <td className="px-3 py-1.5"><code className="font-mono text-[11px] text-muted-foreground">{row.backend_model_id}</code></td>
                                <td className="px-3 py-1.5"><Badge tone="muted">auto</Badge></td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground/50">Aucune résolution configurée.</p>
                  )}

                  {mapping.backend_models.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => setBackendRawOpen(o => !o)}
                        className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors w-fit"
                      >
                        <ChevronDown size={11} className={clsx('transition-transform duration-200', !backendRawOpen && '-rotate-90')} />
                        Backends raw
                        <span className="text-muted-foreground/40">({mapping.backend_models.length})</span>
                      </button>
                      {backendRawOpen && (
                        <div className="overflow-x-auto border border-border/60 rounded-lg max-h-[min(360px,45vh)] overflow-y-auto">
                          <table className="w-full text-left border-collapse">
                            <thead className="sticky top-0 z-[1]">
                              <tr>
                                {['Nom', 'Backend', 'ID', 'Normalisé'].map(h => (
                                  <th key={h} className="px-3 py-2 bg-card text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/60">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {mapping.backend_models.map((row, i) => (
                                <tr key={i} className="border-b border-border/40 last:border-0">
                                  <td className="px-3 py-1.5"><code className="font-mono text-[11px] text-foreground">{row.name}</code></td>
                                  <td className="px-3 py-1.5 text-[11px] text-foreground">{row.backend}</td>
                                  <td className="px-3 py-1.5"><code className="font-mono text-[11px] text-foreground">{row.backend_model_id}</code></td>
                                  <td className="px-3 py-1.5"><code className="font-mono text-[11px] text-muted-foreground/60">{row.normalized}</code></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex justify-center py-4"><Spinner /></div>
              )}
            </div>
          )}
        </div>

      </CardBody>
    </Card>
  )
}
