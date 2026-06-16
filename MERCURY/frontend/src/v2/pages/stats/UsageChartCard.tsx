import { useMemo, useState } from 'react'
import { TrendingUp } from 'lucide-react'
import { useStatsRange } from '../../../api/queries'
import type { UsagePoint } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Spinner } from '../../ui/Spinner'
import { formatDurationMs, formatTokenCount } from '../../../utils/format'

type RangeOpt = { label: string; days: number; bucket: 'day' | 'hour' }
const RANGES: RangeOpt[] = [
  { label: '24h', days: 1, bucket: 'hour' },
  { label: '7j', days: 7, bucket: 'day' },
  { label: '15j', days: 15, bucket: 'day' },
  { label: '30j', days: 30, bucket: 'day' },
  { label: '3 mois', days: 90, bucket: 'day' },
  { label: '6 mois', days: 180, bucket: 'day' },
  { label: '1 an', days: 365, bucket: 'day' },
]

type Metric = 'requests' | 'tokens' | 'duration'
const METRICS: { id: Metric; label: string }[] = [
  { id: 'requests', label: 'Requêtes' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'duration', label: 'Durée' },
]

function pointValue(p: UsagePoint, metric: Metric): number {
  if (metric === 'requests') return p.requests
  if (metric === 'tokens') return (p.input_tokens || 0) + (p.output_tokens || 0)
  return p.duration_ms || 0
}

function formatValue(v: number, metric: Metric): string {
  if (metric === 'requests') return String(v)
  if (metric === 'tokens') return formatTokenCount(v)
  return formatDurationMs(v)
}

function formatLabel(t: string, bucket: 'day' | 'hour'): string {
  if (bucket === 'hour') {
    // t = YYYY-MM-DDTHH:00:00Z
    const d = new Date(t)
    return d.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const d = new Date(t + 'T00:00:00Z')
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
}

function formatFullLabel(t: string, bucket: 'day' | 'hour'): string {
  if (bucket === 'hour') {
    const d = new Date(t)
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const d = new Date(t + 'T00:00:00Z')
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function UsageChartCard() {
  const [rangeIdx, setRangeIdx] = useState(1) // 7j par défaut
  const [metric, setMetric] = useState<Metric>('requests')
  const range = RANGES[rangeIdx]
  const { data, isLoading, error } = useStatsRange(range.days, range.bucket)

  const points = data?.points ?? []
  const max = useMemo(() => points.reduce((m, p) => Math.max(m, pointValue(p, metric)), 0), [points, metric])
  const total = useMemo(() => points.reduce((s, p) => s + pointValue(p, metric), 0), [points, metric])

  // Limit X labels for readability
  const labelStep = Math.max(1, Math.ceil(points.length / 10))

  const W = 720
  const H = 200
  const padL = 44
  const padR = 14
  const padT = 14
  const padB = 24
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const n = points.length
  // En-dessous de 45 points : barres ; au-delà : area lissée
  const useArea = n > 45
  const barGap = n > 30 ? 1 : 3
  const barW = n > 0 ? Math.max(1.5, innerW / n - barGap) : 0
  const yScale = (v: number) => (max > 0 ? (v / max) * innerH : 0)

  // Coords pour l'area chart (centre du bucket)
  const areaPts = useMemo(() => {
    if (!useArea || n === 0) return [] as Array<{ x: number; y: number; v: number }>
    return points.map((p, i) => {
      const v = pointValue(p, metric)
      const x = padL + (i + 0.5) * (innerW / n)
      const y = padT + innerH - yScale(v)
      return { x, y, v }
    })
  }, [points, useArea, n, innerW, innerH, metric])

  // Lisseur Catmull-Rom → Bezier pour une courbe douce
  const smoothPath = useMemo(() => {
    if (areaPts.length === 0) return ''
    if (areaPts.length === 1) {
      const p = areaPts[0]
      return `M ${p.x} ${p.y}`
    }
    const d: string[] = [`M ${areaPts[0].x} ${areaPts[0].y}`]
    for (let i = 0; i < areaPts.length - 1; i++) {
      const p0 = areaPts[i - 1] ?? areaPts[i]
      const p1 = areaPts[i]
      const p2 = areaPts[i + 1]
      const p3 = areaPts[i + 2] ?? p2
      const cp1x = p1.x + (p2.x - p0.x) / 6
      const cp1y = p1.y + (p2.y - p0.y) / 6
      const cp2x = p2.x - (p3.x - p1.x) / 6
      const cp2y = p2.y - (p3.y - p1.y) / 6
      d.push(`C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`)
    }
    return d.join(' ')
  }, [areaPts])

  const areaFill = useMemo(() => {
    if (areaPts.length === 0) return ''
    const baseY = padT + innerH
    const first = areaPts[0]
    const last = areaPts[areaPts.length - 1]
    return `M ${first.x} ${baseY} L ${first.x} ${first.y} ${smoothPath.slice(2)} L ${last.x} ${baseY} Z`
  }, [areaPts, smoothPath, padT, innerH])

  const gradId = `chart-grad-${metric}`
  const lineId = `chart-line-${metric}`

  const errMsg = error instanceof Error ? error.message : error ? String(error) : null

  return (
    <Card>
      <CardHeader
        title="Évolution de l'usage"
        icon={<TrendingUp size={13} />}
        subtitle={`Total sur la période : ${formatValue(total, metric)}`}
        right={
          errMsg ? <span className="text-[11px] text-destructive">{errMsg}</span> : undefined
        }
      />
      <CardBody className="flex flex-col gap-3">
        {/* Range tabs */}
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

        {/* Metric toggle */}
        <div className="flex gap-1.5">
          {METRICS.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMetric(m.id)}
              className={
                'px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold border transition-colors ' +
                (metric === m.id
                  ? 'bg-foreground/10 border-foreground/30 text-foreground'
                  : 'bg-transparent border-border/60 text-muted-foreground hover:text-foreground')
              }
            >
              {m.label}
            </button>
          ))}
        </div>

        {isLoading && (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Spinner size={16} />
          </div>
        )}

        {!isLoading && n > 0 && (
          <div className="overflow-x-auto">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="w-full h-[200px] block"
              role="img"
              aria-label="Graphique d'usage"
            >
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" className="text-primary" stopOpacity={0.85} />
                  <stop offset="60%" stopColor="currentColor" className="text-primary" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="currentColor" className="text-primary" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="currentColor" className="text-primary" stopOpacity={0.6} />
                  <stop offset="50%" stopColor="currentColor" className="text-primary" stopOpacity={1} />
                  <stop offset="100%" stopColor="currentColor" className="text-primary" stopOpacity={0.6} />
                </linearGradient>
              </defs>

              {/* Gridlines + Y axis labels */}
              {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                const y = padT + innerH - frac * innerH
                const v = max * frac
                const showLabel = frac === 0 || frac === 0.5 || frac === 1
                return (
                  <g key={frac}>
                    <line
                      x1={padL}
                      x2={W - padR}
                      y1={y}
                      y2={y}
                      stroke="currentColor"
                      className={frac === 0 ? 'text-border/50' : 'text-border/20'}
                      strokeWidth={frac === 0 ? 1 : 0.6}
                      strokeDasharray={frac === 0 ? undefined : '3 4'}
                    />
                    {showLabel && (
                      <text
                        x={padL - 6}
                        y={y + 3}
                        textAnchor="end"
                        className="fill-muted-foreground/70"
                        style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace' }}
                      >
                        {metric === 'requests'
                          ? Math.round(v).toString()
                          : metric === 'tokens'
                          ? formatTokenCount(Math.round(v))
                          : formatDurationMs(Math.round(v))}
                      </text>
                    )}
                  </g>
                )
              })}

              {useArea ? (
                <>
                  <path d={areaFill} fill={`url(#${gradId})`} />
                  <path
                    d={smoothPath}
                    fill="none"
                    stroke={`url(#${lineId})`}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {/* Invisible hover targets per point */}
                  {areaPts.map((p, i) => (
                    <g key={points[i].t}>
                      <circle cx={p.x} cy={p.y} r={1.8} className="fill-primary" opacity={0.9} />
                      <rect
                        x={p.x - innerW / n / 2}
                        y={padT}
                        width={innerW / n}
                        height={innerH}
                        fill="transparent"
                      >
                        <title>{`${formatFullLabel(points[i].t, range.bucket)} — ${formatValue(p.v, metric)}`}</title>
                      </rect>
                    </g>
                  ))}
                </>
              ) : (
                points.map((p, i) => {
                  const v = pointValue(p, metric)
                  const h = yScale(v)
                  const x = padL + i * (innerW / n) + barGap / 2
                  const y = padT + innerH - h
                  const r = Math.min(3, barW / 2, h / 2)
                  return (
                    <g key={p.t}>
                      <rect
                        x={x}
                        y={y}
                        width={barW}
                        height={Math.max(h, v > 0 ? 1.5 : 0)}
                        rx={r}
                        ry={r}
                        fill={`url(#${gradId})`}
                        className="hover:opacity-90 transition-opacity"
                      >
                        <title>{`${formatFullLabel(p.t, range.bucket)} — ${formatValue(v, metric)}`}</title>
                      </rect>
                      {/* Top highlight */}
                      {h > 4 && (
                        <rect
                          x={x}
                          y={y}
                          width={barW}
                          height={1.5}
                          rx={r}
                          className="fill-primary"
                          opacity={0.9}
                        />
                      )}
                    </g>
                  )
                })
              )}

              {/* X labels */}
              {points.map((p, i) => {
                if (i % labelStep !== 0 && i !== n - 1) return null
                const x = useArea
                  ? padL + (i + 0.5) * (innerW / n)
                  : padL + i * (innerW / n) + barW / 2 + barGap / 2
                return (
                  <text
                    key={`l-${p.t}`}
                    x={x}
                    y={H - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground/70"
                    style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace' }}
                  >
                    {formatLabel(p.t, range.bucket)}
                  </text>
                )
              })}
            </svg>
          </div>
        )}

        {!isLoading && n > 0 && max === 0 && (
          <p className="text-[11px] text-muted-foreground m-0">Aucune activité sur cette période.</p>
        )}
      </CardBody>
    </Card>
  )
}
