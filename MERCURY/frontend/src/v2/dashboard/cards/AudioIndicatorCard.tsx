import { useEffect, useState } from 'react'
import { Mic, Volume2, ArrowRight, Settings, Cloud, Wand2 } from 'lucide-react'
import * as api from '../../../api/admin'
import type { Config } from '../../../api/admin'
import { useConfig, useSaveConfigMutation } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { StatusDot } from '../../ui/Badge'
import { Switch } from '../../ui/Switch'
import { Spinner } from '../../ui/Spinner'

type AudioHealth = {
  whisper_loaded?: boolean
  whisper_model?: string | null
  kokoro_loaded?: boolean
  kokoro_lang?: string | null
  configured?: boolean
  voices_count?: number
  error?: string
  // OmniVoice (TTS clone zero-shot) — exposé par /audio/health depuis le daemon brain.
  omnivoice?: {
    loaded?: boolean
    device?: string
    num_step?: number
    error?: string | null
  }
  profiles_count?: number
}

const KOKORO_LANG_LABELS: Record<string, string> = {
  a: 'en-US', b: 'en-GB', e: 'es', f: 'fr',
  h: 'hi', i: 'it', j: 'ja', k: 'ko', p: 'pt-BR', z: 'zh',
}

type AudioIndicatorCardProps = {
  onOpenRouting?: () => void
  onOpenBrain?: () => void
}

export function AudioIndicatorCard({ onOpenRouting, onOpenBrain }: AudioIndicatorCardProps) {
  const { data: config } = useConfig()
  const saveConfig = useSaveConfigMutation()
  const [health, setHealth] = useState<AudioHealth | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const audioEnabled = config?.audio_local_enabled === true
  const audioUrl = (config?.audio_local_url ?? '').trim()
  const configured = audioEnabled && audioUrl !== ''

  useEffect(() => {
    if (!configured) {
      setHealth(null)
      setErr(null)
      return
    }
    let mounted = true
    const fetchHealth = async () => {
      try {
        const data = await api.getAudioLocalHealth() as AudioHealth
        if (!mounted) return
        setHealth(data)
        setErr(data.error || null)
      } catch (e) {
        if (!mounted) return
        setErr(e instanceof Error ? e.message : String(e))
        setHealth(null)
      }
    }
    fetchHealth()
    const t = setInterval(fetchHealth, 15000)
    return () => { mounted = false; clearInterval(t) }
  }, [configured])

  const sttUp   = health?.whisper_loaded === true
  const ttsUp   = health?.kokoro_loaded === true
  const cloneUp = health?.omnivoice?.loaded === true

  const handleToggle = () => {
    if (!config) return
    saveConfig.mutate({ ...config, audio_local_enabled: !audioEnabled })
  }

  return (
    <Card className="h-full">
      <CardHeader
        title="Audio local"
        icon={<Volume2 size={13} />}
        right={
          onOpenRouting && (
            <button
              type="button"
              onClick={onOpenRouting}
              className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors"
              title="Voir le routage audio (STT/TTS, voix)"
            >
              Routage <ArrowRight size={11} />
            </button>
          )
        }
      />
      <CardBody className="!py-3 flex flex-col gap-2">
        {/* Master toggle — désactive complètement le provider audio local. */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-background/60 border border-border/40">
          <span className="text-[11px] font-medium text-foreground flex-1">Activé</span>
          {saveConfig.isPending && <Spinner size={11} />}
          <Switch
            checked={audioEnabled}
            onChange={handleToggle}
            disabled={!config || saveConfig.isPending}
          />
        </div>

        {!audioEnabled && (
          <>
            <p className="text-[10px] text-muted-foreground/60 px-1">
              Provider audio local désactivé.
            </p>
            <CloudAudioRow config={config} />
          </>
        )}

        {saveConfig.isError && (
          <p className="text-[11px] text-destructive px-1">
            Échec du toggle : {saveConfig.error instanceof Error ? saveConfig.error.message : String(saveConfig.error)}
          </p>
        )}

        {audioEnabled && !audioUrl && (
          <p className="text-[11px] text-theme-amber px-1">
            Aucune URL configurée. Configure-la depuis les{' '}
            <button
              type="button"
              onClick={onOpenBrain}
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              Settings
            </button>
            .
          </p>
        )}

        {configured && err && <p className="text-[11px] text-destructive">{err}</p>}
        {configured && !err && health == null && (
          <p className="text-[11px] text-muted-foreground/60">Chargement…</p>
        )}
        {configured && health && (
          <>
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-background/60 border border-border/40">
              <Mic size={13} className="text-muted-foreground/60 shrink-0" />
              <StatusDot tone={sttUp ? 'success' : 'muted'} />
              <span className="text-[11px] font-medium text-foreground flex-1">STT</span>
              <span className="text-[10px] font-mono text-muted-foreground/70 truncate">
                {sttUp ? (health.whisper_model ?? 'whisper') : 'non chargé'}
              </span>
            </div>
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-background/60 border border-border/40">
              <Volume2 size={13} className="text-muted-foreground/60 shrink-0" />
              <StatusDot tone={ttsUp ? 'success' : 'muted'} />
              <span className="text-[11px] font-medium text-foreground flex-1">TTS</span>
              <span className="text-[10px] font-mono text-muted-foreground/70 truncate">
                {ttsUp
                  ? `kokoro · ${KOKORO_LANG_LABELS[health.kokoro_lang ?? ''] ?? health.kokoro_lang ?? '?'}`
                  : 'non chargé'}
              </span>
            </div>
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-background/60 border border-border/40">
              <Wand2 size={13} className="text-muted-foreground/60 shrink-0" />
              <StatusDot tone={cloneUp ? 'success' : 'muted'} />
              <span className="text-[11px] font-medium text-foreground flex-1">Clone</span>
              <span className="text-[10px] font-mono text-muted-foreground/70 truncate">
                {cloneUp
                  ? `omnivoice · ${health.omnivoice?.device ?? '?'}${
                      health.profiles_count != null ? ` · ${health.profiles_count} profil${health.profiles_count > 1 ? 's' : ''}` : ''
                    }`
                  : 'non chargé'}
              </span>
            </div>
            <CloudAudioRow config={config} />
            <div className="flex items-center justify-between gap-2 px-1 pt-0.5">
              {health.voices_count != null ? (
                <span className="text-[10px] text-muted-foreground/60">
                  {health.voices_count} voix dispo
                </span>
              ) : <span />}
              {onOpenBrain && (
                <button
                  type="button"
                  onClick={onOpenBrain}
                  className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  title="Ouvrir la page Brain pour gérer libs/voix"
                >
                  <Settings size={10} /> Gérer
                </button>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * Petit indicateur read-only des providers audio cloud (OpenAI / Groq /
 * ElevenLabs). Affiché seulement si au moins un est activé — sinon ça ferait
 * juste du bruit.
 */
function CloudAudioRow({ config }: { config: Config | undefined }) {
  if (!config) return null
  const providers: { id: string; label: string; enabled: boolean; configured: boolean }[] = [
    {
      id: 'openai',
      label: 'OpenAI',
      enabled: config.audio_openai_enabled === true,
      configured: config.audio_openai_api_key_set === true,
    },
    {
      id: 'groq',
      label: 'Groq',
      enabled: config.audio_groq_enabled === true,
      configured: config.audio_groq_api_key_set === true,
    },
    {
      id: 'elevenlabs',
      label: 'ElevenLabs',
      enabled: config.audio_elevenlabs_enabled === true,
      configured: config.audio_elevenlabs_api_key_set === true,
    },
  ]
  const anyEnabled = providers.some(p => p.enabled)
  if (!anyEnabled) return null
  return (
    <div className="flex flex-col gap-1 px-2.5 py-1.5 rounded-md bg-background/60 border border-border/40">
      <div className="flex items-center gap-1.5">
        <Cloud size={11} className="text-muted-foreground/60" />
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
          Audio cloud
        </span>
      </div>
      <div className="flex items-center gap-2.5 flex-wrap pl-0.5">
        {providers.filter(p => p.enabled).map(p => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1"
            title={p.configured ? `${p.label} · clé API configurée` : `${p.label} · clé API manquante`}
          >
            <StatusDot tone={p.configured ? 'success' : 'warning'} />
            <span className="text-[11px] text-foreground">{p.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
