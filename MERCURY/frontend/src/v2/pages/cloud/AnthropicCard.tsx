import { useState } from 'react'
import { Bot, Map } from 'lucide-react'
import type { Config, ModelMappingResponse, AnthropicModelEntry } from '../../../api/admin'
import * as api from '../../../api/admin'
import { useSaveConfigMutation } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
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
  return <div className="flex items-center gap-3 pt-3 border-t border-border/40"><GroupLabel>{label}</GroupLabel></div>
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  markDirty: () => void
  modelMapping: ModelMappingResponse | null
  refreshConfig: () => void
  loadModelMapping: () => void
  setSaveStatus: (s: string | null) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AnthropicCard({
  config, updateField, markDirty,
  modelMapping, refreshConfig, loadModelMapping, setSaveStatus,
}: Props) {
  const [accessToken,    setAccessToken]    = useState('')
  const [refreshToken,   setRefreshToken]   = useState('')
  const [credStatus,     setCredStatus]     = useState<string | null>(null)
  const [credSaving,     setCredSaving]     = useState(false)
  const [models,         setModels]         = useState<AnthropicModelEntry[]>([])
  const [modelsLoading,  setModelsLoading]  = useState(false)
  const [modelsErr,      setModelsErr]      = useState<string | null>(null)

  const saveConfigMutation = useSaveConfigMutation()

  const credentialsSet = config.anthropic_credentials_set === true

  const mappedModels = (modelMapping?.from_config ?? [])
    .filter(r => r.backend === 'anthropic')
    .map(r => ({ canonical: r.canonical, backend_model_id: r.backend_model_id }))

  const handleSaveCredentials = async () => {
    const token = accessToken.trim()
    if (!token) { setCredStatus('Access token requis.'); return }
    setCredSaving(true); setCredStatus(null)
    try {
      const res = await api.setAnthropicCredentials({ access_token: token, refresh_token: refreshToken.trim() || undefined })
      if (res.ok) {
        setCredStatus('ok')
        setAccessToken(''); setRefreshToken('')
        refreshConfig()
      } else {
        setCredStatus('err:' + (res.detail ?? 'inconnue'))
      }
    } catch (e) {
      setCredStatus('err:' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setCredSaving(false)
    }
  }

  const handleLoadModels = async () => {
    setModelsErr(null); setModelsLoading(true)
    try {
      const res = await api.getAnthropicModels()
      setModels(Array.isArray(res.models) ? res.models : [])
      if (res.detail) setModelsErr(res.detail)
    } catch (e) {
      setModelsErr(e instanceof Error ? e.message : String(e)); setModels([])
    } finally {
      setModelsLoading(false) }
  }

  const handleAddMapping = async (modelId: string) => {
    const canonical = `anthropic/${modelId}`
    const next = { ...(config.model_mapping ?? {}), [canonical]: { backend: 'anthropic', backend_model_id: modelId } }
    updateField('model_mapping', next)
    try { await saveConfigMutation.mutateAsync({ ...config, model_mapping: next }); refreshConfig(); loadModelMapping() }
    catch (e) { setSaveStatus('Erreur mapping : ' + (e instanceof Error ? e.message : String(e))) }
  }

  const handleDeleteMapping = async (canonical: string) => {
    const next = { ...(config.model_mapping ?? {}) }
    delete next[canonical]
    markDirty()
    try { await saveConfigMutation.mutateAsync({ ...config, model_mapping: next }); refreshConfig(); loadModelMapping() }
    catch (e) { setSaveStatus('Erreur suppression : ' + (e instanceof Error ? e.message : String(e))) }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

      {/* ── Config card ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Anthropic"
          icon={<Bot size={13} />}
          right={
            <div className="flex items-center gap-2">
              <Badge tone={credentialsSet ? 'success' : 'muted'}>
                {credentialsSet ? 'Credentials OK' : 'Non configuré'}
              </Badge>
              <Switch label="Activé" checked={config.anthropic_enabled === true} onChange={() => updateField('anthropic_enabled', !config.anthropic_enabled)} />
            </div>
          }
        />
        <CardBody className="flex flex-col gap-3">

          {/* Provider */}
          <GroupLabel>Provider</GroupLabel>
          <Field label="Fichier credentials" htmlFor="ant-cred-file">
            <input
              id="ant-cred-file"
              value={config.anthropic_credentials_file ?? ''}
              onChange={e => updateField('anthropic_credentials_file', e.target.value)}
              placeholder="~/.claude/.credentials.json (par défaut)"
              className={inputCls}
            />
          </Field>

          {/* OAuth tokens */}
          <SectionDivider label="Tokens OAuth" />
          <Field label="Access Token" htmlFor="ant-access">
            <input
              id="ant-access"
              type="password"
              value={accessToken}
              onChange={e => setAccessToken(e.target.value)}
              placeholder="sk-ant-oat01-…"
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <Field label="Refresh Token (optionnel)" htmlFor="ant-refresh">
            <input
              id="ant-refresh"
              type="password"
              value={refreshToken}
              onChange={e => setRefreshToken(e.target.value)}
              placeholder="claudeAiOauth.refreshToken"
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button
              variant="primary" size="sm"
              disabled={credSaving || !accessToken.trim()}
              onClick={handleSaveCredentials}
            >
              {credSaving ? 'Enregistrement…' : 'Enregistrer les credentials'}
            </Button>
            {credStatus && (
              <span className={`text-[11px] font-medium ${credStatus.startsWith('err:') ? 'text-destructive' : 'text-theme-green'}`}>
                {credStatus.startsWith('err:') ? credStatus.slice(4) : 'Credentials enregistrés.'}
              </span>
            )}
          </div>

          {/* Models */}
          <SectionDivider label="Modèles" />
          <Field label="Fallback" htmlFor="ant-fallback">
            <select
              id="ant-fallback"
              value={config.anthropic_fallback_model ?? ''}
              onChange={e => updateField('anthropic_fallback_model', e.target.value)}
              className={selectCls}
            >
              <option value="">— Aucun —</option>
              {models.map(m => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
              {config.anthropic_fallback_model && !models.find(m => m.id === config.anthropic_fallback_model) && (
                <option value={config.anthropic_fallback_model}>{config.anthropic_fallback_model}</option>
              )}
            </select>
          </Field>
          <Field label="Raisonnement étendu" htmlFor="ant-reasoning">
            <select
              id="ant-reasoning"
              value={config.anthropic_reasoning_model ?? ''}
              onChange={e => updateField('anthropic_reasoning_model', e.target.value)}
              className={selectCls}
            >
              <option value="">— Aucun —</option>
              {models.map(m => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
              {config.anthropic_reasoning_model && !models.find(m => m.id === config.anthropic_reasoning_model) && (
                <option value={config.anthropic_reasoning_model}>{config.anthropic_reasoning_model}</option>
              )}
            </select>
          </Field>
        </CardBody>
      </Card>

      {/* ── Mapping card ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Mapping modèles"
          icon={<Map size={13} />}
          right={models.length > 0 ? <span className="text-[10px] text-muted-foreground/60 font-mono">{models.length} disponibles</span> : undefined}
        />
        <CardBody className="flex flex-col gap-4">

          <div className="flex flex-col gap-2">
            <GroupLabel>Découverte</GroupLabel>
            <Button variant="subtle" size="sm" disabled={modelsLoading} onClick={handleLoadModels}>
              {modelsLoading ? 'Chargement…' : 'Charger les modèles'}
            </Button>
            {modelsErr && <p className="text-[11px] text-destructive">{modelsErr}</p>}
          </div>

          {models.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="overflow-auto max-h-52 rounded-lg border border-border/40 bg-background">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                    <tr>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">ID</th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Nom</th>
                      <th className="px-3 py-2 w-24 border-b border-border/40" />
                    </tr>
                  </thead>
                  <tbody>
                    {models.map(m => (
                      <tr key={m.id} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                        <td className="px-3 py-2 font-mono text-[11px] text-foreground truncate max-w-[140px]">{m.id}</td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">{m.name ?? m.id}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => updateField('anthropic_fallback_model', m.id)}
                            className="text-[11px] text-primary/70 hover:text-primary transition-colors px-1"
                          >
                            Fallback
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Quick-add chips for unmapped models */}
              {models.filter(m => !mappedModels.find(am => am.backend_model_id === m.id)).length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <GroupLabel>Ajouter au mapping</GroupLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {models
                      .filter(m => !mappedModels.find(am => am.backend_model_id === m.id))
                      .map(m => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleAddMapping(m.id)}
                          className="text-[11px] px-2.5 py-1 rounded border bg-secondary border-border/60 text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors font-mono"
                        >
                          + {m.name ?? m.id}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Current mapping */}
          <div className={`flex flex-col gap-2 ${models.length > 0 ? 'pt-3 border-t border-border/40' : ''}`}>
            <GroupLabel>En mapping {mappedModels.length > 0 && `(${mappedModels.length})`}</GroupLabel>
            {mappedModels.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/50 italic">Aucun modèle. Charge la liste et ajoute des modèles.</p>
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
                            onClick={() => handleDeleteMapping(m.canonical)}
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
  )
}
