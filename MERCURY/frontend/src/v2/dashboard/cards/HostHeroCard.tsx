import { Cpu, Activity, Thermometer, Network, Zap, Gauge } from 'lucide-react'
import { useHostStats, useBrainSettings, useConfig } from '../../../api/queries'
import { Card } from '../../ui/Card'
import { ProgressBar } from '../../ui/Progress'
import { Badge } from '../../ui/Badge'
import { SpinnerInline } from '../../ui/Spinner'

function formatUptime(seconds: number | undefined): string {
  if (seconds == null || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}j`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0 || parts.length === 0) parts.push(`${m}m`)
  return parts.join(' ')
}

function formatMb(n: number | undefined): string {
  if (n == null) return '—'
  return n >= 1024 ? `${(n / 1024).toFixed(1)} Go` : `${n} Mo`
}

function pctOf(used: number | undefined, total: number | undefined): number | null {
  if (used == null || total == null || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)))
}

type ResourceTone = 'primary' | 'success' | 'warning' | 'destructive'

function toneForUsage(pct: number | null): ResourceTone {
  if (pct == null) return 'primary'
  if (pct >= 90) return 'destructive'
  if (pct >= 75) return 'warning'
  return 'success'
}

function ResourceCell({
  icon,
  label,
  value,
  hint,
  pct,
  raw,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
  pct: number | null
  raw?: string
}) {
  const tone = toneForUsage(pct)
  return (
    <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-background/60 border border-border/40">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          <span className="text-primary/70">{icon}</span>
          {label}
        </span>
        {pct != null && (
          <span className={`text-[10px] font-mono tabular-nums ${
            tone === 'destructive' ? 'text-destructive' :
            tone === 'warning' ? 'text-theme-amber' :
            tone === 'success' ? 'text-theme-green' :
            'text-muted-foreground'
          }`}>
            {pct}%
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-lg font-mono font-semibold tabular-nums text-foreground leading-none">{value}</span>
        {hint && <span className="text-[11px] text-muted-foreground/70 truncate">{hint}</span>}
      </div>
      <ProgressBar value={pct ?? 0} tone={tone} thickness="xs" />
      {raw && <span className="text-[10px] text-muted-foreground/50 font-mono">{raw}</span>}
    </div>
  )
}

function ChipKv({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'success' | 'warning' | 'destructive' }) {
  const toneCls =
    tone === 'success' ? 'text-theme-green' :
    tone === 'warning' ? 'text-theme-amber' :
    tone === 'destructive' ? 'text-destructive' :
    'text-foreground'
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-background/40 border border-border/40">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">{label}</span>
      <span className={`text-[11px] font-mono ${toneCls}`}>{value}</span>
    </span>
  )
}

export function HostHeroCard() {
  const { data: stats, isLoading } = useHostStats()
  const { data: config } = useConfig()
  // brain-settings n'est utile que si le daemon llamacpp est joignable.
  const brainEnabled = config?.llamacpp_enabled !== false && Boolean((config?.llamacpp_url ?? '').trim())
  const { data: brainSettings } = useBrainSettings(brainEnabled)

  const cpuPct = stats?.cpu?.percent ?? null
  const gpuPct = stats?.gpu?.percent ?? null
  const ramPct = pctOf(stats?.ram?.used_mb, stats?.ram?.total_mb)
  const vramPct = pctOf(stats?.vram?.used_mb, stats?.vram?.total_mb)

  const ramRaw = stats?.ram?.used_mb != null && stats?.ram?.total_mb != null
    ? `${formatMb(stats.ram.used_mb)} / ${formatMb(stats.ram.total_mb)}` : '—'
  const vramRaw = stats?.vram?.used_mb != null && stats?.vram?.total_mb != null
    ? `${formatMb(stats.vram.used_mb)} / ${formatMb(stats.vram.total_mb)}` : '—'

  const temps = (stats?.temperature && typeof stats.temperature !== 'number') ? stats.temperature : null
  const network = stats?.network
  const brain = stats?.brain

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-primary" />
          <h2 className="text-[11px] font-bold text-foreground uppercase tracking-widest m-0">
            Machine
          </h2>
        </div>
        <div className="flex items-center gap-1.5">
          {stats?.uptime_seconds != null && (
            <Badge tone="muted" mono>Up {formatUptime(stats.uptime_seconds)}</Badge>
          )}
          {brain?.thermal_level != null && brain.thermal_level !== 'off' && (
            <Badge tone={brain.thermal_level === 'emergency' ? 'destructive' : 'success'}>
              {brain.thermal_level === 'emergency' ? 'thermal!' : 'thermal'}
            </Badge>
          )}
        </div>
      </div>

      <div className="px-5 py-4">
        {isLoading && <SpinnerInline />}
        {!isLoading && (
          <>
            {/* Resource grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <ResourceCell
                icon={<Cpu size={11} />}
                label="CPU"
                value={cpuPct != null ? `${cpuPct}%` : '—'}
                hint={temps?.cpu_c != null ? `${temps.cpu_c}°C` : undefined}
                pct={cpuPct}
              />
              <ResourceCell
                icon={<Gauge size={11} />}
                label="GPU"
                value={gpuPct != null ? `${gpuPct}%` : '—'}
                hint={[
                  temps?.gpu_c != null ? `${temps.gpu_c}°C` : null,
                  stats?.gpu?.name ?? null,
                ].filter(Boolean).join(' · ') || undefined}
                pct={gpuPct}
              />
              <ResourceCell
                icon={<Activity size={11} />}
                label="RAM"
                value={ramPct != null ? `${ramPct}%` : '—'}
                pct={ramPct}
                raw={ramRaw}
              />
              <ResourceCell
                icon={<Activity size={11} />}
                label="VRAM"
                value={vramPct != null ? `${vramPct}%` : '—'}
                pct={vramPct}
                raw={vramRaw}
              />
            </div>

            {/* Secondary chips row */}
            <div className="flex flex-wrap gap-1.5 mt-3">
              {temps?.nvme_c != null && (
                <ChipKv label="NVMe" value={`${temps.nvme_c}°C`} tone={temps.nvme_c >= 70 ? 'warning' : 'default'} />
              )}
              {network != null && (network.rx_mb != null || network.tx_mb != null) && (
                <ChipKv
                  label="Net"
                  value={`↓${formatMb(network.rx_mb)} ↑${formatMb(network.tx_mb)}`}
                />
              )}
              {network != null && network.rx_mb == null && (network.rx_mbps != null || network.tx_mbps != null) && (
                <ChipKv
                  label="Net"
                  value={`↓${network.rx_mbps ?? 0} ↑${network.tx_mbps ?? 0} Mbit/s`}
                />
              )}
              {brain?.power_w != null && (
                <ChipKv label="Power" value={`${brain.power_w} W`} />
              )}
              {brain?.governor != null && (
                <ChipKv
                  label="Gov"
                  value={brain.governor === 'performance' ? 'perf' : brain.governor}
                  tone={brain.governor === 'performance' ? 'success' : 'default'}
                />
              )}
              {brain?.gpu_level != null && (
                <ChipKv
                  label="GPU lvl"
                  value={brain.gpu_level}
                  tone={brain.gpu_level === 'high' ? 'success' : 'default'}
                />
              )}
              {brainSettings?.perf_mode && (
                <ChipKv
                  label="Perf"
                  value={brainSettings.perf_mode}
                  tone={
                    brainSettings.perf_mode === 'performance' || brainSettings.perf_mode === 'turbo' ? 'success' :
                    brainSettings.perf_mode === 'eco' ? 'warning' :
                    'default'
                  }
                />
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

// Silence unused warnings for icons reserved for future variants.
void Thermometer
void Network
void Zap
