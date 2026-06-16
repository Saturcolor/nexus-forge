import { useConfig, useBackends } from '../../api/queries'

export default function FallbackCard() {
  const { data: config } = useConfig()
  const { data: backends } = useBackends()

  const orModel = (config?.openrouter_fallback_model ?? '').trim()
  const anthropicModel = (config?.anthropic_fallback_model ?? '').trim()
  const openrouterEnabled = config?.openrouter_enabled === true
  const anthropicEnabled = config?.anthropic_enabled === true
  const cloudOrder: string[] = Array.isArray(config?.fallback_providers_order) ? config.fallback_providers_order : ['openrouter', 'anthropic']
  const localBackendsAllDown = backends != null && (backends.length === 0 || backends.every((b) => b.status !== 'up'))
  const fallbackAutoActive = localBackendsAllDown && (openrouterEnabled || anthropicEnabled)

  const providers = cloudOrder
    .filter(p => (p === 'openrouter' && openrouterEnabled) || (p === 'anthropic' && anthropicEnabled))
    .map(p => ({
      id: p,
      label: p === 'openrouter' ? 'OpenRouter' : 'Anthropic (OAuth)',
      model: p === 'openrouter' ? orModel : anthropicModel,
      enabled: p === 'openrouter' ? openrouterEnabled : anthropicEnabled,
    }))

  // Ajouter les providers désactivés à la fin (visibilité)
  const disabledProviders = (['openrouter', 'anthropic'] as string[])
    .filter(p => !providers.find(ep => ep.id === p))
    .map(p => ({
      id: p,
      label: p === 'openrouter' ? 'OpenRouter' : 'Anthropic (OAuth)',
      model: p === 'openrouter' ? orModel : anthropicModel,
      enabled: false,
    }))

  const allProviders = [...providers, ...disabledProviders]

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-4 py-2 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Providers</h2>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-1.5">
        {allProviders.map((p, idx) => (
          <div key={p.id} className="flex flex-col gap-0.5 p-2.5 bg-neutral-950 border border-neutral-800 rounded-lg">
            <div className="flex items-center gap-2">
              {p.enabled && idx < providers.length && (
                <span className="text-[10px] font-semibold text-neutral-500 uppercase">{idx + 1}</span>
              )}
              <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">{p.label}</span>
              {p.enabled ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-green-500/20 text-green-400 border border-green-500/30">activé</span>
              ) : (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-neutral-700/40 text-neutral-500 border border-neutral-700">désactivé</span>
              )}
            </div>
            <p className="text-sm text-neutral-300 m-0">
              <span className="text-neutral-500 mr-2">Modèle :</span>
              {p.model
                ? <code className="px-1.5 py-0.5 bg-neutral-800 rounded text-blue-400 text-xs">{p.model}</code>
                : <span className="text-neutral-600">—</span>
              }
            </p>
            {fallbackAutoActive && p.enabled && idx === 0 && (
              <p className="text-xs font-medium text-orange-400 m-0">Actif — aucun backend local disponible</p>
            )}
          </div>
        ))}
        <p className="text-xs text-neutral-500 mt-1">Ordre configurable dans la card Priorité des providers.</p>
      </div>
    </section>
  )
}
