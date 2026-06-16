import type { ScheduleAction } from '../../../api/admin'
import { Badge } from '../../ui/Badge'

const TONE_BY_TYPE: Record<string, 'primary' | 'destructive' | 'success' | 'warning' | 'neutral'> = {
  snapshot_state: 'primary',
  restore_state:  'primary',
  unload_all:     'destructive',
  load:           'success',
  unload:         'warning',
}

export function ActionBadge({ action }: { action: ScheduleAction }) {
  const tone = TONE_BY_TYPE[action.type] ?? 'neutral'
  const label = (action.type === 'load' || action.type === 'unload')
    ? `${action.type} ${action.backend}/${action.model}`
    : action.type.replace('_', ' ')
  return <Badge tone={tone} mono>{label}</Badge>
}
