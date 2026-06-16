import { XCircle, Activity, Cloud, Clock, Hourglass, Sigma } from 'lucide-react'
import { useQueue, useCancelQueueMutation } from '../../../api/queries'
import { clsx } from 'clsx'

type Tone = 'primary' | 'warning' | 'muted' | 'success'

const TONE_RING: Record<Tone, string> = {
  primary: 'ring-1 ring-primary/20 bg-primary/[0.04]',
  warning: 'ring-1 ring-theme-amber/25 bg-theme-amber/[0.04]',
  success: 'ring-1 ring-theme-green/25 bg-theme-green/[0.04]',
  muted:   'bg-card',
}
const TONE_VALUE: Record<Tone, string> = {
  primary: 'text-primary',
  warning: 'text-theme-amber',
  success: 'text-theme-green',
  muted:   'text-foreground',
}
const TONE_ICON: Record<Tone, string> = {
  primary: 'text-primary',
  warning: 'text-theme-amber',
  success: 'text-theme-green',
  muted:   'text-muted-foreground/60',
}

function QueueLaneCell({
  icon, lane, inFlight, processed, queueSize, pulse, tone,
  current, onCancel, cancelPending,
}: {
  icon: React.ReactNode
  lane: 'Local' | 'Cloud'
  inFlight: number
  processed: number
  queueSize?: number
  pulse?: boolean
  tone: Tone
  current?: { model?: string; user_id?: string } | null
  onCancel?: () => void
  cancelPending?: boolean
}) {
  return (
    <div className={clsx('flex items-center gap-3 px-4 py-3 rounded-xl border border-border/40', TONE_RING[tone])}>
      <span className={clsx('shrink-0', TONE_ICON[tone], pulse && 'animate-pulse')}>{icon}</span>
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {lane}
          </span>
          {queueSize != null && queueSize > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-theme-amber">
              <Hourglass size={9} />
              {queueSize} en queue
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-2">
          <span className={clsx('text-xl font-mono font-semibold tabular-nums leading-tight', TONE_VALUE[tone])}>
            {inFlight}
          </span>
          <span className="text-[10px] text-muted-foreground/70 truncate">
            en cours · {processed.toLocaleString()} traité{processed > 1 ? 's' : ''}
          </span>
        </div>
        {current && (
          <span className="text-[10px] text-muted-foreground/60 mt-0.5 truncate font-mono" title={current.model}>
            ▶ {current.model ?? '—'}
            {current.user_id ? ` · ${current.user_id}` : ''}
          </span>
        )}
      </div>
      {current && onCancel && (
        <button
          type="button"
          disabled={cancelPending}
          onClick={onCancel}
          title="Annuler la requête en cours"
          className="shrink-0 p-1.5 rounded-md text-destructive/70 hover:text-destructive hover:bg-destructive/10 disabled:opacity-40 transition-colors"
        >
          <XCircle size={14} />
        </button>
      )}
    </div>
  )
}

function ThresholdCell({ remaining }: { remaining: number }) {
  return (
    <div className={clsx(
      'flex items-center gap-3 px-4 py-3 rounded-xl border border-border/40',
      TONE_RING.warning,
    )}>
      <span className={clsx('shrink-0 animate-pulse', TONE_ICON.warning)}>
        <Clock size={18} />
      </span>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Threshold
        </span>
        <span className={clsx('text-xl font-mono font-semibold tabular-nums leading-tight', TONE_VALUE.warning)}>
          {`${remaining.toFixed(0)}s`}
        </span>
        <span className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">
          priorité active
        </span>
      </div>
    </div>
  )
}

function TotalProcessedCell({ local, cloud }: { local: number; cloud: number }) {
  const total = local + cloud
  return (
    <div className={clsx('flex items-center gap-3 px-4 py-3 rounded-xl border border-border/40', TONE_RING.muted)}>
      <span className={clsx('shrink-0', TONE_ICON.muted)}>
        <Sigma size={18} />
      </span>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Total traité
        </span>
        <span className={clsx('text-xl font-mono font-semibold tabular-nums leading-tight', TONE_VALUE.muted)}>
          {total.toLocaleString()}
        </span>
        <span className="text-[10px] text-muted-foreground/70 mt-0.5 truncate font-mono">
          {local.toLocaleString()} local · {cloud.toLocaleString()} cloud
        </span>
      </div>
    </div>
  )
}

export function ActivityStrip() {
  const { data: queue } = useQueue()
  const cancelMutation = useCancelQueueMutation()

  const localInFlight = queue?.in_progress ?? 0
  const queueSize = queue?.size ?? 0
  const localProcessed = queue?.processed ?? 0
  const cloudInFlight = queue?.cloud_in_progress ?? 0
  const cloudProcessed = queue?.cloud_processed ?? 0
  const thresholdActive = queue?.threshold_active === true
  const thresholdRemaining = queue?.threshold_remaining ?? 0
  const current = queue?.current_request

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <QueueLaneCell
        icon={<Activity size={18} />}
        lane="Local"
        inFlight={localInFlight}
        processed={localProcessed}
        queueSize={queueSize}
        pulse={localInFlight > 0}
        tone={localInFlight > 0 || queueSize > 0 ? 'primary' : 'muted'}
        current={current ?? null}
        onCancel={() => cancelMutation.mutate()}
        cancelPending={cancelMutation.isPending}
      />
      <QueueLaneCell
        icon={<Cloud size={18} />}
        lane="Cloud"
        inFlight={cloudInFlight}
        processed={cloudProcessed}
        pulse={cloudInFlight > 0}
        tone={cloudInFlight > 0 ? 'primary' : 'muted'}
      />
      {thresholdActive
        ? <ThresholdCell remaining={thresholdRemaining} />
        : <TotalProcessedCell local={localProcessed} cloud={cloudProcessed} />
      }
    </div>
  )
}
