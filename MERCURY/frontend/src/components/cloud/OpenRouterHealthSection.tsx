import { useEffect, useState, useCallback, useRef } from 'react'
import * as api from '../../api/admin'
import type { OpenRouterHealthResponse, OpenRouterCreditsResponse } from '../../api/admin'

const POLL_INTERVAL_MS = 5000

function formatRelativeTs(ts: number | null | undefined): string {
  // Strict null check : un ts === 0 (epoch) reste valide même si visuellement
  // étrange ; on ne le veut pas confondu avec "absent".
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
  if (status == null) return <span className="text-neutral-500">—</span>
  const ok = status >= 200 && status < 400
  const cls = ok
    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
    : status === 504 || status === 408
    ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
    : 'bg-red-500/10 text-red-400 border-red-500/30'
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>{status}</span>
}

export default function OpenRouterHealthSection() {
  const [health, setHealth] = useState<OpenRouterHealthResponse | null>(null)
  const [credits, setCredits] = useState<OpenRouterCreditsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resetBusy, setResetBusy] = useState(false)
  const [creditsBusy, setCreditsBusy] = useState(false)
  // Guards against (a) request stacking when Mercury is slow >5s, (b) state writes
  // after unmount. We don't have AbortSignal plumbed in apiGet so we use cancelled
  // flags + an "in-flight" guard.
  const inflightRef = useRef(false)
  const cancelledRef = useRef(false)

  const refresh = useCallback(async () => {
    if (inflightRef.current) return // skip if a previous tick is still running
    inflightRef.current = true
    try {
      const h = await api.getOpenRouterHealth()
      if (cancelledRef.current) return
      setHealth(h)
      setError(null)
    } catch (e) {
      if (cancelledRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inflightRef.current = false
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    void refresh()
    const t = setInterval(refresh, POLL_INTERVAL_MS)
    return () => {
      cancelledRef.current = true
      clearInterval(t)
    }
  }, [refresh])

  const fetchCredits = async () => {
    setCreditsBusy(true)
    try {
      setCredits(await api.getOpenRouterCredits())
    } catch (e) {
      setCredits({ detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setCreditsBusy(false)
    }
  }

  const resetBreaker = async () => {
    setResetBusy(true)
    try {
      await api.resetOpenRouterCircuitBreaker()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setResetBusy(false)
    }
  }

  const m = health?.metrics
  const cb = health?.circuit_breaker
  const fb = health?.fallback
  const byModel = m ? Object.entries(m.by_model) : []
  const byProvider = m ? Object.entries(m.by_provider) : []
  const inFlight = m ? Object.entries(m.in_flight).filter(([, v]) => v > 0) : []
  const blacklistSet = new Set(cb?.blacklist ?? [])

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white m-0">OpenRouter — santé</h3>
          <p className="text-xs text-neutral-500 m-0 mt-0.5">
            Métriques live (refresh {POLL_INTERVAL_MS / 1000}s) · circuit breaker upstream · solde
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchCredits}
            disabled={creditsBusy || !health?.api_key_set}
            className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-neutral-200 transition-colors"
          >
            {creditsBusy ? 'Fetch…' : 'Vérifier solde'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-400 m-0">{error}</p>}

      {/* Solde OR (on-demand) */}
      {credits && (
        <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-xs">
          {credits.detail ? (
            <span className="text-amber-400">⚠️ {credits.detail}</span>
          ) : credits.data ? (
            <div className="flex items-center gap-4 text-neutral-300">
              <span>
                Solde total : <span className="font-mono text-emerald-400">{credits.data.total_credits ?? '?'}</span>
              </span>
              <span>
                Usage : <span className="font-mono">{credits.data.total_usage ?? '?'}</span>
              </span>
              {typeof credits.data.total_credits === 'number' &&
                typeof credits.data.total_usage === 'number' && (
                  <span>
                    Disponible :{' '}
                    <span
                      className={`font-mono ${(credits.data.total_credits as number) - (credits.data.total_usage as number) > 1 ? 'text-emerald-400' : 'text-red-400'}`}
                    >
                      {((credits.data.total_credits as number) - (credits.data.total_usage as number)).toFixed(4)}
                    </span>
                  </span>
                )}
            </div>
          ) : (
            <span className="text-neutral-500">— pas de données</span>
          )}
        </div>
      )}

      {/* Cards résumé */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card label="Dernier statut" value={<StatusPill status={m?.last_status ?? null} />} />
        <Card label="Dernier provider" value={m?.last_provider || '—'} mono />
        <Card label="Dernier total" value={formatMs(m?.last_total_ms)} mono />
        <Card label="Activité" value={formatRelativeTs(m?.last_activity_ts ?? null)} />
      </div>

      {/* In-flight (si > 0) */}
      {inFlight.length > 0 && (
        <div className="bg-blue-950/20 border border-blue-900/40 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-blue-400 font-semibold mb-2">
            En cours ({inFlight.reduce((s, [, v]) => s + v, 0)})
          </div>
          <div className="flex flex-wrap gap-2">
            {inFlight.map(([model, count]) => (
              <span key={model} className="font-mono text-xs text-blue-300 bg-blue-950/40 border border-blue-900/40 px-2 py-1 rounded">
                {model} ×{count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Circuit breaker */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-neutral-200 m-0">
            Circuit breaker upstream
            <span className="ml-2 text-[10px] text-neutral-500 font-normal">
              {cb?.config && `seuil ${cb.config.failure_threshold} fails / ${cb.config.failure_window_s}s`}
            </span>
          </h4>
          <button
            type="button"
            onClick={resetBreaker}
            disabled={resetBusy || !cb || Object.keys(cb.providers).length === 0}
            className="px-2.5 py-1 text-[11px] bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed rounded text-neutral-300 transition-colors"
          >
            {resetBusy ? 'Reset…' : 'Reset breaker'}
          </button>
        </div>
        {!cb || Object.keys(cb.providers).length === 0 ? (
          <p className="text-xs text-neutral-500 italic m-0">
            Aucun fail enregistré. Les providers upstream OR sont sains.
          </p>
        ) : (
          <div className="overflow-hidden border border-neutral-800 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-neutral-950 text-neutral-500">
                <tr>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Upstream</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">État</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Fails</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Plus ancien</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(cb.providers).map(([provider, state]) => (
                  <tr key={provider} className="border-t border-neutral-800">
                    <td className="py-2 px-3 font-mono text-neutral-200">{provider}</td>
                    <td className="py-2 px-3">
                      {state.blacklisted ? (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/30">
                          BLACKLISTED
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/30">
                          warn
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 font-mono text-neutral-300">{state.fails_in_window}</td>
                    <td className="py-2 px-3 text-neutral-400">
                      {state.oldest_fail_ago_s != null ? `${Math.round(state.oldest_fail_ago_s)}s` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Dernier appel par modèle */}
      <div>
        <h4 className="text-sm font-semibold text-neutral-200 m-0 mb-2">Dernier appel par modèle</h4>
        {byModel.length === 0 ? (
          <p className="text-xs text-neutral-500 italic m-0">Aucun appel enregistré (Mercury vient peut-être de redémarrer).</p>
        ) : (
          <div className="overflow-hidden border border-neutral-800 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-neutral-950 text-neutral-500">
                <tr>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Modèle</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Provider</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Statut</th>
                  <th className="text-right font-medium uppercase tracking-wider text-[10px] py-2 px-3">TTFB</th>
                  <th className="text-right font-medium uppercase tracking-wider text-[10px] py-2 px-3">Total</th>
                  <th className="text-right font-medium uppercase tracking-wider text-[10px] py-2 px-3">Tok in/out</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Activité</th>
                </tr>
              </thead>
              <tbody>
                {byModel.map(([model, mm]) => (
                  <tr key={model} className="border-t border-neutral-800 hover:bg-neutral-950/50">
                    <td className="py-2 px-3 font-mono text-neutral-200 max-w-[180px] truncate">{model}</td>
                    <td className="py-2 px-3 font-mono text-neutral-400">{mm.last_provider || '—'}</td>
                    <td className="py-2 px-3"><StatusPill status={mm.last_status} /></td>
                    <td className="py-2 px-3 text-right font-mono text-neutral-300">{formatMs(mm.last_ttfb_ms)}</td>
                    <td className="py-2 px-3 text-right font-mono text-neutral-300">{formatMs(mm.last_total_ms)}</td>
                    <td className="py-2 px-3 text-right font-mono text-neutral-400">
                      {mm.last_prompt_tokens ?? '—'} / {mm.last_generation_tokens ?? '—'}
                    </td>
                    <td className="py-2 px-3 text-neutral-500">{formatRelativeTs(mm.last_activity_ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Dernier appel par upstream provider */}
      <div>
        <h4 className="text-sm font-semibold text-neutral-200 m-0 mb-2">
          Par provider upstream
          <span className="ml-2 text-[10px] text-neutral-500 font-normal">
            (DeepInfra, Anthropic, Together, …) — quel upstream OR a routé chaque call
          </span>
        </h4>
        {byProvider.length === 0 ? (
          <p className="text-xs text-neutral-500 italic m-0">Aucun appel enregistré.</p>
        ) : (
          <div className="overflow-hidden border border-neutral-800 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-neutral-950 text-neutral-500">
                <tr>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Upstream</th>
                  <th className="text-right font-medium uppercase tracking-wider text-[10px] py-2 px-3">Calls</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Dernier statut</th>
                  <th className="text-right font-medium uppercase tracking-wider text-[10px] py-2 px-3">TTFB</th>
                  <th className="text-right font-medium uppercase tracking-wider text-[10px] py-2 px-3">Total</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">CB</th>
                  <th className="text-left font-medium uppercase tracking-wider text-[10px] py-2 px-3">Activité</th>
                </tr>
              </thead>
              <tbody>
                {byProvider.map(([provider, pm]) => (
                  <tr key={provider} className="border-t border-neutral-800 hover:bg-neutral-950/50">
                    <td className="py-2 px-3 font-mono text-neutral-200">{provider}</td>
                    <td className="py-2 px-3 text-right font-mono text-neutral-400">{pm.calls_count ?? 0}</td>
                    <td className="py-2 px-3"><StatusPill status={pm.last_status} /></td>
                    <td className="py-2 px-3 text-right font-mono text-neutral-300">{formatMs(pm.last_ttfb_ms)}</td>
                    <td className="py-2 px-3 text-right font-mono text-neutral-300">{formatMs(pm.last_total_ms)}</td>
                    <td className="py-2 px-3">
                      {blacklistSet.has(provider) ? (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/30">BL</span>
                      ) : (
                        <span className="text-neutral-500 text-[10px]">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-neutral-500">{formatRelativeTs(pm.last_activity_ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fallback config readonly summary (édition dans la section Fallback) */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-400">
            Fallback model :{' '}
            <span className={fb?.enabled ? 'text-emerald-400 font-medium' : 'text-neutral-500'}>
              {fb?.enabled ? 'activé' : 'désactivé'}
            </span>
          </span>
          {fb?.enabled && (
            <span className="text-neutral-500 truncate">
              triggers: {fb.triggers.join(', ') || '(défaut)'} · chain: {(fb.chain || []).length > 0 ? fb.chain.join(' → ') : '(vide)'}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

function Card({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">{label}</div>
      <div className={`mt-1 text-sm text-neutral-200 ${mono ? 'font-mono' : ''} truncate`}>{value}</div>
    </div>
  )
}
