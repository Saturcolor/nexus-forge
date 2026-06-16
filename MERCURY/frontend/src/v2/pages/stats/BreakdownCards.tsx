import { useMemo, useState } from 'react'
import { PieChart, Flame, Trophy } from 'lucide-react'
import { useStatsRange } from '../../../api/queries'
import type { UsageBreakdown } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Spinner } from '../../ui/Spinner'
import { formatDurationMs, formatTokenCount } from '../../../utils/format'

type Metric = 'requests' | 'tokens' | 'duration'

function pickValue(e: { requests: number; tokens: number; duration_ms: number } | undefined, metric: Metric): number {
  if (!e) return 0
  if (metric === 'requests') return e.requests
  if (metric === 'tokens') return e.tokens
  return e.duration_ms
}

function fmt(v: number, metric: Metric): string {
  if (metric === 'requests') return String(v)
  if (metric === 'tokens') return formatTokenCount(v)
  return formatDurationMs(v)
}

const PALETTE = [
  'oklch(0.72 0.16 215)', // primary-ish blue
  'oklch(0.78 0.16 145)', // green
  'oklch(0.80 0.16 75)',  // amber
  'oklch(0.72 0.18 0)',   // red
  'oklch(0.74 0.16 295)', // violet
  'oklch(0.78 0.13 195)', // teal
  'oklch(0.76 0.15 50)',  // orange
  'oklch(0.72 0.16 330)', // pink
]

// ──────────────────────────────────────────────────────────────────────────
// Donut chart — répartition par backend
// ──────────────────────────────────────────────────────────────────────────

const RANGES = [
  { label: '7j', days: 7 },
  { label: '30j', days: 30 },
  { label: '90j', days: 90 },
]

type DonutSlice = { label: string; value: number; color: string }

function Donut({ slices, total, metric }: { slices: DonutSlice[]; total: number; metric: Metric }) {
  const size = 180
  const cx = size / 2
  const cy = size / 2
  const r = 70
  const innerR = 46
  let acc = 0
  const arcs = slices.map((s, i) => {
    const frac = total > 0 ? s.value / total : 0
    const a0 = acc * 2 * Math.PI - Math.PI / 2
    acc += frac
    const a1 = acc * 2 * Math.PI - Math.PI / 2
    const large = a1 - a0 > Math.PI ? 1 : 0
    const x0 = cx + r * Math.cos(a0)
    const y0 = cy + r * Math.sin(a0)
    const x1 = cx + r * Math.cos(a1)
    const y1 = cy + r * Math.sin(a1)
    const ix0 = cx + innerR * Math.cos(a0)
    const iy0 = cy + innerR * Math.sin(a0)
    const ix1 = cx + innerR * Math.cos(a1)
    const iy1 = cy + innerR * Math.sin(a1)
    const d = [
      `M ${x0} ${y0}`,
      `A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
      `L ${ix1} ${iy1}`,
      `A ${innerR} ${innerR} 0 ${large} 0 ${ix0} ${iy0}`,
      'Z',
    ].join(' ')
    return { d, color: s.color, label: s.label, value: s.value, frac, key: `${s.label}-${i}` }
  })
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="block" style={{ width: size, height: size }}>
      {total === 0 && (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" className="text-border/40" strokeWidth={2} />
      )}
      {arcs.map(a => (
        <path key={a.key} d={a.d} fill={a.color} className="hover:opacity-80 transition-opacity">
          <title>{`${a.label} — ${fmt(a.value, metric)} (${(a.frac * 100).toFixed(0)}%)`}</title>
        </path>
      ))}
      {/* Centre : total */}
      <text x={cx} y={cy - 4} textAnchor="middle" className="fill-foreground" style={{ fontSize: 18, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>
        {fmt(total, metric)}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase' }}>
        Total
      </text>
    </svg>
  )
}

function useBreakdown(days: number) {
  const { data, isLoading } = useStatsRange(days, 'day')
  return { breakdown: data?.breakdown, isLoading }
}

export function BackendDonutCard() {
  const [rangeIdx, setRangeIdx] = useState(1)
  const [metric, setMetric] = useState<Metric>('requests')
  const { breakdown, isLoading } = useBreakdown(RANGES[rangeIdx].days)

  const slices: DonutSlice[] = useMemo(() => {
    if (!breakdown) return []
    const entries = Object.entries(breakdown.by_backend)
      .map(([label, e]) => ({ label, value: pickValue(e, metric) }))
      .filter(s => s.value > 0)
      .sort((a, b) => b.value - a.value)
    return entries.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }))
  }, [breakdown, metric])

  const total = slices.reduce((s, x) => s + x.value, 0)

  return (
    <Card>
      <CardHeader title="Backends" icon={<PieChart size={13} />} subtitle="Répartition par provider" />
      <CardBody className="flex flex-col gap-3">
        <RangeMetricBar
          rangeIdx={rangeIdx}
          setRangeIdx={setRangeIdx}
          metric={metric}
          setMetric={setMetric}
        />
        {isLoading ? (
          <div className="flex justify-center py-6 text-muted-foreground"><Spinner size={16} /></div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-4 items-center">
            <Donut slices={slices} total={total} metric={metric} />
            <ul className="flex-1 flex flex-col gap-1.5 m-0 p-0 list-none w-full">
              {slices.length === 0 && (
                <li className="text-[11px] text-muted-foreground">Aucune activité.</li>
              )}
              {slices.map(s => {
                const pct = total > 0 ? (s.value / total) * 100 : 0
                return (
                  <li key={s.label} className="flex items-center gap-2 text-[11px]">
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                    <span className="text-foreground/90 truncate flex-1">{s.label}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{fmt(s.value, metric)}</span>
                    <span className="font-mono tabular-nums text-muted-foreground w-10 text-right">{pct.toFixed(0)}%</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Heatmap jour × heure
// ──────────────────────────────────────────────────────────────────────────

const DOW_LABELS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']

export function HeatmapCard() {
  const [rangeIdx, setRangeIdx] = useState(1)
  const { breakdown, isLoading } = useBreakdown(RANGES[rangeIdx].days)

  const grid = breakdown?.by_dow_hour ?? Array.from({ length: 7 }, () => Array(24).fill(0))
  const max = Math.max(1, ...grid.flat())

  // Layout
  const cell = 14
  const gap = 2
  const labelW = 32
  const labelH = 16
  const W = labelW + 24 * (cell + gap)
  const H = labelH + 7 * (cell + gap)

  function color(v: number): string {
    if (v <= 0) return 'rgba(255,255,255,0.04)'
    const t = v / max
    // Interpolation simple bleu → cyan vif via opacity de la couleur primaire
    return `oklch(0.72 0.16 215 / ${0.15 + t * 0.85})`
  }

  return (
    <Card>
      <CardHeader title="Heatmap activité" icon={<Flame size={13} />} subtitle="Distribution jour × heure (UTC)" />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRangeIdx(i)}
              className={
                'px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ' +
                (i === rangeIdx
                  ? 'bg-primary/15 border-primary/40 text-primary'
                  : 'bg-background border-border/60 text-muted-foreground hover:text-foreground hover:border-border')
              }
            >
              {r.label}
            </button>
          ))}
        </div>
        {isLoading ? (
          <div className="flex justify-center py-6 text-muted-foreground"><Spinner size={16} /></div>
        ) : (
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 540, height: H }}>
              {/* X labels (heures, toutes les 3h) */}
              {Array.from({ length: 24 }).map((_, h) => {
                if (h % 3 !== 0 && h !== 23) return null
                const x = labelW + h * (cell + gap) + cell / 2
                return (
                  <text
                    key={`xh-${h}`}
                    x={x}
                    y={labelH - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground/70"
                    style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace' }}
                  >
                    {h.toString().padStart(2, '0')}
                  </text>
                )
              })}
              {/* Y labels (jours) + cellules */}
              {grid.map((row, d) => (
                <g key={`row-${d}`}>
                  <text
                    x={labelW - 6}
                    y={labelH + d * (cell + gap) + cell - 3}
                    textAnchor="end"
                    className="fill-muted-foreground/70"
                    style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace' }}
                  >
                    {DOW_LABELS[d]}
                  </text>
                  {row.map((v, h) => (
                    <rect
                      key={`c-${d}-${h}`}
                      x={labelW + h * (cell + gap)}
                      y={labelH + d * (cell + gap)}
                      width={cell}
                      height={cell}
                      rx={2}
                      fill={color(v)}
                    >
                      <title>{`${DOW_LABELS[d]} ${h.toString().padStart(2, '0')}h — ${v} req`}</title>
                    </rect>
                  ))}
                </g>
              ))}
            </svg>
          </div>
        )}
        <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          <span>Moins</span>
          {[0.1, 0.25, 0.5, 0.75, 1].map(t => (
            <span
              key={t}
              className="w-3 h-3 rounded-sm inline-block"
              style={{ background: `oklch(0.72 0.16 215 / ${0.15 + t * 0.85})` }}
            />
          ))}
          <span>Plus</span>
        </div>
      </CardBody>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Top modèles — barres horizontales
// ──────────────────────────────────────────────────────────────────────────

export function TopModelsCard() {
  const [rangeIdx, setRangeIdx] = useState(1)
  const [metric, setMetric] = useState<Metric>('requests')
  const { breakdown, isLoading } = useBreakdown(RANGES[rangeIdx].days)

  const items = useMemo(() => {
    if (!breakdown) return []
    const arr = Object.entries(breakdown.by_model)
      .map(([label, e]) => ({ label, value: pickValue(e, metric) }))
      .filter(x => x.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
    return arr
  }, [breakdown, metric])

  const max = items.reduce((m, x) => Math.max(m, x.value), 0)

  return (
    <Card>
      <CardHeader title="Top modèles" icon={<Trophy size={13} />} subtitle="Classement par activité" />
      <CardBody className="flex flex-col gap-3">
        <RangeMetricBar
          rangeIdx={rangeIdx}
          setRangeIdx={setRangeIdx}
          metric={metric}
          setMetric={setMetric}
        />
        {isLoading ? (
          <div className="flex justify-center py-6 text-muted-foreground"><Spinner size={16} /></div>
        ) : items.length === 0 ? (
          <p className="text-[11px] text-muted-foreground m-0">Aucun modèle utilisé sur cette période.</p>
        ) : (
          <ol className="flex flex-col gap-2 m-0 p-0 list-none">
            {items.map((it, i) => {
              const pct = max > 0 ? (it.value / max) * 100 : 0
              const color = PALETTE[i % PALETTE.length]
              return (
                <li key={it.label} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] font-mono text-muted-foreground w-5 shrink-0">#{i + 1}</span>
                    <span className="text-[11px] text-foreground/90 truncate flex-1">{it.label}</span>
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground shrink-0">{fmt(it.value, metric)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-border/30 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${pct}%`,
                        background: `linear-gradient(90deg, color-mix(in oklch, ${color}, transparent 30%), ${color})`,
                        boxShadow: `0 0 10px -2px ${color}`,
                      }}
                    />
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </CardBody>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Small range/metric selector reused
// ──────────────────────────────────────────────────────────────────────────

function RangeMetricBar({
  rangeIdx,
  setRangeIdx,
  metric,
  setMetric,
}: {
  rangeIdx: number
  setRangeIdx: (i: number) => void
  metric: Metric
  setMetric: (m: Metric) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1.5">
        {RANGES.map((r, i) => (
          <button
            key={r.label}
            type="button"
            onClick={() => setRangeIdx(i)}
            className={
              'px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ' +
              (i === rangeIdx
                ? 'bg-primary/15 border-primary/40 text-primary'
                : 'bg-background border-border/60 text-muted-foreground hover:text-foreground hover:border-border')
            }
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        {(['requests', 'tokens', 'duration'] as Metric[]).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMetric(m)}
            className={
              'px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold border transition-colors ' +
              (metric === m
                ? 'bg-foreground/10 border-foreground/30 text-foreground'
                : 'bg-transparent border-border/60 text-muted-foreground hover:text-foreground')
            }
          >
            {m === 'requests' ? 'Req' : m === 'tokens' ? 'Tok' : 'Dur'}
          </button>
        ))}
      </div>
    </div>
  )
}

// Silence unused-import warning if utility ever needed
export type { UsageBreakdown }
