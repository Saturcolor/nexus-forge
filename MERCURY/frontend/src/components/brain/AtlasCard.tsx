import { useState, useEffect, useCallback } from 'react'
import { useConfig, useSaveConfigMutation } from '../../api/queries'
import type { Config } from '../../api/admin'

type AtlasHealth = {
  enabled?: boolean
  initialized?: boolean
  current_job?: {
    job_id?: string
    model?: string
    started_at?: number
  } | null
  upstream_error?: string
  configured_brain_url?: string
}

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`

const Lbl = ({ children, title }: { children: React.ReactNode; title?: string }) => (
  <span className="text-neutral-500 uppercase tracking-wider font-medium text-[10px]" title={title}>{children}</span>
)

/**
 * AtlasCard — section "atlas" dans l'onglet Brain.
 *
 * Atlas (extraction de control vectors pour activation steering) est OPT-IN
 * partout : Mercury config `atlas_enabled` + brain-daemon config `atlas.enabled`.
 *
 * Cette card permet :
 * - Toggle on/off du passthrough Mercury (atlas_enabled)
 * - Configuration du brain URL + timeout
 * - Health check live du backend (ping /atlas/health qui via Mercury atteint brain)
 *   → vérifie que le module atlas est chargé côté brain ET que le binaire
 *     `llama-extract-vector` est résoluble.
 * - Display du job en cours s'il y en a un
 *
 * Le frontend appelle `/atlas/health` directement (route publique sur Mercury,
 * pas besoin de double-proxy via /admin/*).
 */
export default function AtlasCard() {
  const { data: config } = useConfig()
  const saveMut = useSaveConfigMutation()

  // Local dirty state (édition formulaire)
  const [atlasEnabled, setAtlasEnabled] = useState<boolean>(false)
  const [brainUrl, setBrainUrl] = useState<string>('')
  const [atlasmindUrl, setAtlasmindUrl] = useState<string>('')
  const [atlasmindApiKey, setAtlasmindApiKey] = useState<string>('')
  const [timeoutSec, setTimeoutSec] = useState<number>(1800)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  // Sync from server (once + à chaque refetch config)
  useEffect(() => {
    if (config && !loaded) {
      setAtlasEnabled(config.atlas_enabled === true)
      setBrainUrl(config.atlas_brain_url ?? 'http://127.0.0.1:4321')
      setAtlasmindUrl(config.atlas_atlasmind_url ?? 'http://127.0.0.1:9300')
      setAtlasmindApiKey(config.atlas_atlasmind_api_key ?? '')
      setTimeoutSec(config.atlas_timeout_sec ?? 1800)
      setLoaded(true)
    }
  }, [config, loaded])

  const markDirty = () => {
    setDirty(true)
    setSaved(false)
  }

  // Health check polling
  const [health, setHealth] = useState<AtlasHealth | null>(null)
  const [healthErr, setHealthErr] = useState<string | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const r = await fetch('/atlas/health')
      const data = (await r.json()) as AtlasHealth
      setHealth(data)
      setHealthErr(null)
    } catch (e) {
      setHealth(null)
      setHealthErr(e instanceof Error ? e.message : String(e))
    } finally {
      setHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const iv = setInterval(fetchHealth, 5000)
    return () => clearInterval(iv)
  }, [fetchHealth])

  const handleSave = () => {
    if (!config) return
    const merged: Config = {
      ...config,
      atlas_enabled: atlasEnabled,
      atlas_brain_url: brainUrl.trim() || undefined,
      atlas_atlasmind_url: atlasmindUrl.trim() || undefined,
      atlas_atlasmind_api_key: atlasmindApiKey.trim() || undefined,
      atlas_timeout_sec: timeoutSec,
    }
    saveMut.mutate(merged, {
      onSuccess: () => {
        setDirty(false)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        // refresh health après changement
        setTimeout(fetchHealth, 500)
      },
    })
  }

  // Status visuel
  const brainUp = !healthErr && !health?.upstream_error
  let statusColor = 'bg-neutral-600'
  let statusLabel = 'Inconnu'
  if (!atlasEnabled) {
    statusColor = 'bg-neutral-600'
    statusLabel = 'Désactivé (Mercury)'
  } else if (!brainUp) {
    statusColor = 'bg-red-500'
    statusLabel = 'Brain inaccessible'
  } else if (!health?.enabled) {
    statusColor = 'bg-amber-500'
    statusLabel = 'Mercury OK · brain désactivé'
  } else if (!health?.initialized) {
    statusColor = 'bg-amber-500'
    statusLabel = 'Init en cours'
  } else if (health?.current_job) {
    statusColor = 'bg-blue-500'
    statusLabel = `Extraction en cours (${health.current_job.job_id ?? '?'})`
  } else {
    statusColor = 'bg-emerald-500'
    statusLabel = 'OK'
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white m-0">Atlas</h2>
          <span className="text-[10px] text-neutral-500">
            extraction de control vectors (activation steering)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${statusColor} ${healthLoading ? 'animate-pulse' : ''}`}
            title={statusLabel}
          />
          <span className="text-xs text-neutral-300">{statusLabel}</span>
          <button
            type="button"
            onClick={fetchHealth}
            className="ml-1 px-1.5 py-0.5 text-xs text-neutral-400 hover:text-white transition-colors"
            title="Rafraîchir health"
          >
            ⟳
          </button>
        </div>
      </div>

      <div className="px-4 py-3 flex flex-col gap-4">
        {/* Toggle Mercury-side */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Lbl>Passthrough Mercury</Lbl>
            <span className="text-xs text-neutral-300">
              Active la route <code className="text-violet-300">/atlas/*</code> sur Mercury (proxy vers brain-daemon).
            </span>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={atlasEnabled}
              onChange={(e) => {
                setAtlasEnabled(e.target.checked)
                markDirty()
              }}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-neutral-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500/40 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>

        {/* Brain URL + AtlasMind URL + timeout (édit seulement si atlas activé) */}
        {atlasEnabled && (
          <div className="grid grid-cols-3 gap-3 border-t border-neutral-800 pt-3">
            <div className="flex flex-col gap-1">
              <Lbl>Brain URL</Lbl>
              <input
                type="text"
                value={brainUrl}
                onChange={(e) => {
                  setBrainUrl(e.target.value)
                  markDirty()
                }}
                placeholder="http://127.0.0.1:4321"
                className="px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Lbl
                title="App AtlasMind (presets cocktail control_vector). Mercury y proxy /atlas/presets et /atlas/mgmt/apply-preset.">
                AtlasMind URL
              </Lbl>
              <input
                type="text"
                value={atlasmindUrl}
                onChange={(e) => {
                  setAtlasmindUrl(e.target.value)
                  markDirty()
                }}
                placeholder="http://127.0.0.1:9300"
                className="px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Lbl>Timeout (sec)</Lbl>
              <input
                type="number"
                min={60}
                max={7200}
                value={timeoutSec}
                onChange={(e) => {
                  setTimeoutSec(Number(e.target.value))
                  markDirty()
                }}
                className="px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {/* AtlasMind API key (optionnel) — affiché seulement si atlas activé */}
        {atlasEnabled && (
          <div className="flex flex-col gap-1">
            <Lbl title="Optionnel — à remplir UNIQUEMENT si AtlasMind a son auth.api_key activée. Vide = pas de Bearer envoyé (AtlasMind ouvert par défaut).">
              AtlasMind API key (optionnel)
            </Lbl>
            <input
              type="password"
              value={atlasmindApiKey}
              onChange={(e) => {
                setAtlasmindApiKey(e.target.value)
                markDirty()
              }}
              placeholder="vide = pas d'auth (default AtlasMind)"
              autoComplete="off"
              className="px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        )}

        {/* Save bar */}
        <div className="flex items-center justify-end gap-3 border-t border-neutral-800 pt-3">
          {dirty && (
            <span className="text-[10px] text-orange-400">
              Modifications non sauvegardées
            </span>
          )}
          {saved && (
            <span className="text-[10px] text-emerald-400">✓ Enregistré</span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!loaded || saveMut.isPending || !dirty}
            className={btnBlue}
          >
            {saveMut.isPending ? '…' : 'Enregistrer'}
          </button>
        </div>

        {/* Backend status detail (quand activé) */}
        {atlasEnabled && (
          <div className="border-t border-neutral-800 pt-3 flex flex-col gap-2">
            <Lbl>Backend brain-daemon</Lbl>

            {healthErr && (
              <div className="text-xs text-red-400">
                ⚠ Mercury → brain : {healthErr}
              </div>
            )}

            {!healthErr && health?.upstream_error && (
              <div className="text-xs text-red-400">
                ⚠ Brain inaccessible : {health.upstream_error}
                {health.configured_brain_url && (
                  <div className="text-[10px] text-neutral-500 mt-0.5">
                    URL configurée : <code>{health.configured_brain_url}</code>
                  </div>
                )}
              </div>
            )}

            {!healthErr && !health?.upstream_error && health && (
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-neutral-500">Module activé</span>
                  <span className="text-xs text-neutral-200">
                    {health.enabled ? (
                      <span className="text-emerald-400">✓ oui</span>
                    ) : (
                      <span className="text-amber-400">
                        ✗ <code className="text-[10px]">atlas.enabled: false</code>
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-neutral-500">Initialisé</span>
                  <span className="text-xs text-neutral-200">
                    {health.initialized ? (
                      <span className="text-emerald-400">✓ oui</span>
                    ) : (
                      <span className="text-neutral-500">—</span>
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-neutral-500">Job en cours</span>
                  <span className="text-xs text-neutral-200">
                    {health.current_job ? (
                      <span
                        className="text-blue-300"
                        title={JSON.stringify(health.current_job)}
                      >
                        ⏵ {health.current_job.job_id}
                      </span>
                    ) : (
                      <span className="text-neutral-500">idle</span>
                    )}
                  </span>
                </div>
              </div>
            )}

            {/* Hint d'install si activé Mercury mais désactivé brain */}
            {!healthErr && !health?.upstream_error && health && health.enabled === false && (
              <div className="mt-1 bg-neutral-950 border border-neutral-800 rounded p-2 text-[10px] text-neutral-400 font-mono overflow-auto">
                <div className="text-neutral-500 mb-1">
                  # Activer côté brain-daemon (/opt/llamacpp-daemon/config.yaml)
                </div>
                <pre className="m-0 whitespace-pre-wrap">{`atlas:
  enabled: true
  output_dir: /var/lib/atlas/vectors
  extractor_binary: /opt/llamacpp-atlas/build/bin/llama-extract-vector
  default_ngl: 99
  default_threads: 8
  cleanup_temp_files: true
  serialize_extractions: true`}</pre>
                <div className="text-neutral-500 mt-2">
                  # Puis : sudo systemctl restart brain-daemon
                </div>
              </div>
            )}
          </div>
        )}

        {!atlasEnabled && (
          <div className="text-[11px] text-neutral-500 border-t border-neutral-800 pt-3">
            Atlas n'est utile que si tu veux extraire des control vectors pour l'activation steering.
            Active le passthrough ci-dessus puis configure le backend côté brain-daemon.
            Voir <code className="text-neutral-400">BRAIN-DAEMON/atlas/README.md</code>.
          </div>
        )}
      </div>
    </section>
  )
}
