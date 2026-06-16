import { useState, useCallback, useMemo } from 'react'
import {
  useOllamaModels,
  useOllamaPs,
  useCacheModels,
  useLoadOllamaModelMutation,
  useUnloadOllamaModelMutation,
  useDeleteOllamaModelMutation,
  useSetModelPriorityMutation,
  useSetHiddenModelMutation,
  useSetModelCategoryMutation,
} from '../../api/queries'
import { pullOllamaModel, createOllamaModelfile } from '../../api/admin'
import type { OllamaPullProgress } from '../../api/admin'
import type { CachedModelEntry } from '../../api/admin'
import Spinner from '../Spinner'

function formatSize(bytes: number | undefined): string {
  if (bytes == null || bytes === 0) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} Go`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} Mo`
  return `${bytes} o`
}

const inputClass = 'w-full bg-neutral-900 border border-neutral-700 text-white text-sm rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-neutral-500'

type ModelfileFields = {
  fromModel: string
  systemPrompt: string
  numCtx: string
  temperature: string
  topK: string
  topP: string
  repeatPenalty: string
  numPredict: string
  numGpu: string
  seed: string
  stop: string
  template: string
}

const defaultFields: ModelfileFields = {
  fromModel: '',
  systemPrompt: '',
  numCtx: '',
  temperature: '',
  topK: '',
  topP: '',
  repeatPenalty: '',
  numPredict: '',
  numGpu: '',
  seed: '',
  stop: '',
  template: '',
}

function buildModelfile(f: ModelfileFields): string {
  if (!f.fromModel.trim()) return ''
  let mf = `FROM ${f.fromModel.trim()}\n`
  if (f.systemPrompt.trim()) mf += `SYSTEM ${f.systemPrompt.trim()}\n`
  if (f.numCtx.trim()) mf += `PARAMETER num_ctx ${f.numCtx.trim()}\n`
  if (f.temperature.trim()) mf += `PARAMETER temperature ${f.temperature.trim()}\n`
  if (f.topK.trim()) mf += `PARAMETER top_k ${f.topK.trim()}\n`
  if (f.topP.trim()) mf += `PARAMETER top_p ${f.topP.trim()}\n`
  if (f.repeatPenalty.trim()) mf += `PARAMETER repeat_penalty ${f.repeatPenalty.trim()}\n`
  if (f.numPredict.trim()) mf += `PARAMETER num_predict ${f.numPredict.trim()}\n`
  if (f.numGpu.trim()) mf += `PARAMETER num_gpu ${f.numGpu.trim()}\n`
  if (f.seed.trim()) mf += `PARAMETER seed ${f.seed.trim()}\n`
  for (const s of f.stop.split(';').map(s => s.trim()).filter(Boolean)) {
    mf += `PARAMETER stop "${s}"\n`
  }
  if (f.template.trim()) mf += `TEMPLATE """${f.template.trim()}"""\n`
  return mf
}

export default function OllamaModelsCard() {
  const { data: modelsData, isLoading: modelsLoading, refetch: refetchModels } = useOllamaModels()
  const { refetch: refetchPs } = useOllamaPs()
  const { data: cacheModelsData, refetch: refreshCacheModels } = useCacheModels()
  const cacheModels = cacheModelsData?.models ?? []
  const hiddenSet = new Set(cacheModelsData?.hidden_model_names ?? [])
  const ollamaCacheModels = cacheModels
    .filter((m) => (m.backend ?? '') === 'ollama')
    .slice()
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
  const ollamaVisible = ollamaCacheModels.filter((m) => !hiddenSet.has(m.name))
  const ollamaHiddenCount = ollamaCacheModels.filter((m) => hiddenSet.has(m.name)).length
  const loadMutation = useLoadOllamaModelMutation()
  const unloadMutation = useUnloadOllamaModelMutation()
  const deleteMutation = useDeleteOllamaModelMutation()
  const setPriorityMutation = useSetModelPriorityMutation()
  const setHiddenMutation = useSetHiddenModelMutation()
  const setCategoryMutation = useSetModelCategoryMutation()

  const [message, setMessage] = useState<string | null>(null)
  const [showHiddenModels, setShowHiddenModels] = useState(false)
  const [messageType, setMessageType] = useState<'info' | 'error'>('info')

  // Pull state
  const [pullInput, setPullInput] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null)

  // Create modelfile state
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [fields, setFields] = useState<ModelfileFields>({ ...defaultFields })
  const [creating, setCreating] = useState(false)
  const [createStatus, setCreateStatus] = useState<string | null>(null)
  const [showParams, setShowParams] = useState(false)
  const [showTemplate, setShowTemplate] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const models = modelsData?.models ?? []
  const categoryOrder = cacheModelsData?.category_order ?? []
  const categoriesInBackend = new Set(
    ollamaCacheModels
      .map((m) => m.category ?? '')
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
  )
  const categoryOptions = [
    ...categoryOrder,
    ...Array.from(categoriesInBackend).filter((c) => !categoryOrder.includes(c)).sort((a, b) => a.localeCompare(b)),
  ]

  const priorityByCacheName = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of ollamaCacheModels) {
      map.set(m.name, m.priority ?? 99)
    }
    return map
  }, [ollamaCacheModels])
  const categoryByCacheName = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of ollamaCacheModels) {
      map.set(m.name, m.category ?? '')
    }
    return map
  }, [ollamaCacheModels])

  const cacheEntryByName = useMemo(() => {
    const map = new Map<string, CachedModelEntry>()
    for (const m of ollamaCacheModels) {
      map.set(m.name, m)
    }
    return map
  }, [ollamaCacheModels])

  const isActionBusy = pulling || creating || loadMutation.isPending || unloadMutation.isPending || deleteMutation.isPending || setPriorityMutation.isPending || setHiddenMutation.isPending || setCategoryMutation.isPending

  const modelfileText = useMemo(() => buildModelfile(fields), [fields])

  const showMessage = useCallback((msg: string, type: 'info' | 'error' = 'info') => {
    setMessage(msg)
    setMessageType(type)
  }, [])

  const updateField = <K extends keyof ModelfileFields>(key: K, value: ModelfileFields[K]) => {
    setFields(prev => ({ ...prev, [key]: value }))
  }

  const handlePull = async () => {
    const model = pullInput.trim()
    if (!model) return
    setPulling(true)
    setPullProgress(null)
    setMessage(null)
    try {
      const res = await pullOllamaModel(model, (progress) => {
        setPullProgress(progress)
      })
      if (res.ok) {
        showMessage(`Modèle "${model}" téléchargé avec succès`)
        setPullInput('')
        setPullProgress(null)
        refetchModels()
      } else {
        const err = (res.body as any)?.error ?? `Erreur ${res.status}`
        showMessage(err, 'error')
      }
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setPulling(false)
    }
  }

  const handleCreate = async () => {
    if (!createName.trim() || !modelfileText.trim()) return
    setCreating(true)
    setCreateStatus(null)
    setMessage(null)
    try {
      const res = await createOllamaModelfile(createName.trim(), modelfileText.trim(), (progress) => {
        setCreateStatus(progress.status)
      })
      if (res.ok) {
        showMessage(`Modèle "${createName.trim()}" créé avec succès`)
        setCreateName('')
        setFields({ ...defaultFields })
        setShowCreate(false)
        setCreateStatus(null)
        refetchModels()
      } else {
        const err = (res.body as any)?.error ?? `Erreur ${res.status}`
        showMessage(err, 'error')
      }
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleLoad = async (model: string) => {
    setMessage(null)
    try {
      const res = await loadMutation.mutateAsync(model)
      if (res.ok) {
        showMessage(`Modèle "${model}" chargé`)
        refetchPs()
        refetchModels()
      } else {
        showMessage((res.body as any)?.detail ?? (res.body as any)?.error ?? `Erreur ${res.status}`, 'error')
      }
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleUnload = async (model: string) => {
    setMessage(null)
    try {
      const res = await unloadMutation.mutateAsync(model)
      if (res.ok) {
        showMessage(`Modèle "${model}" déchargé`)
        refetchPs()
        refetchModels()
      } else {
        showMessage((res.body as any)?.detail ?? `Erreur ${res.status}`, 'error')
      }
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleDelete = async (model: string) => {
    setMessage(null)
    setDeleteConfirm(null)
    try {
      const res = await deleteMutation.mutateAsync(model)
      if (res.ok) {
        showMessage(`Modèle "${model}" supprimé`)
      } else {
        showMessage((res.body as any)?.detail ?? `Erreur ${res.status}`, 'error')
      }
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
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

  const handleOllamaModelPriorityChange = async (model: CachedModelEntry, newPriority: number) => {
    if (ollamaVisible.length < 2 || setPriorityMutation.isPending || newPriority === (model.priority ?? 0)) return
    const orderByBackend = buildOrderByBackend()
    const list = (orderByBackend.ollama ?? []).filter((n) => !hiddenSet.has(n))
    const without = list.filter((n) => n !== model.name)
    without.splice(newPriority - 1, 0, model.name)
    orderByBackend.ollama = without
    await setPriorityMutation.mutateAsync(orderByBackend)
    refreshCacheModels()
  }

  const handleSetCategory = async (modelName: string, category: string | null) => {
    try {
      await setCategoryMutation.mutateAsync({ modelName, category })
      showMessage(category ? `Tag "${category}" enregistré` : 'Tag supprimé', 'info')
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const categoryRank = (category?: string) => {
    const c = (category ?? '').trim()
    if (!c) return { group: categoryOrder.length + 1, sub: '' }
    const idx = categoryOrder.indexOf(c)
    if (idx >= 0) return { group: idx, sub: '' }
    return { group: categoryOrder.length, sub: c }
  }

  const handleToggleHidden = async (modelName: string, hidden: boolean) => {
    try {
      await setHiddenMutation.mutateAsync({ modelName, hidden })
      refreshCacheModels()
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const pullPercent = pullProgress?.total && pullProgress?.completed
    ? Math.round((pullProgress.completed / pullProgress.total) * 100)
    : null

  const filteredOllamaModels = showHiddenModels
    ? models
    : models.filter((m) => !hiddenSet.has(`ollama/${m.name}`))

  const sortedOllamaModels = filteredOllamaModels.slice().sort((a, b) => {
    const aCacheName = `ollama/${a.name}`
    const bCacheName = `ollama/${b.name}`
    const ca = categoryByCacheName.get(aCacheName) ?? ''
    const cb = categoryByCacheName.get(bCacheName) ?? ''
    const ra = categoryRank(ca)
    const rb = categoryRank(cb)
    if (ra.group !== rb.group) return ra.group - rb.group
    if (ra.sub !== rb.sub) return ra.sub.localeCompare(rb.sub)

    const pa = priorityByCacheName.get(aCacheName) ?? 99
    const pb = priorityByCacheName.get(bCacheName) ?? 99
    if (pa !== pb) return pa - pb
    if (a.running && !b.running) return -1
    if (!a.running && b.running) return 1
    return a.name.localeCompare(b.name)
  })

  const renderedOllamaModels: Array<import('react').ReactNode> = []
  for (let idx = 0; idx < sortedOllamaModels.length; idx++) {
    const m = sortedOllamaModels[idx]
    const cacheName = `ollama/${m.name}`
    const cacheEntry = cacheEntryByName.get(cacheName)
    const tag = (cacheEntry?.category ?? '').trim()
    const prev = idx > 0 ? cacheEntryByName.get(`ollama/${sortedOllamaModels[idx - 1]?.name}`) : undefined
    const prevTag = (prev?.category ?? '').trim()
    const showHeader = idx === 0 || prevTag !== tag
    if (showHeader) {
      renderedOllamaModels.push(
        <li key={`tag-${tag || 'none'}`} className="px-3 pt-3 pb-1 border-t border-neutral-800">
          <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
            {tag || 'Sans tag'}
          </span>
        </li>
      )
    }

    renderedOllamaModels.push(
      <li
        key={m.name}
        className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
          hiddenSet.has(cacheName)
            ? 'bg-neutral-900/60 border-neutral-700/80 opacity-80'
            : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'
        }`}
      >
        <span className="font-medium text-neutral-200 text-sm truncate min-w-0 flex-1" title={m.name}>
          {m.name}
          {hiddenSet.has(cacheName) ? ' (masqué)' : ''}
        </span>
        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-400 border border-blue-500/30">
          ollama
        </span>
        {cacheEntry?.template_configured && (
          <span
            className="shrink-0 text-[10px] text-amber-400 border border-amber-700/40 rounded px-1 py-0.5 bg-amber-950/30"
            title="TEMPLATE configuré dans le Modelfile (badge)"
          >
            TPL
          </span>
        )}
        <span className="shrink-0 w-16 text-right text-xs text-neutral-500 tabular-nums" title="Poids du modèle">
          {formatSize(m.size)}
        </span>
        <div className="shrink-0 flex items-center gap-2 ml-auto">
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Tag</span>
            <select
              className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-36"
              value={cacheEntry?.category ?? ''}
              disabled={setCategoryMutation.isPending}
              onChange={(e) => {
                const val = e.target.value
                const NEW_TAG_VALUE = '__new__'
                if (val === NEW_TAG_VALUE) {
                  const next = window.prompt('Nom du tag (catégorie) :')
                  if (next == null) return
                  const trimmed = next.trim()
                  handleSetCategory(cacheName, trimmed ? trimmed : null)
                } else {
                  handleSetCategory(cacheName, val ? val : null)
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
          {m.running ? (
            <button
              type="button"
              className="w-20 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-medium rounded transition-colors disabled:opacity-50"
              disabled={isActionBusy}
              onClick={() => handleUnload(m.name)}
              title={`Décharger ${m.name}`}
            >
              Décharger
            </button>
          ) : (
            <button
              type="button"
              className="w-20 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
              disabled={isActionBusy}
              onClick={() => handleLoad(m.name)}
              title={`Charger ${m.name}`}
            >
              Charger
            </button>
          )}
          {(() => {
            const isHidden = hiddenSet.has(cacheName)
            const showOllamaPriority = !isHidden && ollamaVisible.length >= 2 && cacheEntry
            return showOllamaPriority ? (
              <label className="flex items-center gap-1.5">
                <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Priorité</span>
                <select
                  className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-12"
                  value={cacheEntry?.priority ?? 1}
                  disabled={setPriorityMutation.isPending}
                  onChange={(e) => handleOllamaModelPriorityChange(cacheEntry as CachedModelEntry, Number(e.target.value))}
                  aria-label={`Priorité ${m.name}`}
                >
                  {Array.from({ length: ollamaVisible.length }, (_, i) => i + 1).map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            ) : null
          })()}
          <button
            type="button"
            className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-xs font-medium rounded transition-colors disabled:opacity-50"
            disabled={setHiddenMutation.isPending}
            onClick={() => handleToggleHidden(cacheName, !hiddenSet.has(cacheName))}
            title={hiddenSet.has(cacheName) ? 'Afficher ce modèle dans la liste et la priorité' : 'Masquer ce modèle (ne compte plus en priorité)'}
          >
            {hiddenSet.has(cacheName) ? 'Démasquer' : 'Masquer'}
          </button>
          {deleteConfirm === m.name ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="px-2 py-1 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
                disabled={isActionBusy}
                onClick={() => handleDelete(m.name)}
              >
                Confirmer
              </button>
              <button
                type="button"
                className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-medium rounded transition-colors"
                onClick={() => setDeleteConfirm(null)}
              >
                Annuler
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="px-2 py-1 bg-neutral-800 hover:bg-red-900/50 text-neutral-400 hover:text-red-400 border border-neutral-700 hover:border-red-800 text-xs font-medium rounded transition-colors disabled:opacity-50"
              disabled={isActionBusy}
              onClick={() => setDeleteConfirm(m.name)}
              title={`Supprimer ${m.name}`}
            >
              Supprimer
            </button>
          )}
        </div>
      </li>
    )
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col min-h-0">
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-6 py-4 border-b border-neutral-800">
        <h2 className="text-lg font-semibold text-white m-0">Ollama</h2>
        <div className="flex items-center gap-2">
          {ollamaHiddenCount > 0 && (
            <button
              type="button"
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              disabled={isActionBusy}
              onClick={() => setShowHiddenModels((v) => !v)}
            >
              {showHiddenModels ? 'Masquer les masqués' : `Afficher les masqués (${ollamaHiddenCount})`}
            </button>
          )}
          <button
            type="button"
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
            disabled={isActionBusy}
            onClick={() => { refetchModels(); refetchPs() }}
          >
            Rafraîchir
          </button>
          <button
            type="button"
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-sm font-medium rounded-md transition-colors"
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? 'Fermer' : 'Créer Modelfile'}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-6 space-y-4">
        {/* Message */}
        {message && (
          <p className={`text-sm ${messageType === 'error' ? 'text-red-500' : 'text-neutral-400'}`}>{message}</p>
        )}

        {/* Pull section */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            className="flex-1 bg-neutral-950 border border-neutral-700 text-white text-sm rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-neutral-500"
            placeholder="Pull un modèle (ex: llama3:8b)"
            value={pullInput}
            onChange={(e) => setPullInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !pulling && handlePull()}
            disabled={pulling}
          />
          <button
            type="button"
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
            disabled={pulling || !pullInput.trim()}
            onClick={handlePull}
          >
            {pulling ? 'Pull…' : 'Pull'}
          </button>
        </div>
        {/* Pull progress bar */}
        {pulling && pullProgress && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>{pullProgress.status}</span>
              {pullPercent != null && <span>{pullPercent}%</span>}
            </div>
            {pullPercent != null && (
              <div className="w-full bg-neutral-800 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${pullPercent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Create modelfile section — enriched form */}
        {showCreate && (
          <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg space-y-4">
            {/* Nom du modèle */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-neutral-400">Nom du modèle</label>
              <input
                type="text"
                className={inputClass}
                placeholder="mon-assistant"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                disabled={creating}
              />
            </div>

            {/* FROM — modèle de base */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-neutral-400">Modèle de base (FROM)</label>
              <input
                type="text"
                className={inputClass}
                placeholder="llama3:8b"
                value={fields.fromModel}
                onChange={(e) => updateField('fromModel', e.target.value)}
                disabled={creating}
              />
            </div>

            {/* Prompt système */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-neutral-400">Prompt système</label>
              <textarea
                className={`${inputClass} font-mono min-h-[80px] resize-y`}
                placeholder="Tu es un assistant expert en..."
                value={fields.systemPrompt}
                onChange={(e) => updateField('systemPrompt', e.target.value)}
                disabled={creating}
              />
            </div>

            {/* Paramètres — collapsible */}
            <div>
              <button
                type="button"
                onClick={() => setShowParams(v => !v)}
                className="text-xs font-medium text-neutral-400 hover:text-neutral-200 flex items-center gap-1.5"
              >
                {showParams ? '▼' : '▶'} Paramètres
              </button>
              {showParams && (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Taille de la fenêtre de contexte (défaut Ollama : 2048)">num_ctx</label>
                    <input type="number" className={inputClass} placeholder="4096" value={fields.numCtx} onChange={e => updateField('numCtx', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Température de sampling (défaut : 0.8)">temperature</label>
                    <input type="number" step="0.1" min="0" max="2" className={inputClass} placeholder="0.8" value={fields.temperature} onChange={e => updateField('temperature', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Top K sampling (défaut : 40)">top_k</label>
                    <input type="number" className={inputClass} placeholder="40" value={fields.topK} onChange={e => updateField('topK', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Top P / nucleus sampling (défaut : 0.9)">top_p</label>
                    <input type="number" step="0.05" min="0" max="1" className={inputClass} placeholder="0.9" value={fields.topP} onChange={e => updateField('topP', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Pénalité de répétition (défaut : 1.1)">repeat_penalty</label>
                    <input type="number" step="0.1" min="0" className={inputClass} placeholder="1.1" value={fields.repeatPenalty} onChange={e => updateField('repeatPenalty', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Nombre max de tokens générés (défaut : 128)">num_predict</label>
                    <input type="number" className={inputClass} placeholder="128" value={fields.numPredict} onChange={e => updateField('numPredict', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Nombre de layers sur GPU (vide = auto)">num_gpu</label>
                    <input type="number" className={inputClass} placeholder="auto" value={fields.numGpu} onChange={e => updateField('numGpu', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Seed pour reproductibilité (vide = aléatoire)">seed</label>
                    <input type="number" className={inputClass} placeholder="aléatoire" value={fields.seed} onChange={e => updateField('seed', e.target.value)} disabled={creating} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-neutral-500" title="Séquences de stop, séparées par ; (ex: &lt;|end|&gt;;&lt;|user|&gt;)">stop (séparés par ;)</label>
                    <input type="text" className={inputClass} placeholder="<|end|>;<|user|>" value={fields.stop} onChange={e => updateField('stop', e.target.value)} disabled={creating} />
                  </div>
                </div>
              )}
            </div>

            {/* Template avancé — collapsible */}
            <div>
              <button
                type="button"
                onClick={() => setShowTemplate(v => !v)}
                className="text-xs font-medium text-neutral-400 hover:text-neutral-200 flex items-center gap-1.5"
              >
                {showTemplate ? '▼' : '▶'} Template (avancé)
              </button>
              {showTemplate && (
                <div className="mt-2">
                  <textarea
                    className={`${inputClass} font-mono min-h-[80px] resize-y`}
                    placeholder={'{{ .System }}\n{{ .Prompt }}'}
                    value={fields.template}
                    onChange={(e) => updateField('template', e.target.value)}
                    disabled={creating}
                  />
                </div>
              )}
            </div>

            {/* Aperçu Modelfile — collapsible */}
            <div>
              <button
                type="button"
                onClick={() => setShowPreview(v => !v)}
                className="text-xs font-medium text-neutral-400 hover:text-neutral-200 flex items-center gap-1.5"
              >
                {showPreview ? '▼' : '▶'} Aperçu Modelfile
              </button>
              {showPreview && (
                <pre className="mt-2 p-3 bg-neutral-900 border border-neutral-700 rounded-md text-xs text-neutral-300 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {modelfileText || '(remplir le modèle de base pour générer l\'aperçu)'}
                </pre>
              )}
            </div>

            {/* Status + button */}
            {createStatus && (
              <p className="text-xs text-neutral-400">{createStatus}</p>
            )}
            <button
              type="button"
              className="px-4 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              disabled={creating || !createName.trim() || !fields.fromModel.trim()}
              onClick={handleCreate}
            >
              {creating ? 'Création…' : 'Créer'}
            </button>
          </div>
        )}

        {/* Models list */}
        {modelsLoading && <Spinner />}
        {modelsData?.error && (
          <p className="text-red-500 text-sm">{modelsData.error}</p>
        )}
        {!modelsLoading && models.length === 0 && !modelsData?.error && (
          <p className="text-neutral-500 text-sm">Aucun modèle Ollama disponible.</p>
        )}
        {ollamaVisible.length >= 2 && models.length > 0 && (
          <p className="text-xs text-neutral-500 mb-2">Priorité des modèles Ollama (ordre pour le mode auto)</p>
        )}
        {sortedOllamaModels.length > 0 && (
          <ul className="flex flex-col gap-2">
            {renderedOllamaModels}
          </ul>
        )}
      </div>
    </section>
  )
}
