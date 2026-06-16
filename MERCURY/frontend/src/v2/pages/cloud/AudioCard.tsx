import { useMemo, useState } from 'react'
import { Volume2, Radio, Mic } from 'lucide-react'
import type { Config, OpenAIAudioModelsResponse, GroqAudioModelsResponse, ElevenLabsVoicesResponse, AudioVoicesModelEntry } from '../../../api/admin'
import * as api from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Switch'
import { inputCls, selectCls, labelCls, fieldCls, groupCls } from '../config/shared'

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <span className={groupCls}>{children}</span>
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className={fieldCls}>
      <label htmlFor={htmlFor} className={labelCls}>{label}</label>
      {children}
    </div>
  )
}

function MiniTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return null
  return (
    <div className="overflow-auto max-h-36 rounded-lg border border-border/40 bg-background">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-background/95">
          <tr>
            {headers.map(h => (
              <th key={h} className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/30 last:border-b-0">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-1.5 text-[11px] text-foreground font-mono">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  markDirty: () => void
  refreshConfig: () => void
  setSaveStatus: (s: string | null) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AudioCard({ config, updateField, markDirty, refreshConfig, setSaveStatus }: Props) {

  // API keys
  const [openaiKey,      setOpenaiKey]      = useState('')
  const [groqKey,        setGroqKey]        = useState('')
  const [elevenlabsKey,  setElevenlabsKey]  = useState('')

  // OpenAI discovery
  const [openaiModels,   setOpenaiModels]   = useState<OpenAIAudioModelsResponse | null>(null)
  const [openaiLoading,  setOpenaiLoading]  = useState(false)
  const [openaiErr,      setOpenaiErr]      = useState<string | null>(null)

  // Groq discovery
  const [groqModels,     setGroqModels]     = useState<GroqAudioModelsResponse | null>(null)
  const [groqLoading,    setGroqLoading]    = useState(false)
  const [groqErr,        setGroqErr]        = useState<string | null>(null)

  // ElevenLabs discovery
  const [elData,         setElData]         = useState<ElevenLabsVoicesResponse | null>(null)
  const [elLoading,      setElLoading]      = useState(false)
  const [elErr,          setElErr]          = useState<string | null>(null)
  const [elSelected,     setElSelected]     = useState<Set<string>>(new Set())

  // Realtime
  const [rtModels,       setRtModels]       = useState<AudioVoicesModelEntry[] | null>(null)
  const [rtLoading,      setRtLoading]      = useState(false)
  const [rtErr,          setRtErr]          = useState<string | null>(null)
  const [rtCopied,       setRtCopied]       = useState(false)

  const currentVoiceMap = config.audio_elevenlabs_voice_map ?? {}
  const voiceMapEntries = Object.entries(currentVoiceMap)

  const rtEndpoint = useMemo(() => {
    if (typeof window === 'undefined') return '/v1/realtime?model=<model>'
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/v1/realtime?model=<model>`
  }, [])

  const openaiKeySet     = config.audio_openai_api_key_set === true
  const groqKeySet       = config.audio_groq_api_key_set === true
  const elevenlabsKeySet = config.audio_elevenlabs_api_key_set === true
  const rtEnabled        = config.realtime_enabled === true

  // ── Handlers ────────────────────────────────────────────────────────────────

  const fetchOpenAI = async () => {
    setOpenaiErr(null); setOpenaiLoading(true)
    try { const res = await api.getOpenAIAudioModels(); setOpenaiModels(res); if (res.detail) setOpenaiErr(res.detail) }
    catch (e) { setOpenaiErr(e instanceof Error ? e.message : String(e)); setOpenaiModels(null) }
    finally { setOpenaiLoading(false) }
  }

  const fetchGroq = async () => {
    setGroqErr(null); setGroqLoading(true)
    try { const res = await api.getGroqAudioModels(); setGroqModels(res); if (res.detail) setGroqErr(res.detail) }
    catch (e) { setGroqErr(e instanceof Error ? e.message : String(e)); setGroqModels(null) }
    finally { setGroqLoading(false) }
  }

  const fetchElevenLabs = async () => {
    setElErr(null); setElLoading(true); setElSelected(new Set())
    try { const res = await api.getElevenLabsVoices(); setElData(res); if (res.detail) setElErr(res.detail) }
    catch (e) { setElErr(e instanceof Error ? e.message : String(e)); setElData(null) }
    finally { setElLoading(false) }
  }

  const addVoiceMap = async () => {
    if (!elData) return
    const next = { ...currentVoiceMap }
    for (const vid of elSelected) {
      const voice = elData.voices.find(v => v.voice_id === vid)
      if (voice) next[voice.name.toLowerCase().replace(/\s+/g, '_')] = voice.voice_id
    }
    updateField('audio_elevenlabs_voice_map', next)
    try { await api.saveConfig({ ...config, audio_elevenlabs_voice_map: next }); refreshConfig(); setElSelected(new Set()); setSaveStatus('ok') }
    catch (e) { setSaveStatus('err:' + (e instanceof Error ? e.message : String(e))) }
  }

  const deleteVoice = async (name: string) => {
    const next = { ...currentVoiceMap }; delete next[name]
    updateField('audio_elevenlabs_voice_map', next)
    try { await api.saveConfig({ ...config, audio_elevenlabs_voice_map: next }); refreshConfig() }
    catch (e) { setSaveStatus('err:' + (e instanceof Error ? e.message : String(e))) }
  }

  const fetchRealtime = async () => {
    setRtErr(null); setRtLoading(true)
    try { const res = await api.getAudioVoices(); setRtModels(res.realtime_models ?? []) }
    catch (e) { setRtErr(e instanceof Error ? e.message : String(e)); setRtModels(null) }
    finally { setRtLoading(false) }
  }

  const copyEndpoint = () => {
    navigator.clipboard?.writeText(rtEndpoint).then(() => { setRtCopied(true); setTimeout(() => setRtCopied(false), 1500) })
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Defaults ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Providers par défaut" icon={<Volume2 size={13} />} />
        <CardBody>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="STT (transcription)" htmlFor="audio-stt">
              <select id="audio-stt" value={config.audio_default_stt_provider ?? 'openai'} onChange={e => updateField('audio_default_stt_provider', e.target.value)} className={selectCls}>
                <option value="openai">OpenAI</option>
                <option value="groq">Groq</option>
                <option value="elevenlabs">ElevenLabs (Scribe)</option>
                <option value="local">Local (Brain)</option>
              </select>
            </Field>
            <Field label="TTS (synthèse vocale)" htmlFor="audio-tts">
              <select id="audio-tts" value={config.audio_default_tts_provider ?? 'openai'} onChange={e => updateField('audio_default_tts_provider', e.target.value)} className={selectCls}>
                <option value="openai">OpenAI</option>
                <option value="elevenlabs">ElevenLabs</option>
                <option value="local">Local (Brain)</option>
              </select>
            </Field>
          </div>
        </CardBody>
      </Card>

      {/* ── Row: OpenAI + Groq ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* OpenAI Audio */}
        <Card>
          <CardHeader
            title="OpenAI Audio"
            subtitle="STT + TTS"
            icon={<Mic size={13} />}
            right={
              <Switch label="Actif" checked={config.audio_openai_enabled === true} onChange={() => updateField('audio_openai_enabled', !config.audio_openai_enabled)} />
            }
          />
          <CardBody className="flex flex-col gap-3">
            <Field label="Clé API" htmlFor="audio-openai-key">
              <input id="audio-openai-key" type="password" value={openaiKey}
                onChange={e => { markDirty(); setOpenaiKey(e.target.value); updateField('audio_openai_api_key', e.target.value) }}
                placeholder={openaiKeySet ? '•••••••• (vide = ne pas changer)' : 'sk-…'}
                autoComplete="off" className={inputCls}
              />
            </Field>
            <div className="flex flex-col gap-2">
              <Button variant="subtle" size="sm" disabled={openaiLoading} onClick={fetchOpenAI}>
                {openaiLoading ? 'Chargement…' : 'Découvrir les modèles'}
              </Button>
              {openaiErr && <p className="text-[11px] text-destructive">{openaiErr}</p>}
              {openaiModels && (
                <div className="flex flex-col gap-2">
                  {openaiModels.stt_models.length > 0 && (
                    <div>
                      <GroupLabel>STT</GroupLabel>
                      <div className="mt-1"><MiniTable headers={['ID', 'Nom']} rows={openaiModels.stt_models.map(m => [m.id, m.name ?? m.id])} /></div>
                    </div>
                  )}
                  {openaiModels.tts_models.length > 0 && (
                    <div>
                      <GroupLabel>TTS</GroupLabel>
                      <div className="mt-1"><MiniTable headers={['ID', 'Nom']} rows={openaiModels.tts_models.map(m => [m.id, m.name ?? m.id])} /></div>
                    </div>
                  )}
                  {openaiModels.voices.length > 0 && (
                    <div>
                      <GroupLabel>Voix TTS</GroupLabel>
                      <div className="mt-1"><MiniTable headers={['ID', 'Nom']} rows={openaiModels.voices.map(v => [v.id, v.name])} /></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardBody>
        </Card>

        {/* Groq */}
        <Card>
          <CardHeader
            title="Groq"
            subtitle="STT uniquement"
            icon={<Mic size={13} />}
            right={
              <Switch label="Actif" checked={config.audio_groq_enabled === true} onChange={() => updateField('audio_groq_enabled', !config.audio_groq_enabled)} />
            }
          />
          <CardBody className="flex flex-col gap-3">
            <Field label="Clé API" htmlFor="audio-groq-key">
              <input id="audio-groq-key" type="password" value={groqKey}
                onChange={e => { markDirty(); setGroqKey(e.target.value); updateField('audio_groq_api_key', e.target.value) }}
                placeholder={groqKeySet ? '•••••••• (vide = ne pas changer)' : 'gsk_…'}
                autoComplete="off" className={inputCls}
              />
            </Field>
            <div className="flex flex-col gap-2">
              <Button variant="subtle" size="sm" disabled={groqLoading} onClick={fetchGroq}>
                {groqLoading ? 'Chargement…' : 'Découvrir les modèles STT'}
              </Button>
              {groqErr && <p className="text-[11px] text-destructive">{groqErr}</p>}
              {groqModels?.stt_models && groqModels.stt_models.length > 0 && (
                <MiniTable headers={['ID', 'Nom']} rows={groqModels.stt_models.map(m => [m.id, m.name ?? m.id])} />
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── ElevenLabs ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="ElevenLabs"
          subtitle="STT Scribe + TTS"
          icon={<Volume2 size={13} />}
          right={
            <Switch label="Actif" checked={config.audio_elevenlabs_enabled === true} onChange={() => updateField('audio_elevenlabs_enabled', !config.audio_elevenlabs_enabled)} />
          }
        />
        <CardBody className="flex flex-col gap-4">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

            {/* Left: config + discovery */}
            <div className="flex flex-col gap-3">
              <Field label="Clé API" htmlFor="audio-el-key">
                <input id="audio-el-key" type="password" value={elevenlabsKey}
                  onChange={e => { markDirty(); setElevenlabsKey(e.target.value); updateField('audio_elevenlabs_api_key', e.target.value) }}
                  placeholder={elevenlabsKeySet ? '•••••••• (vide = ne pas changer)' : 'Saisir la clé ElevenLabs'}
                  autoComplete="off" className={inputCls}
                />
              </Field>
              <Button variant="subtle" size="sm" disabled={elLoading} onClick={fetchElevenLabs}>
                {elLoading ? 'Chargement…' : 'Découvrir les voix'}
              </Button>
              {elErr && <p className="text-[11px] text-destructive">{elErr}</p>}

              {elData && elData.voices.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="overflow-auto max-h-48 rounded-lg border border-border/40 bg-background">
                    <table className="w-full border-collapse">
                      <thead className="sticky top-0 bg-background/95">
                        <tr>
                          <th className="px-2 py-2 w-8 border-b border-border/40">
                            <input type="checkbox"
                              checked={elSelected.size === elData.voices.length && elData.voices.length > 0}
                              onChange={e => setElSelected(e.target.checked ? new Set(elData.voices.map(v => v.voice_id)) : new Set())}
                              className="w-3.5 h-3.5 rounded border-border bg-background text-primary"
                            />
                          </th>
                          <th className="px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Nom</th>
                          <th className="px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Cat.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {elData.voices.map(v => (
                          <tr key={v.voice_id} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                            <td className="px-2 py-1.5">
                              <input type="checkbox" checked={elSelected.has(v.voice_id)}
                                onChange={e => { const next = new Set(elSelected); if (e.target.checked) next.add(v.voice_id); else next.delete(v.voice_id); setElSelected(next) }}
                                className="w-3.5 h-3.5 rounded border-border bg-background text-primary"
                              />
                            </td>
                            <td className="px-2 py-1.5 text-[11px] text-foreground font-medium">{v.name}</td>
                            <td className="px-2 py-1.5 text-[11px] text-muted-foreground">{v.category || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Button variant="primary" size="sm" disabled={elSelected.size === 0} onClick={addVoiceMap}>
                    Ajouter au voice map ({elSelected.size})
                  </Button>
                </div>
              )}
              {elData?.models && elData.models.length > 0 && (
                <div>
                  <GroupLabel>Modèles TTS</GroupLabel>
                  <div className="mt-1">
                    <MiniTable headers={['ID', 'Nom']} rows={elData.models.map(m => [m.id, m.name ?? m.id])} />
                  </div>
                </div>
              )}
            </div>

            {/* Right: voice map */}
            <div className="flex flex-col gap-2">
              <GroupLabel>Voice map actuel {voiceMapEntries.length > 0 && `(${voiceMapEntries.length})`}</GroupLabel>
              {voiceMapEntries.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50 italic">
                  Aucune voix mappée. Découvre les voix et ajoute une sélection.
                </p>
              ) : (
                <div className="overflow-auto max-h-64 rounded-lg border border-border/40">
                  <table className="w-full border-collapse">
                    <thead className="bg-secondary/50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">Nom (clé)</th>
                        <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">Voice ID</th>
                        <th className="px-3 py-2 w-16" />
                      </tr>
                    </thead>
                    <tbody>
                      {voiceMapEntries.map(([name, vid]) => (
                        <tr key={name} className="border-t border-border/30 hover:bg-secondary/20">
                          <td className="px-3 py-2 text-[11px] text-foreground font-medium">{name}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground/60 truncate max-w-[120px]">{vid as string}</td>
                          <td className="px-3 py-2 text-right">
                            <button type="button" onClick={() => deleteVoice(name)}
                              className="text-[11px] text-destructive/50 hover:text-destructive transition-colors px-1">
                              Supprimer
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ── Realtime API ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Realtime API"
          icon={<Radio size={13} />}
          right={
            <div className="flex items-center gap-2">
              <Badge tone="primary">WebSocket</Badge>
              <Badge tone="warning">Premium</Badge>
              <Switch label="Actif" checked={rtEnabled} onChange={() => updateField('realtime_enabled', !rtEnabled)} disabled={!openaiKeySet} />
            </div>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-[11px] text-muted-foreground/70">
            Proxy WebSocket bidirectionnel vers <code className="font-mono text-[10px]">wss://api.openai.com/v1/realtime</code>.
            Mode "Realtime" NCM — STT + traduction + TTS dans un seul flux audio (latence minimale).
            Tarif indicatif : ~$0.06/min entrant · ~$0.24/min sortant.
          </p>

          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-muted-foreground">Clé OpenAI :</span>
            {openaiKeySet
              ? <Badge tone="success">Configurée</Badge>
              : <Badge tone="destructive">Manquante</Badge>}
            <span className="text-muted-foreground/50">(gérée dans OpenAI Audio ci-dessus)</span>
          </div>

          {/* Endpoint */}
          <div className="flex flex-col gap-1.5">
            <span className={labelCls}>Endpoint exposé</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-background border border-border/40 rounded-md text-[11px] font-mono text-foreground overflow-x-auto">
                {rtEndpoint}
              </code>
              <Button variant="subtle" size="sm" onClick={copyEndpoint}>
                {rtCopied ? 'Copié ✓' : 'Copier'}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground/50">
              Auth client : <code className="font-mono">Authorization: Bearer &lt;mercury-api-key&gt;</code>. Mercury injecte sa clé OpenAI vers l'upstream.
            </p>
          </div>

          {/* Models discovery */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className={labelCls}>Modèles Realtime exposés à NCM</span>
              <Button variant="subtle" size="sm" disabled={!openaiKeySet || rtLoading} onClick={fetchRealtime}>
                {rtLoading ? 'Chargement…' : 'Découvrir'}
              </Button>
            </div>
            {rtErr && <p className="text-[11px] text-destructive">{rtErr}</p>}
            {rtModels && rtModels.length > 0 && (
              <MiniTable headers={['Modèle', 'Provider']} rows={rtModels.map(m => [m.name, m.provider])} />
            )}
            {rtModels && rtModels.length === 0 && !rtErr && (
              <p className="text-[11px] text-muted-foreground/60 italic">Aucun modèle retourné — vérifier la clé OpenAI.</p>
            )}
          </div>

          {/* Status */}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted-foreground">Statut :</span>
            {!openaiKeySet
              ? <Badge tone="muted">Bloqué — clé manquante</Badge>
              : rtEnabled
              ? <Badge tone="success">Actif</Badge>
              : <Badge tone="muted">Inactif</Badge>
            }
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
