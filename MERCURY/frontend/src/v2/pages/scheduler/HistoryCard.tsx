import { History } from 'lucide-react'
import type { ScheduleRun } from '../../../api/admin'
import { useScheduleHistory } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { SpinnerInline } from '../../ui/Spinner'
import { formatDate } from './helpers'

function statusTone(status: string): 'success' | 'destructive' | 'warning' | 'muted' {
  if (status === 'completed') return 'success'
  if (status === 'failed')    return 'destructive'
  if (status === 'pending' || status === 'running') return 'warning'
  return 'muted'
}

function phaseTone(phase: string): 'primary' | 'purple' | 'muted' {
  if (phase === 'start') return 'primary'
  if (phase === 'end')   return 'purple'
  return 'muted'
}

export function HistoryCard() {
  const { data, isLoading } = useScheduleHistory()
  const runs = data?.runs || []

  return (
    <Card>
      <CardHeader
        title="Historique des exécutions"
        icon={<History size={13} />}
        subtitle={runs.length > 0 ? `${runs.length} run${runs.length > 1 ? 's' : ''}` : undefined}
      />
      <CardBody className="!py-3">
        {isLoading && <SpinnerInline />}
        {!isLoading && runs.length === 0 && (
          <p className="text-[11px] text-muted-foreground/60 m-0">Aucun historique.</p>
        )}
        {!isLoading && runs.length > 0 && (
          <div className="overflow-auto rounded-lg border border-border/40 bg-background">
            <table className="w-full min-w-[720px] text-left border-collapse">
              <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                <tr>
                  <Th>Schedule</Th>
                  <Th>Phase</Th>
                  <Th>Status</Th>
                  <Th>Début</Th>
                  <Th>Fin</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((run: ScheduleRun) => (
                  <tr key={run.id} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                    <td className="px-3 py-2 text-[11px] text-foreground font-medium">{run.schedule_name}</td>
                    <td className="px-3 py-2"><Badge tone={phaseTone(run.phase)}>{run.phase}</Badge></td>
                    <td className="px-3 py-2"><Badge tone={statusTone(run.status)}>{run.status}</Badge></td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground font-mono tabular-nums">{formatDate(run.started_at)}</td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground font-mono tabular-nums">{formatDate(run.finished_at)}</td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground/80 font-mono truncate max-w-[280px]">
                      {run.actions_log.join(' → ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-widest border-b border-border/40">
      {children}
    </th>
  )
}
