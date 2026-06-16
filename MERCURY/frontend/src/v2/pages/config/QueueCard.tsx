import { ArrowLeftRight, Layers } from 'lucide-react'
import { clsx } from 'clsx'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { ConfigCheckbox } from './ConfigCheckbox'
import * as api from '../../../api/admin'
import { inputCls, labelCls, fieldCls, groupCls, type SectionProps } from './shared'

const DEFAULT_FALLBACK_ORDER = ['openrouter', 'anthropic']
const CLOUD_LABELS: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic' }

const budgetCls = 'w-20 px-2 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30'

type QueueCardProps = SectionProps & {
  debugBusy: boolean
  setDebugBusy: (busy: boolean) => void
  refreshConfig: () => void
}

function Divider() {
  return <div className="h-px bg-border/40 -mx-4" />
}

export function QueueCard({ config, updateField, markDirty, debugBusy, setDebugBusy, refreshConfig }: QueueCardProps) {
  const fallbackOrder: string[] = Array.isArray(config.fallback_providers_order)
    ? config.fallback_providers_order
    : DEFAULT_FALLBACK_ORDER

  const swapFallback = () => {
    markDirty()
    updateField('fallback_providers_order', [...fallbackOrder].reverse())
  }

  return (
    <Card>
      <CardHeader title="Queue & Optimisations" icon={<Layers size={13} />} />
      <CardBody className="!py-4 flex flex-col gap-4">

        {/* ── Queue ── */}
        <div className="flex flex-col gap-3">
          <span className={groupCls}>File d'attente</span>

          <div className="grid grid-cols-2 gap-3">
            <div className={fieldCls}>
              <label htmlFor="cfg-queue-size" className={labelCls}>Taille max</label>
              <input
                id="cfg-queue-size"
                type="number"
                value={config.queue_max_size ?? 100}
                onChange={e => updateField('queue_max_size', Number(e.target.value))}
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <label htmlFor="cfg-queue-timeout" className={labelCls}>Timeout (s)</label>
              <input
                id="cfg-queue-timeout"
                type="number"
                value={config.queue_timeout_seconds ?? ''}
                min={0}
                placeholder="∞"
                onChange={e => updateField('queue_timeout_seconds', e.target.value === '' ? undefined : Number(e.target.value))}
                className={inputCls}
              />
            </div>
          </div>

          {/* Grace period — toggle + inline input */}
          <div className="flex items-center gap-3 flex-wrap">
            <ConfigCheckbox
              id="cfg-priority-threshold"
              checked={config.priority_threshold_enabled === true}
              onChange={e => updateField('priority_threshold_enabled', e.target.checked)}
              label="Grace period"
              hint="Après un user prioritaire, attend avant de servir les users moins prioritaires."
            />
            {config.priority_threshold_enabled && (
              <div className="flex items-center gap-1.5 ml-auto shrink-0">
                <input
                  id="cfg-priority-threshold-seconds"
                  type="number"
                  value={config.priority_threshold_seconds ?? 30}
                  min={5} max={120} step={5}
                  onChange={e => updateField('priority_threshold_seconds', Number(e.target.value))}
                  className="w-16 px-2 py-1 bg-background border border-border/60 rounded-md text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 text-right"
                />
                <span className="text-[10px] text-muted-foreground/60">s</span>
              </div>
            )}
          </div>
        </div>

        <Divider />

        {/* ── Routage ── */}
        <div className="flex flex-col gap-3">
          <span className={groupCls}>Routage</span>

          <ConfigCheckbox
            id="cfg-auto-priority-enabled"
            checked={config.auto_priority_enabled !== false}
            onChange={e => updateField('auto_priority_enabled', e.target.checked)}
            label="Priorité stricte"
            hint="Active : choix selon provider_priority. Désactivé : préfère les modèles déjà chargés."
          />

          {/* Fallback cloud — swap simple */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground/60 shrink-0">Fallback cloud :</span>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {fallbackOrder.map((p, i) => (
                <span
                  key={p}
                  className={clsx(
                    'flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium',
                    i === 0
                      ? 'bg-primary/10 border-primary/30 text-primary'
                      : 'bg-background border-border/50 text-muted-foreground/70',
                  )}
                >
                  <span className="font-mono text-[9px] opacity-60">{i + 1}</span>
                  {CLOUD_LABELS[p] ?? p}
                </span>
              ))}
              <button
                type="button"
                onClick={swapFallback}
                title="Inverser l'ordre"
                className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary transition-colors ml-auto"
              >
                <ArrowLeftRight size={11} />
              </button>
            </div>
          </div>
        </div>

        <Divider />

        {/* ── Thinking Budget ── */}
        <div className="flex flex-col gap-3">
          <span className={groupCls}>Thinking Budget (tokens)</span>
          <p className="text-[10px] text-muted-foreground/60 m-0">
            Valeurs par défaut pour les requêtes Mastermind low / medium / high.
          </p>
          <div className="flex items-end gap-4">
            {([
              { key: 'thinking_budget_low',    label: 'low',    placeholder: '1024'   },
              { key: 'thinking_budget_medium', label: 'medium', placeholder: '4096'   },
              { key: 'thinking_budget_high',   label: 'high',   placeholder: '-1 (∞)' },
            ] as const).map(({ key, label, placeholder }) => (
              <div key={key} className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-muted-foreground/60">{label}</label>
                <input
                  type="number"
                  min={label === 'high' ? -1 : 0}
                  placeholder={placeholder}
                  value={(config[key] as number | undefined) ?? ''}
                  onChange={e => updateField(key, e.target.value ? Number(e.target.value) : undefined as unknown as number)}
                  className={budgetCls}
                />
              </div>
            ))}
          </div>
        </div>

        <Divider />

        {/* ── Debug ── */}
        <div className="flex flex-col gap-2.5">
          <span className={groupCls}>Debug</span>
          <div className="flex flex-col gap-2">
            <ConfigCheckbox
              id="cfg-debug"
              checked={config.debug === true}
              disabled={debugBusy}
              label="Logs debug"
              hint="Enregistrer les JSON reçus, envoyés et transférés dans le journal."
              onChange={async e => {
                const enabled = e.target.checked
                setDebugBusy(true)
                try {
                  await api.setDebug(enabled)
                  refreshConfig()
                } catch {
                  refreshConfig()
                } finally {
                  setDebugBusy(false)
                }
              }}
            />
            <ConfigCheckbox
              id="cfg-debug-full-json"
              checked={config.debug_full_json === true}
              onChange={e => updateField('debug_full_json', e.target.checked)}
              label="JSON complets"
              hint="Inclure les JSON entiers sans troncature."
            />
          </div>
        </div>

      </CardBody>
    </Card>
  )
}
