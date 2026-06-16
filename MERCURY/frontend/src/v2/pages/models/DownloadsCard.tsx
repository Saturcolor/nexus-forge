import { Download } from 'lucide-react'
import { clsx } from 'clsx'
import { useHfJobs, useCancelHfJobMutation } from '../../../api/queries'
import type { HfDownloadJob } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'

function fmtBytes(n: number): string {
  if (n < 1024)       return `${n} B`
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtSpeed(bps: number): string {
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
}

const STATE_TONE = {
  queued:    'muted',
  running:   'primary',
  done:      'success',
  cancelled: 'muted',
  error:     'destructive',
} as const

const STATE_LABEL: Record<HfDownloadJob['state'], string> = {
  queued:    'En attente',
  running:   'En cours',
  done:      'Terminé',
  cancelled: 'Annulé',
  error:     'Erreur',
}

function JobRow({ job, onCancel }: { job: HfDownloadJob; onCancel: () => void }) {
  const pct = Math.min(100, Math.max(0, job.pct))
  const canCancel = job.state === 'queued' || (job.state === 'running' && !job.cancel_requested)
  const barColor =
    job.state === 'error'     ? 'bg-destructive'        :
    job.state === 'done'      ? 'bg-theme-green'         :
    job.state === 'cancelled' ? 'bg-muted-foreground/30' :
    'bg-primary'

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 bg-background/60 border border-border/40 rounded-lg">
      <div className="flex items-center gap-2">
        <div className="flex flex-col min-w-0 flex-1">
          <code className="text-[11px] font-mono text-foreground truncate" title={`${job.repo_id}/${job.filename}`}>
            <span className="text-muted-foreground">{job.repo_id}</span>/{job.filename}
          </code>
          <span className="text-[10px] text-muted-foreground/60 mt-0.5">
            {STATE_LABEL[job.state]}
            {job.state === 'running' && <> · {fmtBytes(job.bytes_done)} / {fmtBytes(job.bytes_total)} · {fmtSpeed(job.speed_bps)}</>}
            {job.cancel_requested && ' · annulation…'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge tone={STATE_TONE[job.state]}>{STATE_LABEL[job.state]}</Badge>
          {canCancel && (
            <Button variant="destructive" size="sm" onClick={onCancel}>
              Annuler
            </Button>
          )}
        </div>
      </div>
      <div className="h-1 bg-secondary rounded-full overflow-hidden">
        <div className={clsx('h-full transition-all', barColor)} style={{ width: `${pct}%` }} />
      </div>
      {job.error && (
        <code className="text-[10px] text-destructive font-mono">{job.error}</code>
      )}
    </div>
  )
}

export function DownloadsCard() {
  const { data } = useHfJobs()
  const cancelMut = useCancelHfJobMutation()

  const visible = (data ?? []).filter(j => j.state !== 'done')
  const active  = visible.filter(j => j.state === 'queued' || j.state === 'running')

  return (
    <Card>
      <CardHeader
        title="Téléchargements"
        icon={<Download size={13} />}
        right={
          active.length > 0
            ? <Badge tone="primary" mono>{active.length} actif{active.length > 1 ? 's' : ''}</Badge>
            : <Badge tone="muted">Aucun en cours</Badge>
        }
      />
      <CardBody className="!py-3">
        {visible.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/50 py-6 text-center">
            Aucun téléchargement. Lance une recherche HuggingFace pour télécharger un modèle.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {visible.map(j => (
              <JobRow key={j.id} job={j} onCancel={() => cancelMut.mutate(j.id)} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
