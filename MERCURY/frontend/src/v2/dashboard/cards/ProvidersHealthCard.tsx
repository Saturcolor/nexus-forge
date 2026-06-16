import { Server, ArrowRight } from 'lucide-react'
import {
  useConfig,
  useBackends,
  useLlamacppDaemonVersion,
} from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge, StatusDot } from '../../ui/Badge'

const CLOUD_PROVIDER_NAMES = new Set(['openrouter', 'anthropic'])

// Note: les probes Mercury (lm_studio_probe_url / ollama_probe_url) ont été
// retirées — brain-daemon expose désormais ces stats. Seul l'indicateur
// "daemon v…" (llamacpp) reste pertinent ici.

export function ProvidersHealthCard({ onManage }: { onManage?: () => void }) {
  const { data: config } = useConfig()
  const { data: backends } = useBackends()

  const llamacppDaemonEnabled =
    config?.llamacpp_enabled !== false && Boolean((config?.llamacpp_url ?? '').trim())
  const { data: llamacppDaemonVersion } = useLlamacppDaemonVersion(llamacppDaemonEnabled)

  // Local backends only — cloud providers live in their own card (FallbackCloudCard).
  const localBackends = (backends ?? []).filter(b => !CLOUD_PROVIDER_NAMES.has(b.name))
  const sortedLocal = [...localBackends].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))

  return (
    <Card className="h-full">
      <CardHeader
        title="Providers"
        icon={<Server size={13} />}
        right={
          onManage && (
            <button
              type="button"
              onClick={onManage}
              className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors"
              title="Gérer priorité & fallback"
            >
              Routage <ArrowRight size={11} />
            </button>
          )
        }
      />
      <CardBody className="!py-3">
        {sortedLocal.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">Aucun backend local configuré.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sortedLocal.map((b, idx) => {
              const up = b.status === 'up'
              const extra: string[] = []
              if (b.name === 'llamacpp' && llamacppDaemonEnabled) {
                extra.push(`daemon ${llamacppDaemonVersion?.version ? 'v' + llamacppDaemonVersion.version : '—'}`)
              }
              return (
                <li
                  key={b.name}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-background/60 border border-border/40"
                >
                  <span className="text-[10px] font-mono text-muted-foreground/70 w-4 shrink-0">
                    {idx + 1}
                  </span>
                  <StatusDot tone={up ? 'success' : 'destructive'} pulse={!up} />
                  <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">
                    {b.name}
                  </span>
                  {extra.length > 0 && (
                    <span className="text-[10px] font-mono text-muted-foreground/70 truncate">
                      {extra.join(' · ')}
                    </span>
                  )}
                  <Badge tone={up ? 'success' : 'destructive'}>{b.status}</Badge>
                </li>
              )
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
