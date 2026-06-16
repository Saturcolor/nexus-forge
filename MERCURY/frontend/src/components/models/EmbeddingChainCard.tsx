import { useState, useMemo } from 'react'
import { useConfig, useSaveConfigMutation, useLlamacppModels } from '../../api/queries'
import type { Config } from '../../api/admin'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnPrimary = `${btn} bg-blue-600 hover:bg-blue-500 text-white`
const btnRed = `${btn} bg-red-600/80 hover:bg-red-500 text-white`
const inputCls = 'px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500'

type LocalEntry = { id?: string; model: string; dim?: number | null; priority?: number }

export default function EmbeddingChainCard() {
  const { data: config } = useConfig()
  const saveMut = useSaveConfigMutation()
  const { data: localModels } = useLlamacppModels()

  const [newModel, setNewModel] = useState('')
  const [newDim, setNewDim] = useState<number | ''>(4096)
  const [newPriority, setNewPriority] = useState<number>(1)
  const [error, setError] = useState<string | null>(null)

  const localEntries: LocalEntry[] = config?.local_embedding_models ?? []
  const cloudModel = (config?.openrouter_embedding_model ?? '').trim()
  const cloudEnabled = config?.openrouter_enabled === true && cloudModel.length > 0

  const availableLocalModels = (localModels?.models ?? [])
    .map((m) => m.model_id)
    .filter((id) => !localEntries.some((e) => e.model === id))

  const chainPreview = useMemo(() => {
    const items: Array<{ id: string; backend: 'llamacpp' | 'openrouter'; model: string; dim?: number | null; priority: number }> = []
    for (const e of localEntries) {
      items.push({
        id: e.id || `local-${e.model.split('/').pop()}`,
        backend: 'llamacpp',
        model: e.model,
        dim: e.dim,
        priority: e.priority ?? 1,
      })
    }
    if (cloudEnabled) {
      items.push({
        id: 'cloud-openrouter',
        backend: 'openrouter',
        model: cloudModel,
        dim: config?.openrouter_embedding_dim,
        priority: config?.openrouter_embedding_priority ?? 99,
      })
    }
    return items.sort((a, b) => a.priority - b.priority)
  }, [localEntries, cloudEnabled, cloudModel, config?.openrouter_embedding_dim, config?.openrouter_embedding_priority])

  const dimsHomogeneous = useMemo(() => {
    const dims = chainPreview.map((e) => e.dim).filter((d): d is number => typeof d === 'number')
    return dims.length === 0 || dims.every((d) => d === dims[0])
  }, [chainPreview])

  if (!config) return null

  const persist = async (next: Partial<Config>) => {
    setError(null)
    try {
      await saveMut.mutateAsync({ ...config, ...next })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const addLocal = async () => {
    if (!newModel.trim()) {
      setError('Choisis un modèle local')
      return
    }
    const entry: LocalEntry = {
      model: newModel.trim(),
      dim: newDim === '' ? null : Number(newDim),
      priority: newPriority,
    }
    await persist({ local_embedding_models: [...localEntries, entry] })
    setNewModel('')
    setNewDim(4096)
    setNewPriority(1)
  }

  const updateLocal = async (idx: number, patch: Partial<LocalEntry>) => {
    const next = localEntries.map((e, i) => (i === idx ? { ...e, ...patch } : e))
    await persist({ local_embedding_models: next })
  }

  const removeLocal = async (idx: number) => {
    const next = localEntries.filter((_, i) => i !== idx)
    await persist({ local_embedding_models: next })
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="px-4 py-2.5 border-b border-neutral-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white m-0">Chaine embedding</h2>
        <span className="text-[10px] text-neutral-500">
          {chainPreview.length} mod{chainPreview.length > 1 ? 'èles' : 'èle'} · {dimsHomogeneous ? 'dim cohérente' : '⚠ dim hétérogène'}
        </span>
      </div>
      <div className="px-4 py-3 flex flex-col gap-4">
        {error && <p className="text-xs text-red-400 m-0">{error}</p>}
        {!dimsHomogeneous && (
          <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 m-0">
            Les modèles n'ont pas tous la même dimension — Mastermind refusera de booter (validation cohérence).
          </p>
        )}

        {/* Chaine consolidée */}
        {chainPreview.length === 0 ? (
          <p className="text-xs text-neutral-500 italic m-0">
            Aucun modèle d'embedding configuré. Ajoute un modèle local ci-dessous, ou définis le modèle OpenRouter dans le panneau Cloud.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-neutral-800 bg-neutral-950">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-neutral-900/80">
                <tr>
                  <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800 w-12 text-center">Prio</th>
                  <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">ID</th>
                  <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Backend</th>
                  <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Modèle</th>
                  <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800 w-16 text-right">Dim</th>
                </tr>
              </thead>
              <tbody>
                {chainPreview.map((e) => (
                  <tr key={e.id}>
                    <td className="p-2 border-b border-neutral-800/50 text-center text-neutral-300 font-mono">{e.priority}</td>
                    <td className="p-2 border-b border-neutral-800/50 text-white font-mono">{e.id}</td>
                    <td className="p-2 border-b border-neutral-800/50">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${e.backend === 'llamacpp' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'}`}>
                        {e.backend === 'llamacpp' ? 'local' : 'cloud'}
                      </span>
                    </td>
                    <td className="p-2 border-b border-neutral-800/50 text-neutral-300 font-mono truncate max-w-[20rem]" title={e.model}>{e.model}</td>
                    <td className="p-2 border-b border-neutral-800/50 text-right text-neutral-400 font-mono tabular-nums">{e.dim ?? '?'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Édition entrées locales */}
        {localEntries.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider m-0">Entrées locales (éditer)</h3>
            <div className="flex flex-col gap-1.5">
              {localEntries.map((e, idx) => (
                <div key={`${e.model}-${idx}`} className="flex items-center gap-2 px-2 py-1.5 bg-neutral-950 border border-neutral-800 rounded">
                  <span className="font-mono text-xs text-white truncate flex-1" title={e.model}>{e.model}</span>
                  <label className="text-[10px] text-neutral-500">dim</label>
                  <input
                    type="number"
                    min={1}
                    value={e.dim ?? ''}
                    onChange={(ev) => updateLocal(idx, { dim: ev.target.value === '' ? null : Number(ev.target.value) })}
                    className={`${inputCls} w-20 tabular-nums`}
                  />
                  <label className="text-[10px] text-neutral-500">prio</label>
                  <input
                    type="number"
                    min={1}
                    value={e.priority ?? 1}
                    onChange={(ev) => updateLocal(idx, { priority: Number(ev.target.value) })}
                    className={`${inputCls} w-14 tabular-nums`}
                  />
                  <button className={btnRed} onClick={() => removeLocal(idx)} disabled={saveMut.isPending}>
                    Retirer
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Ajout d'une entrée locale */}
        <div className="flex flex-col gap-2 pt-2 border-t border-neutral-800">
          <h3 className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider m-0">Ajouter un modèle local</h3>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex flex-col gap-1 flex-1 min-w-[20rem]">
              <label className="text-[10px] text-neutral-500">Modèle (GGUF chargé via brain-daemon)</label>
              <select
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                className={`${inputCls} w-full`}
              >
                <option value="">— Choisir —</option>
                {availableLocalModels.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-neutral-500">Dim</label>
              <input
                type="number"
                min={1}
                value={newDim}
                onChange={(e) => setNewDim(e.target.value === '' ? '' : Number(e.target.value))}
                className={`${inputCls} w-24 tabular-nums`}
                placeholder="4096"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-neutral-500">Priorité</label>
              <input
                type="number"
                min={1}
                value={newPriority}
                onChange={(e) => setNewPriority(Number(e.target.value))}
                className={`${inputCls} w-16 tabular-nums`}
              />
            </div>
            <button className={btnPrimary} onClick={addLocal} disabled={!newModel || saveMut.isPending}>
              Ajouter
            </button>
          </div>
          <p className="text-[10px] text-neutral-500 m-0">
            Le modèle doit être déclaré dans <code className="text-neutral-400">BRAIN-DAEMON/load_configs.json</code> avec les flags <code className="text-neutral-400">--embedding --pooling last</code>.
          </p>
        </div>
      </div>
    </section>
  )
}
