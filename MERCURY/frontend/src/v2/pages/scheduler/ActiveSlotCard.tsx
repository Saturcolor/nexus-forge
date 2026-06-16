import { Radio, StopCircle } from 'lucide-react'
import type { ActiveSlot } from '../../../api/admin'
import { useDeactivateSlotMutation } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { formatCountdown, formatDate } from './helpers'

const LBL = 'text-[10px] uppercase tracking-widest text-muted-foreground'

export function ActiveSlotCard({ slot }: { slot: ActiveSlot }) {
  const deactivate = useDeactivateSlotMutation()

  return (
    <Card accent="warning">
      <CardHeader
        title="Slot actif"
        icon={<Radio size={13} className="text-theme-amber" />}
        subtitle={slot.schedule_name}
        right={
          <>
            <Badge tone="warning">en cours</Badge>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deactivate.mutate()}
              disabled={deactivate.isPending}
              title="Forcer l'arrêt du slot actif"
            >
              <StopCircle size={11} />
              {deactivate.isPending ? 'Arrêt…' : 'Forcer l’arrêt'}
            </Button>
          </>
        }
      />
      <CardBody className="flex flex-col gap-3 !py-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <span className={LBL}>Début</span>
            <p className="text-[11px] text-foreground font-mono tabular-nums mt-0.5 m-0">{formatDate(slot.started_at)}</p>
          </div>
          <div>
            <span className={LBL}>Fin</span>
            <p className="text-[11px] text-foreground font-mono tabular-nums mt-0.5 m-0">{formatDate(slot.ends_at)}</p>
          </div>
          <div>
            <span className={LBL}>Temps restant</span>
            <p className="text-[11px] text-theme-amber font-mono tabular-nums mt-0.5 m-0">{formatCountdown(slot.ends_at)}</p>
          </div>
          <div>
            <span className={LBL}>Consumers autorisés</span>
            <p className="text-[11px] text-foreground mt-0.5 m-0">{slot.allowed_consumers.join(', ') || 'aucun'}</p>
          </div>
        </div>
        {slot.snapshot && slot.snapshot.loaded_models.length > 0 && (
          <p className="text-[10px] text-muted-foreground/70 m-0">
            Snapshot sauvegardé : <span className="font-mono">{slot.snapshot.loaded_models.map(m => `${m.backend}/${m.model_id}`).join(', ')}</span>
          </p>
        )}
      </CardBody>
    </Card>
  )
}
