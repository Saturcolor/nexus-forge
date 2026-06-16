import { Users } from 'lucide-react'
import type { StatsEntry } from '../../../api/admin'
import { formatDurationMs, formatTokenCount } from '../../../utils/format'
import { Card, CardHeader, CardBody } from '../../ui/Card'

type ByUserCardProps = {
  stats: StatsEntry
}

export function ByUserCard({ stats }: ByUserCardProps) {
  const byUser = stats.by_user ?? {}
  const entries = Object.entries(byUser)
  const hasByUser = entries.length > 0
  const hasReasoning =
    stats.total_reasoning_tokens != null && stats.total_reasoning_tokens > 0

  const maxRequests = entries.reduce((m, [, v]) => Math.max(m, v.requests), 0)

  return (
    <Card>
      <CardHeader
        title="Par utilisateur"
        icon={<Users size={13} />}
        subtitle={hasByUser ? `${entries.length} utilisateur(s)` : undefined}
      />
      <CardBody>
        {!hasByUser ? (
          <p className="text-[11px] text-muted-foreground m-0">
            Aucune donnée par utilisateur pour cette date.
          </p>
        ) : (
          <div className="overflow-auto rounded-lg border border-border/40 bg-background">
            <table className="w-full min-w-[500px] text-left border-collapse">
              <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                <tr>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-widest border-b border-border/40">
                    Utilisateur
                  </th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-widest border-b border-border/40 text-right">
                    Requêtes
                  </th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-widest border-b border-border/40 text-right">
                    Durée
                  </th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-widest border-b border-border/40 text-right">
                    Tokens entrée
                  </th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-widest border-b border-border/40 text-right">
                    Tokens sortie
                  </th>
                  {hasReasoning && (
                    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-widest border-b border-border/40 text-right">
                      Tokens reasoning
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {entries.map(([uid, v]) => {
                  const pct = maxRequests > 0 ? (v.requests / maxRequests) * 100 : 0
                  return (
                    <tr key={uid} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                      <td className="px-3 py-2 text-[11px] text-foreground font-medium">{uid}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="block h-1 w-12 rounded-full bg-secondary overflow-hidden shrink-0">
                            <span
                              className="block h-full rounded-full bg-primary"
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span className="font-mono tabular-nums text-[11px] text-foreground w-10 text-right">
                            {v.requests}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-[11px] text-foreground">
                        {formatDurationMs(v.total_duration_ms)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-[11px] text-foreground">
                        {formatTokenCount(v.total_input_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-[11px] text-theme-green">
                        {formatTokenCount(v.total_output_tokens)}
                      </td>
                      {hasReasoning && (
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-[11px] text-muted-foreground">
                          {formatTokenCount(v.total_reasoning_tokens)}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
