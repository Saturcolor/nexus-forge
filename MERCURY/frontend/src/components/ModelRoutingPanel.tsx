import { useState, useEffect, useCallback } from 'react'
import type { Config, ModelMappingResponse } from '../api/admin'
import * as api from '../api/admin'
import { useConfig, useSaveConfigMutation, useCacheModels, useSetHiddenModelMutation, useAudioVoices } from '../api/queries'
import Spinner from './Spinner'

const ROUTING_TAGS: { tag: string; description: string }[] = [
  { tag: 'lm_studio/lm_studio ou lmstudio/lmstudio', description: 'Premier modèle LM Studio' },
  { tag: 'ollama/ollama', description: 'Premier modèle Ollama' },
  { tag: 'llamacpp/llamacpp', description: 'Premier modèle llama.cpp' },
  { tag: 'vllm/vllm', description: 'Premier modèle vLLM' },
  { tag: 'lucebox/lucebox', description: 'Premier modèle Lucebox' },
  { tag: 'mlx/mlx', description: 'Premier modèle MLX' },
]

type RowSource = 'Mapping' | 'Résolution' | 'Backend'

function buildRows(mapping: ModelMappingResponse | null): { tag: string; backend: string; backend_model_id: string; source: RowSource }[] {
  if (!mapping) return []
  const byTag = new Map<string, { backend: string; backend_model_id: string; source: RowSource }>()

  for (const m of mapping.from_config) {
    byTag.set(m.canonical, { backend: m.backend, backend_model_id: m.backend_model_id, source: 'Mapping' })
  }
  for (const m of mapping.from_cache) {
    if (!byTag.has(m.canonical)) {
      byTag.set(m.canonical, { backend: m.backend, backend_model_id: m.backend_model_id, source: 'Résolution' })
    }
  }
  for (const m of mapping.backend_models) {
    if (!byTag.has(m.name)) {
      byTag.set(m.name, { backend: m.backend, backend_model_id: m.backend_model_id, source: 'Backend' })
    }
  }

  return Array.from(byTag.entries())
    .map(([tag, v]) => ({ tag, ...v }))
    .sort((a, b) => a.tag.localeCompare(b.tag))
}

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'

export default function ModelRoutingPanel() {
  const { data: config } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()
  const { data: cacheModelsData } = useCacheModels()
  const setHiddenMutation = useSetHiddenModelMutation()
  const { data: audioVoicesData } = useAudioVoices()
  const [mapping, setMapping] = useState<ModelMappingResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editModal, setEditModal] = useState<{ tag: string; backend: string; backend_model_id: string } | null>(null)
  const [newEntry, setNewEntry] = useState(false)
  const [showHiddenModels, setShowHiddenModels] = useState(false)

  const loadMapping = useCallback(async () => {
    try {
      setError(null)
      setMapping(await api.getModelMapping())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setMapping(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMapping()
  }, [loadMapping])

  const handleRefreshCache = async () => {
    setRefreshLoading(true)
    try {
      await api.refreshModelsCache()
      await loadMapping()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshLoading(false)
    }
  }

  const [flushLoading, setFlushLoading] = useState(false)
  const handleFlushCache = async () => {
    setFlushLoading(true)
    try {
      await api.flushModelsCache()
      await loadMapping()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFlushLoading(false)
    }
  }

  const handleSaveMappingEntry = async (canonical: string, backend: string, backend_model_id: string, isNew: boolean) => {
    const current = (config?.model_mapping ?? {}) as Record<string, { backend: string; backend_model_id: string }>
    const next = { ...current }
    if (!isNew) {
      const prevTag = editModal?.tag
      if (prevTag && prevTag !== canonical) delete next[prevTag]
    }
    next[canonical] = { backend, backend_model_id }
    try {
      await saveConfigMutation.mutateAsync({ ...config, model_mapping: next } as Config)
      await loadMapping()
      setEditModal(null)
      setNewEntry(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDeleteMappingEntry = async (canonical: string) => {
    const current = (config?.model_mapping ?? {}) as Record<string, { backend: string; backend_model_id: string }>
    const next = { ...current }
    delete next[canonical]
    try {
      await saveConfigMutation.mutateAsync({ ...config, model_mapping: next } as Config)
      await loadMapping()
      setEditModal(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const rows = buildRows(mapping)

  const hiddenSet = new Set(cacheModelsData?.hidden_model_names ?? [])
  const getHiddenModelName = (r: { backend: string; backend_model_id: string; tag: string }) => {
    const backend = (r.backend ?? '').trim()
    const bid = (r.backend_model_id ?? '').trim()
    if (backend && bid) return `${backend}/${bid}`
    return (r.tag ?? '').trim()
  }

  const hiddenCount = rows.filter((r) => hiddenSet.has(getHiddenModelName(r))).length
  const visibleRows = rows.filter((r) => showHiddenModels || !hiddenSet.has(getHiddenModelName(r)))

  if (loading) return <Spinner />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-xl font-semibold text-white m-0">Routage modèles</h2>
        {error && <p className="text-red-500 text-sm m-0">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
            disabled={refreshLoading}
            onClick={handleRefreshCache}
          >
            {refreshLoading ? 'Rafraichissement...' : 'Rafraichir le cache'}
          </button>
          <button
            type="button"
            className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
            disabled={flushLoading}
            onClick={handleFlushCache}
            title="Vide le cache + le cache de resolution, puis reconstruit depuis zero"
          >
            {flushLoading ? 'Flush...' : 'Flush cache'}
          </button>
          <button
            type="button"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors"
            onClick={() => { setNewEntry(true); setEditModal({ tag: '', backend: 'ollama', backend_model_id: '' }) }}
          >
            Ajouter une entrée
          </button>
          {hiddenCount > 0 && (
            <button
              type="button"
              className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              disabled={setHiddenMutation.isPending}
              onClick={() => setShowHiddenModels((v) => !v)}
            >
              {showHiddenModels ? 'Masquer les masqués' : `Afficher les masqués (${hiddenCount})`}
            </button>
          )}
        </div>
      </div>

      {/* Référence : tags pour routage auto */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Tags pour routage</h3>
        <p className="text-xs text-neutral-500 mb-4">Identifiants a utiliser dans le champ <code className="text-xs bg-neutral-800 px-1 rounded">model</code> pour router vers le bon provider (premier modele du backend).</p>
        <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr>
                <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Tag à utiliser</th>
                <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Comportement</th>
              </tr>
            </thead>
            <tbody>
              {ROUTING_TAGS.map(({ tag, description }) => (
                <tr key={tag}>
                  <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code className="text-xs bg-neutral-800 px-1.5 py-0.5 rounded">{tag}</code></td>
                  <td className="p-3 border-b border-neutral-800/50 text-neutral-300">{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Tableau : résolution par modèle */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Résolution des modèles</h3>
        <p className="text-xs text-neutral-500 mb-4">Tag = identifiant utilise dans le champ <code className="text-xs bg-neutral-800 px-1 rounded">model</code> pour le routage. Les entrees « Mapping » sont editables.</p>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500 m-0">Aucun modèle. Rafraîchissez le cache ou ajoutez une entrée au mapping.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Tag</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Backend</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Backend model ID</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Source</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 w-28">Masqué</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 w-24">Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const hideModelName = getHiddenModelName(r)
                  const isHidden = hiddenSet.has(hideModelName)
                  return (
                  <tr key={r.tag}>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-200 font-mono text-xs">{r.tag || '—'}</td>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-300">{r.backend}</td>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-300 font-mono text-xs">{r.backend_model_id}</td>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-400">{r.source}</td>
                    <td className="p-3 border-b border-neutral-800/50">
                      <input
                        type="checkbox"
                        checked={isHidden}
                        disabled={setHiddenMutation.isPending}
                        onChange={(e) => {
                          setHiddenMutation.mutateAsync({ modelName: hideModelName, hidden: e.target.checked })
                        }}
                        className="w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-2 focus:ring-blue-500"
                        aria-label={isHidden ? `Démasquer ${hideModelName}` : `Masquer ${hideModelName}`}
                        title={isHidden ? 'Démasquer (ré-intègre la priorité auto)' : 'Masquer (ne compte plus dans la priorité auto)'}
                      />
                    </td>
                    <td className="p-3 border-b border-neutral-800/50">
                      {r.source === 'Mapping' ? (
                        <button
                          type="button"
                          className="text-blue-400 hover:text-blue-300 text-xs font-medium"
                          onClick={() => setEditModal({ tag: r.tag, backend: r.backend, backend_model_id: r.backend_model_id })}
                        >
                          Modifier
                        </button>
                      ) : r.source === 'Backend' ? (
                        <button
                          type="button"
                          className="text-blue-400 hover:text-blue-300 text-xs font-medium"
                          onClick={() => { setNewEntry(true); setEditModal({ tag: r.tag, backend: r.backend, backend_model_id: r.backend_model_id }) }}
                        >
                          Ajouter au mapping
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Routage audio */}
      {audioVoicesData && (audioVoicesData.stt_models.length > 0 || audioVoicesData.tts_models.length > 0) && (
        <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
          <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Routage audio</h3>
          <p className="text-xs text-neutral-500 mb-4">Les routes <code className="text-xs bg-neutral-800 px-1 rounded">/v1/audio/*</code> resolvent le provider automatiquement depuis le model name. Le header <code className="text-xs bg-neutral-800 px-1 rounded">X-Audio-Provider</code> reste prioritaire.</p>

          {(audioVoicesData.stt_models.length > 0 || audioVoicesData.tts_models.length > 0) && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Modeles</h4>
              <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Modele</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Provider</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audioVoicesData.stt_models.map((m) => (
                      <tr key={`stt-${m.name}`}>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200 font-mono text-xs">{m.name}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-300">{m.provider}</td>
                        <td className="p-3 border-b border-neutral-800/50"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400">STT</span></td>
                      </tr>
                    ))}
                    {audioVoicesData.tts_models.map((m) => (
                      <tr key={`tts-${m.name}`}>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200 font-mono text-xs">{m.name}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-300">{m.provider}</td>
                        <td className="p-3 border-b border-neutral-800/50"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400">TTS</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {audioVoicesData.voices.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Voix TTS</h4>
              <div className="overflow-x-auto max-h-48 rounded-lg border border-neutral-800 bg-neutral-950">
                <table className="w-full text-left border-collapse text-sm">
                  <thead className="sticky top-0 bg-neutral-950">
                    <tr>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Nom</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Provider</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Voice ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audioVoicesData.voices.map((v) => (
                      <tr key={`${v.provider}-${v.name}`}>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200 font-medium">{v.name}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-300">{v.provider}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-500 font-mono text-xs">{v.voice_id || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Modal édition */}
      {editModal && (
        <EditMappingModal
          initialTag={editModal.tag}
          initialBackend={editModal.backend}
          initialBackendModelId={editModal.backend_model_id}
          isNew={newEntry}
          onSave={handleSaveMappingEntry}
          onDelete={editModal.tag ? () => handleDeleteMappingEntry(editModal.tag) : undefined}
          onClose={() => { setEditModal(null); setNewEntry(false) }}
        />
      )}
    </div>
  )
}

function EditMappingModal({
  initialTag,
  initialBackend,
  initialBackendModelId,
  isNew,
  onSave,
  onDelete,
  onClose,
}: {
  initialTag: string
  initialBackend: string
  initialBackendModelId: string
  isNew: boolean
  onSave: (canonical: string, backend: string, backend_model_id: string, isNew: boolean) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}) {
  const [tag, setTag] = useState(initialTag)
  const [backend, setBackend] = useState(initialBackend)
  const [backendModelId, setBackendModelId] = useState(initialBackendModelId)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const canonical = tag.trim()
    if (!canonical) return
    setSaving(true)
    try {
      await onSave(canonical, backend, backendModelId.trim(), isNew)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete) return
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">{isNew ? 'Ajouter une entrée au mapping' : 'Modifier l\'entrée'}</h3>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className={labelClass}>Tag (nom canonique)</label>
            <input
              type="text"
              value={tag}
              onChange={e => setTag(e.target.value)}
              placeholder="ex. ollama/llama3.2 ou openrouter/openai/gpt-4o"
              className={inputClass}
              required
            />
          </div>
          <div>
            <label className={labelClass}>Backend</label>
            <select
              value={backend}
              onChange={e => setBackend(e.target.value)}
              className={inputClass}
            >
              <option value="ollama">ollama</option>
              <option value="lm_studio">lm_studio</option>
              <option value="mlx">mlx</option>
              <option value="llamacpp">llamacpp</option>
              <option value="vllm">vllm</option>
              <option value="lucebox">lucebox</option>
              <option value="openrouter">openrouter</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Backend model ID</label>
            <input
              type="text"
              value={backendModelId}
              onChange={e => setBackendModelId(e.target.value)}
              placeholder="ID envoyé au provider"
              className={inputClass}
              required
            />
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              disabled={saving || !tag.trim() || !backendModelId.trim()}
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <button type="button" className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors" onClick={onClose}>
              Annuler
            </button>
            {onDelete && !isNew && (
              <button
                type="button"
                className="px-4 py-2 bg-red-900/50 hover:bg-red-900/70 text-red-300 text-sm font-medium rounded-md transition-colors disabled:opacity-50 ml-auto"
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting ? 'Suppression…' : 'Supprimer du mapping'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
