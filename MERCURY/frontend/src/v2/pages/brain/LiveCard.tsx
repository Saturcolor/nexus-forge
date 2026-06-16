import { useState } from 'react'
import { clsx } from 'clsx'
import { Activity } from 'lucide-react'
import { selectSmCls } from '../config/shared'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge, StatusDot } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { StatTile } from '../../ui/StatTile'
import {
  useBrainThermal, useBrainPerf,
  useBrainThermalStartMutation, useBrainThermalStopMutation,
  useBrainPerfModeMutation, useBrainPerfCustomMutation, useBrainRebootMutation,
} from '../../../api/queries'

// ── Helpers ──────────────────────────────────────────────────────────────────

function tempBarColor(t: number, startC: number, fullC: number): string {
  if (t >= fullC) return 'bg-red-500'
  if (t >= (startC + fullC) / 2) return 'bg-orange-500'
  if (t >= startC) return 'bg-yellow-500'
  return 'bg-emerald-500'
}

function fmtFreq(khz: number | null | undefined): string {
  if (khz == null) return '—'
  return (khz / 1_000_000).toFixed(2)
}

type Tone = 'default' | 'success' | 'warning' | 'destructive' | 'muted'

function powerTone(w: number | null | undefined): Tone {
  if (w == null) return 'muted'
  if (w < 100) return 'success'
  if (w > 160) return 'warning'
  return 'default'
}
function gpuTone(level: string | null | undefined): Tone {
  if (level === 'high') return 'success'
  if (level === 'low')  return 'muted'
  return 'default'
}
function governorTone(g: string | null | undefined): Tone {
  return g === 'performance' ? 'success' : 'default'
}
function thpTone(thp: string | null | undefined): Tone {
  if (!thp) return 'muted'
  if (thp.includes('always'))  return 'success'
  if (thp.includes('madvise')) return 'default'
  return 'muted'
}
function thpLabel(thp: string | null | undefined): string {
  if (!thp) return '—'
  if (thp.includes('always'))  return 'always'
  if (thp.includes('madvise')) return 'madvise'
  return thp
}

// ── Status cell (text state values, no boxy tile) ────────────────────────────

const STATUS_VALUE: Record<string, string> = {
  default:     'text-foreground',
  success:     'text-theme-green',
  warning:     'text-theme-amber',
  destructive: 'text-destructive',
  muted:       'text-muted-foreground',
}

function StatusCell({ label, value, tone = 'default' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-secondary/40 border border-border/40">
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider leading-none">{label}</span>
      <span className={`text-sm font-semibold font-mono leading-tight truncate ${STATUS_VALUE[tone] ?? STATUS_VALUE.default}`}>{value}</span>
    </div>
  )
}

// ── Throttle badge ────────────────────────────────────────────────────────────

function ThrottleBadge({ th }: { th: { level?: string; throttle_pct?: number | null } }) {
  if (th.level === 'emergency') return <Badge tone="destructive">Emergency Stop</Badge>
  if (th.level === 'off')       return <Badge tone="muted">Off</Badge>
  const pct = th.throttle_pct ?? 0
  if (pct === 0)   return <Badge tone="success">Full Perf</Badge>
  if (pct < 70)    return <Badge tone="warning">Throttle {pct}%</Badge>
  return <Badge tone="destructive">Throttle {pct}%</Badge>
}

// ── Perf mode definitions ─────────────────────────────────────────────────────

const PERF_MODES = [
  { id: 'performance', label: 'Perf',      hint: 'GPU high 120W'  },
  { id: 'turbo',       label: 'Turbo',     hint: 'GPU auto 150W'  },
  { id: 'optimized',   label: 'Optimized', hint: 'GPU auto 120W'  },
  { id: 'eco',         label: 'Eco',       hint: 'GPU auto 85W'   },
] as const

// ── Component ─────────────────────────────────────────────────────────────────

export function LiveCard() {
  const { data: th, isLoading: thLoad, isError: thErr } = useBrainThermal()
  const { data: perf } = useBrainPerf()
  const startMut  = useBrainThermalStartMutation()
  const stopMut   = useBrainThermalStopMutation()
  const perfMut   = useBrainPerfModeMutation()
  const customMut = useBrainPerfCustomMutation()
  const rebootMut = useBrainRebootMutation()
  const [rebooting,   setRebooting]   = useState(false)
  const [customWatts, setCustomWatts] = useState('150')
  const [customTctl,  setCustomTctl]  = useState('90')

  const handleReboot = () => {
    if (!confirm('Redémarrer la machine brain ? Tout sera coupé.')) return
    setRebooting(true)
    rebootMut.mutate(undefined, {
      onSettled: () => setTimeout(() => setRebooting(false), 8000),
    })
  }

  const temp        = th?.temp_c
  const currentMode = perf?.current_mode
  return (
    <Card>
      <CardHeader
        title="Brain — Live"
        icon={<Activity size={13} />}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            {th?.running ? (
              <>
                <StatusDot tone="success" pulse />
                <span className="text-[11px] text-theme-green font-medium hidden sm:inline">Thermique actif</span>
                <Button variant="destructive" size="sm" onClick={() => stopMut.mutate()} disabled={stopMut.isPending}>
                  Désactiver
                </Button>
              </>
            ) : (
              <>
                <StatusDot tone="neutral" />
                <span className="text-[11px] text-muted-foreground hidden sm:inline">Thermique inactif</span>
                <Button variant="subtle" size="sm" onClick={() => startMut.mutate()} disabled={startMut.isPending}>
                  Activer
                </Button>
              </>
            )}
            <Button variant="destructive" size="sm" onClick={handleReboot} disabled={rebooting}>
              {rebooting ? 'Reboot…' : 'Reboot'}
            </Button>
          </div>
        }
      />

      <CardBody className="flex flex-col gap-4">

        {/* ── Mode selector row ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Segmented control for presets */}
          <div className="flex items-center bg-secondary rounded-lg border border-border/60 p-0.5 shrink-0">
            {PERF_MODES.map(({ id, label, hint }) => (
              <button
                key={id}
                type="button"
                title={hint}
                onClick={() => perfMut.mutate(id)}
                disabled={perfMut.isPending}
                className={clsx(
                  'px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all whitespace-nowrap',
                  currentMode === id
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground disabled:opacity-40',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Custom controls */}
          <div className="flex items-center gap-1.5">
            <select className={selectSmCls} value={customWatts} onChange={e => setCustomWatts(e.target.value)}>
              {[60, 80, 100, 120, 130, 140, 150, 160, 170, 180, 200].map(w => (
                <option key={w} value={String(w)}>{w}W</option>
              ))}
            </select>
            <select className={selectSmCls} value={customTctl} onChange={e => setCustomTctl(e.target.value)}>
              {[80, 85, 90, 95, 100].map(t => (
                <option key={t} value={String(t)}>{t}°C</option>
              ))}
            </select>
            <Button
              variant={currentMode === 'custom' ? 'primary' : 'subtle'}
              size="sm"
              onClick={() => customMut.mutate({ stapm_w: parseInt(customWatts), tctl_c: parseInt(customTctl) })}
              disabled={customMut.isPending}
            >
              Custom
            </Button>
          </div>
        </div>

        {/* ── Loading / error ───────────────────────────────────────────── */}
        {thLoad && <div className="flex justify-center py-4"><Spinner size={16} /></div>}
        {thErr  && <p className="text-[11px] text-muted-foreground">Brain daemon inaccessible</p>}

        {th && !thLoad && (
          <>
            {/* ── Temperature bar ─────────────────────────────────────── */}
            {temp != null && (
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Température
                    </span>
                    {th.running && <ThrottleBadge th={th} />}
                  </div>
                  <span className="font-mono text-sm font-bold text-foreground">{temp.toFixed(0)}°C</span>
                </div>
                <div className="w-full h-2.5 bg-secondary rounded-full overflow-hidden relative">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${tempBarColor(temp, th.thresholds?.throttle_start_c ?? 65, th.thresholds?.throttle_full_c ?? 85)}`}
                    style={{ width: `${Math.min(100, temp)}%` }}
                  />
                  {th.thresholds && (
                    <>
                      <div className="absolute top-0 h-full w-0.5 bg-yellow-400/50" style={{ left: `${th.thresholds.throttle_start_c}%` }} />
                      <div className="absolute top-0 h-full w-0.5 bg-orange-400/50" style={{ left: `${th.thresholds.throttle_full_c}%` }} />
                      <div className="absolute top-0 h-full w-0.5 bg-red-400/50"    style={{ left: `${th.thresholds.emergency_c}%` }} />
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── Metrics ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              {/* Row 1 — numeric KPIs */}
              <div className="grid grid-cols-3 gap-2">
                <StatTile
                  label="Power"
                  value={th.power_w != null ? `${th.power_w}` : '—'}
                  hint={th.power_w != null ? 'W' : undefined}
                  tone={powerTone(th.power_w)}
                />
                <StatTile
                  label="CPU Freq"
                  value={fmtFreq(th.cpu_freq_khz)}
                  hint={th.cpu_freq_khz != null ? 'GHz' : undefined}
                />
                <StatTile
                  label="Swappiness"
                  value={perf?.swappiness != null ? String(perf.swappiness) : '—'}
                />
              </div>
              {/* Row 2 — state values (text, no box treatment) */}
              <div className="grid grid-cols-3 gap-2">
                <StatusCell label="Governor"  value={th.governor  ?? '—'} tone={governorTone(th.governor)} />
                <StatusCell label="GPU Level" value={th.gpu_level ?? '—'} tone={gpuTone(th.gpu_level)} />
                <StatusCell label="THP"       value={thpLabel(perf?.thp)} tone={thpTone(perf?.thp)} />
              </div>
            </div>

            {th.stopped_pid != null && (
              <p className="text-[11px] text-destructive font-mono animate-pulse">
                llama-server SIGSTOP (pid {th.stopped_pid})
              </p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
