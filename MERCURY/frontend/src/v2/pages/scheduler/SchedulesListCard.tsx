import { CalendarClock, Plus, X } from 'lucide-react'
import type { ActiveSlot, ModelSchedule } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { SpinnerInline } from '../../ui/Spinner'
import { ScheduleForm } from './ScheduleForm'
import { ScheduleRow } from './ScheduleRow'

type Props = {
  schedules: ModelSchedule[]
  activeSlot: ActiveSlot | null
  isLoading: boolean
  showCreate: boolean
  onToggleCreate: () => void
}

export function SchedulesListCard({
  schedules, activeSlot, isLoading, showCreate, onToggleCreate,
}: Props) {
  return (
    <Card>
      <CardHeader
        title="Schedules"
        icon={<CalendarClock size={13} />}
        subtitle={`${schedules.length} configuré${schedules.length > 1 ? 's' : ''}`}
        right={
          <>
            <Badge tone="muted" mono>{schedules.length}</Badge>
            <Button variant="primary" size="sm" onClick={onToggleCreate}>
              {showCreate ? <X size={11} /> : <Plus size={11} />}
              {showCreate ? 'Fermer' : 'Nouveau'}
            </Button>
          </>
        }
      />
      <CardBody className="flex flex-col gap-3 !py-3">
        {showCreate && (
          <div className="rounded-lg border border-border/60 bg-background p-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground m-0 mb-3">
              Nouveau schedule
            </h3>
            <ScheduleForm onClose={onToggleCreate} />
          </div>
        )}

        {isLoading && <SpinnerInline />}

        {!isLoading && schedules.length === 0 && (
          <p className="text-[11px] text-muted-foreground/60 py-2 text-center m-0">
            Aucun schedule configuré. Créez-en un pour automatiser le load/unload de modèles.
          </p>
        )}

        {!isLoading && schedules.length > 0 && (
          <ul className="flex flex-col gap-1.5 list-none p-0 m-0">
            {schedules.map(s => (
              <ScheduleRow key={s.id} schedule={s} activeSlot={activeSlot} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
