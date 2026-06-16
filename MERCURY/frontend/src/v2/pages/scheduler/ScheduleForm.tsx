import { useState } from 'react'
import { clsx } from 'clsx'
import { Save, X } from 'lucide-react'
import type { ModelSchedule, ScheduleAction } from '../../../api/admin'
import {
  useCreateScheduleMutation,
  useUpdateScheduleMutation,
  useCacheModels,
  useUsers,
} from '../../../api/queries'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Switch'
import {
  ALL_DAYS, EMPTY_FORM, buildCron, computeDurationMinutes,
  scheduleToFormState, modelKey, splitModelKey, type ScheduleFormState,
} from './helpers'

const LBL = 'text-[10px] uppercase tracking-widest text-muted-foreground font-medium'
const INPUT = 'w-full px-2 py-1.5 bg-background border border-border/60 rounded text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40'

type Props = {
  onClose: () => void
  editSchedule?: ModelSchedule
}

export function ScheduleForm({ onClose, editSchedule }: Props) {
  const [f, setF] = useState<ScheduleFormState>(
    editSchedule ? scheduleToFormState(editSchedule) : EMPTY_FORM,
  )
  const create = useCreateScheduleMutation()
  const update = useUpdateScheduleMutation()
  const { data: modelsData } = useCacheModels()
  const { data: usersData } = useUsers()

  // openrouter exclu — slots = modèles locaux uniquement.
  const models = (modelsData?.models || []).filter(m => m.backend && m.backend !== 'openrouter')
  const users = usersData || []

  const duration = computeDurationMinutes(f.start_time, f.end_time)
  const cronExpr = buildCron(f.start_time, f.days)

  // Clés canoniques des modèles dispo dans le cache + celles sélectionnées mais
  // absentes (modèle disparu / non-local) — rendues en chips "orphelins" pour
  // rester visibles et retirables au lieu d'être droppées silencieusement.
  const availableModelKeys = new Set(models.map(m => modelKey(m.backend!, m.name)))
  const orphanModelKeys = f.selected_models.filter(k => !availableModelKeys.has(k))

  const set = <K extends keyof ScheduleFormState>(key: K, val: ScheduleFormState[K]) =>
    setF(prev => ({ ...prev, [key]: val }))

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

  const toggleModel = (name: string) => {
    setF(prev => {
      const sel = prev.selected_models.includes(name)
        ? prev.selected_models.filter(m => m !== name)
        : [...prev.selected_models, name]
      return { ...prev, selected_models: sel }
    })
  }

  const handleSubmit = () => {
    const actions_start: ScheduleAction[] = [
      { type: 'snapshot_state' },
      { type: 'unload_all' },
    ]
    // selected_models contient des clés canoniques `${backend}/${model}` (cf. modelKey).
    // On parse directement la clé → aucune dépendance au cache `models`, donc un modèle
    // sélectionné mais absent du cache n'est PAS droppé silencieusement à l'édition.
    for (const key of f.selected_models) {
      const parsed = splitModelKey(key)
      if (parsed) actions_start.push({ type: 'load', backend: parsed.backend, model: parsed.model })
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

  const submitDisabled = !f.name.trim() || duration <= 0 || create.isPending || update.isPending

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Nom */}
        <div className="flex flex-col gap-1">
          <label className={LBL}>Nom</label>
          <input className={INPUT} value={f.name} onChange={e => set('name', e.target.value)} placeholder="My Schedule" />
        </div>

        {/* Timezone */}
        <div className="flex flex-col gap-1">
          <label className={LBL}>Timezone</label>
          <input className={clsx(INPUT, 'font-mono')} value={f.timezone} onChange={e => set('timezone', e.target.value)} />
        </div>

        {/* Heure début */}
        <div className="flex flex-col gap-1">
          <label className={LBL}>Heure de début</label>
          <input className={clsx(INPUT, 'font-mono tabular-nums')} type="time" value={f.start_time} onChange={e => set('start_time', e.target.value)} />
        </div>

        {/* Heure fin */}
        <div className="flex flex-col gap-1">
          <label className={LBL}>Heure de fin</label>
          <input className={clsx(INPUT, 'font-mono tabular-nums')} type="time" value={f.end_time} onChange={e => set('end_time', e.target.value)} />
        </div>

        {/* Jours */}
        <div className="flex flex-col gap-1 col-span-full">
          <label className={LBL}>Jours</label>
          <div className="flex gap-1.5 mt-1 flex-wrap items-center">
            {ALL_DAYS.map(d => {
              const selected = f.days.includes(d.cron)
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleDay(d.cron)}
                  className={clsx(
                    'w-10 py-1 rounded text-[11px] font-medium border transition-colors',
                    selected
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'bg-background border-border/60 text-muted-foreground hover:text-foreground hover:border-border',
                  )}
                >
                  {d.label}
                </button>
              )
            })}
            {f.days.length === 0 && (
              <span className="text-[10px] text-muted-foreground/70 ml-1">Tous les jours</span>
            )}
          </div>
        </div>

        {/* Résumé */}
        <div className="col-span-full rounded-md border border-border/40 bg-background px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Résumé</span>
          <span className="text-foreground font-mono tabular-nums">{f.start_time} → {f.end_time}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="text-foreground font-mono tabular-nums">{duration} min</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="text-muted-foreground font-mono">{cronExpr}</span>
        </div>

        {/* Modèles à charger (multi) */}
        <div className="flex flex-col gap-1 col-span-full">
          <label className={LBL}>
            Modèles à charger <span className="text-muted-foreground/60 normal-case tracking-normal">(plusieurs possibles · aucun = unload seulement)</span>
          </label>
          {models.length === 0 && orphanModelKeys.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 m-0">Aucun modèle local détecté.</p>
          ) : (
            <div className="flex flex-wrap gap-2 mt-1 max-h-40 overflow-y-auto">
              {models.map(m => {
                const key = modelKey(m.backend!, m.name)
                const selected = f.selected_models.includes(key)
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleModel(key)}
                    className={clsx(
                      'px-2.5 py-1 rounded text-[11px] font-mono border transition-colors',
                      selected
                        ? 'bg-primary/15 border-primary/40 text-primary'
                        : 'bg-background border-border/60 text-muted-foreground hover:text-foreground hover:border-border',
                    )}
                  >
                    {m.name}{m.loaded ? ' ●' : ''}
                  </button>
                )
              })}
              {orphanModelKeys.map(key => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleModel(key)}
                  title="Modèle sélectionné mais absent du cache local — cliquer pour le retirer"
                  className="px-2.5 py-1 rounded text-[11px] font-mono border transition-colors bg-amber-500/10 border-amber-500/40 text-amber-400 hover:border-amber-500/60"
                >
                  {key} ⚠
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Consumers */}
        <div className="flex flex-col gap-1 col-span-full">
          <label className={LBL}>Consumers autorisés</label>
          {users.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 m-0">Aucun user configuré dans Mercury.</p>
          ) : (
            <div className="flex flex-wrap gap-2 mt-1">
              {users.map(u => {
                const selected = f.selected_consumers.includes(u.user_id)
                return (
                  <button
                    key={u.user_id}
                    type="button"
                    onClick={() => toggleConsumer(u.user_id)}
                    className={clsx(
                      'px-2.5 py-1 rounded text-[11px] font-mono border transition-colors',
                      selected
                        ? 'bg-primary/15 border-primary/40 text-primary'
                        : 'bg-background border-border/60 text-muted-foreground hover:text-foreground hover:border-border',
                    )}
                  >
                    {u.user_id}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Options : exclusif + wait idle */}
        <div className="col-span-full flex flex-col gap-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <Switch checked={f.exclusive} onChange={() => set('exclusive', !f.exclusive)} />
            <span className="text-[11px] text-foreground">Slot exclusif <span className="text-muted-foreground/70">(bloque les autres consumers)</span></span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <Switch checked={f.wait_idle} onChange={() => set('wait_idle', !f.wait_idle)} />
              <span className="text-[11px] text-foreground">Attendre que la queue soit vide</span>
            </label>
            {f.wait_idle && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">max</span>
                <input
                  className={clsx(INPUT, 'w-20 font-mono tabular-nums text-center')}
                  type="number"
                  value={f.max_wait_seconds}
                  onChange={e => set('max_wait_seconds', +e.target.value)}
                />
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">s</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {(create.isError || update.isError) && (
        <p className="text-[11px] text-destructive m-0">
          {((create.error || update.error) as Error).message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X size={11} />
          Annuler
        </Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitDisabled}>
          <Save size={11} />
          {(create.isPending || update.isPending)
            ? (editSchedule ? 'Enregistrement…' : 'Création…')
            : (editSchedule ? 'Enregistrer' : 'Créer')}
        </Button>
      </div>
    </div>
  )
}
