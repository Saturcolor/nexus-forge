import { useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { QUERY_KEYS } from '../api/queries'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`
const btnGreen = `${btn} bg-emerald-600 hover:bg-emerald-500 text-white`
const btnRed = `${btn} bg-red-600/80 hover:bg-red-500 text-white`
const btnGray = `${btn} bg-neutral-700 hover:bg-neutral-600 text-neutral-200`
const card = 'bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-5'

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('mercury_admin_token') || ''}` })

type BenchStatus = {
  bench_id: string
  label: string
  enabled: boolean
  service_online: boolean
  service_url: string
  env_exists: boolean
  configured_models: string[]
  configured_daemon: string
  default_port: number
  managed_pid: number | null
}

type ExtBenchConfig = {
  benchId: string
  label: string
  routePrefix: string
  extraSetup?: string
  hasSandbox?: boolean
}

function ExtBenchTab({ config }: { config: ExtBenchConfig }) {
  const { benchId, label, routePrefix, extraSetup, hasSandbox } = config
  const [status, setStatus] = useState<BenchStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [sandboxOnline, setSandboxOnline] = useState(false)
  const [sandboxToggling, setSandboxToggling] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())

  const checkStatus = useCallback(async () => {
    try {
      const resp = await fetch(`/admin/${routePrefix}/status`, { headers: authHeaders() })
      if (resp.ok) setStatus(await resp.json())
    } catch { /* ignore */ }
    if (hasSandbox) {
      try {
        const resp = await fetch(`/admin/${routePrefix}/sandbox-status`, { headers: authHeaders() })
        if (resp.ok) { const d = await resp.json(); setSandboxOnline(d.online) }
      } catch { /* ignore */ }
    }
  }, [routePrefix, hasSandbox])

  // Fetch loaded models from daemon
  const fetchModels = useCallback(async () => {
    try {
      const resp = await fetch('/admin/llamacpp/probe', { headers: authHeaders() })
      if (resp.ok) {
        const data = await resp.json()
        const models = (data.instances || []).filter((i: any) => i.ready).map((i: any) => i.model_id as string)
        setAvailableModels(models)
        // Pre-select all if nothing selected yet
        if (selectedModels.size === 0 && models.length > 0) {
          setSelectedModels(new Set(models))
        }
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    checkStatus()
    fetchModels()
    const interval = setInterval(() => { checkStatus(); fetchModels() }, 15000)
    return () => clearInterval(interval)
  }, [checkStatus, fetchModels])

  const toggleModel = (m: string) => {
    setSelectedModels(prev => {
      const next = new Set(prev)
      if (next.has(m)) next.delete(m)
      else next.add(m)
      return next
    })
  }

  const syncEnv = async () => {
    if (selectedModels.size === 0) { setMsg('Selectionne au moins un modele'); return }
    setSyncing(true)
    setMsg(null)
    try {
      const resp = await fetch(`/admin/${routePrefix}/sync-env`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: [...selectedModels] }),
      })
      const data = await resp.json()
      setMsg(data.ok ? `Sync OK: ${data.models?.length} modeles` : `Erreur: ${data.error}`)
      checkStatus()
    } catch (e: any) { setMsg(`Erreur: ${e?.message || e}`) }
    setSyncing(false)
  }

  const toggleSandbox = async () => {
    setSandboxToggling(true)
    const action = sandboxOnline ? 'sandbox-stop' : 'sandbox-start'
    try {
      await fetch(`/admin/${routePrefix}/${action}`, { method: 'POST', headers: authHeaders() })
      await new Promise(r => setTimeout(r, sandboxOnline ? 1000 : 5000))
      checkStatus()
    } catch { /* ignore */ }
    setSandboxToggling(false)
  }

  const toggleService = async () => {
    setToggling(true)
    setMsg(null)
    const action = online ? 'stop' : 'start'
    try {
      const resp = await fetch(`/admin/ext-bench/${benchId}/${action}`, { method: 'POST', headers: authHeaders() })
      const data = await resp.json()
      if (!resp.ok) setMsg(`Erreur: ${data.error}`)
      else setMsg(action === 'start' ? 'Service demarre' : 'Service arrete')
      await new Promise(r => setTimeout(r, action === 'start' ? 3000 : 1000))
      checkStatus()
    } catch (e: any) { setMsg(`Erreur: ${e?.message || e}`) }
    setToggling(false)
  }

  const online = status?.service_online
  const hasModels = (status?.configured_models?.length ?? 0) > 0
  const serviceUrl = status?.service_url || `http://localhost:${status?.default_port || 3015}`

  return (
    <div className={card}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white m-0">{label}</h2>
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-500' : status === null ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-[10px] text-neutral-500">{online ? 'En ligne' : 'Hors ligne'}</span>
          </div>
        </div>
        {online && (
          <a href={serviceUrl} target="_blank" rel="noopener" className={btnBlue + ' no-underline text-center'}>
            Ouvrir {label}
          </a>
        )}
      </div>

      {/* Model selection */}
      {availableModels.length > 0 && (
        <div className="mb-3">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1.5">Modeles charges (selectionner pour le bench) :</span>
          <div className="flex flex-wrap gap-2">
            {availableModels.map(m => {
              const checked = selectedModels.has(m)
              const shortName = m.split('/').pop() || m
              return (
                <label key={m} className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-[11px] font-mono transition-colors ${checked ? 'bg-blue-500/20 border border-blue-500/30 text-blue-400' : 'bg-neutral-800 border border-neutral-700 text-neutral-500 hover:text-neutral-300'}`} title={m}>
                  <input type="checkbox" checked={checked} onChange={() => toggleModel(m)} className="cursor-pointer" />
                  {shortName}
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* Currently configured */}
      {hasModels && (
        <div className="flex items-center gap-1.5 mb-3">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wider">Configure:</span>
          {status!.configured_models.map((m, i) => (
            <span key={i} className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-emerald-400 font-mono max-w-[200px] truncate" title={m}>
              {m.split('/').pop()}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button className={btnGreen} onClick={syncEnv} disabled={syncing}>
          {syncing ? 'Sync...' : 'Sync modeles'}
        </button>

        {online ? (
          <button className={btnRed} onClick={toggleService} disabled={toggling}>
            {toggling ? 'Arret...' : 'Arreter'}
          </button>
        ) : (
          <button className={btnGray} onClick={toggleService} disabled={toggling}>
            {toggling ? 'Demarrage...' : 'Demarrer'}
          </button>
        )}

        {hasSandbox && (
          <>
            <span className="text-neutral-700">|</span>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${sandboxOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <span className="text-[10px] text-neutral-500">Sandbox</span>
            </div>
            {sandboxOnline ? (
              <button className={btnRed} onClick={toggleSandbox} disabled={sandboxToggling}>
                {sandboxToggling ? '...' : 'Stop sandbox'}
              </button>
            ) : (
              <button className={btnGray} onClick={toggleSandbox} disabled={sandboxToggling}>
                {sandboxToggling ? 'Build...' : 'Start sandbox'}
              </button>
            )}
          </>
        )}

        {msg && <span className={`text-[10px] ${msg.startsWith('Erreur') ? 'text-red-400' : 'text-emerald-400'}`}>{msg}</span>}
      </div>

      {/* Setup help */}
      {!online && !hasModels && (
        <div className="mt-4 bg-neutral-950 rounded-lg p-3 text-[11px] text-neutral-500 space-y-1">
          <p>1. Charge des modeles dans le dashboard Mercury</p>
          <p>2. Clique "Sync modeles" pour configurer le .env</p>
          <p>3. Clique "Demarrer" ou lance manuellement :</p>
          <pre className="text-neutral-400 font-mono pl-3">cd /MERCURY/{routePrefix} && npm run start -- -p {status?.default_port || 3015}</pre>
          {extraSetup && <pre className="text-neutral-400 font-mono pl-3">{extraSetup}</pre>}
        </div>
      )}

      {/* Import score */}
      <ScoreImport benchId={benchId} label={label} configuredModels={status?.configured_models || []} />
    </div>
  )
}

// ── Score Import ─────────────────────────────────────────────────────────────

function ScoreImport({ benchId, label, configuredModels }: { benchId: string; label: string; configuredModels: string[] }) {
  const qc = useQueryClient()
  const [modelId, setModelId] = useState('')
  const [score, setScore] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Pre-select first model
  useEffect(() => {
    if (!modelId && configuredModels.length > 0) setModelId(configuredModels[0])
  }, [configuredModels])

  const handleSave = async () => {
    if (!modelId || !score) return
    setSaving(true)
    setSaved(false)
    try {
      const resp = await fetch('/admin/benchmark/results', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: modelId,
          preset_id: `${benchId}_full`,
          preset_category: benchId,
          [`${benchId}_score`]: parseFloat(score),
          response_preview: `${label}: ${score}%`,
        }),
      })
      if (resp.ok) { setSaved(true); setScore(''); qc.invalidateQueries({ queryKey: QUERY_KEYS.benchmarkResults }) }
    } catch { /* ignore */ }
    setSaving(false)
  }

  return (
    <div className="mt-4 pt-4 border-t border-neutral-800">
      <span className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-2">Importer le score dans Mercury</span>
      <div className="flex items-center gap-2 flex-wrap">
        <select className="px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer min-w-[180px]" value={modelId} onChange={e => setModelId(e.target.value)}>
          <option value="">-- Modele --</option>
          {configuredModels.map(m => (
            <option key={m} value={m}>{m.split('/').pop()}</option>
          ))}
        </select>
        <input
          type="number" min="0" max="100" step="1"
          className="w-20 px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="Score %"
          value={score}
          onChange={e => { setScore(e.target.value); setSaved(false) }}
        />
        <button className={btnGreen} onClick={handleSave} disabled={!modelId || !score || saving}>
          {saving ? 'Sauvegarde...' : 'Enregistrer'}
        </button>
        {saved && <span className="text-[10px] text-emerald-400">Score enregistre dans le classement</span>}
      </div>
    </div>
  )
}

export function ToolCall15Panel() {
  return <ExtBenchTab config={{ benchId: 'toolcall15', label: 'ToolCall-15', routePrefix: 'toolcall15' }} />
}

export function BugFind15Panel() {
  return <ExtBenchTab config={{
    benchId: 'bugfind15', label: 'BugFind-15', routePrefix: 'bugfind15',
    hasSandbox: true,
  }} />
}
