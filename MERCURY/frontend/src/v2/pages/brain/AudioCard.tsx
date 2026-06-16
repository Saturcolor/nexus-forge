import { useState, useEffect } from 'react'
import { Volume2 } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge, StatusDot } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import * as api from '../../../api/admin'

type AudioHealth = {
  whisper_loaded?: boolean
  whisper_model?: string | null
  kokoro_loaded?: boolean
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

export function AudioCard() {
  const [health,      setHealth]      = useState<AudioHealth | null>(null)
  const [voices,      setVoices]      = useState<AudioVoice[]>([])
  const [libs,        setLibs]        = useState<LibsStatus | null>(null)
  const [upgrading,   setUpgrading]   = useState(false)
  const [upgradeLog,  setUpgradeLog]  = useState<string[]>([])
  const [showLog,     setShowLog]     = useState(false)
  const [err,         setErr]         = useState<string | null>(null)

  const fetchData = async () => {
    try {
      const data = await api.getAudioLocalHealth() as AudioHealth
      setHealth(data); setErr(data.error || null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setHealth(null)
    }
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
    setUpgrading(true); setShowLog(true); setUpgradeLog(['Lancement…'])
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

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 30000)
    return () => clearInterval(iv)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Card>
      <CardHeader
        title="Audio Local"
        icon={<Volume2 size={13} />}
        right={<Button size="sm" variant="ghost" onClick={fetchData}>Rafraîchir</Button>}
      />
      <CardBody>
        {err && <p className="text-[11px] text-destructive mb-2">{err}</p>}

        {health && health.configured !== false && (
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">STT (Whisper)</span>
              <div className="flex items-center gap-2">
                <StatusDot tone={health.whisper_loaded ? 'success' : 'neutral'} />
                <span className="text-[11px] text-foreground">
                  {health.whisper_loaded ? health.whisper_model : 'Non chargé'}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">TTS (Kokoro)</span>
              <div className="flex items-center gap-2">
                <StatusDot tone={health.kokoro_loaded ? 'success' : 'neutral'} />
                <span className="text-[11px] text-foreground">
                  {health.kokoro_loaded ? `${health.voices_count} voix` : 'Non chargé'}
                </span>
              </div>
            </div>
          </div>
        )}

        {voices.length > 0 && (
          <div className="flex flex-col gap-1 mb-3">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Voix disponibles</span>
            <div className="flex flex-wrap gap-1">
              {voices.slice(0, 12).map(v => (
                <Badge key={v.id} tone="neutral" mono>{v.name}</Badge>
              ))}
              {voices.length > 12 && (
                <span className="text-[10px] text-muted-foreground/50">+{voices.length - 12}</span>
              )}
            </div>
          </div>
        )}

        {libs && libs.configured !== false && (
          <div className="flex flex-col gap-2 pt-3 border-t border-border/40">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Libs Python</span>
              <Button size="sm" variant="subtle" onClick={handleUpgrade} disabled={upgrading}>
                {upgrading ? 'Upgrade…' : 'Mettre à jour'}
              </Button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(libs.libs ?? {}).map(([name, version]) => (
                <span key={name} className="text-[10px] text-muted-foreground/70">
                  <span className="text-foreground">{name}</span>{' '}
                  <span className={version ? 'text-muted-foreground/50' : 'text-destructive'}>
                    {version ?? 'non installé'}
                  </span>
                </span>
              ))}
            </div>
            {showLog && upgradeLog.length > 0 && (
              <div className="mt-1 max-h-32 overflow-auto rounded border border-border/60 bg-background p-2">
                <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap m-0">
                  {upgradeLog.join('\n')}
                </pre>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
