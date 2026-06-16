import type { Config } from '../../api/admin'

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'
const fieldClass = 'flex flex-col gap-1.5'

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  onSave: () => void
  saveStatus: string | null
  saving: boolean
}

export default function FallbackSettingsSection({ config, updateField, onSave, saveStatus, saving }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-4">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Resilience</h3>
        <div className={fieldClass}>
          <label htmlFor="cloud-max-retry" className={labelClass}>Tentatives fallback</label>
          <input
            id="cloud-max-retry"
            type="number"
            value={config.max_retry_on_fallback ?? 1}
            min={1}
            max={5}
            className={inputClass}
            onChange={e => updateField('max_retry_on_fallback', Number(e.target.value))}
            title="Nombre de tentatives sur le provider cloud fallback avant abandon"
          />
          <p className="text-xs text-neutral-500">Nombre de retry si le fallback cloud echoue (1 = pas de retry).</p>
        </div>
        <p className="text-xs text-neutral-500 m-0">L'ordre des providers cloud est configurable dans la card Priorite des providers (Dashboard).</p>
      </section>

      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-white m-0">Enregistrer</h3>
            <p className="text-sm text-neutral-400 mt-1 m-0">Enregistre les options des providers cloud.</p>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            {saveStatus && <span className={`text-sm font-medium ${saveStatus.startsWith('Erreur') ? 'text-red-400' : 'text-emerald-400'}`}>{saveStatus}</span>}
            <button
              type="button"
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-neutral-900 disabled:opacity-50"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? 'Enregistrement...' : 'Enregistrer'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
