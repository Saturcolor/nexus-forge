import { useState } from 'react'
import { GitFork, Plus, Trash2, GripVertical } from 'lucide-react'
import type { Config } from '../../../api/admin'
import { useConfig, useSaveConfigMutation } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Badge } from '../../ui/Badge'

type Route = { pattern: string; backend: string }

const BACKENDS = [
  'ollama',
  'mlx',
  'lm_studio',
  'llamacpp',
  'vllm',
  'lucebox',
  'openrouter',
  'anthropic',
] as const

type Backend = typeof BACKENDS[number]

function isValidBackend(s: string): s is Backend {
  return (BACKENDS as readonly string[]).includes(s)
}

function EmptyRow() {
  return (
    <tr>
      <td colSpan={4} className="px-3 py-6 text-center text-[11px] text-muted-foreground/60">
        Aucune règle. Les requêtes utilisent le routage par défaut.
      </td>
    </tr>
  )
}

/**
 * V2 routing card for `model_routes` — ordered regex→backend fallback rules.
 *
 * First match wins. Rules are saved as a full array via POST /admin/config
 * (`model_routes` key), mirroring ModelMappingCard's save pattern.
 */
export function ModelRoutesCard() {
  const { data: config } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()

  const [error, setError] = useState<string | null>(null)

  // Local editing state: null means "not editing"; index is the row being edited.
  type EditState = { index: number | null; pattern: string; backend: Backend }
  const [editing, setEditing] = useState<EditState | null>(null)

  const routes: Route[] = config?.model_routes ?? []

  // ── helpers ────────────────────────────────────────────────────────────────

  async function save(next: Route[]) {
    try {
      setError(null)
      await saveConfigMutation.mutateAsync({ ...config, model_routes: next } as Config)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function startAdd() {
    setEditing({ index: null, pattern: '', backend: 'ollama' })
  }

  function startEdit(idx: number) {
    const r = routes[idx]
    setEditing({
      index: idx,
      pattern: r.pattern,
      backend: isValidBackend(r.backend) ? r.backend : 'ollama',
    })
  }

  function cancelEdit() {
    setEditing(null)
  }

  async function commitEdit() {
    if (!editing) return
    const trimmed = editing.pattern.trim()
    if (!trimmed) {
      setError('Le pattern ne peut pas être vide.')
      return
    }
    const next = [...routes]
    if (editing.index === null) {
      next.push({ pattern: trimmed, backend: editing.backend })
    } else {
      next[editing.index] = { pattern: trimmed, backend: editing.backend }
    }
    await save(next)
    setEditing(null)
  }

  async function deleteRoute(idx: number) {
    const next = routes.filter((_, i) => i !== idx)
    await save(next)
  }

  const isPending = saveConfigMutation.isPending

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <Card>
      <CardHeader
        title="Règles de routage (model_routes)"
        subtitle="Regex testée sur le champ model — première règle qui matche l'emporte. Ordre = priorité."
        icon={<GitFork size={13} />}
        right={
          <Button
            variant="primary"
            size="sm"
            onClick={startAdd}
            disabled={isPending || editing !== null}
          >
            <Plus size={11} />
            Ajouter
          </Button>
        }
      />
      <CardBody className="!py-3 flex flex-col gap-2">
        {error && (
          <p className="text-[11px] text-destructive m-0">{error}</p>
        )}

        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-background/40">
                <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60 w-6" />
                <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">
                  Pattern (regex)
                </th>
                <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60 w-36">
                  Backend cible
                </th>
                <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60 w-24">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {routes.length === 0 && editing === null && <EmptyRow />}

              {routes.map((r, idx) => {
                const isCurrentlyEditing = editing?.index === idx

                if (isCurrentlyEditing && editing) {
                  return (
                    <EditRow
                      key={`edit-${idx}`}
                      editing={editing}
                      onChangePattern={p => setEditing(e => e ? { ...e, pattern: p } : e)}
                      onChangeBackend={b => setEditing(e => e ? { ...e, backend: b } : e)}
                      onCommit={commitEdit}
                      onCancel={cancelEdit}
                      isPending={isPending}
                    />
                  )
                }

                return (
                  <tr key={idx} className="hover:bg-background/40">
                    <td className="px-3 py-1.5 border-b border-border/40">
                      <GripVertical size={12} className="text-muted-foreground/30" />
                    </td>
                    <td className="px-3 py-1.5 border-b border-border/40">
                      <code className="text-[11px] font-mono text-foreground">{r.pattern}</code>
                    </td>
                    <td className="px-3 py-1.5 border-b border-border/40">
                      <Badge tone="primary" mono>{r.backend}</Badge>
                    </td>
                    <td className="px-3 py-1.5 border-b border-border/40">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(idx)}
                          disabled={isPending || editing !== null}
                        >
                          Modifier
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteRoute(idx)}
                          disabled={isPending || editing !== null}
                          title="Supprimer cette règle"
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 size={10} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}

              {/* New-entry row appended at the bottom when adding */}
              {editing !== null && editing.index === null && (
                <EditRow
                  key="new-entry"
                  editing={editing}
                  onChangePattern={p => setEditing(e => e ? { ...e, pattern: p } : e)}
                  onChangeBackend={b => setEditing(e => e ? { ...e, backend: b } : e)}
                  onCommit={commitEdit}
                  onCancel={cancelEdit}
                  isPending={isPending}
                />
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[10px] text-muted-foreground/50 m-0">
          Le pattern est une regex Python testée sur le champ <code className="font-mono">model</code> de la requête.
          Si aucune règle ne matche, le routage par défaut (mapping + résolution) s'applique.
        </p>
      </CardBody>
    </Card>
  )
}

// ── Inline edit row ────────────────────────────────────────────────────────

type EditRowProps = {
  editing: { pattern: string; backend: Backend }
  onChangePattern: (v: string) => void
  onChangeBackend: (v: Backend) => void
  onCommit: () => void
  onCancel: () => void
  isPending: boolean
}

function EditRow({ editing, onChangePattern, onChangeBackend, onCommit, onCancel, isPending }: EditRowProps) {
  return (
    <tr className="bg-primary/5">
      <td className="px-3 py-2 border-b border-border/40" />
      <td className="px-3 py-2 border-b border-border/40">
        <input
          type="text"
          value={editing.pattern}
          onChange={e => onChangePattern(e.target.value)}
          placeholder="Ex: ^gpt-4.*|^claude.*"
          autoFocus
          className={[
            'w-full min-w-0 bg-background border border-border/60 rounded px-2 py-1',
            'text-[11px] font-mono text-foreground placeholder:text-muted-foreground/40',
            'focus:outline-none focus:ring-1 focus:ring-primary/60',
          ].join(' ')}
          onKeyDown={e => {
            if (e.key === 'Enter') onCommit()
            if (e.key === 'Escape') onCancel()
          }}
          disabled={isPending}
        />
      </td>
      <td className="px-3 py-2 border-b border-border/40">
        <select
          value={editing.backend}
          onChange={e => isValidBackend(e.target.value) && onChangeBackend(e.target.value)}
          disabled={isPending}
          className={[
            'bg-background border border-border/60 rounded px-2 py-1',
            'text-[11px] text-foreground',
            'focus:outline-none focus:ring-1 focus:ring-primary/60',
          ].join(' ')}
        >
          {BACKENDS.map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 border-b border-border/40">
        <div className="flex items-center gap-1">
          <Button
            variant="primary"
            size="sm"
            onClick={onCommit}
            disabled={isPending || !editing.pattern.trim()}
          >
            {isPending ? 'Enregistrement…' : 'OK'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isPending}
          >
            Annuler
          </Button>
        </div>
      </td>
    </tr>
  )
}
