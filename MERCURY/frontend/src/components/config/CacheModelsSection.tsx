import { useState, useCallback, useEffect } from 'react'
import type { Config, ModelsCacheState, CacheModelsResponse } from '../../api/admin'
import * as api from '../../api/admin'
import { useRefreshCacheMutation } from '../../api/queries'
import { inputClass, labelClass, fieldClass, sectionClass, legendClass, formatDateTime } from './shared'
import Spinner from '../Spinner'

type CacheModelsSectionProps = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  onCacheRefreshed: () => void
}

export default function CacheModelsSection({ config, updateField, onCacheRefreshed }: CacheModelsSectionProps) {
  const refreshCacheMutation = useRefreshCacheMutation()
  const [cacheState, setCacheState] = useState<ModelsCacheState | null>(null)
  const [cacheRefreshing, setCacheRefreshing] = useState(false)
  const [cacheModalOpen, setCacheModalOpen] = useState(false)
  const [cacheModalData, setCacheModalData] = useState<{ state: ModelsCacheState | null; models: CacheModelsResponse | null }>({ state: null, models: null })
  const [cacheModalLoading, setCacheModalLoading] = useState(false)
  const [hiddenModelsOpen, setHiddenModelsOpen] = useState(false)
  const [hiddenModelInput, setHiddenModelInput] = useState('')

  const hiddenModels: string[] = Array.isArray(config.hidden_models) ? config.hidden_models : []

  const loadCacheState = useCallback(async () => {
    try { setCacheState(await api.getCacheState()) } catch { setCacheState(null) }
  }, [])

  useEffect(() => { loadCacheState() }, [loadCacheState])

  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Cache & Modeles</h3>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>Cache modeles</legend>
        <div className={fieldClass}>
          <label htmlFor="cfg-models-cache-ttl" className={labelClass}>TTL cache (secondes)</label>
          <input id="cfg-models-cache-ttl" type="number" value={config.models_cache_ttl_seconds ?? 60} min={0} className={inputClass} onChange={e => updateField('models_cache_ttl_seconds', Number(e.target.value))} title="0 = rafraichir a chaque GET /api/tags" />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-neutral-400 uppercase tracking-wider font-medium mb-0.5">Etat du cache</p>
            {cacheState ? (
              <p className="text-sm text-neutral-200 m-0">
                {cacheState.count} modele{cacheState.count !== 1 ? 's' : ''} en cache
                {cacheState.updated_at ? ` · Mis a jour le ${formatDateTime(cacheState.updated_at)}` : ''}
              </p>
            ) : (
              <p className="text-sm text-neutral-500 m-0">—</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors border border-neutral-600"
              onClick={async () => {
                setCacheModalOpen(true)
                setCacheModalLoading(true)
                setCacheModalData({ state: null, models: null })
                try {
                  const [state, models] = await Promise.all([api.getCacheState(), api.getCacheModels()])
                  setCacheModalData({ state, models })
                } catch {
                  setCacheModalData({ state: null, models: null })
                } finally {
                  setCacheModalLoading(false)
                }
              }}
            >
              Visualiser le cache
            </button>
            <button
              type="button"
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 border border-neutral-600"
              disabled={cacheRefreshing}
              onClick={async () => {
                setCacheRefreshing(true)
                try {
                  await refreshCacheMutation.mutateAsync()
                  await loadCacheState()
                  onCacheRefreshed()
                } finally {
                  setCacheRefreshing(false)
                }
              }}
            >
              {cacheRefreshing ? 'Rafraichissement…' : 'Rafraichir le cache'}
            </button>
          </div>
        </div>
        <p className="text-xs text-neutral-500">Recharge la liste des modeles depuis les backends et met a jour le mapping.</p>
      </fieldset>

      {/* Hidden models editor */}
      <div className="border-t border-neutral-800 pt-4">
        <button
          type="button"
          onClick={() => setHiddenModelsOpen(o => !o)}
          className="text-xs font-medium text-neutral-400 hover:text-neutral-200 flex items-center gap-1.5"
        >
          {hiddenModelsOpen ? '▼' : '▶'} Modeles masques ({hiddenModels.length})
        </button>
        {hiddenModelsOpen && (
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-xs text-neutral-500">Les modeles masques n'apparaissent pas dans /api/tags et ne comptent pas dans la priorite auto.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={hiddenModelInput}
                onChange={e => setHiddenModelInput(e.target.value)}
                placeholder="ex. ollama/llama3.2:1b"
                className={inputClass + ' flex-1'}
                onKeyDown={e => {
                  if (e.key === 'Enter' && hiddenModelInput.trim()) {
                    const name = hiddenModelInput.trim()
                    if (!hiddenModels.includes(name)) {
                      updateField('hidden_models', [...hiddenModels, name])
                    }
                    setHiddenModelInput('')
                  }
                }}
              />
              <button
                type="button"
                className="px-3 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm rounded-md transition-colors border border-neutral-600"
                onClick={() => {
                  const name = hiddenModelInput.trim()
                  if (name && !hiddenModels.includes(name)) {
                    updateField('hidden_models', [...hiddenModels, name])
                  }
                  setHiddenModelInput('')
                }}
              >
                Ajouter
              </button>
            </div>
            {hiddenModels.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {hiddenModels.map(m => (
                  <span key={m} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded-full text-xs text-neutral-300">
                    <code>{m}</code>
                    <button
                      type="button"
                      onClick={() => updateField('hidden_models', hiddenModels.filter(x => x !== m))}
                      className="text-neutral-500 hover:text-red-400 transition-colors"
                      title="Retirer"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cache modal */}
      {cacheModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setCacheModalOpen(false)} role="dialog" aria-modal="true" aria-label="Visualiser le cache">
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-neutral-800">
              <h3 className="text-lg font-semibold text-white m-0">Contenu du cache modeles</h3>
              <button type="button" className="text-neutral-400 hover:text-white p-1 rounded" onClick={() => setCacheModalOpen(false)} aria-label="Fermer">✕</button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 min-h-0">
              {cacheModalLoading ? (
                <Spinner />
              ) : (
                <>
                  {cacheModalData.state && (
                    <p className="text-sm text-neutral-300 mb-4">
                      {cacheModalData.state.count} modele{cacheModalData.state.count !== 1 ? 's' : ''} en cache
                      {cacheModalData.state.updated_at ? ` · Mis a jour le ${formatDateTime(cacheModalData.state.updated_at)}` : ''}
                    </p>
                  )}
                  {cacheModalData.models?.models && cacheModalData.models.models.length > 0 ? (
                    <div className="overflow-x-auto border border-neutral-800 rounded-lg">
                      <table className="w-full text-left border-collapse text-sm">
                        <thead>
                          <tr>
                            <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Modele</th>
                            <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Backend</th>
                            <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Priorite</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cacheModalData.models.models.map((m, i) => (
                            <tr key={i}>
                              <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code className="text-xs">{m.name}</code></td>
                              <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{m.backend ?? '—'}</td>
                              <td className="p-3 border-b border-neutral-800/50 text-neutral-400">{m.priority ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-neutral-500 m-0">Aucun modele en cache. Utilisez « Rafraichir le cache » pour charger les modeles.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
