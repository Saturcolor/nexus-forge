import type { ModelSchedule } from '../../../api/admin'

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
  } catch { return iso }
}

export function formatCountdown(endsAt: string): string {
  const diff = new Date(endsAt).getTime() - Date.now()
  if (diff <= 0) return 'expiré'
  const m = Math.floor(diff / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function computeEndTime(startTime: string, durationMinutes: number): string {
  const [sh, sm] = startTime.split(':').map(Number)
  const total = (sh * 60 + sm + durationMinutes) % (24 * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function computeDurationMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  let startMin = sh * 60 + sm
  let endMin = eh * 60 + em
  if (endMin <= startMin) endMin += 24 * 60
  return endMin - startMin
}

/**
 * Identité canonique d'un modèle pour le multi-select des schedules :
 * `${backend}/${model_id}`. Le `name` du cache inclut déjà le préfixe backend
 * pour llamacpp mais PAS pour ollama/lm_studio/vllm/mlx — on normalise pour que
 * la sélection matche les actions `load` (qui stockent {backend, model} et se
 * décodent en `${backend}/${model}`). Sans ça, le round-trip édition cassait
 * pour les backends sans préfixe (chip jamais sélectionné + load droppé au save).
 */
export function modelKey(backend: string, name: string): string {
  const id = name.startsWith(`${backend}/`) ? name.slice(backend.length + 1) : name
  return `${backend}/${id}`
}

/** Inverse de modelKey : `${backend}/${model}` -> { backend, model }. */
export function splitModelKey(key: string): { backend: string; model: string } | null {
  const slash = key.indexOf('/')
  if (slash <= 0 || slash >= key.length - 1) return null
  return { backend: key.slice(0, slash), model: key.slice(slash + 1) }
}

export function buildCron(startTime: string, days: string[]): string {
  const [h, m] = startTime.split(':').map(Number)
  const dow = days.length === 0 || days.length === 7 ? '*' : days.join(',')
  return `${m} ${h} * * ${dow}`
}

export function cronToReadable(cron: string, durationMin: number): string {
  const parts = cron.split(/\s+/)
  if (parts.length < 5) return cron
  const m = parts[0].padStart(2, '0')
  const h = parts[1].padStart(2, '0')
  const startTime = `${h}:${m}`
  const endTime = computeEndTime(startTime, durationMin)
  const dow = parts[4]
  const dayMap: Record<string, string> = { '0': 'Dim', '1': 'Lun', '2': 'Mar', '3': 'Mer', '4': 'Jeu', '5': 'Ven', '6': 'Sam' }
  let dayStr = 'tous les jours'
  if (dow !== '*') {
    dayStr = dow.split(',').map(d => dayMap[d] || d).join(', ')
  }
  return `${startTime} → ${endTime} · ${dayStr}`
}

export const ALL_DAYS = [
  { key: 'mon', label: 'Lun', cron: '1' },
  { key: 'tue', label: 'Mar', cron: '2' },
  { key: 'wed', label: 'Mer', cron: '3' },
  { key: 'thu', label: 'Jeu', cron: '4' },
  { key: 'fri', label: 'Ven', cron: '5' },
  { key: 'sat', label: 'Sam', cron: '6' },
  { key: 'sun', label: 'Dim', cron: '0' },
]

export type ScheduleFormState = {
  name: string
  start_time: string
  end_time: string
  days: string[]
  exclusive: boolean
  selected_consumers: string[]
  timezone: string
  wait_idle: boolean
  max_wait_seconds: number
  selected_models: string[]
}

export const EMPTY_FORM: ScheduleFormState = {
  name: '',
  start_time: '02:00',
  end_time: '04:00',
  days: [],
  exclusive: true,
  selected_consumers: [],
  timezone: 'Europe/Paris',
  wait_idle: true,
  max_wait_seconds: 120,
  selected_models: [],
}

export function scheduleToFormState(schedule: ModelSchedule): ScheduleFormState {
  const parts = schedule.cron_start.split(/\s+/)
  const m = parts[0] || '0'
  const h = parts[1] || '0'
  const dow = parts[4] || '*'
  const start_time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  const end_time = computeEndTime(start_time, schedule.duration_minutes)
  const days = dow === '*' ? [] : dow.split(',')
  const selected_models = schedule.actions_start
    .filter(a => a.type === 'load' && a.backend && a.model)
    .map(a => `${a.backend}/${a.model}`)
  return {
    name: schedule.name,
    start_time,
    end_time,
    days,
    exclusive: schedule.exclusive,
    selected_consumers: schedule.allowed_consumers,
    timezone: schedule.timezone,
    wait_idle: schedule.guard.wait_idle,
    max_wait_seconds: schedule.guard.max_wait_seconds,
    selected_models,
  }
}
