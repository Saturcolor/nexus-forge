import { ScrollText } from 'lucide-react'
import { useRecentLogs } from '../../../api/queries'
import {
  formatLogDateTime,
  formatLogStatus,
  formatDurationMs,
  formatUsageSummary,
} from '../../../utils/format'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'

function statusTone(status: string | undefined | null): 'success' | 'destructive' | 'muted' {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'ok' || /^2\d{2}$/.test(s)) return 'success'
  if (/^[45]\d{2}$/.test(s) || s === 'error') return 'destructive'
  return 'muted'
}

export function RecentLogsCard() {
  const { data: recentLogs = [] } = useRecentLogs()

  return (
    <Card>
      <CardHeader title="Actions récentes" icon={<ScrollText size={13} />} />
      <CardBody>
        {recentLogs.length === 0 ? (
          <p className="text-muted-foreground/60 text-xs">Aucune requête récente.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {recentLogs.slice(0, 8).map((e, i) => (
              <li
                key={`${e.request_id}-${i}`}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 bg-background border border-border/60 rounded-lg hover:bg-secondary/40 transition-colors"
              >
                <span className="text-[12px] text-foreground/90 truncate">
                  <strong className="text-foreground font-medium">{e.user_id ?? '—'}</strong>
                  <span className="mx-1.5 text-muted-foreground/50">·</span>
                  <span>{e.model}</span>
                  <span className="mx-1.5 text-muted-foreground/50">→</span>
                  <span className="text-muted-foreground">{e.backend === '-' ? '—' : e.backend}</span>
                </span>
                <div className="flex items-center gap-2.5 shrink-0">
                  <Badge tone={statusTone(e.status)}>{formatLogStatus(e.status)}</Badge>
                  <span className="text-[10px] text-muted-foreground flex flex-col items-end font-mono">
                    <span>
                      {formatLogDateTime(e.timestamp ?? e.date ?? undefined)} ·{' '}
                      {formatDurationMs(e.duration_ms)}
                    </span>
                    {(e.usage || e.error) && (
                      <span className="mt-0.5">
                        {e.usage && <span>{formatUsageSummary(e.usage, e.duration_ms)}</span>}
                        {e.error && <span className="text-destructive ml-1">{e.error}</span>}
                      </span>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
