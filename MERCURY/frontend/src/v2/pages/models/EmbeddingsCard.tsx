import { useMemo, useState, useEffect } from 'react'
import { Link2, Plus, Trash2, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { useConfig, useSaveConfigMutation, useLlamacppModels } from '../../../api/queries'
import type { Config } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'
import { Switch } from '../../ui/Switch'

type LocalEntry = { id?: string; model: string; dim?: number | null; priority?: number }

const DEFAULT_FALLBACK_TRIGGERS: NonNullable<Config['embedding_fallback_triggers']> = {
  retryable_status: [408, 429, 500, 502, 503, 504],
  timeout_ms: 15000,
  model_unavailable: false,
}

export function EmbeddingsCard() {
  const { data: config } = useConfig()
  const saveMut = useSaveConfigMutation()
  const { data: localModels } = useLlamacppModels()

  const [newModel,    setNewModel]    = useState('')
  const [newDim,      setNewDim]      = useState<number | ''>(4096)
  const [newPriority, setNewPriority] = useState<number>(1)
  const [error,       setError]       = useState<string | null>(null)

  // Fallback section
  const [fallbackOpen, setFallbackOpen] = useState(false)
  // Local draft for retryable_status codes (comma-separated string — validated on save)
  const [statusDraft, setStatusDraft] = useState<string>('')

  // Sync statusDraft whenever config loads or changes
  // Dépend de la VALEUR jointe (pas de la référence array) : un refetch config (10s) qui
  // ramène les mêmes codes ne re-déclenche pas l'effet → ne clobbe pas la saisie en cours.
  const configStatusesKey = (config?.embedding_fallback_triggers?.retryable_status ?? DEFAULT_FALLBACK_TRIGGERS.retryable_status!).join(', ')
  useEffect(() => {
    setStatusDraft(configStatusesKey)
  }, [configStatusesKey])

  const localEntries: LocalEntry[] = config?.local_embedding_models ?? []
  const cloudModel   = (config?.openrouter_embedding_model ?? '').trim()
  const cloudEnabled = config?.openrouter_enabled === true && cloudModel.length > 0

  const availableLocalModels = (localModels?.models ?? [])
    .map(m => m.model_id)
    .filter(id => !localEntries.some(e => e.model === id))

  const chain = useMemo(() => {
    const items: Array<{
      id: string; backend: 'local' | 'cloud'; model: string; dim?: number | null; priority: number
    }> = []
    for (const e of localEntries) {
      items.push({
        id: e.id || `local-${e.model.split('/').pop()}`,
        backend: 'local',
        model: e.model,
        dim: e.dim,
        priority: e.priority ?? 1,
      })
    }
    if (cloudEnabled) {
      items.push({
        id: 'cloud-openrouter',
        backend: 'cloud',
        model: cloudModel,
        dim: config?.openrouter_embedding_dim,
        priority: config?.openrouter_embedding_priority ?? 99,
      })
    }
    return items.sort((a, b) => a.priority - b.priority)
  }, [localEntries, cloudEnabled, cloudModel, config?.openrouter_embedding_dim, config?.openrouter_embedding_priority])

  const dimsOk = useMemo(() => {
    const dims = chain.map(e => e.dim).filter((d): d is number => typeof d === 'number')
    return dims.length === 0 || dims.every(d => d === dims[0])
  }, [chain])

  if (!config) return <div className="flex justify-center py-10"><Spinner size={20} /></div>

  const persist = async (next: Partial<Config>) => {
    setError(null)
    try {
      const toSend = { ...config, ...next }
      // Strip read-only sentinel fields that the backend must not persist
      delete (toSend as Record<string, unknown>).admin_token_set
      delete (toSend as Record<string, unknown>).openrouter_api_key_set
      delete (toSend as Record<string, unknown>).anthropic_credentials_set
      await saveMut.mutateAsync(toSend)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const addLocal = async () => {
    if (!newModel.trim()) { setError('Choisis un modèle local'); return }
    const entry: LocalEntry = {
      model: newModel.trim(),
      dim: newDim === '' ? null : Number(newDim),
      priority: newPriority,
    }
    await persist({ local_embedding_models: [...localEntries, entry] })
    setNewModel('')
    setNewDim(4096)
    setNewPriority(1)
  }

  const updateLocal = async (idx: number, patch: Partial<LocalEntry>) => {
    const next = localEntries.map((e, i) => i === idx ? { ...e, ...patch } : e)
    await persist({ local_embedding_models: next })
  }

  const removeLocal = async (idx: number) => {
    await persist({ local_embedding_models: localEntries.filter((_, i) => i !== idx) })
  }

  // ── embedding_fallback_triggers helpers ────────────────────────────────
  const fallbackTriggers = config?.embedding_fallback_triggers ?? DEFAULT_FALLBACK_TRIGGERS

  const persistFallback = async (patch: Partial<NonNullable<Config['embedding_fallback_triggers']>>) => {
    await persist({ embedding_fallback_triggers: { ...fallbackTriggers, ...patch } })
  }

  const saveStatusDraft = async () => {
    // Parse comma-separated ints, drop NaN
    const codes = statusDraft
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n >= 100 && n <= 999)
    await persistFallback({ retryable_status: codes })
    setStatusDraft(codes.join(', '))
  }

  const inputCls = 'px-2 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40'

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-[11px] text-destructive">
          {error}
        </div>
      )}
      {/* Chain overview */}
      <Card>
        <CardHeader
          title="Chaîne embedding"
          icon={<Link2 size={13} />}
          right={
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground/60 font-mono">{chain.length} mod{chain.length > 1 ? 'èles' : 'èle'}</span>
              {!dimsOk && <Badge tone="warning">dim hétérogène</Badge>}
            </div>
          }
        />
        <CardBody className="!py-3">
          {!dimsOk && (
            <div className="mb-3 px-3 py-2 bg-theme-amber/10 border border-theme-amber/30 rounded-lg text-[11px] text-theme-amber">
              Les modèles n'ont pas tous la même dimension — Mastermind refusera de booter.
            </div>
          )}

          {chain.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/50 py-4 text-center">
              Aucun modèle d'embedding. Ajoute un modèle local ou configure OpenRouter dans l'onglet Cloud.
            </p>
          ) : (
            <div className="overflow-x-auto border border-border/60 rounded-lg">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr>
                    {['Prio', 'Modèle', 'Backend', 'Dim'].map(h => (
                      <th key={h} className="px-3 py-2 bg-background/80 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/60">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chain.map(e => (
                    <tr key={e.id} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums">{e.priority}</td>
                      <td className="px-3 py-2 max-w-[20rem]">
                        <code className="font-mono text-[11px] text-foreground truncate block" title={e.model}>{e.model}</code>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={e.backend === 'local' ? 'success' : 'primary'}>{e.backend}</Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground tabular-nums text-right">
                        {e.dim ?? '?'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Edit local entries */}
      {localEntries.length > 0 && (
        <Card>
          <CardHeader title="Entrées locales" icon={<Link2 size={13} />} />
          <CardBody className="!py-3 flex flex-col gap-1.5">
            {localEntries.map((e, idx) => (
              <div key={`${e.model}-${idx}`} className="flex items-center gap-2 px-2.5 py-1.5 bg-background/60 border border-border/40 rounded-md">
                <code className="text-[11px] font-mono text-foreground truncate flex-1 min-w-0" title={e.model}>{e.model}</code>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="text-[10px] text-muted-foreground/60">dim</label>
                  <input
                    type="number"
                    min={1}
                    value={e.dim ?? ''}
                    onChange={ev => updateLocal(idx, { dim: ev.target.value === '' ? null : Number(ev.target.value) })}
                    className={clsx(inputCls, 'w-20 tabular-nums text-right')}
                  />
                  <label className="text-[10px] text-muted-foreground/60">prio</label>
                  <input
                    type="number"
                    min={1}
                    value={e.priority ?? 1}
                    onChange={ev => updateLocal(idx, { priority: Number(ev.target.value) })}
                    className={clsx(inputCls, 'w-14 tabular-nums text-right')}
                  />
                  <Button variant="destructive" size="sm" onClick={() => removeLocal(idx)} disabled={saveMut.isPending}>
                    <Trash2 size={10} />
                  </Button>
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {/* Add local entry */}
      <Card>
        <CardHeader title="Ajouter un modèle local" icon={<Plus size={13} />} />
        <CardBody className="!py-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1 flex-1 min-w-[240px]">
              <span className="text-[10px] text-muted-foreground/60">Modèle (GGUF chargé via brain-daemon)</span>
              <select
                value={newModel}
                onChange={e => setNewModel(e.target.value)}
                className={clsx(inputCls, 'w-full cursor-pointer')}
              >
                <option value="">— Choisir —</option>
                {availableLocalModels.map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground/60">Dimension</span>
              <input
                type="number"
                min={1}
                value={newDim}
                onChange={e => setNewDim(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="4096"
                className={clsx(inputCls, 'w-24 tabular-nums text-right')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground/60">Priorité</span>
              <input
                type="number"
                min={1}
                value={newPriority}
                onChange={e => setNewPriority(Number(e.target.value))}
                className={clsx(inputCls, 'w-16 tabular-nums text-right')}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={addLocal}
              disabled={!newModel || saveMut.isPending}
            >
              <Plus size={11} />
              Ajouter
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50">
            Le modèle doit être déclaré dans <code className="text-muted-foreground/70">BRAIN-DAEMON/load_configs.json</code> avec les flags{' '}
            <code className="text-muted-foreground/70">--embedding --pooling last</code>.
          </p>
        </CardBody>
      </Card>

      {/* Fallback triggers */}
      <Card>
        <CardHeader
          title="Fallback / cascade"
          icon={<ChevronDown size={13} className={clsx('transition-transform', fallbackOpen && 'rotate-180')} />}
          subtitle="Conditions déclenchant le passage au provider suivant dans la chaîne"
          right={
            <button
              type="button"
              onClick={() => setFallbackOpen(o => !o)}
              className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              {fallbackOpen ? 'Réduire' : 'Configurer'}
            </button>
          }
        />
        {fallbackOpen && (
          <CardBody className="!py-3 flex flex-col gap-4">

            {/* retryable_status */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Codes HTTP retryables
              </span>
              <p className="text-[10px] text-muted-foreground/50">
                Codes de statut qui déclenchent le fallback vers le prochain modèle. Valeurs séparées par des virgules.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={statusDraft}
                  onChange={e => setStatusDraft(e.target.value)}
                  onBlur={saveStatusDraft}
                  onKeyDown={e => e.key === 'Enter' && void saveStatusDraft()}
                  placeholder="408, 429, 500, 502, 503, 504"
                  className={clsx(inputCls, 'flex-1 font-mono')}
                />
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={saveStatusDraft}
                  disabled={saveMut.isPending}
                >
                  Sauver
                </Button>
              </div>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {(fallbackTriggers.retryable_status ?? DEFAULT_FALLBACK_TRIGGERS.retryable_status!).map(code => (
                  <span
                    key={code}
                    className="px-1.5 py-0.5 bg-background border border-border/60 rounded text-[10px] font-mono text-muted-foreground tabular-nums"
                  >
                    {code}
                  </span>
                ))}
              </div>
            </div>

            {/* timeout_ms */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Timeout (ms)
              </span>
              <p className="text-[10px] text-muted-foreground/50">
                Délai maximum avant de considérer l'appel embedding comme échoué et de passer au suivant.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  step={500}
                  value={fallbackTriggers.timeout_ms ?? DEFAULT_FALLBACK_TRIGGERS.timeout_ms}
                  onChange={e => void persistFallback({ timeout_ms: Number(e.target.value) })}
                  className={clsx(inputCls, 'w-32 font-mono tabular-nums text-right')}
                />
                <span className="text-[10px] text-muted-foreground/50">ms</span>
              </div>
            </div>

            {/* model_unavailable */}
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Indisponibilité modèle
                </span>
                <p className="text-[10px] text-muted-foreground/50">
                  Déclencher le fallback si le modèle local est absent ou non chargé.
                </p>
              </div>
              <Switch
                checked={fallbackTriggers.model_unavailable ?? DEFAULT_FALLBACK_TRIGGERS.model_unavailable!}
                onChange={() => void persistFallback({
                  model_unavailable: !(fallbackTriggers.model_unavailable ?? DEFAULT_FALLBACK_TRIGGERS.model_unavailable),
                })}
                disabled={saveMut.isPending}
              />
            </div>

          </CardBody>
        )}
      </Card>
    </div>
  )
}
