import { useState, useCallback, useEffect } from 'react'
import { useConfig, useSaveConfigMutation } from '../api/queries'
import * as api from '../api/admin'
import type { Config, CreditsReport } from '../api/admin'
import { formatCreditValue, getProviderDisplayData } from '../utils/credits'
import Spinner from './Spinner'

const PROVIDERS = ['openrouter', 'openai', 'anthropic', 'elevenlabs'] as const
const CREDITS_KEY_NAMES: { id: (typeof PROVIDERS)[number]; label: string; keyName: 'openrouter_key' | 'openai_key' | 'anthropic_key' | 'elevenlabs_key'; keySetKey: 'openrouter_key_set' | 'openai_key_set' | 'anthropic_key_set' | 'elevenlabs_key_set' }[] = [
  { id: 'openrouter', label: 'OpenRouter', keyName: 'openrouter_key', keySetKey: 'openrouter_key_set' },
  { id: 'openai', label: 'OpenAI', keyName: 'openai_key', keySetKey: 'openai_key_set' },
  { id: 'anthropic', label: 'Anthropic', keyName: 'anthropic_key', keySetKey: 'anthropic_key_set' },
  { id: 'elevenlabs', label: 'ElevenLabs', keyName: 'elevenlabs_key', keySetKey: 'elevenlabs_key_set' },
]

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

export default function CreditsPanel() {
  const { data: config } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()

  const initialProviders = config?.credits?.providers_preferred && config.credits.providers_preferred.length
    ? config.credits.providers_preferred
    : (config?.credits?.providers_configured && config.credits.providers_configured.length
        ? config.credits.providers_configured
        : [...PROVIDERS])

  const [creditProviders, setCreditProviders] = useState<string[]>([])
  
  useEffect(() => {
    if (creditProviders.length === 0 && initialProviders.length > 0) {
      setCreditProviders(initialProviders)
    }
  }, [initialProviders])

  const [creditTimeout, setCreditTimeout] = useState(30000)
  const [creditsReport, setCreditsReport] = useState<CreditsReport | null>(null)
  const [creditsErr, setCreditsErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [keysModalOpen, setKeysModalOpen] = useState(false)
  const [keysInputs, setKeysInputs] = useState<Record<string, string>>({ openrouter_key: '', openai_key: '', anthropic_key: '', elevenlabs_key: '' })
  const [keysSaveStatus, setKeysSaveStatus] = useState<string | null>(null)

  const refreshCredits = useCallback(async () => {
    if (!config?.credits?.enabled) {
      setCreditsErr('Crédits désactivés dans la configuration')
      return
    }
    try {
      setCreditsErr(null)
      setLoading(true)
      if (config) {
        const updated: Config = {
          ...config,
          credits: {
            ...config.credits,
            providers_preferred: creditProviders,
          },
        }
        saveConfigMutation.mutate(updated)
      }
      setCreditsReport(await api.getCredits(creditProviders.length ? creditProviders : undefined, creditTimeout))
    } catch (e) {
      setCreditsErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [config?.credits?.enabled, creditProviders, creditTimeout, config, saveConfigMutation])

  const toggleProvider = (id: string) => {
    setCreditProviders(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id])
  }

  const configSection = (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6" aria-label="Configuration crédits">
      <h2 className="text-lg font-semibold text-white mb-4">Configuration</h2>
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-wrap gap-4 min-w-0">
          <legend className="text-sm font-semibold text-neutral-300 uppercase tracking-wider mb-2 block w-full">Fournisseurs</legend>
          {PROVIDERS.map(id => (
            <label key={id} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={creditProviders.includes(id)}
                onChange={() => toggleProvider(id)}
                className="w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:ring-offset-neutral-900"
              />
              <span className="text-sm font-medium text-neutral-200">{id.charAt(0).toUpperCase() + id.slice(1)}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-4">
          <button
            type="button"
            className="px-4 py-2 bg-neutral-600 hover:bg-neutral-500 text-white text-sm font-medium rounded-md transition-colors border border-neutral-500 self-end"
            onClick={() => { setKeysModalOpen(true); setKeysInputs({ openrouter_key: '', openai_key: '', anthropic_key: '', elevenlabs_key: '' }); setKeysSaveStatus(null) }}
          >
            Configurer les clés API
          </button>
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="openbill-timeout" className="text-sm font-medium text-neutral-300">Timeout (ms)</label>
              <input
                id="openbill-timeout"
                type="number"
                value={creditTimeout}
                min={5000}
                max={120000}
                step={5000}
                className="w-28 px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white"
                onChange={e => setCreditTimeout(Number(e.target.value))}
              />
            </div>
            <button
              type="button"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              onClick={refreshCredits}
              disabled={loading}
            >
              Rafraîchir
            </button>
          </div>
        </div>
      </div>
    </section>
  )

  return (
    <div className="flex flex-col gap-6">
      {!config?.credits?.enabled ? (
        <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
          <p className="text-neutral-400 text-sm mb-4">Activez « Crédits (OpenBill) » dans Configuration, enregistrez, puis configurez les clés ci-dessous.</p>
          <button
            type="button"
            className="px-4 py-2 bg-neutral-600 hover:bg-neutral-500 text-white text-sm font-medium rounded-md transition-colors border border-neutral-500"
            onClick={() => { setKeysModalOpen(true); setKeysInputs({ openrouter_key: '', openai_key: '', anthropic_key: '', elevenlabs_key: '' }); setKeysSaveStatus(null) }}
          >
            Configurer les clés API
          </button>
        </section>
      ) : (
        configSection
      )}

      {/* Modal clés API des providers */}
      {keysModalOpen && config && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-labelledby="keys-modal-title"
          onClick={() => setKeysModalOpen(false)}
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-xl max-w-md w-full p-6 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
            <h3 id="keys-modal-title" className="text-lg font-semibold text-white m-0">Clés API des providers</h3>
            <p className="text-sm text-neutral-400 m-0">Modifier les clés utilisées pour récupérer les crédits. Laisser vide pour ne pas modifier une clé existante.</p>
            <div className="flex flex-col gap-3">
              {CREDITS_KEY_NAMES.map(({ label, keyName, keySetKey }) => (
                <div key={keyName} className="flex flex-col gap-1">
                  <label htmlFor={`keys-${keyName}`} className="text-sm font-medium text-neutral-300">{label}</label>
                  <input
                    id={`keys-${keyName}`}
                    type="password"
                    value={keysInputs[keyName] ?? ''}
                    onChange={e => setKeysInputs(prev => ({ ...prev, [keyName]: e.target.value }))}
                    placeholder={config?.credits?.[keySetKey] ? '•••••••• (vide = ne pas modifier)' : 'Saisir la clé API'}
                    autoComplete="off"
                    className="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500"
                  />
                </div>
              ))}
            </div>
            {keysSaveStatus && (
              <p className={`text-sm m-0 ${keysSaveStatus.startsWith('Erreur') ? 'text-red-400' : 'text-emerald-400'}`}>{keysSaveStatus}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white text-sm font-medium rounded-md transition-colors"
                onClick={() => setKeysModalOpen(false)}
              >
                Annuler
              </button>
              <button
                type="button"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
                disabled={saveConfigMutation.isPending}
                onClick={async () => {
                  setKeysSaveStatus(null)
                  try {
                    const credits: Config['credits'] = {
                      ...config.credits,
                      enabled: config.credits?.enabled,
                      timeout_ms: config.credits?.timeout_ms ?? 30000,
                      providers_preferred: creditProviders.length ? creditProviders : config.credits?.providers_preferred,
                    }
                    if ((keysInputs.openrouter_key ?? '').trim()) credits.openrouter_key = keysInputs.openrouter_key!.trim()
                    if ((keysInputs.openai_key ?? '').trim()) credits.openai_key = keysInputs.openai_key!.trim()
                    if ((keysInputs.anthropic_key ?? '').trim()) credits.anthropic_key = keysInputs.anthropic_key!.trim()
                    if ((keysInputs.elevenlabs_key ?? '').trim()) credits.elevenlabs_key = keysInputs.elevenlabs_key!.trim()
                    await saveConfigMutation.mutateAsync({ ...config, credits })
                    setKeysSaveStatus('Enregistré.')
                    setTimeout(() => { setKeysModalOpen(false); setKeysSaveStatus(null) }, 1200)
                  } catch (e) {
                    setKeysSaveStatus('Erreur : ' + (e instanceof Error ? e.message : String(e)))
                  }
                }}
              >
                {saveConfigMutation.isPending ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {config?.credits?.enabled && (
        <>
          {loading && <Spinner text="Récupération des crédits…" />}
          {creditsErr && (
            <p className="text-red-500 text-sm px-1">{creditsErr}</p>
          )}

          {/* Meta */}
          {(creditsReport?.fetchedAt || (creditsReport?.errors?.length ?? 0) > 0) && (
        <div className="flex flex-col gap-1" aria-live="polite">
          {creditsReport?.fetchedAt && (
            <p className="text-xs text-neutral-500">
              Dernière récupération : {formatDateTime(creditsReport.fetchedAt)}
            </p>
          )}
          {creditsReport?.errors?.length ? (
            <ul className="text-red-500 text-sm list-disc list-inside">
              {creditsReport.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          ) : null}
        </div>
      )}

      {creditsReport && (
        <>
          {/* Total en cours */}
          <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6" aria-label="Total en cours">
            <h2 className="text-lg font-semibold text-white mb-4">Total en cours</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              <div className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                <span className="text-2xl font-bold text-white mb-1">
                  {formatCreditValue(
                    ['openrouter', 'openai', 'anthropic'].reduce((sum, id) => { const p = creditsReport.providers?.[id]; return p?.ok && typeof p.remaining === 'number' ? sum + p.remaining : sum }, 0 as number),
                    true
                  )}
                </span>
                <span className="text-xs text-neutral-400 uppercase tracking-wider font-medium">Restant USD (total)</span>
              </div>
              {PROVIDERS.map(id => {
                const p = creditsReport.providers?.[id]
                const val = p?.ok && typeof p.remaining === 'number' ? p.remaining : null
                const isChars = id === 'elevenlabs'
                return (
                  <div key={id} className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                    <span className="text-xl font-bold text-neutral-200 mb-1">{isChars ? (val != null ? String(val).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' car.' : '–') : formatCreditValue(val, true)}</span>
                    <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Restant ({id.charAt(0).toUpperCase() + id.slice(1)})</span>
                  </div>
                )
              })}
            </div>
          </section>

          {/* Tuiles par fournisseur */}
          <section aria-label="Récapitulatif par fournisseur">
            <h2 className="text-lg font-semibold text-white mb-4">Récapitulatif par fournisseur</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
              {PROVIDERS.map(id => {
                const display = getProviderDisplayData(id, creditsReport.providers?.[id])
                const isOk = display.statusClass === 'ok'
                const isNonDemande = display.statusText === 'Non demandé'
                return (
                  <div
                    key={id}
                    className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-4"
                    data-provider={id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-base font-semibold text-white m-0">{display.name}</h3>
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium ${
                          isOk
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : isNonDemande
                              ? 'bg-neutral-700/50 text-neutral-400 border border-neutral-600'
                              : 'bg-red-500/20 text-red-400 border border-red-500/30'
                        }`}
                      >
                        {display.statusText}
                      </span>
                    </div>
                    <div className="flex flex-col gap-3 text-sm">
                      {display.restant != null && (
                        <div className="flex justify-between items-baseline gap-2">
                          <span className="text-neutral-400">{display.restantLabel}</span>
                          <span className="font-semibold text-white tabular-nums">{formatCreditValue(display.restant)}</span>
                        </div>
                      )}
                      {display.depense30j != null && (
                        <div className="flex justify-between items-baseline gap-2">
                          <span className="text-neutral-400">{display.depense30jLabel}</span>
                          <span className="text-neutral-200 tabular-nums">{formatCreditValue(display.depense30j, true)}</span>
                        </div>
                      )}
                      {display.details.map((d, i) => (
                        <div key={i} className="flex justify-between items-baseline gap-2">
                          <span className="text-neutral-400">{d.label}</span>
                          <span className="text-neutral-200 tabular-nums">{d.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
      </>
      )}
    </div>
  )
}
