import { useConfig, useBackends, useLmStudioProbe, useOllamaProbe, useLlamacppDaemonVersion, useSetProviderPriorityMutation, useSaveConfigMutation, useSetCloudFallbackOrderMutation } from '../../api/queries'
import type { BackendStatus } from '../../api/admin'
import Spinner from '../Spinner'

const CLOUD_PROVIDER_NAMES = new Set(['openrouter', 'anthropic'])

export default function BackendsCard() {
  const { data: config } = useConfig()
  const { data: backends, error: backendsErr, isLoading: backendsLoading, refetch: refreshBackends } = useBackends()
  const probeEnabled = Boolean((config?.lm_studio_probe_url ?? '').trim())
  const { data: probeStatus } = useLmStudioProbe(probeEnabled)
  const probeOk = probeEnabled && probeStatus?.configured === true && !probeStatus?.error
  const ollamaProbeEnabled = Boolean((config?.ollama_probe_url ?? '').trim())
  const { data: ollamaProbeStatus } = useOllamaProbe(ollamaProbeEnabled)
  const ollamaProbeOk = ollamaProbeEnabled && ollamaProbeStatus?.configured === true && !ollamaProbeStatus?.error
  const llamacppDaemonEnabled = config?.llamacpp_enabled !== false && Boolean((config?.llamacpp_url ?? '').trim())
  const { data: llamacppDaemonVersion } = useLlamacppDaemonVersion(llamacppDaemonEnabled)
  const setProviderPriorityMutation = useSetProviderPriorityMutation()
  const saveConfigMutation = useSaveConfigMutation()
  const setCloudFallbackOrderMutation = useSetCloudFallbackOrderMutation()

  const fallbackForce = config?.openrouter_fallback_force === true
  const openrouterEnabled = config?.openrouter_enabled === true
  const anthropicEnabled = config?.anthropic_enabled === true
  const cloudOrder: string[] = Array.isArray(config?.fallback_providers_order) ? config.fallback_providers_order : ['openrouter', 'anthropic']
  const autoPriorityEnabled = config?.auto_priority_enabled !== false

  const localBackends = (backends ?? []).filter((b) => !CLOUD_PROVIDER_NAMES.has(b.name))
  const sortedLocal = [...localBackends].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))

  const handleLocalMove = (backend: BackendStatus, direction: 'up' | 'down') => {
    if (setProviderPriorityMutation.isPending) return
    const idx = sortedLocal.findIndex((b) => b.name === backend.name)
    if (idx < 0) return
    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= sortedLocal.length) return
    const next = [...sortedLocal]
    next.splice(idx, 1)
    next.splice(newIdx, 0, backend)
    setProviderPriorityMutation.mutate(next.map((b) => b.name))
  }

  const handleCloudMove = (provider: string, direction: 'up' | 'down') => {
    if (setCloudFallbackOrderMutation.isPending) return
    const current = [...cloudOrder]
    const idx = current.indexOf(provider)
    if (idx < 0) return
    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= current.length) return
    current.splice(idx, 1)
    current.splice(newIdx, 0, provider)
    setCloudFallbackOrderMutation.mutate(current)
  }

  const handleFallbackSwitch = () => {
    if (!config || saveConfigMutation.isPending) return
    saveConfigMutation.mutate({ ...config, openrouter_fallback_force: !fallbackForce })
  }

  const handlePriorityModeSwitch = () => {
    if (!config || saveConfigMutation.isPending) return
    saveConfigMutation.mutate({ ...config, auto_priority_enabled: !autoPriorityEnabled })
  }

  const activeCloud = cloudOrder.filter(
    (p) => (p === 'openrouter' && openrouterEnabled) || (p === 'anthropic' && anthropicEnabled)
  )

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col min-h-0 h-full">
      {/* Header */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-6 py-4 border-b border-neutral-800">
        <div>
          <h2 className="text-lg font-semibold text-white m-0">Priorité des providers</h2>
          <p className="text-xs text-neutral-500 mt-0.5 m-0">Ordre de sollicitation des backends locaux</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-neutral-300 font-medium">Mode priorité</span>
              <div className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={autoPriorityEnabled} disabled={saveConfigMutation.isPending} onChange={handlePriorityModeSwitch} />
                <div className="w-9 h-5 bg-neutral-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-neutral-300 font-medium">Fallback</span>
              <div className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={fallbackForce} disabled={saveConfigMutation.isPending || !openrouterEnabled} onChange={handleFallbackSwitch} />
                <div className="w-9 h-5 bg-neutral-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </div>
            </label>
          </div>
          <button type="button" className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors" onClick={() => refreshBackends()}>
            Rafraîchir
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-6">
        {backendsLoading && <Spinner />}
        {backendsErr && <p className="text-red-500 text-sm mb-4">{backendsErr instanceof Error ? backendsErr.message : String(backendsErr)}</p>}
        {backends && (
          <div className="flex flex-col gap-4">

            {/* ── Backends locaux ── */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider px-1">Backends locaux (priorité)</p>
              {fallbackForce && openrouterEnabled && (
                <p className="text-xs text-orange-400/80 px-1">Mode forcé actif — requêtes routées vers OpenRouter.</p>
              )}
              {sortedLocal.length === 0 ? (
                <p className="text-xs text-neutral-600 px-1">Aucun backend local configuré.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {sortedLocal.map((b, idx) => (
                    <li key={b.name} className="flex items-center gap-2 p-3 bg-neutral-950 border border-neutral-800 rounded-lg relative overflow-hidden">
                      <span className={`w-1 h-full absolute left-0 top-0 ${b.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`} aria-hidden />

                      {/* ▲▼ */}
                      {sortedLocal.length >= 2 && (
                        <div className="flex flex-col gap-0.5 shrink-0">
                          <button type="button" disabled={idx === 0 || setProviderPriorityMutation.isPending} onClick={() => handleLocalMove(b, 'up')}
                            className="text-neutral-500 hover:text-white disabled:opacity-20 disabled:cursor-default text-xs leading-none" aria-label={`Monter ${b.name}`}>▲</button>
                          <button type="button" disabled={idx === sortedLocal.length - 1 || setProviderPriorityMutation.isPending} onClick={() => handleLocalMove(b, 'down')}
                            className="text-neutral-500 hover:text-white disabled:opacity-20 disabled:cursor-default text-xs leading-none" aria-label={`Descendre ${b.name}`}>▼</button>
                        </div>
                      )}

                      <div className="flex flex-col flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-semibold text-neutral-500 uppercase w-4 shrink-0">{idx + 1}</span>
                          <strong className="font-medium text-white">{b.name}</strong>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${b.status === 'up' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>{b.status}</span>
                          {b.name === 'lm_studio' && probeEnabled && (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${probeOk ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-neutral-600/30 text-neutral-400 border border-neutral-600/50'}`}
                              title={probeOk ? 'La probe répond (health OK)' : probeStatus?.error ?? 'Probe non configurée'}>
                              Probe {probeOk ? 'OK' : '—'}
                            </span>
                          )}
                          {b.name === 'ollama' && ollamaProbeEnabled && (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ollamaProbeOk ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-neutral-600/30 text-neutral-400 border border-neutral-600/50'}`}
                              title={ollamaProbeOk ? 'La probe répond (health OK)' : ollamaProbeStatus?.error ?? 'Probe non configurée'}>
                              Probe {ollamaProbeOk ? 'OK' : '—'}
                            </span>
                          )}
                          {b.name === 'llamacpp' && llamacppDaemonEnabled && (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${llamacppDaemonVersion?.version ? 'bg-sky-500/15 text-sky-300 border border-sky-500/25' : 'bg-neutral-600/30 text-neutral-400 border border-neutral-600/50'}`}
                              title={llamacppDaemonVersion?.version ? 'Version llamacpp-daemon' : llamacppDaemonVersion?.error ?? 'Daemon indisponible'}>
                              daemon {llamacppDaemonVersion?.version ? `v${llamacppDaemonVersion.version}` : '—'}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-neutral-500 truncate mt-0.5" title={b.url}>{b.url}</span>
                        {b.error && <span className="text-xs text-red-400 mt-0.5">{b.error}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── Fallback cloud ── */}
            {activeCloud.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="border-t border-neutral-800/60" />
                <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider px-1">Fallback cloud (ordre)</p>
                <ul className="flex flex-col gap-2">
                  {activeCloud.map((provider, idx) => (
                    <li key={provider} className="flex items-center gap-2 p-3 bg-neutral-950 border border-neutral-800 rounded-lg relative overflow-hidden">
                      <span className={`w-1 h-full absolute left-0 top-0 ${provider === 'openrouter' ? 'bg-sky-500/60' : 'bg-orange-500/60'}`} aria-hidden />
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button type="button" disabled={idx === 0 || setCloudFallbackOrderMutation.isPending} onClick={() => handleCloudMove(provider, 'up')}
                          className="text-neutral-500 hover:text-white disabled:opacity-20 disabled:cursor-default text-xs leading-none" aria-label={`Monter ${provider}`}>▲</button>
                        <button type="button" disabled={idx === activeCloud.length - 1 || setCloudFallbackOrderMutation.isPending} onClick={() => handleCloudMove(provider, 'down')}
                          className="text-neutral-500 hover:text-white disabled:opacity-20 disabled:cursor-default text-xs leading-none" aria-label={`Descendre ${provider}`}>▼</button>
                      </div>
                      <div className="flex flex-col flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-semibold text-neutral-500 uppercase w-4 shrink-0">{idx + 1}</span>
                          <strong className="font-medium text-white">{provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'}</strong>
                          {provider === 'anthropic' && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/15 text-green-400 border border-green-500/25">OAuth</span>
                          )}
                          {fallbackForce && provider === 'openrouter' && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-green-500/20 text-green-400 border border-green-500/30">forcé</span>
                          )}
                        </div>
                        <span className="text-xs text-neutral-500 mt-0.5">
                          {idx === 0 ? 'Premier recours si backends locaux down' : `Recours n°${idx + 1}`}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

          </div>
        )}
      </div>
    </section>
  )
}
