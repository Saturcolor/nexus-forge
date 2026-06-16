import { useState } from 'react'
import { HardDrive, Trash2, Key, Eye, EyeOff } from 'lucide-react'
import { clsx } from 'clsx'
import {
  useLlamacppModels, useDeleteLocalModelMutation,
  useHfDisk, useHfToken, useSetHfTokenMutation,
} from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'

function DiskRow() {
  const { data } = useHfDisk()
  if (!data) return null
  const { models_used_gb, free_gb, total_gb, disk_used_gb } = data
  const pct = total_gb > 0 ? Math.min(100, (disk_used_gb / total_gb) * 100) : 0
  const barColor = pct > 90 ? 'bg-destructive' : pct > 75 ? 'bg-theme-amber' : 'bg-theme-green'

  return (
    <Card>
      <CardHeader title="Stockage" icon={<HardDrive size={13} />} />
      <CardBody className="!py-3 flex flex-col gap-2">
        <div className="flex items-center gap-4 text-[11px]">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Modèles</span>
            <span className="font-mono font-semibold">{models_used_gb.toFixed(1)} GB</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Disponible</span>
            <span className="font-mono">{free_gb.toFixed(1)} GB</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Total</span>
            <span className="font-mono text-muted-foreground">{total_gb.toFixed(1)} GB</span>
          </div>
        </div>
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={clsx('h-full transition-all', barColor)} style={{ width: `${pct}%` }} />
        </div>
      </CardBody>
    </Card>
  )
}

function TokenCard() {
  const { data, isLoading } = useHfToken()
  const setMut = useSetHfTokenMutation()
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)
  const [show, setShow] = useState(false)

  const configured = data?.configured === true

  const handleSave = () => {
    const val = input.trim()
    if (!val) return
    setMut.mutate(val, {
      onSuccess: () => { setInput(''); setEditing(false) },
    })
  }

  const handleClear = () => {
    if (!confirm('Supprimer le token HuggingFace ?')) return
    setMut.mutate(null)
  }

  return (
    <Card>
      <CardHeader title="HuggingFace Token" icon={<Key size={13} />} />
      <CardBody className="!py-3">
        {isLoading ? (
          <div className="flex justify-center py-2"><Spinner /></div>
        ) : configured && !editing ? (
          <div className="flex items-center justify-between gap-3">
            <code className="text-[11px] font-mono text-theme-green">{data?.masked ?? '••••••'}</code>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={setMut.isPending}>
                Modifier
              </Button>
              <Button variant="destructive" size="sm" onClick={handleClear} disabled={setMut.isPending}>
                Effacer
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {!configured && (
              <p className="text-[11px] text-muted-foreground/70">
                Optionnel pour les repos publics, requis pour les repos gated.
              </p>
            )}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={show ? 'text' : 'password'}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  placeholder="hf_..."
                  autoFocus={editing}
                  className="w-full px-2.5 py-1.5 pr-8 bg-background border border-border/60 rounded-md text-[11px] font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40"
                />
                <button
                  type="button"
                  onClick={() => setShow(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                >
                  {show ? <EyeOff size={11} /> : <Eye size={11} />}
                </button>
              </div>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={setMut.isPending || !input.trim()}>
                Enregistrer
              </Button>
              {editing && (
                <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setInput('') }}>
                  Annuler
                </Button>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

export function LocalModelsCard() {
  const { data, isLoading } = useLlamacppModels()
  const deleteMut = useDeleteLocalModelMutation()
  const models = data?.models ?? []
  const totalSize = models.reduce((s, m) => s + (m.size_gb ?? 0), 0)

  const handleDelete = (modelId: string, running: boolean) => {
    if (running) {
      alert(`Déchargez d'abord ${modelId} via Brain.`)
      return
    }
    if (!confirm(`Supprimer définitivement ${modelId} du disque ?`)) return
    deleteMut.mutate(modelId)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <DiskRow />
        <TokenCard />
      </div>

      <Card>
        <CardHeader
          title="Modèles locaux"
          icon={<HardDrive size={13} />}
          right={
            models.length > 0
              ? <span className="text-[10px] text-muted-foreground/60 font-mono">{models.length} · {totalSize.toFixed(1)} GB</span>
              : undefined
          }
        />
        <CardBody className="!py-3">
          {isLoading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : models.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/50 py-6 text-center">
              Aucun modèle local. Télécharge un fichier GGUF depuis la recherche HuggingFace.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {models.map(m => (
                <div
                  key={m.model_id}
                  className="flex items-center gap-2 px-2.5 py-1.5 bg-background/60 border border-border/40 rounded-md"
                >
                  <code className="text-[11px] font-mono text-foreground flex-1 min-w-0 truncate" title={m.model_id}>
                    {m.model_id}
                  </code>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {m.running   && <Badge tone="success">running</Badge>}
                    {m.protected && <Badge tone="primary">protected</Badge>}
                    {m.kind === 'hf' && <Badge tone="muted">vLLM</Badge>}
                    <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                      {m.size_gb?.toFixed(1) ?? '?'} GB
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(m.model_id, !!m.running)}
                      disabled={!!m.running || deleteMut.isPending}
                      title={m.running ? "Déchargez le modèle d'abord" : 'Supprimer du disque'}
                    >
                      <Trash2 size={10} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
