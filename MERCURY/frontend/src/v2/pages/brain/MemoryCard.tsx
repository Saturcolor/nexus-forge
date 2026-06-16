import { useState, useEffect } from 'react'
import { Database, ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import {
  useBrainMemoryStatus, useBrainMemoryEvents,
  useBrainMemoryStartMutation, useBrainMemoryStopMutation,
  useBrainMemoryConfigMutation, useBrainMemoryProtectMutation,
  useBrainMemoryUnprotectMutation, useBrainMemoryEvictMutation,
  useBrainMemorySwapClearMutation, useSaveBrainSettingsMutation,
} from '../../../api/queries'
import type { MemoryPool, MemoryModelInfo, MemoryEvent } from '../../../api/admin'

// ── Helpers ──────────────────────────────────────────────────────────────────

function barColor(pct: number, warnPct: number, evictPct: number, emergPct?: number): string {
  if (emergPct && pct >= emergPct) return 'bg-red-500'
  if (pct >= evictPct) return 'bg-orange-500'
  if (pct >= warnPct)  return 'bg-yellow-500'
  return 'bg-emerald-500'
}

function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
}

function formatIdle(seconds: number): string {
  if (seconds < 0)    return '—'
  if (seconds < 60)   return `${seconds.toFixed(0)}s`
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

// ── Pool bar ──────────────────────────────────────────────────────────────────

function PoolBar({ label, pool, thresholds }: {
  label: string
  pool: MemoryPool
  thresholds: { warn: number; evict: number; emergency?: number }
}) {
  const pct   = pool.percent
  const color = barColor(pct, thresholds.warn, thresholds.evict, thresholds.emergency)
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="font-mono text-sm font-bold text-foreground">
          {pct.toFixed(1)}%
          <span className="text-muted-foreground/50 text-[10px] font-normal ml-1.5">
            {formatMB(pool.used_mb)} / {formatMB(pool.total_mb)}
          </span>
        </span>
      </div>
      <div className="w-full h-2.5 bg-secondary rounded-full overflow-hidden relative">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
        <div className="absolute top-0 h-full w-0.5 bg-yellow-400/50" style={{ left: `${thresholds.warn}%` }} />
        <div className="absolute top-0 h-full w-0.5 bg-orange-400/50" style={{ left: `${thresholds.evict}%` }} />
        {thresholds.emergency != null && (
          <div className="absolute top-0 h-full w-0.5 bg-red-400/50" style={{ left: `${thresholds.emergency}%` }} />
        )}
      </div>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MemoryCard() {
  const { data: status, isLoading, isError } = useBrainMemoryStatus()
  const { data: eventsResp } = useBrainMemoryEvents()
  const startMut      = useBrainMemoryStartMutation()
  const stopMut       = useBrainMemoryStopMutation()
  const configMut     = useBrainMemoryConfigMutation()
  const protectMut    = useBrainMemoryProtectMutation()
  const unprotectMut  = useBrainMemoryUnprotectMutation()
  const evictMut      = useBrainMemoryEvictMutation()
  const swapClearMut  = useBrainMemorySwapClearMutation()
  const saveBrainMut  = useSaveBrainSettingsMutation()

  const [thresholds,     setThresholds]     = useState<Record<string, number>>({})
  const [thDirty,        setThDirty]        = useState(false)
  const [thSaved,        setThSaved]        = useState(false)
  const [loaded,         setLoaded]         = useState(false)
  const [showDetails,    setShowDetails]    = useState(false)
  const [showThresholds, setShowThresholds] = useState(false)

  useEffect(() => {
    if (status?.thresholds && !loaded) {
      setThresholds(status.thresholds)
      setLoaded(true)
    }
  }, [status, loaded])

  const updateTh = (key: string, val: string) => {
    setThresholds(prev => ({ ...prev, [key]: parseFloat(val) || 0 }))
    setThDirty(true); setThSaved(false)
  }

  const handleSave = () => {
    configMut.mutate(thresholds, {
      onSuccess: () => { setThSaved(true); setThDirty(false) },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveBrainMut.mutate({ memory_thresholds: thresholds } as any)
  }

  const handleToggleProtect = (model: MemoryModelInfo) => {
    if (model.protected) unprotectMut.mutate(model.model_id)
    else                 protectMut.mutate(model.model_id)
  }

  const handleEvict = (modelId: string) => {
    if (confirm(`Évicter ${modelId} ?`)) evictMut.mutate(modelId)
  }

  const events = (eventsResp?.events ?? []).slice(-5).reverse()

  // Threshold values with fallback
  const th = (key: string, fallback: number) =>
    thresholds[key] ?? status?.thresholds?.[key] ?? fallback

  const poolsContent = status && !isLoading && (
    <>
      <PoolBar
        label="RAM"
        pool={status.ram}
        thresholds={{ warn: th('ram_warn_percent', 75), evict: th('ram_evict_percent', 85), emergency: th('ram_emergency_percent', 93) }}
      />

      {status.vram.total_mb > 0 && (
        <div className="mt-3">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">VRAM</span>
            <span className="font-mono text-sm font-bold text-foreground">
              {status.vram.percent.toFixed(1)}%
              <span className="text-muted-foreground/50 text-[10px] font-normal ml-1.5">
                {formatMB(status.vram.used_mb)} / {formatMB(status.vram.total_mb)}
              </span>
            </span>
          </div>
          <div className="w-full h-2.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all bg-blue-500" style={{ width: `${Math.min(100, status.vram.percent)}%` }} />
          </div>
        </div>
      )}

      {(status.ram.swap_total_mb ?? 0) > 0 && (() => {
        const swapPct   = status.ram.swap_percent  ?? 0
        const swapUsed  = status.ram.swap_used_mb  ?? 0
        const swapTotal = status.ram.swap_total_mb ?? 0
        return (
          <div className="mt-3">
            <div className="flex justify-between items-center mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">SWAP</span>
                {swapUsed > 0 && (
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => swapClearMut.mutate()}
                    disabled={swapClearMut.isPending}
                    title="swapoff -a && swapon -a"
                  >
                    {swapClearMut.isPending ? 'Clearing…' : 'Clear'}
                  </Button>
                )}
              </div>
              <span className="font-mono text-sm font-bold text-foreground">
                {swapPct.toFixed(1)}%
                <span className="text-muted-foreground/50 text-[10px] font-normal ml-1.5">
                  {formatMB(swapUsed)} / {formatMB(swapTotal)}
                </span>
              </span>
            </div>
            <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${swapPct > 10 ? 'bg-red-500' : swapPct > 0 ? 'bg-orange-500' : 'bg-muted-foreground/30'}`}
                style={{ width: `${Math.min(100, swapPct)}%` }}
              />
            </div>
          </div>
        )
      })()}
    </>
  )

  return (
    <Card>
      <CardHeader
        title="Memory — Dual Pool"
        icon={<Database size={13} />}
        right={
          <div className="flex items-center gap-2">
            {status?.running ? (
              <>
                <Badge tone="success">Running</Badge>
                <Button size="sm" variant="subtle" onClick={() => stopMut.mutate()} disabled={stopMut.isPending}>
                  {stopMut.isPending ? '…' : 'Stop'}
                </Button>
              </>
            ) : (
              <>
                <Badge tone="muted">Stopped</Badge>
                <Button size="sm" variant="primary" onClick={() => startMut.mutate()} disabled={startMut.isPending}>
                  {startMut.isPending ? '…' : 'Start'}
                </Button>
              </>
            )}
          </div>
        }
      />
      <CardBody>
        {isLoading && <div className="flex justify-center py-4"><Spinner size={16} /></div>}
        {isError   && <p className="text-[11px] text-muted-foreground">Daemon inaccessible</p>}

        {/* Pool bars — always shown */}
        {poolsContent}

        {/* ── Toggle détails ───────────────────────────────────────── */}
        {status && !isLoading && (
          <button
            type="button"
            className="flex items-center gap-1.5 mt-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
            onClick={() => setShowDetails(v => !v)}
          >
            {showDetails ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Modèles & Seuils
            {status.models.length > 0 && (
              <span className="ml-1 normal-case tracking-normal font-semibold text-muted-foreground/60">
                · {status.models.length} chargé{status.models.length > 1 ? 's' : ''}
              </span>
            )}
          </button>
        )}

        {/* ── Detail sections ───────────────────────────────────────── */}
        {showDetails && status && !isLoading && (
          <>
            {/* Loaded models */}
            {status.models.length > 0 && (
              <div className="mt-4 pt-3 border-t border-border/40">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Modèles chargés
                </span>
                <div className="mt-1.5">
                  {status.models.map((m: MemoryModelInfo) => (
                    <div key={m.model_id} className="flex items-center justify-between py-2 border-b border-border/40 last:border-b-0">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <button
                          className={`w-4 h-4 rounded border flex items-center justify-center text-[8px] transition-colors cursor-pointer ${
                            m.protected
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'bg-background border-border hover:border-muted-foreground'
                          }`}
                          onClick={() => handleToggleProtect(m)}
                          disabled={protectMut.isPending || unprotectMut.isPending}
                          title={m.protected ? 'Unpin' : 'Pin (protect from eviction)'}
                        >
                          {m.protected ? '✓' : ''}
                        </button>
                        <span className="text-[11px] text-foreground font-medium truncate">{m.model_id}</span>
                        {m.thermal_stopped && <Badge tone="warning">paused</Badge>}
                        {m.idle_seconds >= 0 && m.idle_seconds < 5 && <Badge tone="success">active</Badge>}
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-[10px] text-muted-foreground/60 font-mono">
                        <span title="VRAM delta">V {formatMB(m.vram_delta_mb)}</span>
                        <span title="RAM">R {formatMB(m.ram_display_mb || m.ram_delta_mb || m.ram_estimated_mb)}</span>
                        <span title="Load order">#{m.load_order}</span>
                        <span title="Idle">{formatIdle(m.idle_seconds)}</span>
                        <button
                          className="text-destructive/60 hover:text-destructive cursor-pointer px-1 transition-colors"
                          onClick={() => handleEvict(m.model_id)}
                          disabled={evictMut.isPending}
                          title="Évicter"
                        >✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Thresholds — collapsible */}
            <div className="mt-4 pt-3 border-t border-border/40">
              <button
                type="button"
                className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors w-full"
                onClick={() => setShowThresholds(v => !v)}
              >
                {showThresholds ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                Seuils mémoire
                {thDirty && <span className="ml-1 text-theme-amber normal-case tracking-normal font-semibold">· modifié</span>}
                {thSaved && <span className="ml-1 text-theme-green normal-case tracking-normal font-semibold">· OK</span>}
              </button>

              {showThresholds && (
                <div className="mt-2">
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'ram_warn_percent',      label: 'RAM warn'   },
                      { key: 'ram_evict_percent',     label: 'RAM evict'  },
                      { key: 'ram_emergency_percent', label: 'RAM emerg'  },
                      { key: 'swap_flush_percent',    label: 'Swap flush' },
                    ].map(({ key, label }) => (
                      <div key={key} className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-muted-foreground/70">{label}</span>
                        <input
                          className="w-full px-1.5 py-1 bg-background border border-border/60 rounded text-[11px] text-foreground font-mono text-center focus:outline-none focus:ring-2 focus:ring-ring/30"
                          type="number"
                          value={thresholds[key] ?? status?.thresholds?.[key] ?? ''}
                          onChange={e => updateTh(key, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" variant="primary" onClick={handleSave} disabled={configMut.isPending || !thDirty}>
                      {configMut.isPending ? '…' : 'Sauvegarder'}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Recent events */}
            {events.length > 0 && (
              <div className="mt-4 pt-3 border-t border-border/40">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Événements récents
                </span>
                <div className="mt-1.5 space-y-1">
                  {events.map((ev: MemoryEvent, i: number) => {
                    const d    = new Date(ev.ts * 1000)
                    const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
                    return (
                      <div key={i} className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
                        <span className="font-mono text-muted-foreground/40">{time}</span>
                        <Badge tone={ev.type === 'auto_evict' ? 'warning' : 'primary'}>
                          {ev.type.replace('_', ' ')}
                        </Badge>
                        <span className="text-foreground font-medium truncate max-w-[180px]">{ev.model_id}</span>
                        <span className="truncate">{ev.reason}</span>
                        <span className="text-theme-green shrink-0">-{formatMB(ev.freed_mb)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
