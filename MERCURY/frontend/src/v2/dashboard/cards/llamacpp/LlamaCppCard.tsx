import { useEffect, useMemo, useState } from 'react'
import { Search, RefreshCw, EyeOff, Eye, Boxes, AlertCircle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'
import { clsx } from 'clsx'
import {
  useLlamacppModels,
  useLlamacppProbe,
  useCacheModels,
  useAllAtlasPresets,
} from '../../../../api/queries'
import type { LlamacppModelEntry, LlamacppProbeResponse } from '../../../../api/admin'

type ProbeInstance = NonNullable<LlamacppProbeResponse['instances']>[number]
import { Card, CardHeader, CardBody } from '../../../ui/Card'
import { Badge } from '../../../ui/Badge'
import { Button } from '../../../ui/Button'
import { Spinner, SpinnerInline } from '../../../ui/Spinner'
import { DaemonLogs } from './DaemonLogs'
import { ModelRow } from './ModelRow'
import { ModelDrawer } from './ModelDrawer'

const UNTAGGED = '__untagged__'
const EXPAND_STORAGE_KEY = 'mercury_v2_llamacpp_expanded'

/**
 * Cache entries are stored backend-prefixed (e.g. `llamacpp/Qwen/Qwen2.5-...`).
 * Mirror the V1 convention so hidden/category lookups and mutations target the
 * same key — otherwise the join silently misses every llamacpp model.
 */
const cacheKey = (modelId: string): string => `llamacpp/${modelId}`

type Msg = { msg: string; type: 'info' | 'error' } | null

export function LlamaCppCard() {
  const { data, isLoading, refetch, isFetching } = useLlamacppModels()
  const { data: probe } = useLlamacppProbe(true)
  const { data: cache } = useCacheModels()

  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [showHidden, setShowHidden] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [drawerModelId, setDrawerModelId] = useState<string | null>(null)
  const [msg, setMsg] = useState<Msg>(null)
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(EXPAND_STORAGE_KEY) === 'true' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(EXPAND_STORAGE_KEY, String(expanded)) } catch { /* ignore */ }
  }, [expanded])

  // ── Filtering & grouping ────────────────────────────────────────────────
  // V1 excludes vLLM (kind=hf) and Lucebox instances from this card.
  const baseModels = useMemo<LlamacppModelEntry[]>(() => {
    const all = data?.models ?? []
    return all.filter(m => m.kind !== 'hf')
  }, [data?.models])

  // Étiquetage des LoRA indexés : on fetch TOUS les presets exportables une seule
  // fois (pas par card — préserve le lazy-fetch d'origine du sélecteur de preset)
  // et seulement si au moins un modèle a un stack LoRA. On en dérive une map
  // brain_path → nom de preset pour afficher "0·nom 1·nom" sur les cards.
  const anyLoras = useMemo(
    () => baseModels.some(m => (m.loras?.length ?? 0) > 0),
    [baseModels],
  )
  const atlasPresetsQ = useAllAtlasPresets(anyLoras)
  const loraNameByPath = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of atlasPresetsQ.data?.presets ?? []) {
      if (p.lora_path) map.set(p.lora_path, p.name)
    }
    return map
  }, [atlasPresetsQ.data?.presets])

  const hiddenSet = useMemo(() => new Set(cache?.hidden_model_names ?? []), [cache?.hidden_model_names])
  // Index cacheModels by their stored name (backend-prefixed, e.g. `llamacpp/...`).
  // Consumers must look up via `cacheKey(model.model_id)`.
  const cacheByName = useMemo(() => {
    const map = new Map<string, { category?: string; priority?: number }>()
    for (const m of cache?.models ?? []) {
      map.set(m.name, { category: m.category, priority: m.priority })
    }
    return map
  }, [cache?.models])

  const categoryOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const c of cache?.category_order ?? []) if (c) seen.add(c)
    // Only categories actually attached to a llamacpp model are surfaced here —
    // avoids polluting the picker with categories used by other backends.
    for (const m of cache?.models ?? []) {
      if (m.backend === 'llamacpp' && m.category) seen.add(m.category)
    }
    return Array.from(seen).sort()
  }, [cache?.category_order, cache?.models])

  const memoryByModelId = useMemo(() => {
    const map = new Map<string, ProbeInstance>()
    for (const inst of probe?.instances ?? []) {
      map.set(inst.model_id, inst)
    }
    return map
  }, [probe?.instances])

  const tpsByModelId = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const [mid, m] of Object.entries(probe?.by_model ?? {})) {
      map.set(mid, m.last_generation_tokens_per_second ?? null)
    }
    return map
  }, [probe?.by_model])

  // Filter pass — matches model_id, category, et taille (ex: "12gb", "30b").
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return baseModels.filter(m => {
      const isHidden = hiddenSet.has(cacheKey(m.model_id))
      if (isHidden && !showHidden) return false
      if (q) {
        const cat = cacheByName.get(cacheKey(m.model_id))?.category ?? ''
        // Sérialise la taille avec une fenêtre ±1 GiB pour que "12gb"
        // matche un modèle de 12.8 GiB ou 13.0 GiB (les utilisateurs tapent
        // rarement la valeur exacte).
        const sizeStr = m.size_gb != null
          ? Array.from(new Set([
              m.size_gb.toFixed(1),
              Math.floor(m.size_gb),
              Math.round(m.size_gb),
              Math.ceil(m.size_gb),
            ])).map(n => `${n}gb`).join(' ')
          : ''
        const haystack = `${m.model_id} ${cat} ${sizeStr}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      if (tagFilter !== 'all') {
        const cat = cacheByName.get(cacheKey(m.model_id))?.category
        if (tagFilter === UNTAGGED) {
          if (cat) return false
        } else {
          if (cat !== tagFilter) return false
        }
      }
      return true
    })
  }, [baseModels, search, tagFilter, showHidden, hiddenSet, cacheByName])

  // Group by tag, then sort within group
  const groups = useMemo(() => {
    const map = new Map<string, LlamacppModelEntry[]>()
    for (const m of filtered) {
      const cat = cacheByName.get(cacheKey(m.model_id))?.category ?? UNTAGGED
      const list = map.get(cat) ?? []
      list.push(m)
      map.set(cat, list)
    }
    const orderedCats: string[] = []
    for (const c of cache?.category_order ?? []) if (map.has(c)) orderedCats.push(c)
    for (const c of map.keys()) {
      if (c !== UNTAGGED && !orderedCats.includes(c)) orderedCats.push(c)
    }
    if (map.has(UNTAGGED)) orderedCats.push(UNTAGGED)
    // sort within: running first, then priority asc, then name
    for (const cat of orderedCats) {
      const list = map.get(cat)!
      list.sort((a, b) => {
        if ((a.running ? 1 : 0) !== (b.running ? 1 : 0)) return b.running ? 1 : -1
        const pa = cacheByName.get(cacheKey(a.model_id))?.priority ?? 999
        const pb = cacheByName.get(cacheKey(b.model_id))?.priority ?? 999
        if (pa !== pb) return pa - pb
        return a.model_id.localeCompare(b.model_id)
      })
    }
    return { orderedCats, byCategory: map }
  }, [filtered, cacheByName, cache?.category_order])

  const drawerModel = drawerModelId
    ? baseModels.find(m => m.model_id === drawerModelId) ?? null
    : null

  const totalRunning = baseModels.filter(m => m.running).length
  // Count only llamacpp models currently hidden (hiddenSet may contain entries
  // for other backends like ollama).
  const hiddenCount = baseModels.filter(m => hiddenSet.has(cacheKey(m.model_id))).length

  const onMessage = (m: string, type: 'info' | 'error') => {
    setMsg({ msg: m, type })
    window.setTimeout(() => setMsg(null), 4000)
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Modèles llamacpp"
          icon={<Boxes size={13} />}
          subtitle={`${baseModels.length} modèles · ${totalRunning} actif${totalRunning > 1 ? 's' : ''}`}
          right={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(e => !e)}
                title={expanded ? 'Réduire la liste (actifs seulement)' : 'Afficher tous les modèles'}
              >
                {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => refetch()} title="Rafraîchir">
                {isFetching ? <Spinner size={11} /> : <RefreshCw size={12} />}
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-3 !py-3">
          {/* Filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Rechercher un modèle, tag ou taille (ex: 30b)…"
                className="w-full pl-7 pr-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40"
              />
            </div>
            <select
              value={tagFilter}
              onChange={e => setTagFilter(e.target.value)}
              className="px-2 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30"
            >
              <option value="all">Tous les tags</option>
              <option value={UNTAGGED}>sans tag</option>
              {categoryOptions.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <Button
              variant={showHidden ? 'primary' : 'subtle'}
              size="sm"
              onClick={() => setShowHidden(v => !v)}
              title={showHidden ? 'Masquer les modèles cachés' : 'Afficher les modèles cachés'}
            >
              {showHidden ? <Eye size={11} /> : <EyeOff size={11} />}
              {hiddenCount > 0 && <span className="ml-0.5">({hiddenCount})</span>}
            </Button>
          </div>

          {/* Status banner */}
          {msg && (
            <div
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-md text-[11px] border',
                msg.type === 'info'
                  ? 'bg-theme-green/5 text-theme-green border-theme-green/30'
                  : 'bg-destructive/5 text-destructive border-destructive/30',
              )}
            >
              {msg.type === 'info' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
              <span>{msg.msg}</span>
            </div>
          )}

          {/* Daemon logs collapsible */}
          <DaemonLogs open={logsOpen} onToggle={() => setLogsOpen(v => !v)} />

          {/* Model list */}
          {isLoading && <SpinnerInline />}
          {!isLoading && filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-6 px-3 rounded-md border border-dashed border-border/40 bg-background/30">
              <Search size={14} className="text-muted-foreground/40" />
              <p className="text-[11px] text-muted-foreground/70 text-center m-0">
                Aucun modèle ne correspond à ces critères.
              </p>
              {(search.trim() !== '' || tagFilter !== 'all' || showHidden) && (
                <button
                  type="button"
                  onClick={() => { setSearch(''); setTagFilter('all'); setShowHidden(false) }}
                  className="text-[10px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          )}

          {!isLoading && filtered.length > 0 && (() => {
            const filtering = search.trim() !== '' || tagFilter !== 'all'
            const showAll = expanded || filtering
            const runningList = filtered.filter(m => m.running)
            const idleList = filtered.filter(m => !m.running)
            const runningCount = runningList.length
            const idleCount = idleList.length

            const renderRow = (m: typeof filtered[number]) => {
              const mem = memoryByModelId.get(m.model_id)
              const memInfo = mem ? {
                vram_delta_mb: mem.vram_delta_mb,
                ram_delta_mb: mem.ram_delta_mb,
                ram_rss_mb: mem.ram_rss_mb,
                protected: mem.protected,
                load_order: mem.load_order,
                pid: mem.pid,
                port: mem.port,
              } : undefined
              return (
                <ModelRow
                  key={m.model_id}
                  model={m}
                  category={cacheByName.get(cacheKey(m.model_id))?.category}
                  categoryOptions={categoryOptions}
                  isHidden={hiddenSet.has(cacheKey(m.model_id))}
                  memoryInfo={memInfo}
                  tps={tpsByModelId.get(m.model_id)}
                  loraNameByPath={loraNameByPath}
                  onOpenDrawer={() => setDrawerModelId(m.model_id)}
                  onMessage={onMessage}
                />
              )
            }

            return (
              <div className="flex flex-col gap-4">
                {/* Collapsed view : running models only, flat list under "Actifs". */}
                {!showAll && (
                  <section className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground m-0">
                        Actifs
                      </h4>
                      <Badge tone={runningCount > 0 ? 'success' : 'muted'} mono>{runningCount}</Badge>
                      <div className="flex-1 h-px bg-border/30" />
                    </div>
                    {runningCount === 0 ? (
                      <p className="text-[11px] text-muted-foreground/60 py-2">
                        Aucun modèle chargé.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-1.5">{runningList.map(renderRow)}</ul>
                    )}
                  </section>
                )}

                {/* Expanded view : full grouping by tag (existing layout). */}
                {showAll && groups.orderedCats.map(cat => {
                  const list = groups.byCategory.get(cat)!
                  return (
                    <section key={cat} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground m-0">
                          {cat === UNTAGGED ? 'Sans tag' : cat}
                        </h4>
                        <Badge tone="muted" mono>{list.length}</Badge>
                        <div className="flex-1 h-px bg-border/30" />
                      </div>
                      <ul className="flex flex-col gap-1.5">{list.map(renderRow)}</ul>
                    </section>
                  )
                })}

                {/* Toggle expand / collapse — hidden when an active filter forces full view. */}
                {!filtering && (
                  <button
                    type="button"
                    onClick={() => setExpanded(e => !e)}
                    className="self-center inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 bg-background/40 text-muted-foreground hover:text-foreground hover:bg-secondary/50 text-[11px] font-medium transition-colors"
                  >
                    {expanded ? (
                      <>
                        <ChevronUp size={12} /> Réduire — voir uniquement les actifs
                      </>
                    ) : (
                      <>
                        <ChevronDown size={12} /> Afficher tous les modèles
                        <span className="font-mono tabular-nums text-muted-foreground/70 ml-0.5">
                          ({idleCount} non chargé{idleCount > 1 ? 's' : ''})
                        </span>
                      </>
                    )}
                  </button>
                )}

                {filtering && (
                  <p className="text-[10px] text-muted-foreground/60 text-center mt-1">
                    Filtre actif — liste complète affichée.
                  </p>
                )}
              </div>
            )
          })()}
        </CardBody>
      </Card>

      {/* Side drawer */}
      {drawerModel && (
        <ModelDrawer
          model={drawerModel}
          memoryInfo={(() => {
            const mem = memoryByModelId.get(drawerModel.model_id)
            return mem ? {
              vram_delta_mb: mem.vram_delta_mb,
              ram_delta_mb: mem.ram_delta_mb,
              ram_rss_mb: mem.ram_rss_mb,
              protected: mem.protected,
              load_order: mem.load_order,
            } : undefined
          })()}
          onClose={() => setDrawerModelId(null)}
          onMessage={onMessage}
        />
      )}
    </>
  )
}
