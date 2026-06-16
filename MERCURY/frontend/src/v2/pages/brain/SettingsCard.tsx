import { useState, useEffect } from 'react'
import { Settings } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { selectCls, inputSmCls } from '../config/shared'
import { useBrainSettings, useSaveBrainSettingsMutation } from '../../../api/queries'

function ThresholdInput({
  label, hint, color, value, onChange,
}: {
  label: string; hint: string; color: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between bg-secondary/40 rounded-lg px-3 py-2 border border-border/40">
      <div className="flex flex-col">
        <span className={`text-[11px] font-medium ${color}`}>{label}</span>
        <span className="text-[10px] text-muted-foreground/60">{hint}</span>
      </div>
      <div className="flex items-center gap-1">
        <input className={inputSmCls} value={value} onChange={e => onChange(e.target.value)} />
        <span className="text-[11px] text-muted-foreground/60">°C</span>
      </div>
    </div>
  )
}

export function SettingsCard() {
  const { data: settings, isLoading } = useBrainSettings()
  const saveMut = useSaveBrainSettingsMutation()
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [thermalAuto, setThermalAuto]   = useState(false)
  const [memoryAuto,  setMemoryAuto]    = useState(false)
  const [perfMode,    setPerfMode]      = useState('none')
  const [thStart,     setThStart]       = useState('75')
  const [thFull,      setThFull]        = useState('90')
  const [thEmergency, setThEmergency]   = useState('95')
  const [thResume,    setThResume]      = useState('60')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (settings && !loaded) {
      setThermalAuto(settings.thermal_auto_start ?? false)
      setMemoryAuto(settings.memory_auto_start ?? false)
      setPerfMode(settings.perf_mode ?? 'none')
      const t = settings.thermal_thresholds
      if (t) {
        setThStart(String(t.throttle_start_c ?? 75))
        setThFull(String(t.throttle_full_c ?? 90))
        setThEmergency(String(t.emergency_c ?? 95))
        setThResume(String(t.resume_c ?? 60))
      }
      setLoaded(true)
    }
  }, [settings, loaded])

  const mark = () => { setDirty(true); setSaved(false) }

  const handleSave = () => {
    saveMut.mutate({
      thermal_auto_start: thermalAuto,
      memory_auto_start:  memoryAuto,
      perf_mode: perfMode === 'none' ? null : perfMode as 'performance' | 'optimized' | 'eco',
      thermal_thresholds: {
        throttle_start_c: parseInt(thStart)     || 75,
        throttle_full_c:  parseInt(thFull)      || 90,
        emergency_c:      parseInt(thEmergency) || 95,
        resume_c:         parseInt(thResume)    || 60,
      },
    }, {
      onSuccess: () => { setSaved(true); setDirty(false) },
    })
  }

  return (
    <Card>
      <CardHeader
        title="Config persistante"
        icon={<Settings size={13} />}
        right={
          <div className="flex items-center gap-2">
            {dirty && <span className="text-[10px] text-theme-amber">Modifications non sauvegardées</span>}
            {saved && <span className="text-[10px] text-theme-green">Sauvegardé</span>}
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saveMut.isPending || !loaded || !dirty}>
              {saveMut.isPending ? '…' : 'Sauvegarder'}
            </Button>
          </div>
        }
      />
      <CardBody>
        {isLoading && <div className="flex justify-center py-4"><Spinner size={16} /></div>}
        {loaded && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Boot behavior */}
            <div className="flex flex-col gap-3">
              <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest">
                Comportement au boot
              </span>
              <label className="flex items-center gap-2.5 text-[11px] text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={thermalAuto}
                  onChange={e => { setThermalAuto(e.target.checked); mark() }}
                  className="w-4 h-4 rounded border-border bg-background text-primary focus:ring-primary/30"
                />
                Démarrer le thermal controller automatiquement
              </label>
              <label className="flex items-center gap-2.5 text-[11px] text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={memoryAuto}
                  onChange={e => { setMemoryAuto(e.target.checked); mark() }}
                  className="w-4 h-4 rounded border-border bg-background text-primary focus:ring-primary/30"
                />
                Démarrer le memory controller automatiquement
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Mode performance au démarrage
                </span>
                <select
                  value={perfMode}
                  onChange={e => { setPerfMode(e.target.value); mark() }}
                  className={selectCls}
                >
                  <option value="none">Aucun changement</option>
                  <option value="performance">Performance (GPU high, 120W)</option>
                  <option value="turbo">Turbo (GPU auto, 150W)</option>
                  <option value="optimized">Optimized (GPU auto, 120W)</option>
                  <option value="eco">Eco (powersave, 85W)</option>
                </select>
              </div>
            </div>

            {/* Thermal thresholds */}
            <div className="flex flex-col gap-3">
              <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest">
                Seuils thermiques
              </span>
              <div className="grid grid-cols-2 gap-2">
                <ThresholdInput label="Début throttle" hint="Réduction CPU progressive"  color="text-yellow-500"  value={thStart}     onChange={v => { setThStart(v);     mark() }} />
                <ThresholdInput label="Throttle max"   hint="CPU freq minimum"           color="text-orange-500" value={thFull}      onChange={v => { setThFull(v);      mark() }} />
                <ThresholdInput label="Emergency"      hint="SIGSTOP llama-server"       color="text-destructive" value={thEmergency} onChange={v => { setThEmergency(v); mark() }} />
                <ThresholdInput label="Resume"         hint="SIGCONT après emergency"    color="text-primary"    value={thResume}    onChange={v => { setThResume(v);    mark() }} />
              </div>
            </div>
          </div>
        )}
        {saveMut.isError && (
          <p className="mt-3 text-[11px] text-destructive">Erreur : {saveMut.error?.message}</p>
        )}
      </CardBody>
    </Card>
  )
}
