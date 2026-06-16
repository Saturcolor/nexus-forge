import { useState, useRef, useEffect } from 'react'
import { Package } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import {
  useLuceboxUpdater, useLuceboxUpdaterLog,
  useLuceboxUpdateMutation, useLuceboxBuildMutation,
  useLlamacppProbe, useLoadLlamacppModelMutation, useUnloadLlamacppModelMutation,
} from '../../../api/queries'

function colorize(line: string): string {
  if (/\[ERROR\]|error|FAILED|crash/i.test(line)) return 'text-destructive'
  if (/\[WARN\]|warning/i.test(line))             return 'text-theme-amber'
  if (/THERMAL|SIGSTOP|SIGCONT|EMERGENCY/i.test(line)) return 'text-orange-400'
  if (/\[perf\]|PERFORMANCE|ECO/i.test(line))    return 'text-primary'
  if (/load:|ready|started/i.test(line))          return 'text-theme-green'
  return 'text-muted-foreground'
}

export function LuceboxCard() {
  const [panelOpen, setPanelOpen] = useState(false)
  const { data: status, isLoading } = useLuceboxUpdater(true)
  const { data: liveLog }           = useLuceboxUpdaterLog(panelOpen || status?.in_progress === true)
  const updateMut  = useLuceboxUpdateMutation()
  const buildMut   = useLuceboxBuildMutation()
  const { data: probe }     = useLlamacppProbe(true)
  const loadMut    = useLoadLlamacppModelMutation()
  const unloadMut  = useUnloadLlamacppModelMutation()
  const [reloadLog, setReloadLog] = useState<string | null>(null)
  const logScrollRef = useRef<HTMLDivElement>(null)

  const inProgress   = status?.in_progress === true || updateMut.isPending || buildMut.isPending
  const behind       = status?.behind      ?? 0
  const buildExists  = status?.build_exists === true
  const localSha     = status?.local_sha   ?? ''
  const remoteSha    = status?.remote_sha  ?? ''

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const luceboxInstances = (probe?.instances ?? []).filter((i: any) => i.backend_type === 'lucebox' && i.running === true)

  const logLines = liveLog?.log ?? status?.log_tail ?? []
  useEffect(() => {
    const el = logScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logLines.length])

  const runReload = async (instanceIds: string[]) => {
    if (instanceIds.length === 0) return
    setReloadLog(`Reload de ${instanceIds.length} instance${instanceIds.length > 1 ? 's' : ''} Lucebox…`)
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
        const hint = stage === 'load' ? ' (reload manuel requis)' : ''
        setReloadLog(prev => `${prev ?? ''}\n  ✗ ${mid} [${stage}] : ${msg}${hint}`)
      }
    }
    const ok = failed.length === 0
    setReloadLog(prev =>
      `${prev ?? ''}\n${ok
        ? `Terminé — ${instanceIds.length} instance${instanceIds.length > 1 ? 's' : ''} reload OK.`
        : `Terminé avec ${failed.length} échec${failed.length > 1 ? 's' : ''} sur ${instanceIds.length}.`
      }`
    )
  }

  const handleUpdate = async () => {
    if (inProgress) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = luceboxInstances.map((i: any) => i.model_id)
    const msg = snapshot.length > 0
      ? `Update Lucebox (~3-5min). ${snapshot.length} instance${snapshot.length > 1 ? 's' : ''} running seront reload :\n  - ${snapshot.join('\n  - ')}\n\nContinuer ?`
      : 'Update Lucebox (~3-5min) — aucune instance running. Continuer ?'
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
    if (!window.confirm('Rebuild cmake-only (skip git pull, ~1-2min). Instances running non reload. Continuer ?')) return
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
    <Card>
      <CardHeader
        title="Lucebox Updater"
        icon={<Package size={13} />}
        right={
          <div className="flex items-center gap-2">
            {inProgress && (
              <span className="text-[11px] text-theme-amber animate-pulse">
                {status?.phase ?? 'en cours…'}
              </span>
            )}
            <Button size="sm" variant="subtle" onClick={() => setPanelOpen(o => !o)}>
              {panelOpen ? 'Replier' : 'Détails / log'}
            </Button>
          </div>
        }
      />
      <CardBody>
        {isLoading && <div className="flex justify-center py-4"><Spinner size={16} /></div>}
        {status?.error && <p className="text-[11px] text-destructive mb-2">{status.error}</p>}

        {!isLoading && status && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-muted-foreground/60">local</span>
                  <span className="font-mono text-[11px] text-foreground">{localSha || '—'}</span>
                  <span className="text-muted-foreground/40">→</span>
                  <span className="text-[10px] text-muted-foreground/60">remote</span>
                  <span className="font-mono text-[11px] text-foreground">{remoteSha || '—'}</span>
                  {behind > 0
                    ? <Badge tone="warning">{behind} commit{behind > 1 ? 's' : ''} en retard</Badge>
                    : <Badge tone="success">up-to-date</Badge>
                  }
                  {!buildExists && <Badge tone="destructive">Build absent</Badge>}
                  {inProgress && status.phase && <Badge tone="primary">{status.phase}</Badge>}
                </div>
                <p className="text-[10px] text-muted-foreground/60 mt-1">
                  {luceboxInstances.length > 0
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ? `${luceboxInstances.length} instance${luceboxInstances.length > 1 ? 's' : ''} Lucebox running — reload automatique après update.`
                    : 'Aucune instance Lucebox running.'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  variant="primary" size="sm"
                  onClick={handleUpdate}
                  disabled={inProgress || (behind === 0 && buildExists)}
                  title={behind === 0 && buildExists ? 'À jour — utilise Rebuild pour forcer cmake' : 'git pull + submodule + cmake (~3-5min)'}
                >
                  Update
                </Button>
                <Button
                  variant="subtle" size="sm"
                  onClick={handleRebuild}
                  disabled={inProgress}
                  title="cmake-only rebuild (skip git pull)"
                >
                  Rebuild
                </Button>
              </div>
            </div>

            {panelOpen && (
              <div className="mt-3 bg-background border border-border/60 rounded-md p-2">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Log</span>
                  <span className="text-[10px] text-muted-foreground/40 font-mono">{logLines.length} lignes</span>
                </div>
                <div ref={logScrollRef} className="max-h-64 overflow-y-auto font-mono text-[10px] leading-relaxed space-y-0.5">
                  {logLines.length === 0 && <p className="text-muted-foreground/40">Aucun log</p>}
                  {logLines.map((line: string, i: number) => (
                    <div key={i} className={`whitespace-pre-wrap break-all ${colorize(line)}`}>{line}</div>
                  ))}
                </div>
                {reloadLog && (
                  <pre className="mt-2 text-[10px] text-theme-green whitespace-pre-wrap font-mono">{reloadLog}</pre>
                )}
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
