import { useState } from 'react'
import type { Config, OpenAIAudioModelsResponse, GroqAudioModelsResponse, ElevenLabsVoicesResponse } from '../../api/admin'
import * as api from '../../api/admin'

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'
const fieldClass = 'flex flex-col gap-1.5'

function Checkbox({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; children?: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 cursor-pointer">
      <input id={id} type="checkbox" checked={checked} onChange={onChange} className="mt-0.5 w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:ring-offset-neutral-900" />
      {children && <span className="text-sm text-neutral-200">{children}</span>}
    </label>
  )
}

function MiniTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return null
  return (
    <div className="overflow-auto max-h-40 rounded-lg border border-neutral-800 bg-neutral-950">
      <table className="w-full text-left border-collapse text-xs">
        <thead className="sticky top-0 bg-neutral-950">
          <tr>{headers.map((h) => <th key={h} className="p-2 font-medium text-neutral-400 border-b border-neutral-800">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className="p-2 border-b border-neutral-800/50 text-neutral-200">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  markDirty: () => void
  refreshConfig: () => void
  setSaveStatus: (s: string | null) => void
}

export default function AudioSection({ config, updateField, markDirty, refreshConfig, setSaveStatus }: Props) {
  // API key inputs
  const [openaiKeyInput, setOpenaiKeyInput] = useState('')
  const [groqKeyInput, setGroqKeyInput] = useState('')
  const [elevenlabsKeyInput, setElevenlabsKeyInput] = useState('')

  // OpenAI discovery
  const [openaiModels, setOpenaiModels] = useState<OpenAIAudioModelsResponse | null>(null)
  const [openaiLoading, setOpenaiLoading] = useState(false)
  const [openaiErr, setOpenaiErr] = useState<string | null>(null)

  // Groq discovery
  const [groqModels, setGroqModels] = useState<GroqAudioModelsResponse | null>(null)
  const [groqLoading, setGroqLoading] = useState(false)
  const [groqErr, setGroqErr] = useState<string | null>(null)

  // ElevenLabs discovery
  const [elevenlabsData, setElevenlabsData] = useState<ElevenLabsVoicesResponse | null>(null)
  const [elevenlabsLoading, setElevenlabsLoading] = useState(false)
  const [elevenlabsErr, setElevenlabsErr] = useState<string | null>(null)
  const [selectedVoices, setSelectedVoices] = useState<Set<string>>(new Set())

  // Voice map display
  const currentVoiceMap = config.audio_elevenlabs_voice_map ?? {}
  const voiceMapEntries = Object.entries(currentVoiceMap)

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-6">
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Audio (STT / TTS)</h3>
      <p className="text-xs text-neutral-500 m-0">Providers audio pour les routes /v1/audio/transcriptions (STT) et /v1/audio/speech (TTS). Utilises par NCM.</p>

      {/* Defaults */}
      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Providers par defaut</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={fieldClass}>
            <label htmlFor="audio-default-stt" className={labelClass}>STT (transcription)</label>
            <select id="audio-default-stt" value={config.audio_default_stt_provider ?? 'openai'} onChange={(e) => updateField('audio_default_stt_provider', e.target.value)} className={inputClass + ' cursor-pointer'}>
              <option value="openai">OpenAI</option>
              <option value="groq">Groq</option>
              <option value="elevenlabs">ElevenLabs (Scribe)</option>
              <option value="local">Local (Brain)</option>
            </select>
          </div>
          <div className={fieldClass}>
            <label htmlFor="audio-default-tts" className={labelClass}>TTS (synthese vocale)</label>
            <select id="audio-default-tts" value={config.audio_default_tts_provider ?? 'openai'} onChange={(e) => updateField('audio_default_tts_provider', e.target.value)} className={inputClass + ' cursor-pointer'}>
              <option value="openai">OpenAI</option>
              <option value="elevenlabs">ElevenLabs</option>
              <option value="local">Local (Brain)</option>
            </select>
          </div>
        </div>
      </fieldset>

      {/* ── OpenAI Audio ────────────────────────────────────────────────── */}
      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">OpenAI (STT + TTS)</legend>
        <Checkbox id="audio-openai-enabled" checked={config.audio_openai_enabled === true} onChange={(e) => updateField('audio_openai_enabled', e.target.checked)}>
          Actif
        </Checkbox>
        <div className={fieldClass}>
          <label htmlFor="audio-openai-key" className={labelClass}>Cle API</label>
          <input
            id="audio-openai-key"
            type="password"
            value={openaiKeyInput}
            onChange={(e) => { markDirty(); setOpenaiKeyInput(e.target.value); updateField('audio_openai_api_key', e.target.value) }}
            placeholder={config.audio_openai_api_key_set ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (vide = ne pas changer)' : 'sk-...'}
            autoComplete="off"
            className={inputClass}
          />
        </div>

        {/* Discovery */}
        <div className="flex flex-col gap-2">
          <button type="button" className="self-start px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs font-medium rounded-md transition-colors disabled:opacity-50 border border-neutral-600" disabled={openaiLoading} onClick={async () => {
            setOpenaiErr(null); setOpenaiLoading(true)
            try { const res = await api.getOpenAIAudioModels(); setOpenaiModels(res); if (res.detail) setOpenaiErr(res.detail) }
            catch (e) { setOpenaiErr(e instanceof Error ? e.message : String(e)); setOpenaiModels(null) }
            finally { setOpenaiLoading(false) }
          }}>
            {openaiLoading ? 'Chargement...' : 'Decouvrir les modeles'}
          </button>
          {openaiErr && <p className="text-red-500 text-xs m-0">{openaiErr}</p>}
          {openaiModels && (
            <div className="flex flex-col gap-3">
              {openaiModels.stt_models.length > 0 && (
                <div>
                  <p className="text-xs text-neutral-400 font-medium mb-1">Modeles STT</p>
                  <MiniTable headers={['ID', 'Nom']} rows={openaiModels.stt_models.map(m => [m.id, m.name ?? m.id])} />
                </div>
              )}
              {openaiModels.tts_models.length > 0 && (
                <div>
                  <p className="text-xs text-neutral-400 font-medium mb-1">Modeles TTS</p>
                  <MiniTable headers={['ID', 'Nom']} rows={openaiModels.tts_models.map(m => [m.id, m.name ?? m.id])} />
                </div>
              )}
              {openaiModels.voices.length > 0 && (
                <div>
                  <p className="text-xs text-neutral-400 font-medium mb-1">Voix TTS</p>
                  <MiniTable headers={['ID', 'Nom']} rows={openaiModels.voices.map(v => [v.id, v.name])} />
                </div>
              )}
            </div>
          )}
        </div>
      </fieldset>

      {/* ── Groq ────────────────────────────────────────────────────────── */}
      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">Groq (STT uniquement)</legend>
        <Checkbox id="audio-groq-enabled" checked={config.audio_groq_enabled === true} onChange={(e) => updateField('audio_groq_enabled', e.target.checked)}>
          Actif
        </Checkbox>
        <div className={fieldClass}>
          <label htmlFor="audio-groq-key" className={labelClass}>Cle API</label>
          <input
            id="audio-groq-key"
            type="password"
            value={groqKeyInput}
            onChange={(e) => { markDirty(); setGroqKeyInput(e.target.value); updateField('audio_groq_api_key', e.target.value) }}
            placeholder={config.audio_groq_api_key_set ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (vide = ne pas changer)' : 'gsk_...'}
            autoComplete="off"
            className={inputClass}
          />
        </div>

        {/* Discovery */}
        <div className="flex flex-col gap-2">
          <button type="button" className="self-start px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs font-medium rounded-md transition-colors disabled:opacity-50 border border-neutral-600" disabled={groqLoading} onClick={async () => {
            setGroqErr(null); setGroqLoading(true)
            try { const res = await api.getGroqAudioModels(); setGroqModels(res); if (res.detail) setGroqErr(res.detail) }
            catch (e) { setGroqErr(e instanceof Error ? e.message : String(e)); setGroqModels(null) }
            finally { setGroqLoading(false) }
          }}>
            {groqLoading ? 'Chargement...' : 'Decouvrir les modeles STT'}
          </button>
          {groqErr && <p className="text-red-500 text-xs m-0">{groqErr}</p>}
          {groqModels && groqModels.stt_models.length > 0 && (
            <MiniTable headers={['ID', 'Nom']} rows={groqModels.stt_models.map(m => [m.id, m.name ?? m.id])} />
          )}
        </div>
      </fieldset>

      {/* ── ElevenLabs ──────────────────────────────────────────────────── */}
      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1">ElevenLabs (STT Scribe + TTS)</legend>
        <Checkbox id="audio-elevenlabs-enabled" checked={config.audio_elevenlabs_enabled === true} onChange={(e) => updateField('audio_elevenlabs_enabled', e.target.checked)}>
          Actif
        </Checkbox>
        <div className={fieldClass}>
          <label htmlFor="audio-elevenlabs-key" className={labelClass}>Cle API</label>
          <input
            id="audio-elevenlabs-key"
            type="password"
            value={elevenlabsKeyInput}
            onChange={(e) => { markDirty(); setElevenlabsKeyInput(e.target.value); updateField('audio_elevenlabs_api_key', e.target.value) }}
            placeholder={config.audio_elevenlabs_api_key_set ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (vide = ne pas changer)' : 'Saisir la cle ElevenLabs'}
            autoComplete="off"
            className={inputClass}
          />
        </div>

        {/* Voice discovery */}
        <div className="flex flex-col gap-3">
          <button type="button" className="self-start px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs font-medium rounded-md transition-colors disabled:opacity-50 border border-neutral-600" disabled={elevenlabsLoading} onClick={async () => {
            setElevenlabsErr(null); setElevenlabsLoading(true); setSelectedVoices(new Set())
            try { const res = await api.getElevenLabsVoices(); setElevenlabsData(res); if (res.detail) setElevenlabsErr(res.detail) }
            catch (e) { setElevenlabsErr(e instanceof Error ? e.message : String(e)); setElevenlabsData(null) }
            finally { setElevenlabsLoading(false) }
          }}>
            {elevenlabsLoading ? 'Chargement...' : 'Decouvrir les voix'}
          </button>
          {elevenlabsErr && <p className="text-red-500 text-xs m-0">{elevenlabsErr}</p>}

          {elevenlabsData && elevenlabsData.voices.length > 0 && (
            <>
              <div className="overflow-auto max-h-48 rounded-lg border border-neutral-800 bg-neutral-950">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-neutral-950">
                    <tr>
                      <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800 w-8">
                        <input type="checkbox" checked={selectedVoices.size === elevenlabsData.voices.length && elevenlabsData.voices.length > 0} onChange={(e) => setSelectedVoices(e.target.checked ? new Set(elevenlabsData.voices.map(v => v.voice_id)) : new Set())} className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-900 text-blue-600" />
                      </th>
                      <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Nom</th>
                      <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Categorie</th>
                      <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Voice ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {elevenlabsData.voices.map((v) => (
                      <tr key={v.voice_id}>
                        <td className="p-2 border-b border-neutral-800/50">
                          <input type="checkbox" checked={selectedVoices.has(v.voice_id)} onChange={(e) => { const next = new Set(selectedVoices); if (e.target.checked) next.add(v.voice_id); else next.delete(v.voice_id); setSelectedVoices(next) }} className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-900 text-blue-600" />
                        </td>
                        <td className="p-2 border-b border-neutral-800/50 text-neutral-200 font-medium">{v.name}</td>
                        <td className="p-2 border-b border-neutral-800/50 text-neutral-400">{v.category || '—'}</td>
                        <td className="p-2 border-b border-neutral-800/50 text-neutral-500 font-mono text-[10px]">{v.voice_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-md transition-colors disabled:opacity-50" disabled={selectedVoices.size === 0} onClick={async () => {
                const next = { ...currentVoiceMap }
                for (const vid of selectedVoices) {
                  const voice = elevenlabsData.voices.find(v => v.voice_id === vid)
                  if (voice) {
                    const key = voice.name.toLowerCase().replace(/\s+/g, '_')
                    next[key] = voice.voice_id
                  }
                }
                updateField('audio_elevenlabs_voice_map', next)
                try {
                  await api.saveConfig({ ...config, audio_elevenlabs_voice_map: next })
                  refreshConfig()
                  setSelectedVoices(new Set())
                  setSaveStatus('Voice map mis a jour.')
                } catch (e) {
                  setSaveStatus('Erreur : ' + (e instanceof Error ? e.message : String(e)))
                }
              }}>
                Ajouter au voice map ({selectedVoices.size})
              </button>
            </>
          )}

          {elevenlabsData && elevenlabsData.models.length > 0 && (
            <div>
              <p className="text-xs text-neutral-400 font-medium mb-1">Modeles TTS</p>
              <MiniTable headers={['ID', 'Nom']} rows={elevenlabsData.models.map(m => [m.id, m.name ?? m.id])} />
            </div>
          )}
        </div>

        {/* Current voice map */}
        {voiceMapEntries.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Voice map actuel</p>
            <div className="overflow-auto max-h-32 rounded-lg border border-neutral-800 bg-neutral-950">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-neutral-950">
                  <tr>
                    <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Nom (cle)</th>
                    <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800">Voice ID</th>
                    <th className="p-2 font-medium text-neutral-400 border-b border-neutral-800 w-16 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {voiceMapEntries.map(([name, vid]) => (
                    <tr key={name}>
                      <td className="p-2 border-b border-neutral-800/50 text-neutral-200 font-medium">{name}</td>
                      <td className="p-2 border-b border-neutral-800/50 text-neutral-500 font-mono text-[10px]">{vid}</td>
                      <td className="p-2 border-b border-neutral-800/50 text-right">
                        <button type="button" className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors" onClick={async () => {
                          const next = { ...currentVoiceMap }; delete next[name]
                          updateField('audio_elevenlabs_voice_map', next)
                          try { await api.saveConfig({ ...config, audio_elevenlabs_voice_map: next }); refreshConfig() }
                          catch (e) { setSaveStatus('Erreur : ' + (e instanceof Error ? e.message : String(e))) }
                        }}>Supprimer</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </fieldset>
    </section>
  )
}
