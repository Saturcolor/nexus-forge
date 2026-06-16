import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import type { BrainBackendInfo } from '../../../api/admin'
import { useBrainUpdater, useBrainUpdaterActionMutation } from '../../../api/queries'

function ToolboxRow({
  name, info, onAction, busy,
}: {
  name: string; info: BrainBackendInfo; onAction: (a: string) => void; busy: boolean
}) {
  const isNative = info.type === 'native'
  const label    = isNative ? name : info.toolbox_name
  const present  = isNative ? info.installed : info.exists
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/40 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-medium text-foreground">{label}</span>
          <Badge tone="neutral">{info.type}</Badge>
          <Badge tone={present ? 'success' : 'destructive'}>{present ? 'OK' : 'Absent'}</Badge>
          {info.has_backup && <Badge tone="primary">Backup</Badge>}
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">
          v{info.version ?? '—'}
          {isNative && info.binary && <> · {info.binary}</>}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          size="sm" variant="primary"
          onClick={() => onAction('build')} disabled={busy}
          title={isNative ? 'Build natif via build-native.sh (fresh clone llama.cpp)' : 'Rebuild depuis Dockerfile (dernier master llama.cpp)'}
        >
          Build
        </Button>
        <Button
          size="sm" variant="subtle"
          onClick={() => onAction('pull')} disabled={busy}
          title={isNative ? 'git pull + rebuild' : 'Pull image Docker Hub'}
        >
          {isNative ? 'Update' : 'Pull'}
        </Button>
        <Button
          size="sm" variant="subtle"
          onClick={() => onAction('backup')} disabled={busy}
          title={isNative ? 'Sauvegarder le binaire actuel (.bak)' : "Sauvegarder l'image actuelle"}
        >
          Backup
        </Button>
        {info.has_backup && (
          <Button
            size="sm" variant="subtle"
            onClick={() => onAction('restore')} disabled={busy}
            title="Restaurer depuis backup"
          >
            Restore
          </Button>
        )}
      </div>
    </div>
  )
}

export function ToolboxesCard() {
  const { data: updater, isLoading, isError } = useBrainUpdater()
  const actionMut = useBrainUpdaterActionMutation()
  const [log, setLog] = useState<string | null>(null)

  const exec = (backend: string, action: string) => {
    setLog(`${action} ${backend}…`)
    actionMut.mutate({ action, backend }, {
      onSuccess: (d) => setLog(d.ok ? `${action} ${backend} OK (v${d.version ?? '?'})` : `Erreur : ${d.error ?? '?'}`),
      onError:   (e) => setLog(`Erreur : ${e.message}`),
    })
  }

  const busy = updater?.update_in_progress === true || actionMut.isPending

  return (
    <Card>
      <CardHeader
        title="Toolboxes llama.cpp"
        icon={<Wrench size={13} />}
        right={
          busy ? <span className="text-[11px] text-theme-amber animate-pulse">Opération en cours…</span> : undefined
        }
      />
      <CardBody className="!py-1">
        {isLoading && <div className="flex justify-center py-4"><Spinner size={16} /></div>}
        {isError   && <p className="text-[11px] text-muted-foreground py-2">Brain daemon inaccessible</p>}
        {updater && !isLoading && (
          <>
            {Object.entries(updater)
              .filter(([key, value]) => key !== 'update_in_progress' && value && typeof value === 'object')
              .sort(([a], [b]) => {
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
          <p className={`py-2 text-[11px] font-mono ${log.startsWith('Erreur') ? 'text-destructive' : 'text-theme-green'}`}>
            {log}
          </p>
        )}
      </CardBody>
    </Card>
  )
}
