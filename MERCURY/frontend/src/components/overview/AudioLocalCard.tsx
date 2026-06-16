import { useState, useEffect } from 'react'
import * as api from '../../api/admin'

type AudioHealth = {
  whisper_loaded?: boolean
  whisper_model?: string | null
  kokoro_loaded?: boolean
  kokoro_lang?: string | null
  default_voice?: string
  voices_count?: number
  configured?: boolean
  error?: string
}

type AudioVoice = { id: string; name: string; provider: string }

type LibsStatus = {
  libs: Record<string, string | null>
  upgrade_in_progress?: boolean
  configured?: boolean
  error?: string
}

export default function AudioLocalCard() {
  const [health, setHealth] = useState<AudioHealth | null>(null)
  const [voices, setVoices] = useState<AudioVoice[]>([])
  const [libs, setLibs] = useState<LibsStatus | null>(null)
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeLog, setUpgradeLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const fetchData = async () => {
    try {
      const data = await api.getAudioLocalHealth() as AudioHealth
      setHealth(data); setErr(data.error || null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setHealth(null) }
    try {
      const data = await api.getAudioLocalVoices()
      setVoices(data.voices ?? [])
    } catch { /* silent */ }
    try {
      const data = await api.getAudioLocalLibsStatus() as LibsStatus
      setLibs(data)
      setUpgrading((data.upgrade_in_progress as boolean) ?? false)
    } catch { /* silent */ }
  }

  const handleUpgrade = async () => {
    setUpgrading(true); setShowLog(true); setUpgradeLog(['Lancement...'])
    try {
      await api.postAudioLocalLibsUpgrade()
      const poll = setInterval(async () => {
        try {
          const data = await api.getAudioLocalLibsLog()
          setUpgradeLog(data.log ?? [])
          if (!data.in_progress) { clearInterval(poll); setUpgrading(false); fetchData() }
        } catch { /* retry */ }
      }, 2000)
    } catch (e) {
      setUpgradeLog(['Erreur: ' + (e instanceof Error ? e.message : String(e))])
      setUpgrading(false)
    }
  }

  useEffect(() => { fetchData(); const iv = setInterval(fetchData, 30000); return () => clearInterval(iv) }, [])

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white m-0">Audio Local</h3>
        <button type="button" onClick={fetchData} className="px-2 py-1 text-xs text-neutral-400 hover:text-white transition-colors">Rafraichir</button>
      </div>

      {err && <p className="text-red-500 text-xs m-0">{err}</p>}

      {health && health.configured !== false && (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">STT (Whisper)</span>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${health.whisper_loaded ? 'bg-emerald-500' : 'bg-neutral-600'}`} />
              <span className="text-xs text-neutral-200">{health.whisper_loaded ? health.whisper_model : 'Non charge'}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">TTS (Kokoro)</span>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${health.kokoro_loaded ? 'bg-emerald-500' : 'bg-neutral-600'}`} />
              <span className="text-xs text-neutral-200">{health.kokoro_loaded ? `${health.voices_count} voix` : 'Non charge'}</span>
            </div>
          </div>
        </div>
      )}

      {voices.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Voix disponibles</span>
          <div className="flex flex-wrap gap-1">
            {voices.slice(0, 12).map(v => (
              <span key={v.id} className="px-1.5 py-0.5 bg-neutral-800 text-neutral-300 rounded text-[10px]" title={v.id}>{v.name}</span>
            ))}
            {voices.length > 12 && <span className="px-1.5 py-0.5 text-neutral-500 text-[10px]">+{voices.length - 12}</span>}
          </div>
        </div>
      )}

      {/* Libs versions + upgrade */}
      {libs && libs.configured !== false && (
        <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Libs Python</span>
            <button
              type="button"
              onClick={handleUpgrade}
              disabled={upgrading}
              className="px-2.5 py-1 bg-neutral-700 hover:bg-neutral-600 text-white text-[10px] font-medium rounded transition-colors disabled:opacity-50 border border-neutral-600"
            >
              {upgrading ? 'Upgrade...' : 'Mettre a jour'}
            </button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {Object.entries(libs.libs ?? {}).map(([name, version]) => (
              <span key={name} className="text-[10px] text-neutral-400">
                <span className="text-neutral-300">{name}</span>{' '}
                <span className={version ? 'text-neutral-500' : 'text-red-400'}>{version ?? 'non installe'}</span>
              </span>
            ))}
          </div>
          {showLog && upgradeLog.length > 0 && (
            <div className="mt-1 max-h-32 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2">
              <pre className="text-[10px] text-neutral-400 whitespace-pre-wrap m-0">{upgradeLog.join('\n')}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
