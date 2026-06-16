import { Gauge } from 'lucide-react'
import type { StatsEntry } from '../../../api/admin'
import { formatDurationMs, formatTokenCount } from '../../../utils/format'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { StatTile } from '../../ui/StatTile'
import { ProgressBar } from '../../ui/Progress'

type SummaryCardProps = {
  stats: StatsEntry
}

export function SummaryCard({ stats }: SummaryCardProps) {
  const hasTokens =
    (stats.total_input_tokens != null && stats.total_input_tokens > 0) ||
    (stats.total_output_tokens != null && stats.total_output_tokens > 0)
  const hasUsage = stats.requests_with_usage != null && stats.requests_with_usage > 0

  const totalTokens =
    (stats.total_input_tokens ?? 0) + (stats.total_output_tokens ?? 0)
  const inputPct =
    totalTokens > 0 ? ((stats.total_input_tokens ?? 0) / totalTokens) * 100 : 0
  const outputPct =
    totalTokens > 0 ? ((stats.total_output_tokens ?? 0) / totalTokens) * 100 : 0

  const usagePct =
    stats.total_requests > 0 && hasUsage
      ? ((stats.requests_with_usage ?? 0) / stats.total_requests) * 100
      : 0

  return (
    <Card>
      <CardHeader
        title="Résumé"
        icon={<Gauge size={13} />}
        subtitle={stats.date}
      />
      <CardBody className="flex flex-col gap-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatTile
            label="Total requêtes"
            value={<span className="font-mono tabular-nums">{stats.total_requests}</span>}
            tone={stats.total_requests > 0 ? 'primary' : 'muted'}
          />
          <StatTile
            label="Durée totale"
            value={<span className="font-mono tabular-nums">{formatDurationMs(stats.total_duration_ms)}</span>}
            tone="default"
          />
          {hasTokens && (
            <>
              <StatTile
                label="Tokens entrée"
                value={<span className="font-mono tabular-nums">{formatTokenCount(stats.total_input_tokens)}</span>}
                tone="default"
              />
              <StatTile
                label="Tokens sortie"
                value={<span className="font-mono tabular-nums">{formatTokenCount(stats.total_output_tokens)}</span>}
                tone="success"
              />
            </>
          )}
          {hasUsage && (
            <StatTile
              label="Requêtes avec usage"
              value={<span className="font-mono tabular-nums">{stats.requests_with_usage}</span>}
              tone="default"
            />
          )}
        </div>

        {hasTokens && totalTokens > 0 && (
          <div className="flex flex-col gap-2 pt-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
                Répartition tokens
              </span>
              <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
                {formatTokenCount(totalTokens)} total
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-14 shrink-0">Entrée</span>
                <ProgressBar value={inputPct} tone="primary" thickness="xs" />
                <span className="text-[10px] font-mono tabular-nums text-muted-foreground w-12 text-right shrink-0">
                  {inputPct.toFixed(0)}%
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-14 shrink-0">Sortie</span>
                <ProgressBar value={outputPct} tone="success" thickness="xs" />
                <span className="text-[10px] font-mono tabular-nums text-muted-foreground w-12 text-right shrink-0">
                  {outputPct.toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        )}

        {hasUsage && stats.total_requests > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
                Couverture usage
              </span>
              <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
                {stats.requests_with_usage} / {stats.total_requests}
              </span>
            </div>
            <ProgressBar
              value={usagePct}
              tone={usagePct > 80 ? 'success' : usagePct > 40 ? 'primary' : 'warning'}
              thickness="sm"
            />
          </div>
        )}
      </CardBody>
    </Card>
  )
}
