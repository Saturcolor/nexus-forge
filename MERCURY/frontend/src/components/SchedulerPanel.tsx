import { useState, useEffect } from 'react'
import {
  useSchedules, useScheduleHistory,
  useCreateScheduleMutation, useUpdateScheduleMutation,
  useDeleteScheduleMutation, useTriggerScheduleMutation,
  useDeactivateSlotMutation, useCacheModels,
} from '../api/queries'
import { useQuery } from '@tanstack/react-query'
import * as api from '../api/admin'
import type { ModelSchedule, ScheduleAction, ActiveSlot, ScheduleRun } from '../api/admin'
import Spinner from './Spinner'

const card = 'bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-5'
const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`
const btnGray = `${btn} bg-neutral-700 hover:bg-neutral-600 text-neutral-200`
const btnRed = `${btn} bg-red-600/80 hover:bg-red-500 text-white`
const btnGreen = `${btn} bg-emerald-600 hover:bg-emerald-500 text-white`
const btnOrange = `${btn} bg-orange-600 hover:bg-orange-500 text-white`
const inputSm = 'px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500'
const lbl = 'text-neutral-500 uppercase tracking-wider font-medium text-[10px]'

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
  } catch { return iso }
}

function formatCountdown(endsAt: string) {
  const diff = new Date(endsAt).getTime() - Date.now()
  if (diff <= 0) return 'expiré'
  const m = Math.floor(diff / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── Active Slot Banner ──────────────────────────────────────────────────────

function ActiveSlotBanner({ slot }: { slot: ActiveSlot }) {
  const deactivate = useDeactivateSlotMutation()
  return (
    <div className="bg-orange-950/50 border border-orange-700/50 rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-orange-500" />
          </span>
          <span className="text-sm font-semibold text-orange-300">Slot actif : {slot.schedule_name}</span>
        </div>
        <button className={btnRed} onClick={() => deactivate.mutate()} disabled={deactivate.isPending}>
          {deactivate.isPending ? 'Arrêt…' : 'Forcer l\'arrêt'}
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div><span className={lbl}>Début</span><p className="text-white mt-0.5">{formatDate(slot.started_at)}</p></div>
        <div><span className={lbl}>Fin</span><p className="text-white mt-0.5">{formatDate(slot.ends_at)}</p></div>
        <div><span className={lbl}>Temps restant</span><p className="text-orange-400 font-mono mt-0.5">{formatCountdown(slot.ends_at)}</p></div>
        <div><span className={lbl}>Consumers autorisés</span><p className="text-white mt-0.5">{slot.allowed_consumers.join(', ') || 'aucun'}</p></div>
      </div>
      {slot.snapshot && slot.snapshot.loaded_models.length > 0 && (
        <div className="text-xs text-neutral-400">
          Snapshot sauvegardé : {slot.snapshot.loaded_models.map(m => `${m.backend}/${m.model_id}`).join(', ')}
        </div>
      )}
    </div>
  )
}

// ── Schedule Card ───────────────────────────────────────────────────────────

function cronToReadable(cron: string, durationMin: number): string {
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

function ScheduleCard({ schedule, activeSlot }: { schedule: ModelSchedule; activeSlot: ActiveSlot | null }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const trigger = useTriggerScheduleMutation()
  const toggle = useUpdateScheduleMutation()
  const del = useDeleteScheduleMutation()
  const isActive = activeSlot?.schedule_id === schedule.id

  return (
    <div className={`${card} ${isActive ? 'ring-1 ring-orange-500/50' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${schedule.enabled ? 'bg-emerald-500' : 'bg-neutral-600'}`} />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">{schedule.name}</h3>
            <p className="text-xs text-neutral-500 mt-0.5">{cronToReadable(schedule.cron_start, schedule.duration_minutes)} · <span className="font-mono">{schedule.timezone}</span></p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isActive && <span className="text-[10px] font-medium text-orange-400 uppercase tracking-wider">actif</span>}
          <button
            className={schedule.enabled ? btnGray : btnGreen}
            onClick={() => toggle.mutate({ id: schedule.id, data: { enabled: !schedule.enabled } })}
            disabled={toggle.isPending}
          >
            {schedule.enabled ? 'Désactiver' : 'Activer'}
          </button>
          <button
            className={btnOrange}
            onClick={() => trigger.mutate(schedule.id)}
            disabled={trigger.isPending || !!activeSlot}
            title={activeSlot ? 'Un slot est déjà actif' : 'Déclencher maintenant'}
          >
            Trigger
          </button>
          <button
            className={btnGray}
            onClick={() => { setEditing(true); setExpanded(false) }}
            disabled={isActive}
            title="Modifier ce schedule"
          >
            Éditer
          </button>
          <button className={btnGray} onClick={() => { setExpanded(!expanded); setEditing(false) }}>
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-neutral-800 pt-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <div><span className={lbl}>Exclusif</span><p className="text-white mt-0.5">{schedule.exclusive ? 'Oui' : 'Non'}</p></div>
            <div><span className={lbl}>Consumers</span><p className="text-white mt-0.5">{schedule.allowed_consumers.join(', ') || '—'}</p></div>
            <div><span className={lbl}>Prochain déclenchement</span><p className="text-white mt-0.5">{formatDate(schedule.next_start_at)}</p></div>
            <div><span className={lbl}>Wait idle</span><p className="text-white mt-0.5">{schedule.guard.wait_idle ? `Oui (${schedule.guard.max_wait_seconds}s)` : 'Non'}</p></div>
            <div><span className={lbl}>Créé le</span><p className="text-white mt-0.5">{formatDate(schedule.created_at)}</p></div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <span className={lbl}>Actions start</span>
              <div className="mt-1 space-y-1">
                {schedule.actions_start.map((a, i) => <ActionBadge key={i} action={a} />)}
              </div>
            </div>
            <div>
              <span className={lbl}>Actions end</span>
              <div className="mt-1 space-y-1">
                {schedule.actions_end.map((a, i) => <ActionBadge key={i} action={a} />)}
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              className={btnRed}
              onClick={() => { if (confirm(`Supprimer "${schedule.name}" ?`)) del.mutate(schedule.id) }}
              disabled={del.isPending || isActive}
            >
              Supprimer
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="mt-4 border-t border-neutral-800 pt-4">
          <ScheduleForm editSchedule={schedule} onClose={() => setEditing(false)} />
        </div>
      )}
    </div>
  )
}

function ActionBadge({ action }: { action: ScheduleAction }) {
  const colors: Record<string, string> = {
    snapshot_state: 'bg-blue-900/50 text-blue-300 border-blue-800/50',
    restore_state: 'bg-blue-900/50 text-blue-300 border-blue-800/50',
    unload_all: 'bg-red-900/50 text-red-300 border-red-800/50',
    load: 'bg-emerald-900/50 text-emerald-300 border-emerald-800/50',
    unload: 'bg-orange-900/50 text-orange-300 border-orange-800/50',
  }
  const c = colors[action.type] || 'bg-neutral-800 text-neutral-300 border-neutral-700'
  const label = action.type === 'load' || action.type === 'unload'
    ? `${action.type} ${action.backend}/${action.model}`
    : action.type.replace('_', ' ')
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-mono border ${c}`}>{label}</span>
}

// ── Create Schedule Form ────────────────────────────────────────────────────

const ALL_DAYS = [
  { key: 'mon', label: 'Lun', cron: '1' },
  { key: 'tue', label: 'Mar', cron: '2' },
  { key: 'wed', label: 'Mer', cron: '3' },
  { key: 'thu', label: 'Jeu', cron: '4' },
  { key: 'fri', label: 'Ven', cron: '5' },
  { key: 'sat', label: 'Sam', cron: '6' },
  { key: 'sun', label: 'Dim', cron: '0' },
]

function computeDurationMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  let startMin = sh * 60 + sm
  let endMin = eh * 60 + em
  if (endMin <= startMin) endMin += 24 * 60
  return endMin - startMin
}

function computeEndTime(startTime: string, durationMinutes: number): string {
  const [sh, sm] = startTime.split(':').map(Number)
  const total = (sh * 60 + sm + durationMinutes) % (24 * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function buildCron(startTime: string, days: string[]): string {
  const [h, m] = startTime.split(':').map(Number)
  const dow = days.length === 0 || days.length === 7 ? '*' : days.join(',')
  return `${m} ${h} * * ${dow}`
}

const EMPTY_FORM = {
  name: '',
  start_time: '02:00',
  end_time: '04:00',
  days: [] as string[],
  exclusive: true,
  selected_consumers: [] as string[],
  timezone: 'Europe/Paris',
  wait_idle: true,
  max_wait_seconds: 120,
  selected_model: '',
}

function scheduleToFormState(schedule: ModelSchedule): typeof EMPTY_FORM {
  const parts = schedule.cron_start.split(/\s+/)
  const m = parts[0] || '0'
  const h = parts[1] || '0'
  const dow = parts[4] || '*'
  const start_time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  const end_time = computeEndTime(start_time, schedule.duration_minutes)
  const days = dow === '*' ? [] : dow.split(',')
  const loadAction = schedule.actions_start.find(a => a.type === 'load')
  const selected_model = loadAction ? `${loadAction.backend}/${loadAction.model}` : ''
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
    selected_model,
  }
}

function ScheduleForm({ onClose, editSchedule }: { onClose: () => void; editSchedule?: ModelSchedule }) {
  const [f, setF] = useState(editSchedule ? scheduleToFormState(editSchedule) : EMPTY_FORM)
  const create = useCreateScheduleMutation()
  const update = useUpdateScheduleMutation()
  const { data: modelsData } = useCacheModels()
  const { data: usersData } = useQuery({ queryKey: ['users'], queryFn: api.getUsers })

  const models = (modelsData?.models || []).filter(m => m.backend && m.backend !== 'openrouter')
  const users = usersData || []

  const duration = computeDurationMinutes(f.start_time, f.end_time)
  const cronExpr = buildCron(f.start_time, f.days)

  const handleSubmit = () => {
    const actions_start: ScheduleAction[] = [
      { type: 'snapshot_state' },
      { type: 'unload_all' },
    ]
    if (f.selected_model) {
      const entry = models.find(m => m.name === f.selected_model)
      if (entry) {
        const backend = entry.backend!
        const model_id = entry.name.replace(`${backend}/`, '')
        actions_start.push({ type: 'load', backend, model: model_id })
      }
    }
    const actions_end: ScheduleAction[] = [
      { type: 'unload_all' },
      { type: 'restore_state' },
    ]
    const payload = {
      name: f.name,
      cron_start: cronExpr,
      duration_minutes: duration,
      exclusive: f.exclusive,
      allowed_consumers: f.selected_consumers,
      actions_start,
      actions_end,
      guard: { wait_idle: f.wait_idle, max_wait_seconds: f.max_wait_seconds },
      enabled: editSchedule ? editSchedule.enabled : true,
      timezone: f.timezone,
    }
    if (editSchedule) {
      update.mutate({ id: editSchedule.id, data: payload }, { onSuccess: onClose })
    } else {
      create.mutate(payload, { onSuccess: onClose })
    }
  }

  const set = (key: string, val: unknown) => setF(prev => ({ ...prev, [key]: val }))

  const toggleDay = (cronVal: string) => {
    setF(prev => {
      const sel = prev.days.includes(cronVal)
        ? prev.days.filter(d => d !== cronVal)
        : [...prev.days, cronVal]
      return { ...prev, days: sel }
    })
  }

  const toggleConsumer = (uid: string) => {
    setF(prev => {
      const sel = prev.selected_consumers.includes(uid)
        ? prev.selected_consumers.filter(c => c !== uid)
        : [...prev.selected_consumers, uid]
      return { ...prev, selected_consumers: sel }
    })
  }

  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-white mb-4">{editSchedule ? 'Modifier schedule' : 'Nouveau schedule'}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <label className={lbl}>Nom</label>
          <input className={inputSm} value={f.name} onChange={e => set('name', e.target.value)} placeholder="My Schedule" />
        </div>
        <div className="flex flex-col gap-1">
          <label className={lbl}>Timezone</label>
          <input className={inputSm} value={f.timezone} onChange={e => set('timezone', e.target.value)} />
        </div>

        <div className="flex flex-col gap-1">
          <label className={lbl}>Heure de début</label>
          <input className={inputSm} type="time" value={f.start_time} onChange={e => set('start_time', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={lbl}>Heure de fin</label>
          <input className={inputSm} type="time" value={f.end_time} onChange={e => set('end_time', e.target.value)} />
        </div>

        <div className="flex flex-col gap-1 col-span-full">
          <label className={lbl}>Jours</label>
          <div className="flex gap-1.5 mt-1">
            {ALL_DAYS.map(d => {
              const selected = f.days.includes(d.cron)
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleDay(d.cron)}
                  className={`w-10 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
                    selected
                      ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                      : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'
                  }`}
                >
                  {d.label}
                </button>
              )
            })}
            <span className="text-[10px] text-neutral-500 self-center ml-2">
              {f.days.length === 0 ? 'Tous les jours' : ''}
            </span>
          </div>
        </div>

        <div className="col-span-full bg-neutral-800/50 rounded-lg px-3 py-2 flex items-center gap-4 text-xs">
          <span className="text-neutral-400">Résumé :</span>
          <span className="text-white font-mono">{f.start_time} → {f.end_time}</span>
          <span className="text-neutral-500">·</span>
          <span className="text-white">{duration} min</span>
          <span className="text-neutral-500">·</span>
          <span className="text-neutral-400 font-mono">{cronExpr}</span>
        </div>

        <div className="flex flex-col gap-1 col-span-full">
          <label className={lbl}>Modèle à charger</label>
          <select className={inputSm} value={f.selected_model} onChange={e => set('selected_model', e.target.value)}>
            <option value="">— Aucun (unload seulement) —</option>
            {models.map(m => (
              <option key={m.name} value={m.name}>{m.name}{m.loaded ? ' ● chargé' : ''}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 col-span-full">
          <label className={lbl}>Consumers autorisés</label>
          {users.length === 0 ? (
            <p className="text-xs text-neutral-500">Aucun user configuré dans Mercury</p>
          ) : (
            <div className="flex flex-wrap gap-2 mt-1">
              {users.map(u => {
                const selected = f.selected_consumers.includes(u.user_id)
                return (
                  <button
                    key={u.user_id}
                    type="button"
                    onClick={() => toggleConsumer(u.user_id)}
                    className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors cursor-pointer ${
                      selected
                        ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                        : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'
                    }`}
                  >
                    {u.user_id}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 col-span-full">
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={f.exclusive} onChange={e => set('exclusive', e.target.checked)} className="accent-blue-500" />
            <span className="text-xs text-neutral-300">Slot exclusif (bloque les autres consumers)</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={f.wait_idle} onChange={e => set('wait_idle', e.target.checked)} className="accent-blue-500" />
              <span className="text-xs text-neutral-300">Attendre que la queue soit vide</span>
            </div>
            {f.wait_idle && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-neutral-500">max</span>
                <input className={`${inputSm} w-16`} type="number" value={f.max_wait_seconds} onChange={e => set('max_wait_seconds', +e.target.value)} />
                <span className="text-xs text-neutral-500">s</span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button className={btnGray} onClick={onClose}>Annuler</button>
        <button className={btnBlue} onClick={handleSubmit} disabled={!f.name.trim() || duration <= 0 || create.isPending || update.isPending}>
          {(create.isPending || update.isPending) ? (editSchedule ? 'Enregistrement…' : 'Création…') : (editSchedule ? 'Enregistrer' : 'Créer')}
        </button>
      </div>
      {(create.isError || update.isError) && <p className="text-xs text-red-400 mt-2">{((create.error || update.error) as Error).message}</p>}
    </div>
  )
}

// ── History ─────────────────────────────────────────────────────────────────

function HistoryCard() {
  const { data, isLoading } = useScheduleHistory()
  const runs = data?.runs || []

  if (isLoading) return <div className={card}><Spinner /></div>
  if (runs.length === 0) return <div className={card}><p className="text-xs text-neutral-500">Aucun historique</p></div>

  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-white mb-3">Historique des exécutions</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-neutral-500 border-b border-neutral-800">
              <th className="pb-2 pr-3">Schedule</th>
              <th className="pb-2 pr-3">Phase</th>
              <th className="pb-2 pr-3">Status</th>
              <th className="pb-2 pr-3">Début</th>
              <th className="pb-2 pr-3">Fin</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 20).map((run: ScheduleRun) => (
              <tr key={run.id} className="border-b border-neutral-800/50">
                <td className="py-2 pr-3 text-white">{run.schedule_name}</td>
                <td className="py-2 pr-3">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    run.phase === 'start' ? 'bg-blue-900/50 text-blue-300' : 'bg-purple-900/50 text-purple-300'
                  }`}>{run.phase}</span>
                </td>
                <td className="py-2 pr-3">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    run.status === 'completed' ? 'bg-emerald-900/50 text-emerald-300' :
                    run.status === 'failed' ? 'bg-red-900/50 text-red-300' :
                    'bg-yellow-900/50 text-yellow-300'
                  }`}>{run.status}</span>
                </td>
                <td className="py-2 pr-3 text-neutral-400">{formatDate(run.started_at)}</td>
                <td className="py-2 pr-3 text-neutral-400">{formatDate(run.finished_at)}</td>
                <td className="py-2 text-neutral-500 font-mono">{run.actions_log.join(' → ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Loaded Models Banner ───────────────────────────────────────────────────

function LoadedModelsBanner() {
  const { data, refetch } = useCacheModels()
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    api.refreshModelsCache().then(() => refetch())
  }, [])

  const loaded = (data?.models || []).filter(m => m.loaded)

  const handleRefresh = () => {
    setRefreshing(true)
    api.refreshModelsCache().then(() => refetch()).finally(() => setRefreshing(false))
  }

  return (
    <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl px-5 py-3 flex items-center gap-3">
      <span className="text-xs text-neutral-500 shrink-0">Modèles chargés :</span>
      {loaded.length === 0 ? (
        <span className="text-xs text-neutral-600">aucun détecté</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {loaded.map(m => (
            <span key={m.name} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-900/40 text-emerald-300 border border-emerald-800/40">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              {m.name}
            </span>
          ))}
        </div>
      )}
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className={`${btn} ml-auto text-neutral-500 hover:text-neutral-300 text-sm`}
        title="Rafraîchir le cache modèles"
      >
        {refreshing ? '...' : '↻'}
      </button>
    </div>
  )
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export default function SchedulerPanel() {
  const { data, isLoading } = useSchedules()
  const [showCreate, setShowCreate] = useState(false)

  const schedules = data?.schedules || []
  const activeSlot = data?.active_slot || null

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Scheduler</h1>
          <p className="text-xs text-neutral-500 mt-0.5">Gestion des slots de réservation modèle (cron load/unload)</p>
        </div>
        <button className={btnBlue} onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Fermer' : '+ Nouveau schedule'}
        </button>
      </header>

      <LoadedModelsBanner />

      {activeSlot && <ActiveSlotBanner slot={activeSlot} />}

      {showCreate && <ScheduleForm onClose={() => setShowCreate(false)} />}

      {isLoading && <Spinner />}

      {schedules.length === 0 && !isLoading && (
        <div className={card}>
          <p className="text-xs text-neutral-500 text-center py-4">
            Aucun schedule configuré. Créez-en un pour automatiser le load/unload de modèles.
          </p>
        </div>
      )}

      {schedules.map(s => (
        <ScheduleCard key={s.id} schedule={s} activeSlot={activeSlot} />
      ))}

      <HistoryCard />
    </div>
  )
}
