import { useState } from 'react'
import { Network, RefreshCw, Trash2, Plus, Eye, EyeOff, Pencil, PlusCircle } from 'lucide-react'
import { clsx } from 'clsx'
import type { Config, ModelMappingResponse } from '../../../api/admin'
import * as api from '../../../api/admin'
import {
  useConfig,
  useSaveConfigMutation,
  useCacheModels,
  useSetHiddenModelMutation,
  useModelMapping,
} from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { EditMappingModal } from './EditMappingModal'

type RowSource = 'Mapping' | 'Résolution' | 'Backend'

type Row = {
  tag: string
  backend: string
  backend_model_id: string
  source: RowSource
}

function buildRows(mapping: ModelMappingResponse | null): Row[] {
  if (!mapping) return []
  const byTag = new Map<string, { backend: string; backend_model_id: string; source: RowSource }>()

  for (const m of mapping.from_config) {
    byTag.set(m.canonical, { backend: m.backend, backend_model_id: m.backend_model_id, source: 'Mapping' })
  }
  for (const m of mapping.from_cache) {
    if (!byTag.has(m.canonical)) {
      byTag.set(m.canonical, { backend: m.backend, backend_model_id: m.backend_model_id, source: 'Résolution' })
    }
  }
  for (const m of mapping.backend_models) {
    if (!byTag.has(m.name)) {
      byTag.set(m.name, { backend: m.backend, backend_model_id: m.backend_model_id, source: 'Backend' })
    }
  }

  return Array.from(byTag.entries())
    .map(([tag, v]) => ({ tag, ...v }))
    .sort((a, b) => a.tag.localeCompare(b.tag))
}

function sourceTone(source: RowSource): 'primary' | 'success' | 'muted' {
  if (source === 'Mapping')   return 'primary'
  if (source === 'Résolution') return 'success'
  return 'muted'
}

function getHiddenModelName(r: Pick<Row, 'tag' | 'backend' | 'backend_model_id'>): string {
  const backend = (r.backend ?? '').trim()
  const bid = (r.backend_model_id ?? '').trim()
  if (backend && bid) return `${backend}/${bid}`
  return (r.tag ?? '').trim()
}

/** V2 model mapping card — list resolved models, edit/add/delete mapping, hide/unhide. */
export function ModelMappingCard() {
  const { data: config } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()
  const { data: cacheModelsData } = useCacheModels()
  const setHiddenMutation = useSetHiddenModelMutation()

  const { data: mapping = null, isLoading: loading, error: mappingErr, refetch: loadMapping } = useModelMapping()
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [flushLoading, setFlushLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editModal, setEditModal] = useState<{ tag: string; backend: string; backend_model_id: string } | null>(null)
  const [newEntry, setNewEntry] = useState(false)
  const [showHiddenModels, setShowHiddenModels] = useState(false)

  const displayErr = error ?? (mappingErr ? (mappingErr instanceof Error ? mappingErr.message : String(mappingErr)) : null)

  const handleRefreshCache = async () => {
    setRefreshLoading(true)
    setError(null)
    try {
      await api.refreshModelsCache()
      await loadMapping()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshLoading(false)
    }
  }

  const handleFlushCache = async () => {
    setFlushLoading(true)
    setError(null)
    try {
      await api.flushModelsCache()
      await loadMapping()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFlushLoading(false)
    }
  }

  const handleSaveMappingEntry = async (
    canonical: string,
    backend: string,
    backend_model_id: string,
    isNew: boolean,
  ) => {
    const current = (config?.model_mapping ?? {}) as Record<string, { backend: string; backend_model_id: string }>
    const next = { ...current }
    if (!isNew) {
      const prevTag = editModal?.tag
      if (prevTag && prevTag !== canonical) delete next[prevTag]
    }
    next[canonical] = { backend, backend_model_id }
    try {
      await saveConfigMutation.mutateAsync({ ...config, model_mapping: next } as Config)
      await loadMapping()
      setEditModal(null)
      setNewEntry(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDeleteMappingEntry = async (canonical: string) => {
    const current = (config?.model_mapping ?? {}) as Record<string, { backend: string; backend_model_id: string }>
    const next = { ...current }
    delete next[canonical]
    try {
      await saveConfigMutation.mutateAsync({ ...config, model_mapping: next } as Config)
      await loadMapping()
      setEditModal(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const rows = buildRows(mapping)
  const hiddenSet = new Set(cacheModelsData?.hidden_model_names ?? [])
  const hiddenCount = rows.filter(r => hiddenSet.has(getHiddenModelName(r))).length
  const visibleRows = rows.filter(r => showHiddenModels || !hiddenSet.has(getHiddenModelName(r)))

  return (
    <>
      <Card>
        <CardHeader
          title="Résolution des modèles"
          subtitle="Tag = identifiant utilisé dans le champ model pour le routage. Les entrées « Mapping » sont éditables."
          icon={<Network size={13} />}
          right={
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="subtle"
                size="sm"
                onClick={handleRefreshCache}
                disabled={refreshLoading}
                title="Rafraîchir le cache des modèles"
              >
                <RefreshCw size={11} className={refreshLoading ? 'animate-spin' : ''} />
                {refreshLoading ? 'Rafraîchir…' : 'Rafraîchir'}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleFlushCache}
                disabled={flushLoading}
                title="Vide le cache + le cache de résolution, puis reconstruit depuis zéro"
              >
                <Trash2 size={11} />
                {flushLoading ? 'Flush…' : 'Flush'}
              </Button>
              {hiddenCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowHiddenModels(v => !v)}
                  disabled={setHiddenMutation.isPending}
                >
                  {showHiddenModels ? <EyeOff size={11} /> : <Eye size={11} />}
                  {showHiddenModels ? 'Masquer masqués' : `Afficher masqués (${hiddenCount})`}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setNewEntry(true)
                  setEditModal({ tag: '', backend: 'ollama', backend_model_id: '' })
                }}
              >
                <Plus size={11} />
                Ajouter
              </Button>
            </div>
          }
        />
        <CardBody className="!py-3 flex flex-col gap-2">
          {displayErr && (
            <p className="text-[11px] text-destructive m-0">{displayErr}</p>
          )}

          {loading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : rows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 py-6 text-center m-0">
              Aucun modèle. Rafraîchissez le cache ou ajoutez une entrée au mapping.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border/60">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-background/40">
                    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Tag</th>
                    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Backend</th>
                    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Backend model ID</th>
                    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">Source</th>
                    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60 w-20">Masqué</th>
                    <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60 w-32">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(r => {
                    const hideName = getHiddenModelName(r)
                    const isHidden = hiddenSet.has(hideName)
                    return (
                      <tr
                        key={r.tag}
                        className={clsx('hover:bg-background/40', isHidden && 'opacity-60')}
                      >
                        <td className="px-3 py-1.5 border-b border-border/40">
                          <code className="text-[11px] font-mono text-foreground">{r.tag || '—'}</code>
                        </td>
                        <td className="px-3 py-1.5 border-b border-border/40 text-[11px] text-foreground">
                          {r.backend}
                        </td>
                        <td className="px-3 py-1.5 border-b border-border/40">
                          <code className="text-[11px] font-mono text-muted-foreground">{r.backend_model_id}</code>
                        </td>
                        <td className="px-3 py-1.5 border-b border-border/40">
                          <Badge tone={sourceTone(r.source)}>{r.source}</Badge>
                        </td>
                        <td className="px-3 py-1.5 border-b border-border/40">
                          <input
                            type="checkbox"
                            checked={isHidden}
                            disabled={setHiddenMutation.isPending}
                            onChange={async e => {
                              try {
                                await setHiddenMutation.mutateAsync({ modelName: hideName, hidden: e.target.checked })
                              } catch (err) {
                                setError(err instanceof Error ? err.message : String(err))
                              }
                            }}
                            className="w-3.5 h-3.5 rounded border-border bg-background text-primary focus:ring-2 focus:ring-ring/40"
                            aria-label={isHidden ? `Démasquer ${hideName}` : `Masquer ${hideName}`}
                            title={isHidden ? 'Démasquer (ré-intègre la priorité auto)' : 'Masquer (ne compte plus dans la priorité auto)'}
                          />
                        </td>
                        <td className="px-3 py-1.5 border-b border-border/40">
                          {r.source === 'Mapping' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditModal({
                                tag: r.tag,
                                backend: r.backend,
                                backend_model_id: r.backend_model_id,
                              })}
                            >
                              <Pencil size={10} />
                              Modifier
                            </Button>
                          ) : r.source === 'Backend' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setNewEntry(true)
                                setEditModal({
                                  tag: r.tag,
                                  backend: r.backend,
                                  backend_model_id: r.backend_model_id,
                                })
                              }}
                            >
                              <PlusCircle size={10} />
                              Ajouter
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {editModal && (
        <EditMappingModal
          initialTag={editModal.tag}
          initialBackend={editModal.backend}
          initialBackendModelId={editModal.backend_model_id}
          isNew={newEntry}
          onSave={handleSaveMappingEntry}
          onDelete={editModal.tag ? () => handleDeleteMappingEntry(editModal.tag) : undefined}
          onClose={() => { setEditModal(null); setNewEntry(false) }}
        />
      )}
    </>
  )
}
