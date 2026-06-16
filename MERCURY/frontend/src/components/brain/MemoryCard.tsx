import { useState, useEffect } from 'react'
import {
  useBrainMemoryStatus,
  useBrainMemoryEvents,
  useBrainMemoryStartMutation,
  useBrainMemoryStopMutation,
  useBrainMemoryConfigMutation,
  useBrainMemoryProtectMutation,
  useBrainMemoryUnprotectMutation,
  useBrainMemoryEvictMutation,
  useBrainMemorySwapClearMutation,
  useSaveBrainSettingsMutation,
} from '../../api/queries'
import type { MemoryPool, MemoryModelInfo, MemoryEvent } from '../../api/admin'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`
const btnGray = `${btn} bg-neutral-700 hover:bg-neutral-600 text-neutral-200`
const btnGreen = `${btn} bg-emerald-600 hover:bg-emerald-500 text-white`
const inputSm = 'w-16 px-1.5 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono text-center focus:outline-none focus:ring-1 focus:ring-blue-500'
const Lbl = ({ children }: { children: React.ReactNode }) => (
  <span className="text-neutral-500 uppercase tracking-wider font-medium text-[10px]">{children}</span>
)

function barColor(pct: number, warnPct: number, evictPct: number, emergPct?: number): string {
  if (emergPct && pct >= emergPct) return 'bg-red-500'
  if (pct >= evictPct) return 'bg-orange-500'
  if (pct >= warnPct) return 'bg-yellow-500'
  return 'bg-emerald-500'
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

function formatIdle(seconds: number): string {
  if (seconds < 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

function PoolBar({ label, pool, thresholds }: {
  label: string
  pool: MemoryPool
  thresholds: { warn: number; evict: number; emergency?: number }
}) {
  const pct = pool.percent
  const color = barColor(pct, thresholds.warn, thresholds.evict, thresholds.emergency)
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center text-xs mb-1">
        <Lbl>{label}</Lbl>
        <span className="font-mono text-sm font-bold text-white">
          {pct.toFixed(1)}% <span className="text-neutral-500 text-[10px] font-normal ml-1">
            {formatMB(pool.used_mb)} / {formatMB(pool.total_mb)}
          </span>
        </span>
      </div>
      <div className="w-full h-2.5 bg-neutral-800 rounded-full overflow-hidden relative">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
        {/* Threshold markers */}
        <div className="absolute top-0 h-full w-0.5 bg-yellow-400/50" style={{ left: `${thresholds.warn}%` }} title={`Warn ${thresholds.warn}%`} />
        <div className="absolute top-0 h-full w-0.5 bg-orange-400/50" style={{ left: `${thresholds.evict}%` }} title={`Evict ${thresholds.evict}%`} />
        {thresholds.emergency != null && (
          <div className="absolute top-0 h-full w-0.5 bg-red-400/50" style={{ left: `${thresholds.emergency}%` }} title={`Emergency ${thresholds.emergency}%`} />
        )}
      </div>
    </div>
  )
}

function badge(bg: string, text: string, border: string) {
  return `px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${bg} ${text} border ${border}`
}

export function MemoryCard() {
  const { data: status, isLoading, isError } = useBrainMemoryStatus()
  const { data: eventsResp } = useBrainMemoryEvents()
  const startMut = useBrainMemoryStartMutation()
  const stopMut = useBrainMemoryStopMutation()
  const configMut = useBrainMemoryConfigMutation()
  const protectMut = useBrainMemoryProtectMutation()
  const unprotectMut = useBrainMemoryUnprotectMutation()
  const evictMut = useBrainMemoryEvictMutation()
  const swapClearMut = useBrainMemorySwapClearMutation()
  const saveBrainMut = useSaveBrainSettingsMutation()

  // Threshold editing
  const [thresholds, setThresholds] = useState<Record<string, number>>({})
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (status?.thresholds && !loaded) {
      setThresholds(status.thresholds)
      setLoaded(true)
    }
  }, [status, loaded])

  const updateTh = (key: string, val: string) => {
    setThresholds(prev => ({ ...prev, [key]: parseFloat(val) || 0 }))
    setDirty(true)
    setSaved(false)
  }

  const handleSave = () => {
    // 1. Push to daemon runtime
    configMut.mutate(thresholds, {
      onSuccess: () => { setSaved(true); setDirty(false) },
    })
    // 2. Persist in Mercury DB (survives daemon restart)
    saveBrainMut.mutate({ memory_thresholds: thresholds } as any)
  }

  const handleToggleProtect = (model: MemoryModelInfo) => {
    if (model.protected) {
      unprotectMut.mutate(model.model_id)
    } else {
      protectMut.mutate(model.model_id)
    }
  }

  const handleEvict = (modelId: string) => {
    if (confirm(`Evicter ${modelId} ?`)) {
      evictMut.mutate(modelId)
    }
  }

  const events = (eventsResp?.events ?? []).slice(-5).reverse()

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Memory — Dual Pool</h2>
        <div className="flex items-center gap-2">
          {status?.running ? (
            <>
              <span className={badge('bg-emerald-500/20', 'text-emerald-400', 'border-emerald-500/30')}>Running</span>
              <button className={btnGray} onClick={() => stopMut.mutate()} disabled={stopMut.isPending}>
                {stopMut.isPending ? '...' : 'Stop'}
              </button>
            </>
          ) : (
            <>
              <span className={badge('bg-neutral-500/20', 'text-neutral-400', 'border-neutral-500/30')}>Stopped</span>
              <button className={btnGreen} onClick={() => startMut.mutate()} disabled={startMut.isPending}>
                {startMut.isPending ? '...' : 'Start'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        {isLoading && <p className="text-xs text-neutral-500">Chargement...</p>}
        {isError && <p className="text-xs text-neutral-500">Daemon inaccessible</p>}

        {status && !isLoading && (
          <>
            {/* Pool bars */}
            <PoolBar
              label="RAM"
              pool={status.ram}
              thresholds={{
                warn: thresholds.ram_warn_percent ?? status?.thresholds?.ram_warn_percent ?? 75,
                evict: thresholds.ram_evict_percent ?? status?.thresholds?.ram_evict_percent ?? 85,
                emergency: thresholds.ram_emergency_percent ?? status?.thresholds?.ram_emergency_percent ?? 93,
              }}
            />
            {/* VRAM: display-only, no eviction thresholds (should stay full) */}
            {status.vram.total_mb > 0 && (
              <div className="mb-3">
                <div className="flex justify-between items-center text-xs mb-1">
                  <Lbl>VRAM</Lbl>
                  <span className="font-mono text-sm font-bold text-white">
                    {status.vram.percent.toFixed(1)}% <span className="text-neutral-500 text-[10px] font-normal ml-1">
                      {formatMB(status.vram.used_mb)} / {formatMB(status.vram.total_mb)}
                    </span>
                  </span>
                </div>
                <div className="w-full h-2.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all bg-blue-500" style={{ width: `${Math.min(100, status.vram.percent)}%` }} />
                </div>
              </div>
            )}

            {/* Swap: display-only, red warning when active */}
            {(status.ram.swap_total_mb ?? 0) > 0 && (() => {
              const swapPct = status.ram.swap_percent ?? 0
              const swapUsed = status.ram.swap_used_mb ?? 0
              const swapTotal = status.ram.swap_total_mb ?? 0
              return (
                <div className="mb-3">
                  <div className="flex justify-between items-center text-xs mb-1">
                    <div className="flex items-center gap-2">
                      <Lbl>SWAP</Lbl>
                      {swapUsed > 0 && (
                        <button
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-neutral-700 hover:bg-neutral-600 text-neutral-200 transition-colors cursor-pointer disabled:opacity-40"
                          onClick={() => swapClearMut.mutate()}
                          disabled={swapClearMut.isPending}
                          title="swapoff -a && swapon -a"
                        >
                          {swapClearMut.isPending ? 'Clearing...' : 'Clear'}
                        </button>
                      )}
                    </div>
                    <span className="font-mono text-sm font-bold text-white">
                      {swapPct.toFixed(1)}% <span className="text-neutral-500 text-[10px] font-normal ml-1">
                        {formatMB(swapUsed)} / {formatMB(swapTotal)}
                      </span>
                    </span>
                  </div>
                  <div className="w-full h-2 bg-neutral-800 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${swapPct > 10 ? 'bg-red-500' : swapPct > 0 ? 'bg-orange-500' : 'bg-neutral-600'}`} style={{ width: `${Math.min(100, swapPct)}%` }} />
                  </div>
                </div>
              )
            })()}

            {/* Models table */}
            {status.models.length > 0 && (
              <div className="mt-3">
                <Lbl>Modeles charges</Lbl>
                <div className="mt-1.5 space-y-0">
                  {status.models.map((m: MemoryModelInfo) => (
                    <div key={m.model_id} className="flex items-center justify-between py-2 border-b border-neutral-800 last:border-b-0">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {/* Pin checkbox */}
                        <button
                          className={`w-4 h-4 rounded border flex items-center justify-center text-[8px] cursor-pointer
                            ${m.protected
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'bg-neutral-800 border-neutral-600 text-transparent hover:border-neutral-400'
                            }`}
                          onClick={() => handleToggleProtect(m)}
                          disabled={protectMut.isPending || unprotectMut.isPending}
                          title={m.protected ? 'Unpin' : 'Pin (protect from eviction)'}
                        >
                          {m.protected ? '✓' : ''}
                        </button>
                        {/* Model name */}
                        <span className="text-xs text-white font-medium truncate">{m.model_id}</span>
                        {m.thermal_stopped && (
                          <span className={badge('bg-orange-500/20', 'text-orange-400', 'border-orange-500/30')}>paused</span>
                        )}
                        {m.idle_seconds >= 0 && m.idle_seconds < 5 && (
                          <span className={badge('bg-emerald-500/20', 'text-emerald-400', 'border-emerald-500/30')}>active</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-[10px] text-neutral-400 font-mono">
                        <span title="VRAM delta">V {formatMB(m.vram_delta_mb)}</span>
                        <span title="RAM (delta mesure au load)">R {formatMB(m.ram_display_mb || m.ram_delta_mb || m.ram_estimated_mb)}</span>
                        <span title="Load order">#{m.load_order}</span>
                        <span title="Idle time">{formatIdle(m.idle_seconds)}</span>
                        <button
                          className="text-red-400 hover:text-red-300 cursor-pointer px-1"
                          onClick={() => handleEvict(m.model_id)}
                          disabled={evictMut.isPending}
                          title="Evicter"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Thresholds */}
            <div className="mt-4 pt-3 border-t border-neutral-800">
              <div className="flex items-center justify-between mb-2">
                <Lbl>Seuils</Lbl>
                <div className="flex items-center gap-2">
                  {dirty && <span className="text-[10px] text-orange-400">Modifie</span>}
                  {saved && <span className="text-[10px] text-emerald-400">OK</span>}
                  <button className={btnBlue} onClick={handleSave} disabled={configMut.isPending || !dirty}>
                    {configMut.isPending ? '...' : 'Save'}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[10px]">
                {[
                  { key: 'ram_warn_percent', label: 'RAM warn' },
                  { key: 'ram_evict_percent', label: 'RAM evict' },
                  { key: 'ram_emergency_percent', label: 'RAM emerg' },
                  { key: 'swap_flush_percent', label: 'Swap flush' },
                ].map(({ key, label }) => (
                  <div key={key} className="flex flex-col gap-0.5">
                    <span className="text-neutral-500">{label}</span>
                    <input
                      className={inputSm}
                      type="number"
                      value={thresholds[key] ?? status?.thresholds?.[key] ?? ''}
                      onChange={e => updateTh(key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Events */}
            {events.length > 0 && (
              <div className="mt-4 pt-3 border-t border-neutral-800">
                <Lbl>Evenements recents</Lbl>
                <div className="mt-1.5 space-y-1">
                  {events.map((ev: MemoryEvent, i: number) => {
                    const d = new Date(ev.ts * 1000)
                    const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
                    const typeBadge = ev.type === 'auto_evict'
                      ? badge('bg-orange-500/20', 'text-orange-400', 'border-orange-500/30')
                      : badge('bg-blue-500/20', 'text-blue-400', 'border-blue-500/30')
                    return (
                      <div key={i} className="flex items-center gap-2 text-[10px] text-neutral-400">
                        <span className="font-mono text-neutral-500">{time}</span>
                        <span className={typeBadge}>{ev.type.replace('_', ' ')}</span>
                        <span className="text-white font-medium truncate max-w-[180px]">{ev.model_id}</span>
                        <span className="truncate">{ev.reason}</span>
                        <span className="text-emerald-400 shrink-0">-{formatMB(ev.freed_mb)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
