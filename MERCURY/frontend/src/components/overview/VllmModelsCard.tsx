/**
 * VllmModelsCard — surface les modèles HF (vLLM) servis par le brain-daemon.
 *
 * V1 minimal : list + Load/Unload + edit (ctx_size + extra_args + backend
 * + env_vars + sampler defaults).
 * Réutilise les routes /admin/llamacpp/{models,load,unload,template/<id>}
 * côté Mercury (le template DB est polymorphe via le field `backend`).
 *
 * Layout aligné sur LlamaCppModelsCard via les primitives ../templates/*.
 */
import { useMemo, useState } from 'react'
import {
  useLlamacppModels,
  useLoadLlamacppModelMutation,
  useUnloadLlamacppModelMutation,
  useSetLlamacppTemplateMutation,
  useDeleteLlamacppTemplateMutation,
} from '../../api/queries'
import type { LlamacppModelEntry, LlamacppTemplate } from '../../api/admin'
import Spinner from '../Spinner'
import TemplateEditorShell from '../templates/TemplateEditorShell'
import TemplateSection from '../templates/TemplateSection'
import TemplateSectionGroup from '../templates/TemplateSectionGroup'
import NumberField from '../templates/NumberField'
import TextField from '../templates/TextField'
import TextareaField from '../templates/TextareaField'
import {
  setTemplateClipboard,
  useTemplateClipboard,
  type ClipboardEntry,
} from '../templates/clipboard'

const DEFAULT_CTX = 32768
const DEFAULT_BACKEND = 'vllm-rocm'

type FormState = {
  // Load
  ctx_size: string
  extra_args: string  // un arg par ligne
  backend: string
  env_vars: string    // une ligne KEY=VAL
  // Defaults — sampling
  temperature: string
  top_p: string
  top_k: string
  min_p: string
  repeat_penalty: string
  frequency_penalty: string
  presence_penalty: string
  seed: string
}

const DEFAULT_FORM: FormState = {
  ctx_size: String(DEFAULT_CTX),
  extra_args: '',
  backend: DEFAULT_BACKEND,
  env_vars: '',
  temperature: '',
  top_p: '',
  top_k: '',
  min_p: '',
  repeat_penalty: '',
  frequency_penalty: '',
  presence_penalty: '',
  seed: '',
}

function templateToForm(t: LlamacppTemplate | undefined): FormState {
  if (!t) return { ...DEFAULT_FORM }
  const load = t.load ?? {}
  const defaults = t.defaults ?? {}
  const ctx = typeof load.ctx_size === 'number' ? String(load.ctx_size) : String(DEFAULT_CTX)
  const args = Array.isArray(load.extra_args) ? load.extra_args.join('\n') : ''
  const backend = typeof load.backend === 'string' && load.backend ? load.backend : DEFAULT_BACKEND
  const env = (load.env_vars && typeof load.env_vars === 'object')
    ? Object.entries(load.env_vars).map(([k, v]) => `${k}=${v}`).join('\n')
    : ''
  return {
    ctx_size: ctx,
    extra_args: args,
    backend,
    env_vars: env,
    temperature: defaults.temperature != null ? String(defaults.temperature) : '',
    top_p: defaults.top_p != null ? String(defaults.top_p) : '',
    top_k: defaults.top_k != null ? String(defaults.top_k) : '',
    min_p: defaults.min_p != null ? String(defaults.min_p) : '',
    repeat_penalty: defaults.repeat_penalty != null ? String(defaults.repeat_penalty) : '',
    frequency_penalty: defaults.frequency_penalty != null ? String(defaults.frequency_penalty) : '',
    presence_penalty: defaults.presence_penalty != null ? String(defaults.presence_penalty) : '',
    seed: defaults.seed != null ? String(defaults.seed) : '',
  }
}

function formToTemplate(form: FormState): LlamacppTemplate {
  const args = form.extra_args
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  const env: Record<string, string> = {}
  for (const line of form.env_vars.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim()
    if (k) env[k] = v
  }
  const load: NonNullable<LlamacppTemplate['load']> = {
    ctx_size: Number(form.ctx_size) || DEFAULT_CTX,
    extra_args: args,
    backend: form.backend.trim() || DEFAULT_BACKEND,
  }
  if (Object.keys(env).length > 0) load.env_vars = env

  const defaults: LlamacppTemplate['defaults'] = {}
  if (form.temperature !== '') defaults.temperature = Number(form.temperature)
  if (form.top_p !== '') defaults.top_p = Number(form.top_p)
  if (form.top_k !== '') defaults.top_k = Number(form.top_k)
  if (form.min_p !== '') defaults.min_p = Number(form.min_p)
  if (form.repeat_penalty !== '') defaults.repeat_penalty = Number(form.repeat_penalty)
  if (form.frequency_penalty !== '') defaults.frequency_penalty = Number(form.frequency_penalty)
  if (form.presence_penalty !== '') defaults.presence_penalty = Number(form.presence_penalty)
  if (form.seed !== '') defaults.seed = Number(form.seed)

  return { load, defaults }
}

function VllmTemplateEditor({
  modelId,
  existingTemplate,
  onClose,
}: {
  modelId: string
  existingTemplate: LlamacppTemplate | undefined
  onClose: () => void
}) {
  const [form, setForm] = useState<FormState>(() => templateToForm(existingTemplate))
  const setTemplateMutation = useSetLlamacppTemplateMutation()
  const deleteTemplateMutation = useDeleteLlamacppTemplateMutation()
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null)
  const clipboard = useTemplateClipboard<Record<string, unknown>>()

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(f => ({ ...f, [key]: value }))
  }

  const handleCopy = () => {
    setTemplateClipboard({ sourceModelId: modelId, form: { ...form } } as ClipboardEntry)
    setStatus({ msg: `Template copié (depuis ${modelId})`, ok: true })
  }

  const handlePaste = () => {
    if (!clipboard) return
    if (clipboard.sourceModelId === modelId) {
      setStatus({ msg: 'Source et destination identiques, rien à coller', ok: false })
      return
    }
    // Cross-provider paste : on n'écrase que les champs présents dans le clipboard
    // et qui existent dans notre FormState. Les champs spécifiques LlamaCpp (jinja,
    // flash_attn, type_k, ...) sont ignorés silencieusement.
    const src = clipboard.form
    const next: FormState = { ...form }
    for (const key of Object.keys(next) as Array<keyof FormState>) {
      const v = src[key as string]
      if (typeof v === 'string') {
        (next as Record<string, string>)[key as string] = v
      }
    }
    setForm(next)
    setStatus({ msg: `Template collé depuis ${clipboard.sourceModelId} — vérifie puis Sauvegarder`, ok: true })
  }

  const handleSave = async () => {
    setStatus(null)
    try {
      await setTemplateMutation.mutateAsync({ model_id: modelId, template: formToTemplate(form) })
      setStatus({ msg: 'Template sauvegardé', ok: true })
    } catch (e) {
      setStatus({ msg: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  const handleDelete = async () => {
    setStatus(null)
    try {
      await deleteTemplateMutation.mutateAsync(modelId)
      setStatus({ msg: 'Template supprimé', ok: true })
      onClose()
    } catch (e) {
      setStatus({ msg: e instanceof Error ? e.message : String(e), ok: false })
    }
  }

  const busy = setTemplateMutation.isPending || deleteTemplateMutation.isPending

  return (
    <TemplateEditorShell
      modelId={modelId}
      existingTemplate={existingTemplate}
      onClose={onClose}
      onSave={handleSave}
      onDelete={handleDelete}
      onCopy={handleCopy}
      onPaste={handlePaste}
      clipboardSourceModelId={clipboard?.sourceModelId ?? null}
      busy={busy}
      status={status}
      saveLabel={setTemplateMutation.isPending ? 'Sauvegarde…' : 'Sauvegarder'}
    >
      <TemplateSectionGroup title="Options de démarrage (load)">
        <TemplateSection title="Backend & contexte" cols={2}>
          <TextField label="backend" tooltip="Déclaré dans brain-daemon `_BACKEND_MAP` (ex: vllm-rocm). Forwardé tel quel au daemon, qui choisit le toolbox / wrapper correspondant." placeholder="vllm-rocm" value={form.backend} onChange={v => update('backend', v)} disabled={busy} />
          <NumberField label="ctx_size (= --max-model-len)" tooltip="Taille de fenêtre vLLM `--max-model-len`. Doit être ≤ max position embeddings du modèle. Valeurs typiques HF: 32768 / 65536 / 131072." placeholder="32768" value={form.ctx_size} onChange={v => update('ctx_size', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Arguments bruts" cols={1}>
          <TextareaField
            label="extra_args (un par ligne, brut, forwardé tel quel à `vllm serve`)"
            tooltip="Forwardé tel quel à `vllm serve`. Un argument par ligne (flag et valeur sur lignes séparées pour les flags qui prennent un argument)."
            value={form.extra_args}
            onChange={v => update('extra_args', v)}
            disabled={busy}
            rows={6}
            monospaced
            placeholder={'--gpu-memory-utilization\n0.92\n--speculative-config\n{"model":"google/gemma-4-31B-it-assistant","num_speculative_tokens":7}'}
          />
        </TemplateSection>

        <TemplateSection title="Variables d'environnement" cols={1}>
          <TextareaField
            label="env_vars (une ligne KEY=VAL, injectées via `env` dans le toolbox)"
            tooltip="Variables d'environnement injectées au process vLLM via brain-daemon (`env KEY=VAL ...`). Utile pour PYTORCH_CUDA_ALLOC_CONF, VLLM_LOGGING_LEVEL, HF_HUB_OFFLINE, etc."
            value={form.env_vars}
            onChange={v => update('env_vars', v)}
            disabled={busy}
            rows={3}
            monospaced
            placeholder={'PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True\nVLLM_LOGGING_LEVEL=INFO'}
          />
        </TemplateSection>
      </TemplateSectionGroup>

      <TemplateSectionGroup title="Valeurs par défaut (defaults — injectées si absentes de la requête)">
        <TemplateSection title="Sampling" cols={3}>
          <NumberField label="temperature" tooltip="Contrôle l'aléatoire. 0 = déterministe. 0.2–0.7 = stable et cohérent. 0.8–1.2 = créatif. > 1.5 = chaotique." placeholder="—" step="0.05" min="0" max="2" value={form.temperature} onChange={v => update('temperature', v)} disabled={busy} />
          <NumberField label="top_p" tooltip="Nucleus sampling : garde les tokens dont la somme des probabilités ≤ top_p. 0.9–0.95 = standard." placeholder="—" step="0.05" min="0" max="1" value={form.top_p} onChange={v => update('top_p', v)} disabled={busy} />
          <NumberField label="top_k" tooltip="Limite le sampling aux k meilleurs tokens. 0 = désactivé. 40–50 = valeurs classiques." placeholder="—" min="0" value={form.top_k} onChange={v => update('top_k', v)} disabled={busy} />
          <NumberField label="min_p" tooltip="Minimum-p sampling : écarte les tokens dont la probabilité < min_p × (prob du token le plus probable). Alternative plus stable à top_p." placeholder="—" step="0.01" min="0" max="1" value={form.min_p} onChange={v => update('min_p', v)} disabled={busy} />
          <NumberField label="repeat_penalty" tooltip="Pénalise les tokens récemment générés. 1.0 = désactivé. 1.1–1.3 = valeurs classiques." placeholder="—" step="0.05" min="0" value={form.repeat_penalty} onChange={v => update('repeat_penalty', v)} disabled={busy} />
          <NumberField label="frequency_penalty" tooltip="Pénalité fréquence (standard OpenAI). 0 = désactivé. Plage : -2 à 2." placeholder="—" step="0.05" min="-2" max="2" value={form.frequency_penalty} onChange={v => update('frequency_penalty', v)} disabled={busy} />
          <NumberField label="presence_penalty" tooltip="Pénalité présence (standard OpenAI). 0 = désactivé. Plage : -2 à 2." placeholder="—" step="0.05" min="-2" max="2" value={form.presence_penalty} onChange={v => update('presence_penalty', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Divers" cols={4}>
          <NumberField label="seed" tooltip="Graine aléatoire pour la génération. -1 = aléatoire à chaque requête. Même seed + même prompt + même modèle = résultat reproductible." placeholder="— (-1)" min="-1" value={form.seed} onChange={v => update('seed', v)} disabled={busy} />
        </TemplateSection>
      </TemplateSectionGroup>
    </TemplateEditorShell>
  )
}

function VllmModelRow({
  model,
  onLoad,
  onUnload,
  busy,
}: {
  model: LlamacppModelEntry
  onLoad: (id: string) => void
  onUnload: (id: string) => void
  busy: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-b border-neutral-800 last:border-b-0">
      <div className="flex items-center justify-between gap-3 py-2.5 px-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white font-mono">{model.model_id}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">
              HF
            </span>
            {model.running && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-500/20 text-green-400 border border-green-500/30">
                running · port {model.port ?? '?'}
              </span>
            )}
            {typeof model.size_gb === 'number' && (
              <span className="text-xs text-neutral-500">{model.size_gb.toFixed(1)} GB</span>
            )}
          </div>
          {model.path && (
            <p className="text-xs text-neutral-600 mt-0.5 truncate font-mono">{model.path}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            className="px-2.5 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 rounded-md disabled:opacity-50"
            onClick={() => setExpanded(v => !v)}
            disabled={busy}
          >
            {expanded ? 'Replier' : 'Config'}
          </button>
          {model.running ? (
            <button
              type="button"
              className="px-2.5 py-1 text-xs bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/40 rounded-md disabled:opacity-50"
              onClick={() => onUnload(model.model_id)}
              disabled={busy}
            >
              Unload
            </button>
          ) : (
            <button
              type="button"
              className="px-2.5 py-1 text-xs bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded-md disabled:opacity-50"
              onClick={() => onLoad(model.model_id)}
              disabled={busy}
            >
              Load
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3">
          <VllmTemplateEditor
            modelId={model.model_id}
            existingTemplate={model.template}
            onClose={() => setExpanded(false)}
          />
        </div>
      )}
    </div>
  )
}

export default function VllmModelsCard() {
  const { data, isLoading, refetch } = useLlamacppModels()
  const loadMut = useLoadLlamacppModelMutation()
  const unloadMut = useUnloadLlamacppModelMutation()
  const tplMut = useSetLlamacppTemplateMutation()
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  const vllmModels = useMemo(
    () => (data?.models ?? []).filter(m => m.kind === 'hf'),
    [data?.models],
  )
  const runningCount = vllmModels.filter(m => m.running).length

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setFeedback({ kind, msg })
    setTimeout(() => setFeedback(null), 4000)
  }

  const handleLoad = async (id: string) => {
    const r = await loadMut.mutateAsync(id).catch(e => ({ ok: false, status: 0, body: { detail: String(e) } }))
    if (r.ok) {
      flash('ok', `Load demandé pour ${id}`)
      setTimeout(() => refetch(), 1500)
    } else {
      const detail = (r.body as { detail?: string } | null)?.detail ?? `HTTP ${r.status}`
      flash('err', `Load failed: ${detail}`)
    }
  }
  const handleUnload = async (id: string) => {
    const r = await unloadMut.mutateAsync(id).catch(e => ({ ok: false, status: 0, body: { detail: String(e) } }))
    if (r.ok) {
      flash('ok', `Unload OK pour ${id}`)
      setTimeout(() => refetch(), 800)
    } else {
      const detail = (r.body as { detail?: string } | null)?.detail ?? `HTTP ${r.status}`
      flash('err', `Unload failed: ${detail}`)
    }
  }

  const busy = loadMut.isPending || unloadMut.isPending || tplMut.isPending

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white m-0">vLLM</h2>
          {runningCount > 0 && (
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-500/20 text-green-400 border border-green-500/30">
              {runningCount} running
            </span>
          )}
          <span className="text-xs text-neutral-500">{vllmModels.length} modèle{vllmModels.length > 1 ? 's' : ''} HF</span>
        </div>
        {feedback && (
          <span className={`text-xs ${feedback.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
            {feedback.msg}
          </span>
        )}
      </div>

      <div className="flex flex-col">
        {isLoading && (
          <div className="px-6 py-4">
            <Spinner />
          </div>
        )}
        {!isLoading && vllmModels.length === 0 && (
          <p className="px-6 py-4 text-xs text-neutral-500">
            Aucun modèle HF détecté côté brain. Téléchargez un modèle (ex: <span className="font-mono">google/gemma-4-31B-it</span>) via le downloader, puis rafraîchissez le cache.
          </p>
        )}
        {!isLoading && vllmModels.map(m => (
          <VllmModelRow
            key={m.model_id}
            model={m}
            onLoad={handleLoad}
            onUnload={handleUnload}
            busy={busy}
          />
        ))}
      </div>
    </section>
  )
}
