import { useState } from 'react'
import { Key, Map, ArrowDownUp } from 'lucide-react'
import type { Config, ModelMappingResponse, OpenRouterModelEntry } from '../../../api/admin'
import * as api from '../../../api/admin'
import { useSaveConfigMutation } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Switch'
import { inputCls, selectCls, labelCls, fieldCls, groupCls } from '../config/shared'

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <span className={groupCls}>{children}</span>
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className={fieldCls}>
      <label htmlFor={htmlFor} className={labelCls}>{label}</label>
      {children}
    </div>
  )
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-3 border-t border-border/40">
      <GroupLabel>{label}</GroupLabel>
    </div>
  )
}

// ── Types ────────────────────────────────────────────────────────────────────

const ALL_TRIGGERS = ['timeout', 'payment', 'server_error', 'connection', 'rate_limit', 'auth'] as const

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  markDirty: () => void
  modelMapping: ModelMappingResponse | null
  refreshConfig: () => void
  loadModelMapping: () => void
  setSaveStatus: (s: string | null) => void
}

// ── Main component ───────────────────────────────────────────────────────────

export function OpenRouterCard({
  config, updateField, markDirty,
  modelMapping, refreshConfig, loadModelMapping, setSaveStatus,
}: Props) {

  const saveConfigMutation = useSaveConfigMutation()

  // Model discovery
  const [apiKeyInput,   setApiKeyInput]   = useState('')
  const [models,        setModels]        = useState<OpenRouterModelEntry[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsErr,     setModelsErr]     = useState<string | null>(null)
  const [selectedIds,   setSelectedIds]   = useState<Set<string>>(new Set())

  // Fallback cascade
  const fb         = config.openrouter_model_fallback || {}
  const fbEnabled  = fb.enabled === true
  const fbTriggers = fb.triggers && fb.triggers.length > 0 ? fb.triggers : ['timeout', 'payment', 'server_error', 'connection']
  const fbChain: string[] = Array.isArray(fb.chain) ? fb.chain : []
  const [newModel, setNewModel] = useState('')

  const setFb = (patch: NonNullable<Config['openrouter_model_fallback']>) =>
    updateField('openrouter_model_fallback', { ...fb, ...patch })

  const fbToggleTrigger = (trig: string) => {
    const next = fbTriggers.includes(trig)
      ? fbTriggers.filter(t => t !== trig)
      : [...fbTriggers, trig]
    setFb({ triggers: next })
  }

  const fbAddModel = () => {
    const m = newModel.trim()
    if (!m || fbChain.includes(m)) return
    setFb({ chain: [...fbChain, m] })
    setNewModel('')
  }

  const fbMoveUp = (idx: number) => {
    if (idx === 0) return
    const next = [...fbChain];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    setFb({ chain: next })
  }

  const fbMoveDown = (idx: number) => {
    if (idx === fbChain.length - 1) return
    const next = [...fbChain];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    setFb({ chain: next })
  }

  const mappedModels = (modelMapping?.from_config ?? [])
    .filter(r => r.backend === 'openrouter')
    .map(r => ({ canonical: r.canonical, backend_model_id: r.backend_model_id }))

  const handleFetchModels = async () => {
    setModelsErr(null); setModelsLoading(true)
    try {
      const res = await api.getOpenRouterModels()
      setModels(Array.isArray(res.data) ? res.data : [])
      if (res.detail) setModelsErr(res.detail)
    } catch (e) {
      setModelsErr(e instanceof Error ? e.message : String(e))
      setModels([])
    } finally {
      setModelsLoading(false)
    }
  }

  const handleAddMapping = async () => {
    const next = { ...(config.model_mapping ?? {}) }
    selectedIds.forEach(id => { next[`openrouter/${id}`] = { backend: 'openrouter', backend_model_id: id } })
    updateField('model_mapping', next)
    try {
      await saveConfigMutation.mutateAsync({ ...config, model_mapping: next })
      refreshConfig(); loadModelMapping(); setSelectedIds(new Set())
    } catch (e) {
      setSaveStatus('Erreur mapping : ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const handleDeleteMapping = async (canonical: string, backendModelId: string) => {
    const next = { ...(config.model_mapping ?? {}) }
    delete next[canonical]
    markDirty()
    try {
      const toSave: Config = { ...config, model_mapping: next }
      if (config.openrouter_fallback_model === backendModelId) toSave.openrouter_fallback_model = ''
      await saveConfigMutation.mutateAsync(toSave)
      refreshConfig(); loadModelMapping()
    } catch (e) {
      setSaveStatus('Erreur suppression : ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Row 1: Config (left) + Mapping (right) ──────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Config card */}
        <Card>
          <CardHeader
            title="OpenRouter"
            icon={<Key size={13} />}
            right={
              <Switch label="Activé" checked={config.openrouter_enabled === true} onChange={() => updateField('openrouter_enabled', !config.openrouter_enabled)} />
            }
          />
          <CardBody className="flex flex-col gap-3">

            {/* Auth */}
            <GroupLabel>Authentification</GroupLabel>
            <Field label="Clé API" htmlFor="or-api-key">
              <input
                id="or-api-key"
                type="password"
                value={apiKeyInput}
                onChange={e => { markDirty(); setApiKeyInput(e.target.value) }}
                placeholder={config.openrouter_api_key_set ? '•••••••• (vide = ne pas changer)' : 'Saisir la clé OpenRouter'}
                autoComplete="off"
                className={inputCls}
              />
            </Field>

            {/* Fallback simple */}
            <SectionDivider label="Fallback simple" />
            <p className="text-[10px] text-muted-foreground/60 -mt-1">
              Modèle utilisé quand les backends locaux ne répondent pas.
            </p>
            <Field label="Modèle" htmlFor="or-fallback-model">
              <select
                id="or-fallback-model"
                value={config.openrouter_fallback_model ?? ''}
                onChange={e => updateField('openrouter_fallback_model', e.target.value)}
                className={selectCls}
              >
                <option value="">— Aucun —</option>
                {mappedModels.map(m => (
                  <option key={m.canonical} value={m.backend_model_id}>{m.canonical}</option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-2.5 text-[11px] text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={config.openrouter_fallback_force === true}
                onChange={e => updateField('openrouter_fallback_force', e.target.checked)}
                className="w-4 h-4 rounded border-border bg-background text-primary focus:ring-primary/30"
              />
              Forcer le fallback (tous les modèles non matchés → OpenRouter)
            </label>

            {/* Specialized models */}
            <SectionDivider label="Modèles spécialisés" />
            <Field label="Vision" htmlFor="or-vision">
              <input id="or-vision" value={config.openrouter_vision_model ?? ''} onChange={e => updateField('openrouter_vision_model', e.target.value)} placeholder="ex: google/gemini-flash-2.0-exp" className={inputCls} />
            </Field>
            <Field label="Raisonnement étendu" htmlFor="or-reasoning">
              <input id="or-reasoning" value={config.openrouter_reasoning_model ?? ''} onChange={e => updateField('openrouter_reasoning_model', e.target.value)} placeholder="ex: anthropic/claude-opus-4" className={inputCls} />
            </Field>
            <Field label="Embedding" htmlFor="or-embedding">
              <input id="or-embedding" value={config.openrouter_embedding_model ?? ''} onChange={e => updateField('openrouter_embedding_model', e.target.value)} placeholder="ex: qwen/qwen3-embedding-8b" className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Dimension" htmlFor="or-emb-dim">
                <input id="or-emb-dim" type="number" min={1} value={config.openrouter_embedding_dim ?? ''} onChange={e => updateField('openrouter_embedding_dim', e.target.value === '' ? null : Number(e.target.value))} placeholder="4096" className={inputCls} />
              </Field>
              <Field label="Priorité" htmlFor="or-emb-prio">
                <input id="or-emb-prio" type="number" min={1} value={config.openrouter_embedding_priority ?? 99} onChange={e => updateField('openrouter_embedding_priority', Number(e.target.value))} placeholder="99" className={inputCls} />
              </Field>
            </div>

            {/* Attribution */}
            <SectionDivider label="Attribution" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="HTTP-Referer" htmlFor="or-referer">
                <input id="or-referer" value={config.openrouter_http_referer ?? ''} onChange={e => updateField('openrouter_http_referer', e.target.value)} placeholder="https://mon-app.example.com" className={inputCls} />
              </Field>
              <Field label="Titre" htmlFor="or-title">
                <input id="or-title" value={config.openrouter_title ?? ''} onChange={e => updateField('openrouter_title', e.target.value)} placeholder="Mon application" className={inputCls} />
              </Field>
            </div>
          </CardBody>
        </Card>

        {/* Mapping card */}
        <Card>
          <CardHeader
            title="Mapping modèles"
            icon={<Map size={13} />}
            right={
              models.length > 0
                ? <span className="text-[10px] text-muted-foreground/60 font-mono">{models.length} disponibles</span>
                : undefined
            }
          />
          <CardBody className="flex flex-col gap-4">

            {/* Discovery */}
            <div className="flex flex-col gap-2">
              <GroupLabel>Découverte</GroupLabel>
              <Button variant="subtle" size="sm" disabled={modelsLoading} onClick={handleFetchModels}>
                {modelsLoading ? 'Chargement…' : 'Récupérer la liste'}
              </Button>
              {modelsErr && <p className="text-[11px] text-destructive">{modelsErr}</p>}
            </div>

            {models.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="overflow-auto max-h-52 rounded-lg border border-border/40 bg-background">
                  <table className="w-full border-collapse">
                    <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                      <tr>
                        <th className="px-3 py-2 w-10 border-b border-border/40">
                          <input
                            type="checkbox"
                            checked={selectedIds.size === models.length && models.length > 0}
                            onChange={e => setSelectedIds(e.target.checked ? new Set(models.map(m => m.id)) : new Set())}
                            className="w-4 h-4 rounded border-border bg-background text-primary"
                          />
                        </th>
                        <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">ID</th>
                        <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Nom</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map(m => (
                        <tr key={m.id} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(m.id)}
                              onChange={e => {
                                const next = new Set(selectedIds)
                                if (e.target.checked) next.add(m.id); else next.delete(m.id)
                                setSelectedIds(next)
                              }}
                              className="w-4 h-4 rounded border-border bg-background text-primary"
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] text-foreground truncate max-w-[160px]">{m.id}</td>
                          <td className="px-3 py-2 text-[11px] text-muted-foreground">{(m as { name?: string }).name ?? m.id}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button
                  variant="primary" size="sm"
                  disabled={selectedIds.size === 0}
                  onClick={handleAddMapping}
                >
                  Ajouter la sélection ({selectedIds.size})
                </Button>
              </div>
            )}

            {/* Current mapping */}
            <div className={`flex flex-col gap-2 ${models.length > 0 || mappedModels.length > 0 ? 'pt-3 border-t border-border/40' : ''}`}>
              <GroupLabel>En mapping {mappedModels.length > 0 && `(${mappedModels.length})`}</GroupLabel>
              {mappedModels.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50 italic">
                  Aucun modèle. Récupère la liste et ajoute une sélection.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border/40">
                  <table className="w-full border-collapse">
                    <thead className="bg-secondary/50">
                      <tr>
                        <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">Canonique</th>
                        <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">ID backend</th>
                        <th className="px-3 py-2 w-20" />
                      </tr>
                    </thead>
                    <tbody>
                      {mappedModels.map(m => (
                        <tr key={m.canonical} className="border-t border-border/30 hover:bg-secondary/20">
                          <td className="px-3 py-2 font-mono text-[11px] text-foreground truncate max-w-[140px]">{m.canonical}</td>
                          <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{m.backend_model_id}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteMapping(m.canonical, m.backend_model_id)}
                              className="text-[11px] text-destructive/50 hover:text-destructive transition-colors px-1"
                            >
                              Supprimer
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── Fallback cascade ─────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Fallback en cascade"
          icon={<ArrowDownUp size={13} />}
          subtitle="Cascade automatique sur erreur — le caller reçoit la réponse du fallback"
          right={
            <Switch label="Activé" checked={fbEnabled} onChange={() => setFb({ enabled: !fbEnabled })} />
          }
        />
        <CardBody className={`flex flex-col gap-4 ${!fbEnabled ? 'opacity-50 pointer-events-none' : ''}`}>

          {/* Triggers */}
          <div className="flex flex-col gap-2">
            <GroupLabel>Déclencheurs</GroupLabel>
            <div className="flex flex-wrap gap-1.5">
              {ALL_TRIGGERS.map(trig => {
                const active = fbTriggers.includes(trig)
                return (
                  <button
                    key={trig}
                    type="button"
                    onClick={() => fbToggleTrigger(trig)}
                    className={`text-[11px] font-mono px-2.5 py-1 rounded border transition-colors ${
                      active
                        ? 'bg-primary/10 border-primary/30 text-primary'
                        : 'bg-secondary border-border/60 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {trig}
                  </button>
                )
              })}
            </div>
            <p className="text-[10px] text-muted-foreground/50">
              Recommandé : timeout, payment, server_error, connection.{' '}
              <code className="text-[10px]">auth</code> et <code className="text-[10px]">rate_limit</code> = config OR (basculer ne règlera rien).
            </p>
          </div>

          {/* Chain */}
          <div className="flex flex-col gap-2 pt-3 border-t border-border/40">
            <GroupLabel>Chain ({fbChain.length} modèle{fbChain.length !== 1 ? 's' : ''})</GroupLabel>
            <p className="text-[10px] text-muted-foreground/50">
              Le modèle demandé est skippé s'il apparaît dans la chain. Premier succès gagne.
            </p>
            <div className="flex flex-col gap-1.5">
              {fbChain.length === 0 && (
                <p className="text-[11px] text-muted-foreground/50 italic py-1">
                  Aucun fallback configuré.
                </p>
              )}
              {fbChain.map((model, idx) => (
                <div
                  key={`${model}-${idx}`}
                  className="flex items-center gap-2 bg-background border border-border/40 rounded-md px-3 py-2"
                >
                  <span className="text-[10px] font-mono text-muted-foreground/40 w-5 shrink-0 text-right">
                    {idx + 1}.
                  </span>
                  <span className="font-mono text-[11px] text-foreground flex-1 truncate">{model}</span>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button type="button" onClick={() => fbMoveUp(idx)} disabled={idx === 0}
                      className="px-1.5 py-1 text-[11px] text-muted-foreground/50 hover:text-primary disabled:opacity-20 transition-colors">↑</button>
                    <button type="button" onClick={() => fbMoveDown(idx)} disabled={idx === fbChain.length - 1}
                      className="px-1.5 py-1 text-[11px] text-muted-foreground/50 hover:text-primary disabled:opacity-20 transition-colors">↓</button>
                    <button type="button" onClick={() => setFb({ chain: fbChain.filter((_, i) => i !== idx) })}
                      className="px-1.5 py-1 text-[11px] text-muted-foreground/50 hover:text-destructive transition-colors">✕</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="text"
                value={newModel}
                onChange={e => setNewModel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); fbAddModel() } }}
                placeholder="ex. anthropic/claude-haiku-4-5"
                className={`${inputCls} font-mono max-w-sm`}
              />
              <Button
                variant="primary" size="sm"
                disabled={!newModel.trim() || fbChain.includes(newModel.trim())}
                onClick={fbAddModel}
              >
                Ajouter
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
