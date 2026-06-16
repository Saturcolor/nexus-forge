import { Shuffle, AlertTriangle } from 'lucide-react'
import { useConfig, useBackends, useOpenRouterHealth } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'

type Provider = { id: 'openrouter' | 'anthropic'; label: string; model: string; enabled: boolean }

/**
 * Cloud fallback providers — port verbatim of the V1 FallbackCard layout,
 * with V2 semantic tokens. Sits between Providers (local) and Audio in the
 * dashboard bottom row.
 */
export function FallbackCloudCard({ onManage }: { onManage?: () => void }) {
  const { data: config } = useConfig()
  const { data: backends } = useBackends()

  const orModel = (config?.openrouter_fallback_model ?? '').trim()
  const anthropicModel = (config?.anthropic_fallback_model ?? '').trim()
  const openrouterEnabled = config?.openrouter_enabled === true
  const anthropicEnabled = config?.anthropic_enabled === true

  // Health OpenRouter — utile pour signaler le circuit breaker. On ne le
  // query que si OR est activé, sinon c'est du bruit réseau (et un 401
  // sans clé API garni de logs côté backend).
  const { data: orHealth } = useOpenRouterHealth(openrouterEnabled)
  const blacklist = orHealth?.circuit_breaker?.blacklist ?? []
  const cbProviders = orHealth?.circuit_breaker?.providers ?? {}
  const blacklistedCount = Object.values(cbProviders).filter(p => p.blacklisted).length
  const circuitOpen = blacklist.length > 0 || blacklistedCount > 0
  const cloudOrder: string[] = Array.isArray(config?.fallback_providers_order)
    ? config.fallback_providers_order
    : ['openrouter', 'anthropic']

  // Auto-fallback "active" when every local backend is down AND a cloud is on.
  const CLOUD_NAMES = new Set(['openrouter', 'anthropic'])
  const localBackends = (backends ?? []).filter(b => !CLOUD_NAMES.has(b.name))
  const localAllDown =
    backends != null && (localBackends.length === 0 || localBackends.every(b => b.status !== 'up'))
  const fallbackAutoActive = localAllDown && (openrouterEnabled || anthropicEnabled)
  const fallbackForce = config?.openrouter_fallback_force === true

  const enabled: Provider[] = cloudOrder
    .filter(p => (p === 'openrouter' && openrouterEnabled) || (p === 'anthropic' && anthropicEnabled))
    .map(p => ({
      id: p as Provider['id'],
      label: p === 'openrouter' ? 'OpenRouter' : 'Anthropic (OAuth)',
      model: p === 'openrouter' ? orModel : anthropicModel,
      enabled: true,
    }))

  const disabled: Provider[] = (['openrouter', 'anthropic'] as const)
    .filter(p => !enabled.find(e => e.id === p))
    .map(p => ({
      id: p,
      label: p === 'openrouter' ? 'OpenRouter' : 'Anthropic (OAuth)',
      model: p === 'openrouter' ? orModel : anthropicModel,
      enabled: false,
    }))

  const allProviders = [...enabled, ...disabled]

  return (
    <Card className="h-full">
      <CardHeader
        title="Providers cloud"
        icon={<Shuffle size={13} />}
        right={
          <span className="flex items-center gap-1.5">
            {circuitOpen && (
              <span
                title={
                  blacklist.length > 0
                    ? `Circuit breaker ouvert · catégories: ${blacklist.join(', ')}`
                    : `Circuit breaker ouvert · ${blacklistedCount} provider(s) blacklisté(s)`
                }
                className="inline-flex"
              >
                <Badge tone="destructive">
                  <AlertTriangle size={10} className="-mt-px" />
                  {' '}circuit
                </Badge>
              </span>
            )}
            {fallbackForce && openrouterEnabled && <Badge tone="warning">forcé</Badge>}
          </span>
        }
      />
      <CardBody className="!py-3 flex flex-col gap-2">
        {allProviders.map((p, idx) => (
          <div
            key={p.id}
            className="flex flex-col gap-1 px-2.5 py-2 bg-background/60 border border-border/40 rounded-lg"
          >
            <div className="flex items-center gap-2 flex-wrap">
              {p.enabled && idx < enabled.length && (
                <span className="text-[10px] font-mono text-muted-foreground/70 w-4 shrink-0">
                  {idx + 1}
                </span>
              )}
              <span className="text-xs font-semibold text-foreground tracking-tight flex-1 min-w-0 truncate">
                {p.label}
              </span>
              <Badge tone={p.enabled ? 'success' : 'muted'}>
                {p.enabled ? 'activé' : 'désactivé'}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground m-0 flex items-baseline gap-1.5 pl-6">
              <span className="text-muted-foreground/70 shrink-0">Modèle :</span>
              {p.model ? (
                <code className="px-1.5 py-0.5 bg-secondary rounded text-primary text-[11px] font-mono truncate">
                  {p.model}
                </code>
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </p>
            {fallbackAutoActive && p.enabled && idx === 0 && (
              <p className="text-[11px] font-medium text-theme-orange m-0 pl-6">
                Actif — aucun backend local disponible
              </p>
            )}
          </div>
        ))}
        {circuitOpen && (
          <p className="text-[10px] text-destructive m-0">
            {blacklist.length > 0
              ? `Circuit ouvert · catégories blacklistées: ${blacklist.join(', ')}`
              : `Circuit ouvert · ${blacklistedCount} provider(s) blacklisté(s) côté OpenRouter`}
          </p>
        )}
        <p className="text-[10px] text-muted-foreground/60 mt-1">
          Ordre configurable dans{' '}
          {onManage ? (
            <button
              type="button"
              onClick={onManage}
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              Routage
            </button>
          ) : 'Routage'}.
        </p>
      </CardBody>
    </Card>
  )
}
