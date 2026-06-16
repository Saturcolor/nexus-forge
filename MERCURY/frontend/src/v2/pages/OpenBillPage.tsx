import { useState, useCallback, useEffect } from 'react'
import { clsx } from 'clsx'
import { Wallet, RefreshCw, KeyRound, Settings2 } from 'lucide-react'
import { useConfig, useSaveConfigMutation } from '../../api/queries'
import * as api from '../../api/admin'
import type { Config, CreditsReport } from '../../api/admin'
import { formatCreditValue } from '../../utils/credits'
import { Card, CardHeader, CardBody } from '../ui/Card'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { StatTile } from '../ui/StatTile'
import { SectionHeader } from '../ui/SectionHeader'
import { KeysModal } from './openbill/KeysModal'
import { ProviderCard } from './openbill/ProviderCard'

const PROVIDERS = ['openrouter', 'openai', 'anthropic', 'elevenlabs'] as const
const PROVIDER_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  openai:     'OpenAI',
  anthropic:  'Anthropic',
  elevenlabs: 'ElevenLabs',
}

function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    if (Number.isNaN(d.getTime())) return isoString
    return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', hour12: false })
  } catch {
    return isoString
  }
}

function formatChars(n: number | null): string {
  if (n == null) return '–'
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' car.'
}

export function OpenBillPage() {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProviders])

  const [creditTimeout, setCreditTimeout] = useState(30000)
  const [creditsReport, setCreditsReport] = useState<CreditsReport | null>(null)
  const [creditsErr, setCreditsErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [keysModalOpen, setKeysModalOpen] = useState(false)

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
          credits: { ...config.credits, providers_preferred: creditProviders },
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

  const enabled = !!config?.credits?.enabled

  // Headline totals
  const totalRestantUsd = creditsReport
    ? ['openrouter', 'openai', 'anthropic'].reduce((sum, id) => {
        const p = creditsReport.providers?.[id]
        return p?.ok && typeof p.remaining === 'number' ? sum + p.remaining : sum
      }, 0 as number)
    : null

  return (
    <div className="flex flex-col gap-5">
      {/* ── Disabled state ───────────────────────────────────────────── */}
      {!enabled && (
        <Card>
          <CardHeader title="OpenBill" icon={<Wallet size={13} />} />
          <CardBody className="flex flex-col gap-3">
            <p className="text-[11px] text-muted-foreground m-0">
              Activez « Crédits (OpenBill) » dans Configuration, enregistrez, puis configurez les clés ci-dessous.
            </p>
            <div>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setKeysModalOpen(true)}
              >
                <KeyRound size={11} />
                Configurer les clés API
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Configuration ────────────────────────────────────────────── */}
      {enabled && (
        <Card>
          <CardHeader
            title="Configuration"
            icon={<Settings2 size={13} />}
            right={
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setKeysModalOpen(true)}
              >
                <KeyRound size={11} />
                Clés API
              </Button>
            }
          />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">
                Fournisseurs
              </span>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDERS.map(id => {
                  const active = creditProviders.includes(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleProvider(id)}
                      className={clsx(
                        'px-2 py-1 rounded-md border text-[11px] font-medium transition-colors',
                        active
                          ? 'bg-primary/10 border-primary/30 text-primary'
                          : 'bg-background border-border/60 text-muted-foreground hover:text-foreground hover:border-border',
                      )}
                      aria-pressed={active}
                    >
                      {PROVIDER_LABELS[id]}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3 pt-1">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="openbill-timeout"
                  className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground"
                >
                  Timeout (ms)
                </label>
                <input
                  id="openbill-timeout"
                  type="number"
                  value={creditTimeout}
                  min={5000}
                  max={120000}
                  step={5000}
                  onChange={e => setCreditTimeout(Number(e.target.value))}
                  className="w-28 px-2.5 py-1.5 bg-background border border-border/60 rounded-md focus:outline-none focus:ring-2 focus:ring-ring/40 text-[11px] font-mono tabular-nums text-foreground"
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={refreshCredits}
                disabled={loading}
              >
                {loading ? <Spinner size={11} /> : <RefreshCw size={11} />}
                Rafraîchir
              </Button>
              {creditsReport?.fetchedAt && (
                <span className="text-[10px] text-muted-foreground/70 ml-auto">
                  Dernière récupération : <span className="font-mono tabular-nums">{formatDateTime(creditsReport.fetchedAt)}</span>
                </span>
              )}
            </div>

            {creditsErr && (
              <p className="text-[11px] text-destructive m-0" role="alert">{creditsErr}</p>
            )}
            {creditsReport?.errors?.length ? (
              <ul className="text-[11px] text-destructive list-disc list-inside m-0" aria-live="polite">
                {creditsReport.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            ) : null}
          </CardBody>
        </Card>
      )}

      {/* ── Totals (StatTiles) ───────────────────────────────────────── */}
      {enabled && creditsReport && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Total en cours" icon={<Wallet size={14} />} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatTile
              label="Restant USD (total)"
              value={
                <span className="font-mono tabular-nums">
                  {formatCreditValue(totalRestantUsd, true)}
                </span>
              }
              tone="primary"
            />
            {PROVIDERS.map(id => {
              const p = creditsReport.providers?.[id]
              const val = p?.ok && typeof p.remaining === 'number' ? p.remaining : null
              const isChars = id === 'elevenlabs'
              const ok = p?.ok === true
              return (
                <StatTile
                  key={id}
                  label={`Restant (${PROVIDER_LABELS[id]})`}
                  value={
                    <span className="font-mono tabular-nums">
                      {isChars ? formatChars(val) : formatCreditValue(val, true)}
                    </span>
                  }
                  tone={ok ? 'default' : 'muted'}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* ── Per-provider detail cards ────────────────────────────────── */}
      {enabled && creditsReport && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Récapitulatif par fournisseur" />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {PROVIDERS.map(id => (
              <ProviderCard
                key={id}
                providerId={id}
                data={creditsReport.providers?.[id]}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Keys modal ───────────────────────────────────────────────── */}
      {keysModalOpen && config && (
        <KeysModal
          config={config}
          creditProviders={creditProviders}
          onClose={() => setKeysModalOpen(false)}
        />
      )}
    </div>
  )
}

export default OpenBillPage
