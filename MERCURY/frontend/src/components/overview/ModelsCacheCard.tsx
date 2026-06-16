import { useState } from 'react'
import {
  useConfig,
  useCacheModels,
  useCacheState,
  useLmStudioModels,
  useHostStats,
  useRefreshCacheMutation,
  useLoadLmStudioModelMutation,
  useUnloadLmStudioModelMutation,
  useInjectLmStudioPromptMutation,
  useSetModelPriorityMutation,
  useSetHiddenModelMutation,
  useSetModelCategoryMutation,
} from '../../api/queries'
import type { CachedModelEntry } from '../../api/admin'
import Spinner from '../Spinner'

function formatSize(bytes: number | undefined): string {
  if (bytes == null || bytes === 0) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} Go`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} Mo`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} Ko`
  return `${bytes} o`
}

function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    if (Number.isNaN(d.getTime())) return isoString
    return d.toLocaleString('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false
    })
  } catch {
    return isoString
  }
}

function formatActivity(ts: number | undefined | null): string {
  if (ts == null) return ''
  const diff = Math.floor(Date.now() / 1000 - ts)
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  return `${Math.floor(diff / 3600)}h`
}

export default function ModelsCacheCard() {
  const { data: config } = useConfig()
  const { data: cacheModelsData, isLoading: cacheModelsLoading, refetch: refreshCacheModels } = useCacheModels()
  const cacheModels = cacheModelsData?.models ?? []
  const hiddenSet = new Set(cacheModelsData?.hidden_model_names ?? [])

  const categoryOrder = cacheModelsData?.category_order ?? []

  const lmStudioCacheModels = cacheModels
    .filter((m) => (m.backend ?? '') === 'lm_studio')
    .slice()

  const categoriesInBackend = new Set(
    lmStudioCacheModels.map((m) => m.category ?? '').filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
  )
  const categoryOptions = [
    ...categoryOrder,
    ...Array.from(categoriesInBackend).filter((c) => !categoryOrder.includes(c)).sort((a, b) => a.localeCompare(b)),
  ]

  const categoryRank = (category?: string) => {
    const c = (category ?? '').trim()
    if (!c) return { group: categoryOrder.length + 1, sub: '' }
    const idx = categoryOrder.indexOf(c)
    if (idx >= 0) return { group: idx, sub: '' }
    return { group: categoryOrder.length, sub: c }
  }

  const sortedLmStudioCacheModels = lmStudioCacheModels.slice().sort((a, b) => {
    const ra = categoryRank(a.category)
    const rb = categoryRank(b.category)
    if (ra.group !== rb.group) return ra.group - rb.group
    if (ra.sub !== rb.sub) return ra.sub.localeCompare(rb.sub)
    const pa = a.priority ?? 99
    const pb = b.priority ?? 99
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })

  const lmStudioVisible = sortedLmStudioCacheModels.filter((m) => !hiddenSet.has(m.name))
  const lmStudioHiddenCount = lmStudioCacheModels.filter((m) => hiddenSet.has(m.name)).length
  const { data: cacheState } = useCacheState()
  const { data: lmStudioData, error: lmStudioErr, isLoading: lmStudioLoading, refetch: refetchLmStudioModels } = useLmStudioModels()
  
  const refreshCacheMutation = useRefreshCacheMutation()
  const loadMutation = useLoadLmStudioModelMutation()
  const unloadMutation = useUnloadLmStudioModelMutation()
  const injectMutation = useInjectLmStudioPromptMutation()
  const setPriorityMutation = useSetModelPriorityMutation()
  const setHiddenMutation = useSetHiddenModelMutation()
  const setCategoryMutation = useSetModelCategoryMutation()

  const [lmStudioMessage, setLmStudioMessage] = useState<string | null>(null)
  const [lmStudioInjectResponse, setLmStudioInjectResponse] = useState<string | null>(null)
  const [showHiddenModels, setShowHiddenModels] = useState(false)

  const isActionBusy = loadMutation.isPending || unloadMutation.isPending || injectMutation.isPending || refreshCacheMutation.isPending || setHiddenMutation.isPending || setCategoryMutation.isPending

  const handleRefreshModelsList = async () => {
    setLmStudioMessage(null)
    await refreshCacheMutation.mutateAsync()
    await refetchLmStudioModels()
  }

  const handleLmStudioLoad = async (modelKey: string) => {
    setLmStudioMessage(null)
    try {
      const res = await loadMutation.mutateAsync(modelKey)
      if (res.ok) {
        setLmStudioMessage('Modèle chargé')
      } else {
        const msg = (res.body as any)?.error?.message ?? (res.body as any)?.detail ?? `Erreur ${res.status}`
        setLmStudioMessage(msg)
      }
    } catch (e) {
      setLmStudioMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const handleLmStudioUnload = async (instanceId: string) => {
    setLmStudioMessage(null)
    try {
      const res = await unloadMutation.mutateAsync(instanceId)
      if (res.ok) {
        setLmStudioMessage('Modèle déchargé')
      } else {
        const msg = (res.body as any)?.error?.message ?? (res.body as any)?.detail ?? `Erreur ${res.status}`
        setLmStudioMessage(msg)
      }
    } catch (e) {
      setLmStudioMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const handleLmStudioInject = async (modelKey: string) => {
    setLmStudioMessage(null)
    setLmStudioInjectResponse(null)
    try {
      const res = await injectMutation.mutateAsync(modelKey)
      if (res.ok) {
        const rid = (res.body as any)?.response_id ?? ''
        const responseText = (res.body as any)?.response_text ?? ''
        const usedCache = (res.body as any)?.used_cached_body
        setLmStudioMessage(`Prompt injecté (${rid.slice(0, 20)}…)${usedCache ? ' [body caché]' : ' [fallback]'}`)
        if (responseText) {
          setLmStudioInjectResponse(responseText)
        }
      } else {
        const msg = (res.body as any)?.detail ?? `Erreur ${res.status}`
        setLmStudioMessage(msg)
      }
    } catch (e) {
      setLmStudioMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const handleSetCategory = async (modelName: string, category: string | null) => {
    try {
      await setCategoryMutation.mutateAsync({ modelName, category })
      setLmStudioMessage(category ? `Tag "${category}" enregistré` : 'Tag supprimé')
    } catch (e) {
      setLmStudioMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const buildOrderByBackend = (): Record<string, string[]> => {
    if (!cacheModels?.length) return {}
    const byBackend: Record<string, CachedModelEntry[]> = {}
    for (const m of cacheModels) {
      const b = m.backend ?? ''
      if (!byBackend[b]) byBackend[b] = []
      byBackend[b].push(m)
    }
    const out: Record<string, string[]> = {}
    for (const [backend, list] of Object.entries(byBackend)) {
      out[backend] = [...list].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map((m) => m.name)
    }
    return out
  }

  const handleModelPriorityChange = async (model: CachedModelEntry, newPriority: number) => {
    const backend = model.backend ?? ''
    const sameBackendVisible = lmStudioCacheModels.filter((m) => (m.backend ?? '') === backend && !hiddenSet.has(m.name))
    if (sameBackendVisible.length < 2 || setPriorityMutation.isPending || newPriority === (model.priority ?? 0)) return

    const orderByBackend = buildOrderByBackend()
    const list = (orderByBackend[backend] ?? []).filter((n) => !hiddenSet.has(n))
    const without = list.filter((n) => n !== model.name)
    without.splice(newPriority - 1, 0, model.name)
    orderByBackend[backend] = without
    await setPriorityMutation.mutateAsync(orderByBackend)
    refreshCacheModels()
  }

  const handleToggleHidden = async (modelName: string, hidden: boolean) => {
    try {
      await setHiddenMutation.mutateAsync({ modelName, hidden })
      refreshCacheModels()
    } catch (e) {
      setLmStudioMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const lmStudioByKey = lmStudioData?.models?.length
    ? Object.fromEntries(lmStudioData.models.map((m) => [m.key, m]))
    : {}

  const { data: hostStats } = useHostStats()
  const lmStats = hostStats?.lmstudio

  const lmRunningCount = lmStudioCacheModels.filter((m) => {
    const key = m.name.startsWith('lm_studio/') ? m.name.slice('lm_studio/'.length) : ''
    return key ? (lmStudioByKey[key]?.loaded_instances?.length ?? 0) > 0 : false
  }).length

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 lg:col-span-2">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white m-0">LM Studio</h2>
          {lmRunningCount > 0 && (
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-500/20 text-green-400 border border-green-500/30">
              {lmRunningCount} running
            </span>
          )}
          {lmStats?.last_generation_tokens_per_second != null && (
            <span className="text-xs text-neutral-400 font-mono">
              {lmStats.last_generation_tokens_per_second.toFixed(1)} tok/s
              {lmStats.last_activity_ts != null && (
                <span className="text-neutral-600"> · {formatActivity(lmStats.last_activity_ts)}</span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lmStudioHiddenCount > 0 && (
            <button
              type="button"
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              disabled={isActionBusy}
              onClick={() => setShowHiddenModels((v) => !v)}
            >
              {showHiddenModels ? 'Masquer les masqués' : `Afficher les masqués (${lmStudioHiddenCount})`}
            </button>
          )}
          <button type="button" className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-sm font-medium rounded-md transition-colors disabled:opacity-50" disabled={isActionBusy || lmStudioLoading} onClick={handleRefreshModelsList}>
            {isActionBusy || lmStudioLoading ? 'Rafraîchissement…' : 'Rafraîchir la liste'}
          </button>
        </div>
      </div>
      {cacheModelsLoading && <Spinner />}
      {lmStudioErr && <p className="text-red-500 text-sm mb-4">{lmStudioErr instanceof Error ? lmStudioErr.message : String(lmStudioErr)}</p>}
      {lmStudioMessage && <p className={`text-sm mb-4 ${lmStudioMessage.startsWith('Erreur') ? 'text-red-500' : 'text-neutral-400'}`}>{lmStudioMessage}</p>}
      {lmStudioInjectResponse && (
        <div className="mt-2 p-3 bg-neutral-950 border border-neutral-800 rounded text-sm text-neutral-300 whitespace-pre-wrap max-h-48 overflow-y-auto mb-4">
          <strong className="text-white">Réponse du modèle :</strong>
          <div className="mt-1">{lmStudioInjectResponse}</div>
        </div>
      )}
      {!cacheModelsLoading && (
        <>
          {cacheState && (
            <p className="text-xs text-neutral-500 mb-4">
              {lmStudioCacheModels.length} modèle{lmStudioCacheModels.length !== 1 ? 's' : ''} LM Studio en cache
              {cacheState.updated_at ? ` · Dernière MAJ ${formatDateTime(cacheState.updated_at)}` : ''}
              {lmStudioCacheModels.length >= 2 && ' · Priorité = ordre pour le mode auto'}
            </p>
          )}
          {lmStudioCacheModels.length === 0 && (
            <p className="text-neutral-500 text-sm">Aucun modèle LM Studio en cache. Cliquez sur « Rafraîchir la liste » pour interroger LM Studio.</p>
          )}
          {(lmStudioVisible.length > 0 || (showHiddenModels && lmStudioHiddenCount > 0)) && (
            <ul className="flex flex-col gap-2">
          {(showHiddenModels ? sortedLmStudioCacheModels : lmStudioVisible).flatMap((m, idx, arr) => {
                const isHidden = hiddenSet.has(m.name)
                const tag = (m.category ?? '').trim()
                const prevTag = idx > 0 ? ((arr[idx - 1]?.category ?? '') as string).trim() : null
                const showTagHeader = idx === 0 || prevTag !== tag
                const lmStudioKey = m.name.startsWith('lm_studio/') ? m.name.slice('lm_studio/'.length) : ''
                const lsEntry = lmStudioKey ? lmStudioByKey[lmStudioKey] : null
                const loadedInstances = lsEntry?.loaded_instances ?? []
                const isLoaded = loadedInstances.length > 0
                const sameBackendVisible = lmStudioVisible
                const showPriority = !isHidden && sameBackendVisible.length >= 2
                const lsConfig = loadedInstances[0]?.config as Record<string, unknown> | undefined
                const lsCtxSize = lsConfig != null
                  ? Number(lsConfig.contextLength ?? lsConfig.n_ctx ?? lsConfig.context_length) || null
                  : null
                return [
                  showTagHeader ? (
                    <li key={`tag-${tag || 'none'}`} className="px-3 pt-3 pb-1 border-t border-neutral-800">
                      <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                        {tag || 'Sans tag'}
                      </span>
                    </li>
                  ) : null,
                  <li key={m.name} className={`flex flex-col rounded-lg border transition-colors ${isHidden ? 'bg-neutral-900/60 border-neutral-700/80 opacity-80' : isLoaded ? 'bg-green-950/20 border-green-800/60' : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'}`}>
                    <div className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-neutral-200 text-sm truncate block" title={m.name}>{m.name}{isHidden ? ' (masqué)' : ''}</span>
                      {isLoaded && lsCtxSize != null && (() => {
                        const tokensCached = lmStats?.last_prompt_tokens ?? 0
                        const ctxPct = Math.min(100, Math.round((tokensCached / lsCtxSize) * 100))
                        return (
                          <>
                            <span className="text-[11px] text-green-400 font-mono block">ctx {lsCtxSize.toLocaleString()}</span>
                            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                              <span className="text-[10px] text-neutral-600 uppercase tracking-wider font-medium">idle</span>
                              <div className="flex items-center gap-1.5">
                                <div className="w-16 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full transition-all ${ctxPct > 80 ? 'bg-orange-500' : 'bg-blue-500/70'}`} style={{ width: `${ctxPct}%` }} />
                                </div>
                                <span className="text-[10px] text-neutral-500 font-mono tabular-nums">{tokensCached.toLocaleString()}/{lsCtxSize.toLocaleString()}</span>
                              </div>
                            </div>
                          </>
                        )
                      })()}
                    </div>
                    {m.backend && m.backend !== 'lm_studio' && (
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                        m.backend === 'openrouter' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' :
                        m.backend === 'mlx' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' :
                        m.backend === 'ollama' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' :
                        'bg-neutral-500/20 text-neutral-400 border border-neutral-500/30'
                      }`}>{m.backend}</span>
                    )}
                    <span className="shrink-0 w-16 text-right text-xs text-neutral-500 tabular-nums" title="Poids du modèle">
                      {(m.size != null && m.size > 0) ? formatSize(m.size) : '—'}
                    </span>
                    {config?.lm_studio_session_init_enabled && (config?.lm_studio_session_init_prompt ?? '').trim() ? (
                      <span
                        className="shrink-0 text-[10px] text-amber-400 border border-amber-700/40 rounded px-1 py-0.5 bg-amber-950/30"
                        title="Session init prompt activé (template global pour LM Studio)"
                      >
                        TPL
                      </span>
                    ) : null}
                    {!isHidden && (isLoaded ? (
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-green-500/20 text-green-400 border border-green-500/30">running</span>
                    ) : (
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-neutral-700/40 text-neutral-500 border border-neutral-700/60">idle</span>
                    ))}
                    <div className="shrink-0 flex items-center gap-2 ml-auto">
                      {isLoaded ? (
                        <>
                          {loadedInstances.map((inst) => (
                            <button
                              key={inst.id}
                              type="button"
                              className="w-20 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-medium rounded transition-colors disabled:opacity-50"
                              disabled={isActionBusy}
                              onClick={() => handleLmStudioUnload(inst.id)}
                              title={`Décharger ${inst.id}`}
                            >
                              Décharger
                            </button>
                          ))}
                          {showPriority && (
                            <label className="flex items-center gap-1.5">
                              <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Priorité</span>
                              <select
                                className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-12"
                                value={m.priority ?? 1}
                                disabled={setPriorityMutation.isPending}
                                onChange={(e) => handleModelPriorityChange(m, Number(e.target.value))}
                                aria-label={`Priorité ${m.name}`}
                              >
                                {Array.from({ length: sameBackendVisible.length }, (_, i) => i + 1).map((p) => (
                                  <option key={p} value={p}>{p}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label className="flex items-center gap-1.5">
                            <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Tag</span>
                            <select
                              className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-36"
                              value={m.category ?? ''}
                              disabled={setCategoryMutation.isPending}
                              onChange={(e) => {
                                const val = e.target.value
                                const NEW_TAG_VALUE = '__new__'
                                if (val === NEW_TAG_VALUE) {
                                  const next = window.prompt('Nom du tag (catégorie) :')
                                  if (next == null) return
                                  const trimmed = next.trim()
                                  handleSetCategory(m.name, trimmed ? trimmed : null)
                                } else {
                                  handleSetCategory(m.name, val ? val : null)
                                }
                              }}
                              aria-label={`Tag ${m.name}`}
                            >
                              <option value="">Sans tag</option>
                              {categoryOptions.map((t) => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                              <option value="__new__">+ Nouveau…</option>
                            </select>
                          </label>
                          {config?.lm_studio_session_init_enabled && (
                            <button
                              type="button"
                              className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
                              disabled={isActionBusy}
                              onClick={() => handleLmStudioInject(lmStudioKey)}
                              title={`Injecter le prompt système dans ${lmStudioKey}`}
                            >
                              Injecter Prompt
                            </button>
                          )}
                          <button
                            type="button"
                            className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-xs font-medium rounded transition-colors disabled:opacity-50"
                            disabled={setHiddenMutation.isPending}
                            onClick={() => handleToggleHidden(m.name, !isHidden)}
                            title={isHidden ? 'Afficher ce modèle dans la liste et la priorité' : 'Masquer ce modèle (ne compte plus en priorité)'}
                          >
                            {isHidden ? 'Démasquer' : 'Masquer'}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="w-20 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
                            disabled={isActionBusy || lmStudioLoading}
                            onClick={() => handleLmStudioLoad(lmStudioKey)}
                            title={`Charger ${lmStudioKey}`}
                          >
                            Charger
                          </button>
                          {showPriority && (
                            <label className="flex items-center gap-1.5">
                              <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Priorité</span>
                              <select
                                className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-12"
                                value={m.priority ?? 1}
                                disabled={setPriorityMutation.isPending}
                                onChange={(e) => handleModelPriorityChange(m, Number(e.target.value))}
                                aria-label={`Priorité ${m.name}`}
                              >
                                {Array.from({ length: sameBackendVisible.length }, (_, i) => i + 1).map((p) => (
                                  <option key={p} value={p}>{p}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label className="flex items-center gap-1.5">
                            <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Tag</span>
                            <select
                              className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-36"
                              value={m.category ?? ''}
                              disabled={setCategoryMutation.isPending}
                              onChange={(e) => {
                                const val = e.target.value
                                const NEW_TAG_VALUE = '__new__'
                                if (val === NEW_TAG_VALUE) {
                                  const next = window.prompt('Nom du tag (catégorie) :')
                                  if (next == null) return
                                  const trimmed = next.trim()
                                  handleSetCategory(m.name, trimmed ? trimmed : null)
                                } else {
                                  handleSetCategory(m.name, val ? val : null)
                                }
                              }}
                              aria-label={`Tag ${m.name}`}
                            >
                              <option value="">Sans tag</option>
                              {categoryOptions.map((t) => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                              <option value="__new__">+ Nouveau…</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-xs font-medium rounded transition-colors disabled:opacity-50"
                            disabled={setHiddenMutation.isPending}
                            onClick={() => handleToggleHidden(m.name, !isHidden)}
                            title={isHidden ? 'Afficher ce modèle dans la liste et la priorité' : 'Masquer ce modèle (ne compte plus en priorité)'}
                          >
                            {isHidden ? 'Démasquer' : 'Masquer'}
                          </button>
                        </>
                      )}
                    </div>
                    </div>
                  </li>
                ]
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )
}