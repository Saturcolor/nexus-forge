import { Volume2 } from 'lucide-react'
import { useAudioVoices } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Spinner } from '../../ui/Spinner'

/** V2 audio routing card — STT/TTS models + TTS voices. */
export function AudioRoutingCard() {
  const { data, isLoading } = useAudioVoices()

  const hasModels = !!data && (data.stt_models.length > 0 || data.tts_models.length > 0)
  const hasVoices = !!data && data.voices.length > 0

  return (
    <Card>
      <CardHeader
        title="Routage audio"
        subtitle="Les routes /v1/audio/* résolvent le provider automatiquement. Le header X-Audio-Provider reste prioritaire."
        icon={<Volume2 size={13} />}
      />
      <CardBody className="!py-3 flex flex-col gap-4">
        {isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : !data || (!hasModels && !hasVoices) ? (
          <p className="text-[11px] text-muted-foreground/60 py-6 text-center m-0">
            Aucun modèle audio détecté.
          </p>
        ) : (
          <>
            {hasModels && (
              <div className="flex flex-col gap-2">
                <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest">
                  Modèles
                </span>
                <div className="overflow-x-auto rounded-md border border-border/60">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-background/40">
                        <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Modèle</th>
                        <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Provider</th>
                        <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60 w-20">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.stt_models.map(m => (
                        <tr key={`stt-${m.name}`} className="hover:bg-background/40">
                          <td className="px-3 py-1.5 border-b border-border/40">
                            <code className="text-[11px] font-mono text-foreground">{m.name}</code>
                          </td>
                          <td className="px-3 py-1.5 border-b border-border/40 text-[11px] text-foreground">{m.provider}</td>
                          <td className="px-3 py-1.5 border-b border-border/40"><Badge tone="primary">STT</Badge></td>
                        </tr>
                      ))}
                      {data.tts_models.map(m => (
                        <tr key={`tts-${m.name}`} className="hover:bg-background/40">
                          <td className="px-3 py-1.5 border-b border-border/40">
                            <code className="text-[11px] font-mono text-foreground">{m.name}</code>
                          </td>
                          <td className="px-3 py-1.5 border-b border-border/40 text-[11px] text-foreground">{m.provider}</td>
                          <td className="px-3 py-1.5 border-b border-border/40"><Badge tone="success">TTS</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {hasVoices && (
              <div className="flex flex-col gap-2">
                <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest">
                  Voix TTS
                </span>
                <div className="overflow-x-auto max-h-72 rounded-md border border-border/60">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr>
                        <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Nom</th>
                        <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Provider</th>
                        <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Engine</th>
                        <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Voice ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.voices].sort((a, b) => {
                        // Group local engines together: omnivoice clones first, then kokoro presets,
                        // then everything else by provider name.
                        const enginePrio = (v: typeof a) => v.engine === 'omnivoice' ? 0 : v.engine === 'kokoro' ? 1 : 2;
                        const eDiff = enginePrio(a) - enginePrio(b);
                        if (eDiff !== 0) return eDiff;
                        return (a.provider + a.name).localeCompare(b.provider + b.name);
                      }).map(v => (
                        <tr key={`${v.provider}-${v.name}`} className="hover:bg-background/40">
                          <td className="px-3 py-1.5 border-b border-border/40 text-[11px] text-foreground font-medium">{v.display_name || v.name}</td>
                          <td className="px-3 py-1.5 border-b border-border/40 text-[11px] text-foreground">{v.provider}</td>
                          <td className="px-3 py-1.5 border-b border-border/40">
                            {v.engine ? (
                              <Badge tone={v.engine === 'omnivoice' ? 'primary' : 'neutral'}>{v.engine}</Badge>
                            ) : (
                              <span className="text-[11px] text-muted-foreground/40">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 border-b border-border/40">
                            <code className="text-[11px] font-mono text-muted-foreground">{v.voice_id || v.name}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
