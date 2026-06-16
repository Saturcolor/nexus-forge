import { useState, useEffect, useRef } from 'react'
import {
  useBrainThermal, useBrainPerf, useBrainUpdater, useBrainSettings,
  useBrainThermalStartMutation, useBrainThermalStopMutation,
  useBrainPerfModeMutation, useBrainPerfCustomMutation, useBrainUpdaterActionMutation,
  useSaveBrainSettingsMutation, useLlamacppDaemonLogs, useBrainRebootMutation,
  useLuceboxUpdater, useLuceboxUpdaterLog,
  useLuceboxUpdateMutation, useLuceboxBuildMutation,
  useLlamacppProbe, useLoadLlamacppModelMutation, useUnloadLlamacppModelMutation,
} from '../api/queries'
import type { BrainBackendInfo } from '../api/admin'
import { useConfig } from '../api/queries'
import Spinner from './Spinner'
import AudioLocalCard from './overview/AudioLocalCard'
import { MemoryCard } from './brain/MemoryCard'
import AtlasCard from './brain/AtlasCard'

// ── Shared styles ────────────────────────────────────────────────────────────

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`
const btnGray = `${btn} bg-neutral-700 hover:bg-neutral-600 text-neutral-200`
const btnRed = `${btn} bg-red-600/80 hover:bg-red-500 text-white`
const btnGreen = `${btn} bg-emerald-600 hover:bg-emerald-500 text-white`
const inputSm = 'w-16 px-1.5 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono text-center focus:outline-none focus:ring-1 focus:ring-blue-500'
const selectSm = 'px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500'
const badge = (bg: string, text: string, border: string) => `px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${bg} ${text} border ${border}`

function throttleBadge(th: { level?: string; throttle_pct?: number | null }) {
  if (th.level === 'emergency') return { cls: badge('bg-red-500/20', 'text-red-400', 'border-red-500/30'), label: 'Emergency Stop' }
  if (th.level === 'off') return { cls: badge('bg-neutral-500/20', 'text-neutral-400', 'border-neutral-500/30'), label: 'Off' }
  const pct = th.throttle_pct ?? 0
  if (pct === 0) return { cls: badge('bg-emerald-500/20', 'text-emerald-400', 'border-emerald-500/30'), label: 'Full Perf' }
  if (pct < 30) return { cls: badge('bg-yellow-500/20', 'text-yellow-400', 'border-yellow-500/30'), label: `Throttle ${pct}%` }
  if (pct < 70) return { cls: badge('bg-orange-500/20', 'text-orange-400', 'border-orange-500/30'), label: `Throttle ${pct}%` }
  return { cls: badge('bg-red-500/20', 'text-red-400', 'border-red-500/30'), label: `Throttle ${pct}%` }
}

function tempBarColor(t: number, startC: number, fullC: number): string {
  if (t >= fullC) return 'bg-red-500'
  if (t >= (startC + fullC) / 2) return 'bg-orange-500'
  if (t >= startC) return 'bg-yellow-500'
  return 'bg-emerald-500'
}

function fmtFreq(khz: number | null | undefined): string {
  if (khz == null) return '—'
  return `${(khz / 1_000_000).toFixed(2)} GHz`
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <span className="text-neutral-500 uppercase tracking-wider font-medium text-[10px]">{children}</span>
}
function Val({ children, color }: { children: React.ReactNode; color?: string }) {
  return <span className={`font-mono text-sm font-bold ${color ?? 'text-white'}`}>{children}</span>
}

// ── 1. Live Status ───────────────────────────────────────────────────────────

function LiveStatusCard() {
  const { data: th, isLoading: thLoad, isError: thErr } = useBrainThermal()
  const { data: perf } = useBrainPerf()
  const startMut = useBrainThermalStartMutation()
  const stopMut = useBrainThermalStopMutation()
  const perfMut = useBrainPerfModeMutation()
  const customMut = useBrainPerfCustomMutation()
  const rebootMut = useBrainRebootMutation()
  const [rebooting, setRebooting] = useState(false)
  const [customWatts, setCustomWatts] = useState('150')
  const [customTctl, setCustomTctl] = useState('90')

  const handleReboot = () => {
    if (!confirm('Redemarrer la machine brain ? Tout sera coupe.')) return
    setRebooting(true)
    rebootMut.mutate(undefined, {
      onSettled: () => setTimeout(() => setRebooting(false), 8000),
    })
  }

  const temp = th?.temp_c
  const tb = throttleBadge(th ?? {})
  const currentMode = perf?.current_mode

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Brain — Live</h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* Reboot */}
          <button
            className={btnRed}
            onClick={handleReboot}
            disabled={rebooting}
            title="Redemarrer la machine brain (systemctl reboot)"
          >
            {rebooting ? 'Reboot...' : 'Reboot'}
          </button>
          <span className="text-neutral-700 text-xs">|</span>
          {/* Thermal toggle */}
          {th?.running ? (
            <>
              <span className="text-[10px] text-emerald-400 font-medium">Protection thermique active</span>
              <button className={btnRed} onClick={() => stopMut.mutate()} disabled={stopMut.isPending}>Desactiver</button>
            </>
          ) : (
            <>
              <span className="text-[10px] text-neutral-500 font-medium">Protection thermique inactive</span>
              <button className={btnGreen} onClick={() => startMut.mutate()} disabled={startMut.isPending}>Activer</button>
            </>
          )}
          {/* Perf presets */}
          {(['performance', 'turbo', 'optimized', 'eco'] as const).map(mode => (
            <button key={mode}
              className={currentMode === mode ? btnBlue : btnGray}
              onClick={() => perfMut.mutate(mode)}
              disabled={perfMut.isPending || currentMode === mode}
              title={mode === 'performance' ? 'GPU high 120W' :
                     mode === 'turbo' ? 'GPU auto 150W' :
                     mode === 'optimized' ? 'GPU auto 120W' : 'GPU auto 85W'}
            >
              {mode === 'performance' ? 'Perf' : mode === 'turbo' ? 'Turbo' : mode === 'optimized' ? 'Optimized' : 'Eco'}
            </button>
          ))}
          {/* Custom */}
          <span className="text-neutral-600 text-xs">|</span>
          <select className={selectSm} value={customWatts} onChange={e => setCustomWatts(e.target.value)}>
            {[60, 80, 100, 120, 130, 140, 150, 160, 170, 180, 200].map(w => (
              <option key={w} value={String(w)}>{w}W</option>
            ))}
          </select>
          <select className={selectSm} value={customTctl} onChange={e => setCustomTctl(e.target.value)}>
            {[80, 85, 90, 95, 100].map(t => (
              <option key={t} value={String(t)}>{t}°C</option>
            ))}
          </select>
          <button
            className={currentMode === 'custom' ? btnBlue : btnGray}
            onClick={() => customMut.mutate({ stapm_w: parseInt(customWatts), tctl_c: parseInt(customTctl) })}
            disabled={customMut.isPending}
          >
            Custom
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        {thLoad && <Spinner />}
        {thErr && <p className="text-xs text-neutral-500">Brain daemon inaccessible</p>}
        {th && !thLoad && (
          <>
            {/* Temperature bar */}
            {temp != null && (
              <div className="mb-4">
                <div className="flex justify-between items-center text-xs mb-1">
                  <div className="flex items-center gap-2">
                    <Lbl>Temperature</Lbl>
                    {th.running && <span className={tb.cls}>{tb.label}</span>}
                  </div>
                  <Val>{temp.toFixed(0)}°C</Val>
                </div>
                <div className="w-full h-2.5 bg-neutral-800 rounded-full overflow-hidden relative">
                  <div className={`h-full rounded-full transition-all duration-300 ${tempBarColor(temp, th.thresholds?.throttle_start_c ?? 65, th.thresholds?.throttle_full_c ?? 85)}`}
                    style={{ width: `${Math.min(100, temp)}%` }} />
                  {th.thresholds && <>
                    <div className="absolute top-0 h-full w-0.5 bg-yellow-400/50" style={{ left: `${th.thresholds.throttle_start_c}%` }} />
                    <div className="absolute top-0 h-full w-0.5 bg-orange-400/50" style={{ left: `${th.thresholds.throttle_full_c}%` }} />
                    <div className="absolute top-0 h-full w-0.5 bg-red-400/50" style={{ left: `${th.thresholds.emergency_c}%` }} />
                  </>}
                </div>
              </div>
            )}

            {/* Metrics row */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              <div className="flex flex-col gap-0.5"><Lbl>Power</Lbl><Val>{th.power_w != null ? `${th.power_w}W` : '—'}</Val></div>
              <div className="flex flex-col gap-0.5"><Lbl>CPU Freq</Lbl><Val>{fmtFreq(th.cpu_freq_khz)}</Val></div>
              <div className="flex flex-col gap-0.5"><Lbl>Governor</Lbl><Val color={th.governor === 'performance' ? 'text-emerald-400' : 'text-neutral-400'}>{th.governor ?? '—'}</Val></div>
              <div className="flex flex-col gap-0.5"><Lbl>GPU Level</Lbl><Val color={th.gpu_level === 'high' ? 'text-emerald-400' : 'text-neutral-400'}>{th.gpu_level ?? '—'}</Val></div>
              <div className="flex flex-col gap-0.5"><Lbl>Swappiness</Lbl><Val>{perf?.swappiness ?? '—'}</Val></div>
              <div className="flex flex-col gap-0.5"><Lbl>THP</Lbl><Val>{perf?.thp ? (perf.thp.includes('always') ? 'always' : perf.thp.includes('madvise') ? 'madvise' : perf.thp) : '—'}</Val></div>
            </div>


            {th.stopped_pid != null && (
              <p className="mt-3 text-xs text-red-400 font-mono animate-pulse">llama-server SIGSTOP (pid {th.stopped_pid})</p>
            )}
          </>
        )}
      </div>
    </section>
  )
}

// ── 2. Persistent Settings ───────────────────────────────────────────────────

function SettingsCard() {
  const { data: settings, isLoading } = useBrainSettings()
  const saveMut = useSaveBrainSettingsMutation()
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Form state
  const [thermalAuto, setThermalAuto] = useState(false)
  const [memoryAuto, setMemoryAuto] = useState(false)
  const [perfMode, setPerfMode] = useState('none')
  const [thStart, setThStart] = useState('75')
  const [thFull, setThFull] = useState('90')
  const [thEmergency, setThEmergency] = useState('95')
  const [thResume, setThResume] = useState('60')
  const [loaded, setLoaded] = useState(false)

  // Sync from server once
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

  // Track changes
  const markDirty = () => { setDirty(true); setSaved(false) }

  const handleSave = () => {
    saveMut.mutate({
      thermal_auto_start: thermalAuto,
      memory_auto_start: memoryAuto,
      perf_mode: perfMode === 'none' ? null : perfMode as 'performance' | 'optimized' | 'eco',
      thermal_thresholds: {
        throttle_start_c: parseInt(thStart) || 75,
        throttle_full_c: parseInt(thFull) || 90,
        emergency_c: parseInt(thEmergency) || 95,
        resume_c: parseInt(thResume) || 60,
      },
    }, {
      onSuccess: () => { setSaved(true); setDirty(false) },
    })
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Configuration persistante</h2>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-[10px] text-orange-400">Modifications non sauvegardees</span>}
          <button className={btnBlue} onClick={handleSave} disabled={saveMut.isPending || !loaded}>
            {saveMut.isPending ? '...' : 'Sauvegarder'}
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        {isLoading && <Spinner />}
        {loaded && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left: Boot behavior */}
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Comportement au boot</h3>

              <label className="flex items-center gap-2.5 text-xs text-neutral-300 cursor-pointer">
                <input type="checkbox" checked={thermalAuto}
                  onChange={e => { setThermalAuto(e.target.checked); markDirty() }}
                  className="w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-blue-500" />
                Demarrer le thermal controller automatiquement
              </label>

              <label className="flex items-center gap-2.5 text-xs text-neutral-300 cursor-pointer">
                <input type="checkbox" checked={memoryAuto}
                  onChange={e => { setMemoryAuto(e.target.checked); markDirty() }}
                  className="w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-blue-500" />
                Demarrer le memory controller automatiquement
              </label>

              <div className="flex items-center gap-2.5 text-xs text-neutral-300">
                <span className="shrink-0">Mode performance au demarrage</span>
                <select value={perfMode} onChange={e => { setPerfMode(e.target.value); markDirty() }} className={selectSm}>
                  <option value="none">Aucun changement</option>
                  <option value="performance">Performance (GPU high, 120W)</option>
                  <option value="turbo">Turbo (GPU auto, 150W)</option>
                  <option value="optimized">Optimized (GPU auto, 120W)</option>
                  <option value="eco">Eco (powersave, 85W)</option>
                </select>
              </div>
            </div>

            {/* Right: Thermal thresholds */}
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Seuils thermiques</h3>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center justify-between text-xs text-neutral-300 bg-neutral-950 rounded-lg px-3 py-2 border border-neutral-800">
                  <div className="flex flex-col">
                    <span className="font-medium text-yellow-400">Debut throttle</span>
                    <span className="text-[10px] text-neutral-500">Debut reduction CPU progressive</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <input className={inputSm} value={thStart} onChange={e => { setThStart(e.target.value); markDirty() }} />
                    <span className="text-neutral-500">°C</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-neutral-300 bg-neutral-950 rounded-lg px-3 py-2 border border-neutral-800">
                  <div className="flex flex-col">
                    <span className="font-medium text-orange-400">Throttle max</span>
                    <span className="text-[10px] text-neutral-500">CPU freq minimum atteint</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <input className={inputSm} value={thFull} onChange={e => { setThFull(e.target.value); markDirty() }} />
                    <span className="text-neutral-500">°C</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-neutral-300 bg-neutral-950 rounded-lg px-3 py-2 border border-neutral-800">
                  <div className="flex flex-col">
                    <span className="font-medium text-red-400">Emergency</span>
                    <span className="text-[10px] text-neutral-500">SIGSTOP llama-server</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <input className={inputSm} value={thEmergency} onChange={e => { setThEmergency(e.target.value); markDirty() }} />
                    <span className="text-neutral-500">°C</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-neutral-300 bg-neutral-950 rounded-lg px-3 py-2 border border-neutral-800">
                  <div className="flex flex-col">
                    <span className="font-medium text-sky-400">Resume</span>
                    <span className="text-[10px] text-neutral-500">SIGCONT apres emergency</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <input className={inputSm} value={thResume} onChange={e => { setThResume(e.target.value); markDirty() }} />
                    <span className="text-neutral-500">°C</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {saved && <p className="mt-3 text-xs text-emerald-400">Sauvegarde et applique au brain</p>}
        {saveMut.isError && <p className="mt-3 text-xs text-red-400">Erreur : {saveMut.error?.message}</p>}
      </div>
    </section>
  )
}

// ── 3. Toolboxes ─────────────────────────────────────────────────────────────

function ToolboxRow({ name, info, onAction, busy }: { name: string; info: BrainBackendInfo; onAction: (a: string) => void; busy: boolean }) {
  const isNative = info.type === 'native'
  // Native backends use the registered name (e.g. native-vulkan, native-dflash, native-mtp);
  // toolbox backends keep their toolbox_name for clarity.
  const label = isNative ? name : info.toolbox_name
  const present = isNative ? info.installed : info.exists
  const buildTitle = isNative ? 'Build natif via build-native.sh (fresh clone llama.cpp)' : 'Rebuild depuis Dockerfile (dernier master llama.cpp)'
  const pullTitle = isNative ? 'Update natif (git pull + rebuild)' : 'Pull image pre-buildee Docker Hub'
  const backupTitle = isNative ? 'Sauvegarder le binaire actuel (.bak)' : "Sauvegarder l'image actuelle"
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-neutral-800 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white">{label}</span>
          <span className={badge('bg-neutral-700/30', 'text-neutral-300', 'border-neutral-600/40')}>{info.type}</span>
          <span className={present
            ? badge('bg-emerald-500/20', 'text-emerald-400', 'border-emerald-500/30')
            : badge('bg-red-500/20', 'text-red-400', 'border-red-500/30')
          }>{present ? 'OK' : 'Absent'}</span>
          {info.has_backup && <span className={badge('bg-sky-500/20', 'text-sky-400', 'border-sky-500/30')}>Backup</span>}
        </div>
        <p className="text-xs text-neutral-500 mt-0.5">
          build <span className="font-mono text-neutral-300">{info.version ?? '—'}</span>
          {isNative && info.binary && <> · <span className="font-mono text-neutral-500">{info.binary}</span></>}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button className={btnBlue} onClick={() => onAction('build')} disabled={busy} title={buildTitle}>Build</button>
        <button className={btnGray} onClick={() => onAction('pull')} disabled={busy} title={pullTitle}>{isNative ? 'Update' : 'Pull'}</button>
        <button className={btnGray} onClick={() => onAction('backup')} disabled={busy} title={backupTitle}>Backup</button>
        {info.has_backup && <button className={btnGray} onClick={() => onAction('restore')} disabled={busy} title="Restaurer depuis backup">Restore</button>}
      </div>
    </div>
  )
}

function ToolboxesCard() {
  const { data: updater, isLoading, isError } = useBrainUpdater()
  const actionMut = useBrainUpdaterActionMutation()
  const [log, setLog] = useState<string | null>(null)

  const exec = (backend: string, action: string) => {
    setLog(`${action} ${backend}...`)
    actionMut.mutate({ action, backend }, {
      onSuccess: (d) => setLog(d.ok ? `${action} ${backend} OK (v${d.version ?? '?'})` : `Erreur : ${d.error ?? '?'}`),
      onError: (e) => setLog(`Erreur : ${e.message}`),
    })
  }

  const busy = updater?.update_in_progress === true || actionMut.isPending

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Toolboxes llama.cpp</h2>
        {busy && <span className="text-xs text-orange-400 animate-pulse">Operation en cours...</span>}
      </div>
      <div className="px-4 py-1">
        {isLoading && <Spinner />}
        {isError && <p className="text-xs text-neutral-500 py-2">Brain daemon inaccessible</p>}
        {updater && !isLoading && (
          <>
            {Object.entries(updater)
              .filter(([key, value]) => key !== 'update_in_progress' && value && typeof value === 'object')
              .sort(([a], [b]) => {
                // Stable order: builtin toolboxes first, then native-vulkan, then extras alphabetically.
                const order = (k: string) => k === 'vulkan' ? 0 : k === 'rocm' ? 1 : k === 'native-vulkan' ? 2 : 3
                const da = order(a), db = order(b)
                return da !== db ? da - db : a.localeCompare(b)
              })
              .map(([name, info]) => (
                <ToolboxRow
                  key={name}
                  name={name}
                  info={info as BrainBackendInfo}
                  onAction={a => exec(name, a)}
                  busy={busy}
                />
              ))}
          </>
        )}
        {log && (
          <p className={`py-2 text-xs font-mono ${log.startsWith('Erreur') ? 'text-red-400' : 'text-emerald-400'}`}>{log}</p>
        )}
      </div>
    </section>
  )
}

// ── 3b. Lucebox sub-updater ──────────────────────────────────────────────────
// Sous-updater dédié au fork llama.cpp/Lucebox (DFlash speculative decoding).
// Bouton "Update" = git pull + submodule + cmake (~3-5min, bloquant côté daemon).
// Bouton "Rebuild" = cmake-only (skip git, ~1-2min).
// Auto-reload : après update OK, on unload+load chaque instance avec backend_type=lucebox
// running (le daemon ne le fait pas tout seul).

function LuceboxUpdaterCard() {
  // Panel ouvert/fermé pilote les pollings (status 2s/30s, log 1s).
  const [panelOpen, setPanelOpen] = useState(false)
  const { data: status, isLoading } = useLuceboxUpdater(true)
  const { data: liveLog } = useLuceboxUpdaterLog(panelOpen || status?.in_progress === true)
  const updateMut = useLuceboxUpdateMutation()
  const buildMut = useLuceboxBuildMutation()
  const { data: probe } = useLlamacppProbe(true)
  const loadMut = useLoadLlamacppModelMutation()
  const unloadMut = useUnloadLlamacppModelMutation()
  const [reloadLog, setReloadLog] = useState<string | null>(null)
  const logScrollRef = useRef<HTMLDivElement>(null)

  const inProgress = status?.in_progress === true || updateMut.isPending || buildMut.isPending
  const behind = status?.behind ?? 0
  const buildExists = status?.build_exists === true
  const localSha = status?.local_sha ?? ''
  const remoteSha = status?.remote_sha ?? ''

  // Liste des instances Lucebox actuellement running (pour confirm dialog + auto-reload).
  const luceboxInstances = (probe?.instances ?? []).filter(
    i => i.backend_type === 'lucebox' && i.running === true,
  )

  // Auto-scroll log live
  const logLines = liveLog?.log ?? status?.log_tail ?? []
  useEffect(() => {
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logLines.length])

  const runReload = async (instanceIds: string[]) => {
    if (instanceIds.length === 0) return
    setReloadLog(`Reload de ${instanceIds.length} instance${instanceIds.length > 1 ? 's' : ''} Lucebox...`)
    // Comportement : continue sur erreur (utile quand >1 instance et qu'une seule
    // échoue) — on accepte qu'une instance puisse rester "unload-OK + load-KO"
    // c-à-d déchargée. C'est tracé dans `failed` + console.error pour post-mortem
    // au-delà du panel UI (qui peut être fermé).
    const failed: { id: string; stage: 'unload' | 'load'; msg: string }[] = []
    for (const mid of instanceIds) {
      let stage: 'unload' | 'load' = 'unload'
      try {
        await unloadMut.mutateAsync(mid)
        stage = 'load'
        await loadMut.mutateAsync(mid)
        setReloadLog(prev => `${prev ?? ''}\n  ✓ ${mid}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // eslint-disable-next-line no-console
        console.error(`[lucebox auto-reload] ${stage} failed for ${mid}:`, e)
        failed.push({ id: mid, stage, msg })
        const hint = stage === 'load' ? ' (instance probablement déchargée — reload manuel requis)' : ''
        setReloadLog(prev => `${prev ?? ''}\n  ✗ ${mid} [${stage}] : ${msg}${hint}`)
      }
    }
    if (failed.length === 0) {
      setReloadLog(prev => `${prev ?? ''}\nTerminé — ${instanceIds.length} instance${instanceIds.length > 1 ? 's' : ''} reload OK.`)
    } else {
      const stuck = failed.filter(f => f.stage === 'load').map(f => f.id)
      const summary = `Terminé avec ${failed.length} échec${failed.length > 1 ? 's' : ''} sur ${instanceIds.length}.`
        + (stuck.length > 0 ? `\nInstances déchargées à reload manuellement : ${stuck.join(', ')}` : '')
      setReloadLog(prev => `${prev ?? ''}\n${summary}`)
    }
  }

  const handleUpdate = async () => {
    if (inProgress) return
    const snapshot = luceboxInstances.map(i => i.model_id)
    const msg = snapshot.length > 0
      ? `Update Lucebox (~3-5min). ${snapshot.length} instance${snapshot.length > 1 ? 's' : ''} running seront reload après :\n  - ${snapshot.join('\n  - ')}\n\nContinuer ?`
      : 'Update Lucebox (~3-5min) — aucune instance running à reload. Continuer ?'
    if (!window.confirm(msg)) return
    setPanelOpen(true)
    setReloadLog(null)
    try {
      const r = await updateMut.mutateAsync()
      if (r.ok) {
        await runReload(snapshot)
      } else {
        setReloadLog(`Update échouée : ${r.detail ?? r.error ?? '?'}`)
      }
    } catch (e) {
      setReloadLog(`Update échouée : ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleRebuild = async () => {
    if (inProgress) return
    if (!window.confirm('Rebuild cmake-only (skip git pull, ~1-2min). Les instances running ne sont PAS reload — fais-le toi-même si nécessaire. Continuer ?')) return
    setPanelOpen(true)
    setReloadLog(null)
    try {
      const r = await buildMut.mutateAsync()
      if (!r.ok) setReloadLog(`Rebuild échoué : ${r.detail ?? r.error ?? '?'}`)
      else setReloadLog('Rebuild terminé.')
    } catch (e) {
      setReloadLog(`Rebuild échoué : ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white m-0">Lucebox updater</h2>
          {inProgress && <span className="text-xs text-orange-400 animate-pulse">{status?.phase || updateMut.isPending ? 'en cours…' : 'build…'}</span>}
        </div>
        <button className={btnGray} onClick={() => setPanelOpen(o => !o)}>
          {panelOpen ? 'Replier' : 'Détails / log'}
        </button>
      </div>
      <div className="px-4 py-3">
        {isLoading && <Spinner />}
        {status?.error && <p className="text-xs text-red-400 mb-2">Erreur status : {status.error}</p>}
        {!isLoading && status && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-neutral-500">local</span>
                  <span className="font-mono text-xs text-neutral-300">{localSha || '—'}</span>
                  <span className="text-neutral-600">→</span>
                  <span className="text-xs text-neutral-500">remote</span>
                  <span className="font-mono text-xs text-neutral-300">{remoteSha || '—'}</span>
                  {behind > 0 ? (
                    <span className={badge('bg-orange-500/20', 'text-orange-400', 'border-orange-500/30')}>
                      {behind} commit{behind > 1 ? 's' : ''} en retard
                    </span>
                  ) : (
                    <span className={badge('bg-emerald-500/20', 'text-emerald-400', 'border-emerald-500/30')}>up-to-date</span>
                  )}
                  {!buildExists && (
                    <span className={badge('bg-red-500/20', 'text-red-400', 'border-red-500/30')}>Build absent</span>
                  )}
                  {inProgress && status.phase && (
                    <span className={badge('bg-blue-500/20', 'text-blue-400', 'border-blue-500/30')}>
                      {status.phase}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-neutral-500 mt-1">
                  {luceboxInstances.length > 0
                    ? `${luceboxInstances.length} instance${luceboxInstances.length > 1 ? 's' : ''} Lucebox running — reload automatique après update.`
                    : 'Aucune instance Lucebox running.'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  className={btnBlue}
                  onClick={handleUpdate}
                  disabled={inProgress || (behind === 0 && buildExists)}
                  title={
                    behind === 0 && buildExists
                      ? 'À jour, rien à faire (utilise Rebuild pour forcer cmake)'
                      : `git pull + submodule + cmake (~3-5min). ${luceboxInstances.length} instance${luceboxInstances.length > 1 ? 's' : ''} reload après.`
                  }
                >
                  Update
                </button>
                <button
                  className={btnGray}
                  onClick={handleRebuild}
                  disabled={inProgress}
                  title="cmake-only rebuild (skip git pull). Pour rebuild après edit local."
                >
                  Rebuild
                </button>
              </div>
            </div>

            {panelOpen && (
              <div className="mt-3 bg-neutral-950 border border-neutral-800 rounded-md p-2">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Log</span>
                  <span className="text-[10px] text-neutral-600 font-mono">{logLines.length} lignes</span>
                </div>
                <div ref={logScrollRef} className="max-h-64 overflow-y-auto font-mono text-[10px] leading-relaxed text-neutral-400 space-y-0.5">
                  {logLines.length === 0 && <p className="text-neutral-600">Aucun log</p>}
                  {logLines.map((line, i) => (
                    <div key={i} className={`whitespace-pre-wrap break-all ${colorize(line)}`}>{line}</div>
                  ))}
                </div>
                {reloadLog && (
                  <pre className="mt-2 text-[10px] text-emerald-300 whitespace-pre-wrap font-mono">{reloadLog}</pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

// ── 4. Daemon Logs ───────────────────────────────────────────────────────────

function colorize(line: string): string {
  if (/\[ERROR\]|error|FAILED|crash/i.test(line)) return 'text-red-400'
  if (/\[WARN\]|warning/i.test(line)) return 'text-yellow-400'
  if (/THERMAL|SIGSTOP|SIGCONT|EMERGENCY/i.test(line)) return 'text-orange-400'
  if (/\[perf\]|PERFORMANCE|ECO/i.test(line)) return 'text-sky-400'
  if (/load:|ready|started/i.test(line)) return 'text-emerald-400'
  return 'text-neutral-400'
}

function DaemonLogsCard() {
  const [enabled, setEnabled] = useState(true)
  const { data } = useLlamacppDaemonLogs(enabled)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const logs = data?.logs ?? []

  // Auto-scroll within the container only (never scroll the page)
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs.length, autoScroll])

  // Detect manual scroll to disable auto-scroll
  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40)
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col" style={{ maxHeight: '400px' }}>
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Daemon Logs</h2>
        <div className="flex items-center gap-2">
          {!autoScroll && (
            <button className={btnGray} onClick={() => { setAutoScroll(true); if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight }}>
              Scroll bas
            </button>
          )}
          <button className={enabled ? btnGray : btnGreen} onClick={() => setEnabled(!enabled)}>
            {enabled ? 'Pause' : 'Resume'}
          </button>
          <span className="text-[10px] text-neutral-500 font-mono">{logs.length} lignes</span>
        </div>
      </div>
      <div ref={containerRef} onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto px-4 py-2 font-mono text-[11px] leading-relaxed bg-neutral-950">
        {logs.length === 0 && <p className="text-neutral-600">Aucun log</p>}
        {logs.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all ${colorize(line)}`}>{line}</div>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function BrainPanel() {
  const { data: config } = useConfig()
  return (
    <div className="flex flex-col gap-6">
      <LiveStatusCard />
      <MemoryCard />
      <SettingsCard />
      <ToolboxesCard />
      {config?.lucebox_enabled === true && (
        <LuceboxUpdaterCard />
      )}
      {config?.audio_local_enabled && (
        <AudioLocalCard />
      )}
      <AtlasCard />
      <DaemonLogsCard />
    </div>
  )
}
