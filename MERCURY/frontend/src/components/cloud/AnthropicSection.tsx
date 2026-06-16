import { useState } from 'react'
import type { Config, ModelMappingResponse, AnthropicModelEntry } from '../../api/admin'
import * as api from '../../api/admin'

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'
const fieldClass = 'flex flex-col gap-1.5'

function Checkbox({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; children?: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 cursor-pointer">
      <input id={id} type="checkbox" checked={checked} onChange={onChange} className="mt-0.5 w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:ring-offset-neutral-900" />
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

export default function AnthropicSection({ config, updateField, markDirty, modelMapping, refreshConfig, loadModelMapping, setSaveStatus }: Props) {
  const [accessToken, setAccessToken] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [credSaveStatus, setCredSaveStatus] = useState<string | null>(null)
  const [credSaving, setCredSaving] = useState(false)
  const [models, setModels] = useState<AnthropicModelEntry[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsErr, setModelsErr] = useState<string | null>(null)

  const credentialsSet = config.anthropic_credentials_set === true
  const mappedModels = (modelMapping?.from_config ?? [])
    .filter((r) => r.backend === 'anthropic')
    .map((r) => ({ canonical: r.canonical, backend_model_id: r.backend_model_id }))

  const handleSaveCredentials = async () => {
    const token = accessToken.trim()
    if (!token) { setCredSaveStatus('Erreur : access token requis.'); return }
    setCredSaving(true); setCredSaveStatus(null)
    try {
      const res = await api.setAnthropicCredentials({ access_token: token, refresh_token: refreshToken.trim() || undefined })
      if (res.ok) { setCredSaveStatus('Credentials enregistres.'); setAccessToken(''); setRefreshToken(''); refreshConfig() }
      else { setCredSaveStatus('Erreur : ' + (res.detail ?? 'inconnue')) }
    } catch (e) { setCredSaveStatus('Erreur : ' + (e instanceof Error ? e.message : String(e))) }
    finally { setCredSaving(false) }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {/* Config + Credentials */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-6">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-800 pb-2">
          <h3 className="text-lg font-semibold text-white m-0">Anthropic (OAuth)</h3>
          <span className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider border ${credentialsSet ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-neutral-700/40 text-neutral-400 border-neutral-700'}`}>
            {credentialsSet ? 'Credentials OK' : 'Non configure'}
          </span>
        </div>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
          <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Provider</legend>
          <Checkbox id="cloud-anthropic-enabled" checked={config.anthropic_enabled === true} onChange={(e) => updateField('anthropic_enabled', e.target.checked)}>
            Active (compte Max via OAuth)
          </Checkbox>
          <div className={fieldClass}>
            <label htmlFor="cloud-anthropic-cred-file" className={labelClass}>Fichier credentials</label>
            <input id="cloud-anthropic-cred-file" value={config.anthropic_credentials_file ?? ''} onChange={(e) => updateField('anthropic_credentials_file', e.target.value)} placeholder="~/.claude/.credentials.json (par defaut)" className={inputClass} />
          </div>
        </fieldset>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
          <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Tokens OAuth</legend>
          <div className={fieldClass}>
            <label htmlFor="cloud-anthropic-access" className={labelClass}>Access Token</label>
            <input id="cloud-anthropic-access" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="sk-ant-oat01-..." autoComplete="off" className={inputClass} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="cloud-anthropic-refresh" className={labelClass}>Refresh Token <span className="text-neutral-500 font-normal">(optionnel)</span></label>
            <input id="cloud-anthropic-refresh" type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="claudeAiOauth.refreshToken" autoComplete="off" className={inputClass} />
          </div>
          <div className="flex items-center gap-4">
            <button type="button" className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 border border-neutral-600" disabled={credSaving || !accessToken.trim()} onClick={handleSaveCredentials}>
              {credSaving ? 'Enregistrement...' : 'Enregistrer les credentials'}
            </button>
            {credSaveStatus && <span className={`text-sm font-medium ${credSaveStatus.startsWith('Erreur') ? 'text-red-400' : 'text-emerald-400'}`}>{credSaveStatus}</span>}
          </div>
        </fieldset>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
          <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Modeles</legend>
          <div className={fieldClass}>
            <label htmlFor="cloud-anthropic-fallback" className={labelClass}>Modele de fallback</label>
            <select id="cloud-anthropic-fallback" value={config.anthropic_fallback_model ?? ''} onChange={(e) => updateField('anthropic_fallback_model', e.target.value)} className={inputClass + ' cursor-pointer'}>
              <option value="">— Aucun —</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
              {config.anthropic_fallback_model && !models.find((m) => m.id === config.anthropic_fallback_model) && <option value={config.anthropic_fallback_model}>{config.anthropic_fallback_model}</option>}
            </select>
          </div>
          <div className={fieldClass}>
            <label htmlFor="cloud-anthropic-reasoning" className={labelClass}>Modele raisonnement etendu</label>
            <select id="cloud-anthropic-reasoning" value={config.anthropic_reasoning_model ?? ''} onChange={(e) => updateField('anthropic_reasoning_model', e.target.value)} className={inputClass + ' cursor-pointer'}>
              <option value="">— Aucun —</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
              {config.anthropic_reasoning_model && !models.find((m) => m.id === config.anthropic_reasoning_model) && <option value={config.anthropic_reasoning_model}>{config.anthropic_reasoning_model}</option>}
            </select>
          </div>
        </fieldset>
      </section>

      {/* Modeles disponibles + mapping */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Modeles Anthropic</h3>

        <div className="flex flex-col gap-3">
          <button type="button" className="self-start px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 border border-neutral-600" disabled={modelsLoading} onClick={async () => {
            setModelsErr(null); setModelsLoading(true)
            try { const res = await api.getAnthropicModels(); setModels(Array.isArray(res.models) ? res.models : []); if (res.detail) setModelsErr(res.detail) }
            catch (e) { setModelsErr(e instanceof Error ? e.message : String(e)); setModels([]) }
            finally { setModelsLoading(false) }
          }}>
            {modelsLoading ? 'Chargement...' : 'Charger les modeles'}
          </button>
          {modelsErr && <p className="text-red-500 text-sm m-0">{modelsErr}</p>}
        </div>

        {models.length > 0 && (
          <div className="overflow-auto max-h-48 rounded-lg border border-neutral-800 bg-neutral-950">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-neutral-950">
                <tr>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">ID</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Nom</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 w-28 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id}>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{m.id}</code></td>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{m.name ?? m.id}</td>
                    <td className="p-3 border-b border-neutral-800/50 text-right">
                      <button type="button" className="px-2 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded transition-colors" onClick={() => updateField('anthropic_fallback_model', m.id)}>
                        Selectionner
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                          const next = { ...(config.model_mapping ?? {}) }; delete next[m.canonical]; markDirty()
                          try { await api.saveConfig({ ...config, model_mapping: next }); refreshConfig(); loadModelMapping() }
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

        {/* Ajout rapide depuis les modeles charges */}
        {models.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {models.filter((m) => !mappedModels.find((am) => am.backend_model_id === m.id)).map((m) => {
              const canonical = `anthropic/${m.id}`
              return (
                <button key={m.id} type="button" className="px-3 py-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/15 rounded border border-blue-500/20 hover:border-blue-500/40 transition-colors" onClick={async () => {
                  const next = { ...(config.model_mapping ?? {}), [canonical]: { backend: 'anthropic', backend_model_id: m.id } }
                  updateField('model_mapping', next)
                  try { await api.saveConfig({ ...config, model_mapping: next }); refreshConfig(); loadModelMapping() }
                  catch (e) { setSaveStatus('Erreur mapping : ' + (e instanceof Error ? e.message : String(e))) }
                }}>
                  + {m.name ?? m.id}
                </button>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
