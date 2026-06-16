import { useMemo, useState } from 'react'
import type { Config, AudioVoicesModelEntry } from '../../api/admin'
import * as api from '../../api/admin'

const labelClass = 'text-sm font-medium text-neutral-300'

function Checkbox({
  id,
  checked,
  disabled,
  onChange,
  children,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  children?: React.ReactNode
}) {
  return (
    <label htmlFor={id} className={`flex items-start gap-3 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:ring-offset-neutral-900"
      />
      {children && <span className="text-sm text-neutral-200">{children}</span>}
    </label>
  )
}

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
}

export default function RealtimeSection({ config, updateField }: Props) {
  const [copied, setCopied] = useState(false)
  const [models, setModels] = useState<AudioVoicesModelEntry[] | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsErr, setModelsErr] = useState<string | null>(null)

  const keyConfigured = config.audio_openai_api_key_set === true
  const enabled = config.realtime_enabled === true

  const endpoint = useMemo(() => {
    if (typeof window === 'undefined') return '/v1/realtime?model=<model>'
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/v1/realtime?model=<model>`
  }, [])

  const handleCopy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    navigator.clipboard.writeText(endpoint).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleDiscover = async () => {
    setModelsErr(null)
    setModelsLoading(true)
    try {
      const res = await api.getAudioVoices()
      setModels(res.realtime_models ?? [])
    } catch (e) {
      setModelsErr(e instanceof Error ? e.message : String(e))
      setModels(null)
    } finally {
      setModelsLoading(false)
    }
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-5">
      <div className="flex items-center gap-3 border-b border-neutral-800 pb-2">
        <h3 className="text-lg font-semibold text-white m-0">Realtime API</h3>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-800/50 uppercase tracking-wider">
          WebSocket
        </span>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-900/30 text-amber-300 border border-amber-800/40 uppercase tracking-wider">
          Premium
        </span>
      </div>
      <p className="text-xs text-neutral-500 m-0">
        Proxy WebSocket bidirectionnel transparent vers <span className="text-neutral-400 font-mono">wss://api.openai.com/v1/realtime</span>.
        Mode "Realtime ☁️" de NCM Interpreter. STT + traduction + TTS dans un seul flux audio bidir (latence minimale).
        Tarif indicatif : ~$0.06/min audio entrant, ~$0.24/min audio sortant.
      </p>

      {/* Clé OpenAI status (gérée dans Audio Section) */}
      <div className="flex items-center gap-2 text-sm">
        <span className={labelClass}>Clé OpenAI :</span>
        {keyConfigured ? (
          <span className="text-green-400 text-sm">✓ configurée</span>
        ) : (
          <span className="text-red-400 text-sm">✗ manquante</span>
        )}
        <span className="text-xs text-neutral-500">(gérée dans la section Audio ci-dessus)</span>
      </div>

      {/* Toggle */}
      <Checkbox
        id="realtime-enabled"
        checked={enabled}
        disabled={!keyConfigured}
        onChange={(e) => updateField('realtime_enabled', e.target.checked)}
      >
        Activer le proxy Realtime
        {!keyConfigured && (
          <span className="block text-xs text-neutral-500 mt-0.5">
            Activez d'abord OpenAI Audio et configurez la clé API ci-dessus.
          </span>
        )}
      </Checkbox>

      {/* Endpoint info (read-only, copiable) */}
      <div className="flex flex-col gap-1.5">
        <label className={labelClass}>Endpoint exposé</label>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-md text-xs font-mono text-neutral-300 overflow-x-auto">
            {endpoint}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="px-3 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-xs font-medium rounded-md transition-colors border border-neutral-600 whitespace-nowrap"
          >
            {copied ? 'Copié ✓' : 'Copier'}
          </button>
        </div>
        <p className="text-xs text-neutral-500 m-0">
          Auth client : <span className="font-mono">Authorization: Bearer &lt;mercury-api-key&gt;</span>. Mercury injecte sa propre clé OpenAI vers l'upstream.
        </p>
        <p className="text-[11px] text-neutral-600 m-0">
          ⓘ L'URL ci-dessus est dérivée de l'hôte du dashboard. Si Mercury est exposé sur un autre host/port que cette page admin, ajustez côté client.
        </p>
      </div>

      {/* Modèles Realtime exposés à NCM (via /api/voices) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className={labelClass}>Modèles Realtime exposés à NCM</label>
          <button
            type="button"
            disabled={!keyConfigured || modelsLoading}
            onClick={handleDiscover}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-md transition-colors border border-neutral-600"
          >
            {modelsLoading ? 'Chargement…' : 'Découvrir'}
          </button>
        </div>
        {modelsErr && <p className="text-red-500 text-xs m-0">{modelsErr}</p>}
        {models && models.length > 0 && (
          <div className="overflow-auto max-h-56 rounded-lg border border-neutral-800 bg-neutral-950">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-neutral-950">
                <tr>
                  <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Model</th>
                  <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Provider</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name}>
                    <td className="p-2 border-b border-neutral-800/50 font-mono text-neutral-200">{m.name}</td>
                    <td className="p-2 border-b border-neutral-800/50 text-neutral-400">{m.provider}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {models && models.length === 0 && !modelsErr && (
          <p className="text-xs text-neutral-500 m-0">Aucun modèle realtime retourné — vérifier la clé OpenAI.</p>
        )}
        <p className="text-[11px] text-neutral-600 m-0">
          Source : <span className="font-mono">GET /api/voices</span> (même endpoint que NCM consomme). Filtre GA-only : les modèles <span className="font-mono">gpt-4o-realtime-preview-*</span> nécessitent l'endpoint beta, non routé par Mercury.
        </p>
      </div>

      {/* Status pill */}
      <div className="flex items-center gap-2 text-xs">
        <span className={labelClass}>Statut :</span>
        {!keyConfigured ? (
          <span className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700">Bloqué — clé manquante</span>
        ) : enabled ? (
          <span className="px-2 py-0.5 rounded bg-green-900/40 text-green-300 border border-green-800/50">Actif</span>
        ) : (
          <span className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700">Inactif</span>
        )}
      </div>
    </section>
  )
}
