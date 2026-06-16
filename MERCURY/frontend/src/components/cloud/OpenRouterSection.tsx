import { useState } from 'react'
import type { Config, ModelMappingResponse, OpenRouterModelEntry } from '../../api/admin'
import * as api from '../../api/admin'

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'
const fieldClass = 'flex flex-col gap-1.5'

function Checkbox({ id, checked, onChange, disabled, children }: { id: string; checked: boolean; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; disabled?: boolean; children?: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 cursor-pointer">
      <input id={id} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5 w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:ring-offset-neutral-900" />
      {children && <span className="text-sm text-neutral-200">{children}</span>}
    </label>
  )
}

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  markDirty: () => void
  modelMapping: ModelMappingResponse | null
  refreshConfig: () => void
  loadModelMapping: () => void
  setSaveStatus: (s: string | null) => void
}

export default function OpenRouterSection({ config, updateField, markDirty, modelMapping, refreshConfig, loadModelMapping, setSaveStatus }: Props) {
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [models, setModels] = useState<OpenRouterModelEntry[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsErr, setModelsErr] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const mappedModels = (modelMapping?.from_config ?? [])
    .filter((r) => r.backend === 'openrouter')
    .map((r) => ({ canonical: r.canonical, backend_model_id: r.backend_model_id }))

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {/* Config */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">OpenRouter</h3>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
          <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Provider</legend>
          <Checkbox id="cloud-openrouter-enabled" checked={config.openrouter_enabled === true} onChange={(e) => updateField('openrouter_enabled', e.target.checked)}>
            Active
          </Checkbox>
          <div className={fieldClass}>
            <label htmlFor="cloud-openrouter-api-key" className={labelClass}>Cle API (standard)</label>
            <input id="cloud-openrouter-api-key" type="password" value={apiKeyInput} onChange={(e) => { markDirty(); setApiKeyInput(e.target.value) }} placeholder={config.openrouter_api_key_set ? '•••••••• (vide = ne pas changer)' : 'Saisir la cle OpenRouter'} autoComplete="off" className={inputClass} />
          </div>
        </fieldset>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
          <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Modele de fallback</legend>
          <p className="text-xs text-neutral-500 m-0">Modele utilise lorsque les backends locaux ne repondent pas.</p>
          <div className={fieldClass}>
            <label htmlFor="cloud-or-fallback-model" className={labelClass}>Modele de fallback</label>
            <select id="cloud-or-fallback-model" value={config.openrouter_fallback_model ?? ''} onChange={(e) => updateField('openrouter_fallback_model', e.target.value)} className={inputClass + ' cursor-pointer'}>
              <option value="">— Aucun —</option>
              {mappedModels.map((m) => <option key={m.canonical} value={m.backend_model_id}>{m.canonical}</option>)}
            </select>
          </div>
          <Checkbox id="cloud-or-force" checked={config.openrouter_fallback_force === true} onChange={(e) => updateField('openrouter_fallback_force', e.target.checked)}>
            Forcer le fallback (tous les modeles non matches → OpenRouter)
          </Checkbox>
        </fieldset>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
          <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Modeles specialises</legend>
          <div className={fieldClass}>
            <label htmlFor="cloud-or-vision" className={labelClass}>Modele vision</label>
            <input id="cloud-or-vision" value={config.openrouter_vision_model ?? ''} onChange={(e) => updateField('openrouter_vision_model', e.target.value)} placeholder="ex: google/gemini-flash-2.0-exp" className={inputClass} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="cloud-or-reasoning" className={labelClass}>Modele raisonnement etendu</label>
            <input id="cloud-or-reasoning" value={config.openrouter_reasoning_model ?? ''} onChange={(e) => updateField('openrouter_reasoning_model', e.target.value)} placeholder="ex: anthropic/claude-opus-4" className={inputClass} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="cloud-or-embedding" className={labelClass}>Modele embedding</label>
            <input id="cloud-or-embedding" value={config.openrouter_embedding_model ?? ''} onChange={(e) => updateField('openrouter_embedding_model', e.target.value)} placeholder="ex: qwen/qwen3-embedding-8b" className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className={fieldClass}>
              <label htmlFor="cloud-or-embedding-dim" className={labelClass}>Dim embedding</label>
              <input id="cloud-or-embedding-dim" type="number" min={1} value={config.openrouter_embedding_dim ?? ''} onChange={(e) => updateField('openrouter_embedding_dim', e.target.value === '' ? null : Number(e.target.value))} placeholder="ex: 4096" className={inputClass} />
            </div>
            <div className={fieldClass}>
              <label htmlFor="cloud-or-embedding-prio" className={labelClass}>Priorite (chaine)</label>
              <input id="cloud-or-embedding-prio" type="number" min={1} value={config.openrouter_embedding_priority ?? 99} onChange={(e) => updateField('openrouter_embedding_priority', Number(e.target.value))} placeholder="99 (essaye apres le local)" className={inputClass} />
            </div>
          </div>
        </fieldset>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
          <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Attribution</legend>
          <div className={fieldClass}>
            <label htmlFor="cloud-or-referer" className={labelClass}>HTTP-Referer</label>
            <input id="cloud-or-referer" value={config.openrouter_http_referer ?? ''} onChange={(e) => updateField('openrouter_http_referer', e.target.value)} placeholder="https://mon-app.example.com" className={inputClass} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="cloud-or-title" className={labelClass}>Titre</label>
            <input id="cloud-or-title" value={config.openrouter_title ?? ''} onChange={(e) => updateField('openrouter_title', e.target.value)} placeholder="Mon application" className={inputClass} />
          </div>
        </fieldset>
      </section>

      {/* Modeles disponibles + mapping */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Modeles OpenRouter</h3>

        <div className="flex flex-col gap-3">
          <button type="button" className="self-start px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 border border-neutral-600" disabled={modelsLoading} onClick={async () => {
            setModelsErr(null); setModelsLoading(true)
            try { const res = await api.getOpenRouterModels(); setModels(Array.isArray(res.data) ? res.data : []); if (res.detail) setModelsErr(res.detail) }
            catch (e) { setModelsErr(e instanceof Error ? e.message : String(e)); setModels([]) }
            finally { setModelsLoading(false) }
          }}>
            {modelsLoading ? 'Chargement...' : 'Recuperer la liste'}
          </button>
          {modelsErr && <p className="text-red-500 text-sm m-0">{modelsErr}</p>}
        </div>

        {models.length > 0 && (
          <>
            <div className="overflow-auto max-h-48 rounded-lg border border-neutral-800 bg-neutral-950">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-neutral-950">
                  <tr>
                    <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 w-10">
                      <input type="checkbox" checked={selectedIds.size === models.length} onChange={(e) => setSelectedIds(e.target.checked ? new Set(models.map(m => m.id)) : new Set())} className="w-4 h-4 rounded border-neutral-600 bg-neutral-900 text-blue-600" />
                    </th>
                    <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">ID</th>
                    <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Nom</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id}>
                      <td className="p-3 border-b border-neutral-800/50">
                        <input type="checkbox" checked={selectedIds.has(m.id)} onChange={(e) => { const next = new Set(selectedIds); if (e.target.checked) next.add(m.id); else next.delete(m.id); setSelectedIds(next) }} className="w-4 h-4 rounded border-neutral-600 bg-neutral-900 text-blue-600" />
                      </td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{m.id}</code></td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{(m as { name?: string }).name ?? m.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="self-start px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50" disabled={selectedIds.size === 0} onClick={async () => {
              const current = config.model_mapping ?? {}
              const next = { ...current }
              selectedIds.forEach((id) => { next[`openrouter/${id}`] = { backend: 'openrouter', backend_model_id: id } })
              updateField('model_mapping', next)
              try { await api.saveConfig({ ...config, model_mapping: next }); refreshConfig(); loadModelMapping(); setSelectedIds(new Set()) }
              catch (e) { setSaveStatus('Erreur mapping : ' + (e instanceof Error ? e.message : String(e))) }
            }}>
              Ajouter la selection au mapping ({selectedIds.size})
            </button>
          </>
        )}

        {/* Mapping actuel */}
        {mappedModels.length > 0 && (
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">En mapping</h4>
            <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Canonique</th>
                    <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">ID</th>
                    <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 w-20 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {mappedModels.map((m) => (
                    <tr key={m.canonical}>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{m.canonical}</code></td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{m.backend_model_id}</code></td>
                      <td className="p-3 border-b border-neutral-800/50 text-right">
                        <button type="button" className="px-2 py-1 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors" onClick={async () => {
                          const next = { ...(config.model_mapping ?? {}) }; delete next[m.canonical]
                          const wasFallback = config.openrouter_fallback_model === m.backend_model_id
                          markDirty()
                          try { const toSave: Config = { ...config, model_mapping: next }; if (wasFallback) toSave.openrouter_fallback_model = ''; await api.saveConfig(toSave); refreshConfig(); loadModelMapping() }
                          catch (e) { setSaveStatus('Erreur suppression : ' + (e instanceof Error ? e.message : String(e))) }
                        }}>Supprimer</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
