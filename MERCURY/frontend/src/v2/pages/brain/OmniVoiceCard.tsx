import { useState, useEffect } from 'react'
import { Wand2, Trash2 } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge, StatusDot } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import * as api from '../../../api/admin'
import type { OmniVoiceStatus, OmniVoiceProfile } from '../../../api/admin'

export function OmniVoiceCard() {
  const [status,   setStatus]   = useState<OmniVoiceStatus | null>(null)
  const [profiles, setProfiles] = useState<OmniVoiceProfile[]>([])
  const [busy,     setBusy]     = useState(false)
  const [err,      setErr]      = useState<string | null>(null)

  const refresh = async () => {
    try {
      const s = await api.getOmniVoiceStatus()
      setStatus(s)
      setErr(s.error || null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setStatus(null)
    }
    try {
      const p = await api.getOmniVoiceProfiles()
      setProfiles(p.profiles ?? [])
    } catch { /* silent */ }
  }

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 30000)
    return () => clearInterval(iv)
  }, [])

  const toggleLoad = async () => {
    setBusy(true); setErr(null)
    try {
      if (status?.loaded) {
        await api.postOmniVoiceUnload()
      } else {
        await api.postOmniVoiceLoad()
      }
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeProfile = async (id: string) => {
    if (!confirm(`Supprimer le profil ${id} ?`)) return
    setBusy(true); setErr(null)
    try {
      await api.deleteOmniVoiceProfile(id)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loaded     = !!status?.loaded
  const configured = status?.configured !== false
  const device     = status?.device ?? '—'

  return (
    <Card>
      <CardHeader
        title="OmniVoice — TTS clone zero-shot"
        icon={<Wand2 size={13} />}
        right={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={refresh} disabled={busy}>Rafraîchir</Button>
            <Button
              size="sm"
              variant={loaded ? 'subtle' : 'primary'}
              onClick={toggleLoad}
              disabled={busy || !configured}
            >
              {busy ? '…' : loaded ? 'Unload' : 'Load'}
            </Button>
          </div>
        }
      />
      <CardBody>
        {err && <p className="text-[11px] text-destructive mb-2">{err}</p>}
        {!configured && (
          <p className="text-[11px] text-muted-foreground">
            Audio local non configuré — coche <code className="px-1 bg-secondary/30 rounded">audio_local_enabled</code> et renseigne <code className="px-1 bg-secondary/30 rounded">audio_local_url</code> dans Settings.
          </p>
        )}

        {configured && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <Cell label="Engine">
                <div className="flex items-center gap-2">
                  <StatusDot tone={loaded ? 'success' : 'neutral'} />
                  <span className="text-[11px] text-foreground">{loaded ? 'Loaded' : 'Unloaded'}</span>
                </div>
              </Cell>
              <Cell label="Device">
                <span className="text-[11px] text-foreground">{device}</span>
              </Cell>
              <Cell label="Profiles">
                <span className="text-[11px] text-foreground">{status?.profiles_count ?? profiles.length}</span>
              </Cell>
            </div>

            {loaded && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                <span className="text-[10px] text-muted-foreground/70">
                  <span className="text-muted-foreground">num_step</span> {status?.num_step}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  <span className="text-muted-foreground">guidance</span> {status?.guidance_scale}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  <span className="text-muted-foreground">sample_rate</span> {status?.sample_rate} Hz
                </span>
              </div>
            )}

            <div className="pt-3 border-t border-border/40">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Voice profiles</span>
              {profiles.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                  Aucun profil. Crée-en depuis NCM (Agent Settings → Voice → Manage voice clones) ou via <code className="px-1 bg-secondary/30 rounded">POST {'{'}daemon{'}'}/audio/profiles</code>.
                </p>
              ) : (
                <ul className="flex flex-col gap-1 mt-1">
                  {profiles.map(p => (
                    <li key={p.id} className="flex items-center justify-between py-1">
                      <div className="min-w-0 flex items-center gap-2">
                        <Badge tone="neutral" mono>{p.id}</Badge>
                        <span className="text-[11px] text-foreground truncate">{p.name}</span>
                        <span className="text-[10px] text-muted-foreground/60">
                          {p.language || 'auto'} · master:{p.master || 'raw'}
                        </span>
                      </div>
                      <button
                        onClick={() => removeProfile(p.id)}
                        disabled={busy || p.locked}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                        title={p.locked ? 'Profile locked' : 'Delete'}
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
      {children}
    </div>
  )
}
