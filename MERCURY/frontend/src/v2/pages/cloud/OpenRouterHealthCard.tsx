import { useState } from 'react'
import { Activity } from 'lucide-react'
import * as api from '../../../api/admin'
import type { OpenRouterCreditsResponse } from '../../../api/admin'
import { useOpenRouterHealth } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTs(ts: number | null | undefined): string {
  if (ts == null) return '—'
  const ms = Date.now() - ts * 1000
  if (ms < 0 || ms > 86_400_000) return new Date(ts * 1000).toLocaleString()
  if (ms < 1000) return "à l'instant"
  if (ms < 60_000) return `il y a ${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `il y a ${Math.round(ms / 60_000)}m`
  return `il y a ${Math.round(ms / 3_600_000)}h`
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

function StatusPill({ status }: { status: number | null | undefined }) {
  if (status == null) return <span className="text-muted-foreground/40 text-[11px]">—</span>
  const tone =
    status >= 200 && status < 400 ? 'success' :
    status === 504 || status === 408 ? 'warning' : 'destructive'
  return <Badge tone={tone} mono>{status}</Badge>
}

function InfoCell({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="bg-background border border-border/40 rounded-lg px-3 py-2.5">
      <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{label}</div>
      <div className={`mt-1 text-sm text-foreground truncate ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest">{children}</span>
  )
}

function DataTable({ headers, aligns, children }: {
  headers: string[]
  aligns: ('left' | 'right')[]
  children: React.ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/40">
      <table className="w-full border-collapse">
        <thead className="bg-secondary/50">
          <tr>
            {headers.map((h, i) => (
              <th
                key={h}
                className={`px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider whitespace-nowrap ${
                  aligns[i] === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function OpenRouterHealthCard() {
  const { data: health, error: healthError, refetch } = useOpenRouterHealth()
  const [credits,     setCredits]     = useState<OpenRouterCreditsResponse | null>(null)
  const [resetBusy,   setResetBusy]   = useState(false)
  const [creditsBusy, setCreditsBusy] = useState(false)
  const [resetError,  setResetError]  = useState<string | null>(null)

  const error = resetError ?? (healthError instanceof Error ? healthError.message : healthError ? String(healthError) : null)

  const fetchCredits = async () => {
    setCreditsBusy(true)
    try { setCredits(await api.getOpenRouterCredits()) }
    catch (e) { setCredits({ detail: e instanceof Error ? e.message : String(e) }) }
    finally { setCreditsBusy(false) }
  }

  const resetBreaker = async () => {
    setResetBusy(true)
    setResetError(null)
    try { await api.resetOpenRouterCircuitBreaker(); void refetch() }
    catch (e) { setResetError(e instanceof Error ? e.message : String(e)) }
    finally { setResetBusy(false) }
  }

  const m          = health?.metrics
  const cb         = health?.circuit_breaker
  const fb         = health?.fallback
  const byModel    = m ? Object.entries(m.by_model)    : []
  const byProvider = m ? Object.entries(m.by_provider) : []
  const inFlight   = m ? Object.entries(m.in_flight).filter(([, v]) => v > 0) : []
  const blacklistSet = new Set(cb?.blacklist ?? [])

  return (
    <Card>
      <CardHeader
        title="OpenRouter — Santé"
        subtitle="Métriques live (refresh 15s) · circuit breaker · solde"
        icon={<Activity size={13} />}
        right={
          <Button
            size="sm" variant="subtle"
            onClick={fetchCredits}
            disabled={creditsBusy || !health?.api_key_set}
          >
            {creditsBusy ? 'Fetch…' : 'Vérifier solde'}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-5">

        {error && <p className="text-[11px] text-destructive">{error}</p>}

        {/* Solde on-demand */}
        {credits && (
          <div className="bg-background border border-border/40 rounded-lg px-3 py-2.5 text-[11px]">
            {credits.detail ? (
              <span className="text-theme-amber">⚠ {credits.detail}</span>
            ) : credits.data ? (
              <div className="flex items-center gap-5 flex-wrap text-foreground">
                <span>Solde : <span className="font-mono text-theme-green font-semibold">{credits.data.total_credits ?? '?'}</span></span>
                <span>Usage : <span className="font-mono text-muted-foreground">{credits.data.total_usage ?? '?'}</span></span>
                {typeof credits.data.total_credits === 'number' && typeof credits.data.total_usage === 'number' && (
                  <span>
                    Disponible :{' '}
                    <span className={`font-mono font-semibold ${
                      (credits.data.total_credits as number) - (credits.data.total_usage as number) > 1
                        ? 'text-theme-green' : 'text-destructive'
                    }`}>
                      {((credits.data.total_credits as number) - (credits.data.total_usage as number)).toFixed(4)}
                    </span>
                  </span>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground/50">— pas de données</span>
            )}
          </div>
        )}

        {/* 4 summary cells */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <InfoCell label="Dernier statut"   value={<StatusPill status={m?.last_status ?? null} />} />
          <InfoCell label="Dernier provider" value={m?.last_provider || '—'} mono />
          <InfoCell label="Dernier total"    value={formatMs(m?.last_total_ms)} mono />
          <InfoCell label="Activité"         value={formatRelativeTs(m?.last_activity_ts ?? null)} />
        </div>

        {/* In-flight */}
        {inFlight.length > 0 && (
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-2">
              En cours ({inFlight.reduce((s, [, v]) => s + v, 0)})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {inFlight.map(([model, count]) => (
                <span key={model} className="font-mono text-[11px] text-primary bg-primary/10 border border-primary/20 px-2 py-1 rounded">
                  {model} ×{count}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Circuit breaker */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <SectionLabel>Circuit breaker upstream</SectionLabel>
              {cb?.config && (
                <span className="text-[10px] text-muted-foreground/50">
                  seuil {cb.config.failure_threshold} fails / {cb.config.failure_window_s}s
                </span>
              )}
            </div>
            <Button
              size="sm" variant="subtle"
              onClick={resetBreaker}
              disabled={resetBusy || !cb || Object.keys(cb.providers).length === 0}
            >
              {resetBusy ? 'Reset…' : 'Reset breaker'}
            </Button>
          </div>
          {!cb || Object.keys(cb.providers).length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 italic">
              Aucun fail enregistré. Les providers upstream OR sont sains.
            </p>
          ) : (
            <DataTable
              headers={['Upstream', 'État', 'Fails', 'Plus ancien']}
              aligns={['left', 'left', 'left', 'left']}
            >
              {Object.entries(cb.providers).map(([provider, state]) => (
                <tr key={provider} className="border-t border-border/30 hover:bg-secondary/20">
                  <td className="px-3 py-2 font-mono text-foreground text-[11px]">{provider}</td>
                  <td className="px-3 py-2">
                    <Badge tone={state.blacklisted ? 'destructive' : 'warning'} mono>
                      {state.blacklisted ? 'BLACKLISTED' : 'warn'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-foreground text-[11px]">{state.fails_in_window}</td>
                  <td className="px-3 py-2 text-muted-foreground/70 text-[11px]">
                    {state.oldest_fail_ago_s != null ? `${Math.round(state.oldest_fail_ago_s)}s` : '—'}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        {/* By model */}
        <div className="flex flex-col gap-2">
          <SectionLabel>Dernier appel par modèle</SectionLabel>
          {byModel.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 italic">
              Aucun appel enregistré (Mercury vient peut-être de redémarrer).
            </p>
          ) : (
            <DataTable
              headers={['Modèle', 'Provider', 'Statut', 'TTFB', 'Total', 'Tok in/out', 'Activité']}
              aligns={['left', 'left', 'left', 'right', 'right', 'right', 'left']}
            >
              {byModel.map(([model, mm]) => (
                <tr key={model} className="border-t border-border/30 hover:bg-secondary/20">
                  <td className="px-3 py-2 font-mono text-foreground text-[11px] max-w-[160px] truncate">{model}</td>
                  <td className="px-3 py-2 font-mono text-muted-foreground text-[11px]">{mm.last_provider || '—'}</td>
                  <td className="px-3 py-2"><StatusPill status={mm.last_status} /></td>
                  <td className="px-3 py-2 text-right font-mono text-foreground text-[11px]">{formatMs(mm.last_ttfb_ms)}</td>
                  <td className="px-3 py-2 text-right font-mono text-foreground text-[11px]">{formatMs(mm.last_total_ms)}</td>
                  <td className="px-3 py-2 text-right font-mono text-muted-foreground/70 text-[11px]">
                    {mm.last_prompt_tokens ?? '—'} / {mm.last_generation_tokens ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground/60 text-[11px]">{formatRelativeTs(mm.last_activity_ts)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        {/* By upstream provider */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <SectionLabel>Par provider upstream</SectionLabel>
            <span className="text-[10px] text-muted-foreground/40">(DeepInfra, Anthropic, Together, …)</span>
          </div>
          {byProvider.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 italic">Aucun appel enregistré.</p>
          ) : (
            <DataTable
              headers={['Upstream', 'Calls', 'Statut', 'TTFB', 'Total', 'CB', 'Activité']}
              aligns={['left', 'right', 'left', 'right', 'right', 'left', 'left']}
            >
              {byProvider.map(([provider, pm]) => (
                <tr key={provider} className="border-t border-border/30 hover:bg-secondary/20">
                  <td className="px-3 py-2 font-mono text-foreground text-[11px]">{provider}</td>
                  <td className="px-3 py-2 text-right font-mono text-muted-foreground text-[11px]">{pm.calls_count ?? 0}</td>
                  <td className="px-3 py-2"><StatusPill status={pm.last_status} /></td>
                  <td className="px-3 py-2 text-right font-mono text-foreground text-[11px]">{formatMs(pm.last_ttfb_ms)}</td>
                  <td className="px-3 py-2 text-right font-mono text-foreground text-[11px]">{formatMs(pm.last_total_ms)}</td>
                  <td className="px-3 py-2">
                    {blacklistSet.has(provider)
                      ? <Badge tone="destructive" mono>BL</Badge>
                      : <span className="text-muted-foreground/40 text-[11px]">—</span>
                    }
                  </td>
                  <td className="px-3 py-2 text-muted-foreground/60 text-[11px]">{formatRelativeTs(pm.last_activity_ts)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        {/* Fallback summary */}
        <div className="bg-background border border-border/40 rounded-lg px-3 py-2.5 text-[11px]">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-muted-foreground">
              Fallback model :{' '}
              <span className={fb?.enabled ? 'text-theme-green font-medium' : 'text-muted-foreground/50'}>
                {fb?.enabled ? 'activé' : 'désactivé'}
              </span>
            </span>
            {fb?.enabled && (
              <span className="text-muted-foreground/50 truncate text-[10px]">
                triggers: {fb.triggers.join(', ') || '(défaut)'} · chain: {(fb.chain || []).length > 0 ? fb.chain.join(' → ') : '(vide)'}
              </span>
            )}
          </div>
        </div>

      </CardBody>
    </Card>
  )
}
