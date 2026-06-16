import { useState } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, ChevronUp, Play, Pencil, Power, PowerOff, Trash2 } from 'lucide-react'
import type { ActiveSlot, ModelSchedule } from '../../../api/admin'
import {
  useDeleteScheduleMutation,
  useTriggerScheduleMutation,
  useUpdateScheduleMutation,
} from '../../../api/queries'
import { Badge, StatusDot } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ActionBadge } from './ActionBadge'
import { ScheduleForm } from './ScheduleForm'
import { cronToReadable, formatDate } from './helpers'

const LBL = 'text-[10px] uppercase tracking-widest text-muted-foreground font-medium'

type Props = {
  schedule: ModelSchedule
  activeSlot: ActiveSlot | null
}

export function ScheduleRow({ schedule, activeSlot }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const trigger = useTriggerScheduleMutation()
  const toggle = useUpdateScheduleMutation()
  const del = useDeleteScheduleMutation()
  const isActive = activeSlot?.schedule_id === schedule.id

  const handleDelete = () => {
    if (confirm(`Supprimer "${schedule.name}" ?`)) del.mutate(schedule.id)
  }

  return (
    <li
      className={clsx(
        'rounded-lg border bg-background transition-colors',
        isActive
          ? 'border-theme-green/50 ring-1 ring-theme-green/30'
          : 'border-border/60 hover:border-border',
      )}
    >
      {/* Top row */}
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <StatusDot tone={schedule.enabled ? 'success' : 'muted'} pulse={isActive} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-[12px] font-semibold text-foreground truncate m-0">{schedule.name}</h3>
              {isActive && <Badge tone="success">actif</Badge>}
              {!schedule.enabled && <Badge tone="muted">désactivé</Badge>}
            </div>
            <p className="text-[10px] text-muted-foreground/80 mt-0.5 m-0 truncate">
              <span className="font-mono tabular-nums">{cronToReadable(schedule.cron_start, schedule.duration_minutes)}</span>
              {' · '}
              <span className="font-mono">{schedule.timezone}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="subtle"
            size="sm"
            onClick={() => toggle.mutate({ id: schedule.id, data: { enabled: !schedule.enabled } })}
            disabled={toggle.isPending}
            title={schedule.enabled ? 'Désactiver' : 'Activer'}
          >
            {schedule.enabled ? <PowerOff size={11} /> : <Power size={11} />}
            {schedule.enabled ? 'Désactiver' : 'Activer'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => trigger.mutate(schedule.id)}
            disabled={trigger.isPending || !!activeSlot}
            title={activeSlot ? 'Un slot est déjà actif' : 'Déclencher maintenant'}
          >
            <Play size={11} />
            Trigger
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => { setEditing(true); setExpanded(false) }}
            disabled={isActive}
            title="Modifier ce schedule"
          >
            <Pencil size={11} />
            Éditer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setExpanded(v => !v); setEditing(false) }}
            title={expanded ? 'Réduire' : 'Détails'}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </Button>
        </div>
      </div>

      {/* Détails repliables */}
      {expanded && (
        <div className="border-t border-border/40 px-3 py-3 flex flex-col gap-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Exclusif" value={schedule.exclusive ? 'Oui' : 'Non'} />
            <Field label="Consumers" value={schedule.allowed_consumers.join(', ') || '—'} />
            <Field label="Prochain déclenchement" value={formatDate(schedule.next_start_at)} mono />
            <Field
              label="Wait idle"
              value={schedule.guard.wait_idle ? `Oui (${schedule.guard.max_wait_seconds}s)` : 'Non'}
            />
            <Field label="Créé le" value={formatDate(schedule.created_at)} mono />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <span className={LBL}>Actions start</span>
              <div className="flex flex-wrap gap-1.5">
                {schedule.actions_start.map((a, i) => <ActionBadge key={i} action={a} />)}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={LBL}>Actions end</span>
              <div className="flex flex-wrap gap-1.5">
                {schedule.actions_end.map((a, i) => <ActionBadge key={i} action={a} />)}
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={del.isPending || isActive}
              title="Supprimer ce schedule"
            >
              <Trash2 size={11} />
              Supprimer
            </Button>
          </div>
        </div>
      )}

      {/* Form édition inline */}
      {editing && (
        <div className="border-t border-border/40 px-3 py-3">
          <ScheduleForm editSchedule={schedule} onClose={() => setEditing(false)} />
        </div>
      )}
    </li>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className={LBL}>{label}</span>
      <p
        className={clsx(
          'text-[11px] text-foreground mt-0.5 m-0 truncate',
          mono && 'font-mono tabular-nums',
        )}
      >
        {value}
      </p>
    </div>
  )
}
