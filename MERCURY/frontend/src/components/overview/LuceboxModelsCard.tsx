/**
 * LuceboxModelsCard — surface les GGUF configurés pour le backend Lucebox
 * (`extra_native_backends.native-lucebox` côté brain-daemon, server.py DFlash
 * speculative decoding avec un draft model safetensors).
 *
 * Filtrage : modèle GGUF *avec template* `load.backend === 'native-lucebox'`.
 * Un GGUF sans template ou avec un autre backend reste dans LlamaCppModelsCard.
 * La passerelle de conversion est le backend selector de LlamaCppModelsCard
 * (sélectionner `native-lucebox` y migre automatiquement le modèle ici).
 *
 * Réutilise les routes /admin/llamacpp/{models,load,unload,templates/<id>}
 * côté Mercury (template DB polymorphe via field `backend`).
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
import BooleanField from '../templates/BooleanField'
import BackendSelector from '../templates/BackendSelector'
import {
  setTemplateClipboard,
  useTemplateClipboard,
  type ClipboardEntry,
} from '../templates/clipboard'

const DEFAULT_CTX = 32768
const LUCEBOX_BACKEND = 'native-lucebox'

type FormState = {
  // Load
  ctx_size: string
  lucebox_draft: string
  extra_args: string  // un arg par ligne
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
  // Defaults — chat template kwargs
  reasoning: boolean  // shortcut UI → chat_template_kwargs.enable_thinking
  chat_template_kwargs_extra: string  // textarea JSON libre (kwargs avancées, hors enable_thinking)
}

const DEFAULT_FORM: FormState = {
  ctx_size: String(DEFAULT_CTX),
  lucebox_draft: '',
  extra_args: '',
  env_vars: '',
  temperature: '',
  top_p: '',
  top_k: '',
  min_p: '',
  repeat_penalty: '',
  frequency_penalty: '',
  presence_penalty: '',
  seed: '',
  reasoning: false,
  chat_template_kwargs_extra: '',
}

function templateToForm(t: LlamacppTemplate | undefined): FormState {
  if (!t) return { ...DEFAULT_FORM }
  const load = t.load ?? {}
  const defaults = t.defaults ?? {}
  const ctx = typeof load.ctx_size === 'number' ? String(load.ctx_size) : String(DEFAULT_CTX)
  const args = Array.isArray(load.extra_args) ? load.extra_args.join('\n') : ''
  const draft = typeof load.lucebox_draft === 'string' ? load.lucebox_draft : ''
  const env = (load.env_vars && typeof load.env_vars === 'object')
    ? Object.entries(load.env_vars).map(([k, v]) => `${k}=${v}`).join('\n')
    : ''
  // Reasoning lu depuis chat_template_kwargs.enable_thinking ; fallback legacy
  // defaults.reasoning si le template n'a pas encore été migré.
  const ctk = (defaults.chat_template_kwargs ?? {}) as Record<string, unknown>
  const reasoningFromCtk = ctk.enable_thinking
  const reasoningValue = typeof reasoningFromCtk === 'boolean'
    ? reasoningFromCtk
    : defaults.reasoning === true
  // Extra kwargs = toutes les clés sauf enable_thinking (géré par la checkbox).
  const ctkExtra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ctk)) {
    if (k !== 'enable_thinking') ctkExtra[k] = v
  }
  const ctkExtraStr = Object.keys(ctkExtra).length > 0 ? JSON.stringify(ctkExtra, null, 2) : ''
  return {
    ctx_size: ctx,
    lucebox_draft: draft,
    extra_args: args,
    env_vars: env,
    temperature: defaults.temperature != null ? String(defaults.temperature) : '',
    top_p: defaults.top_p != null ? String(defaults.top_p) : '',
    top_k: defaults.top_k != null ? String(defaults.top_k) : '',
    min_p: defaults.min_p != null ? String(defaults.min_p) : '',
    repeat_penalty: defaults.repeat_penalty != null ? String(defaults.repeat_penalty) : '',
    frequency_penalty: defaults.frequency_penalty != null ? String(defaults.frequency_penalty) : '',
    presence_penalty: defaults.presence_penalty != null ? String(defaults.presence_penalty) : '',
    seed: defaults.seed != null ? String(defaults.seed) : '',
    reasoning: reasoningValue,
    chat_template_kwargs_extra: ctkExtraStr,
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
    backend: LUCEBOX_BACKEND,
  }
  const draft = form.lucebox_draft.trim()
  if (draft) load.lucebox_draft = draft
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

  // chat_template_kwargs : merge {enable_thinking} + parsed JSON libre.
  // Le textarea JSON est validé au save-time (handleSave) — ici on tente un parse
  // tolérant et on ignore silencieusement les erreurs (la validation côté handleSave
  // catch le cas où le textarea n'est pas un objet JSON valide).
  let ctkExtraObj: Record<string, unknown> = {}
  if (form.chat_template_kwargs_extra.trim()) {
    try {
      const parsed = JSON.parse(form.chat_template_kwargs_extra)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        ctkExtraObj = parsed as Record<string, unknown>
      }
    } catch {
      // ignore
    }
  }
  defaults.chat_template_kwargs = { ...ctkExtraObj, enable_thinking: form.reasoning }

  return { load, defaults }
}

function LuceboxTemplateEditor({
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
    const src = clipboard.form
    const next: FormState = { ...form }
    const nextAny = next as unknown as Record<string, unknown>
    for (const key of Object.keys(next)) {
      const cur = nextAny[key]
      const v = src[key]
      // Copy si types compatibles (string→string, boolean→boolean) ; sinon skip
      // pour éviter de casser FormState (ex. coller depuis un form qui n'a pas
      // `reasoning` ne doit pas mettre le champ à undefined).
      if (typeof v === 'string' && typeof cur === 'string') {
        nextAny[key] = v
      } else if (typeof v === 'boolean' && typeof cur === 'boolean') {
        nextAny[key] = v
      }
    }
    setForm(next)
    setStatus({ msg: `Template collé depuis ${clipboard.sourceModelId} — vérifie puis Sauvegarder`, ok: true })
  }

  const handleSave = async () => {
    setStatus(null)
    // Validation : chat_template_kwargs_extra doit parser si non vide
    if (form.chat_template_kwargs_extra.trim()) {
      try {
        const parsed = JSON.parse(form.chat_template_kwargs_extra)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setStatus({ msg: 'chat_template_kwargs doit être un objet JSON { clé: valeur }', ok: false })
          return
        }
      } catch (e) {
        setStatus({ msg: `JSON invalide dans chat_template_kwargs : ${e instanceof Error ? e.message : String(e)}`, ok: false })
        return
      }
    }
    // Guard : si lucebox_draft était présent dans le template existant et qu'il
    // est vide dans le form, le daemon refusera le prochain load (HTTP 400) sauf
    // s'il garde l'ancienne valeur dans load_configs.json. Comportement implicite
    // du daemon donc on alerte explicitement.
    const previousDraft = typeof existingTemplate?.load?.lucebox_draft === 'string'
      ? existingTemplate.load.lucebox_draft.trim()
      : ''
    if (previousDraft && !form.lucebox_draft.trim()) {
      const ok = window.confirm(
        "Le champ lucebox_draft est vide alors qu'il était configuré "
        + `(${previousDraft}). Le brain-daemon refusera le prochain load avec `
        + 'HTTP 400 si load_configs.json est purgé. Sauvegarder quand même ?'
      )
      if (!ok) return
    }
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
        <TemplateSection title="Lucebox / DFlash draft" cols={1}>
          <TextField
            label="lucebox_draft (chemin absolu vers le model.safetensors du draft)"
            tooltip="Requis : le brain-daemon retourne HTTP 400 sans ce champ au premier load (puis persisté dans load_configs.json pour reload-on-restart)."
            placeholder="/path/to/models/DraftModel/model.safetensors"
            value={form.lucebox_draft}
            onChange={v => update('lucebox_draft', v)}
            disabled={busy}
          />
        </TemplateSection>

        <TemplateSection title="Backend & contexte" cols={2}>
          <BackendSelector value={LUCEBOX_BACKEND} onChange={() => { /* locked */ }} disabled={busy} lockedTo={LUCEBOX_BACKEND} />
          <NumberField label="ctx_size (= --max-ctx côté server.py)" tooltip="Taille de fenêtre Lucebox `--max-ctx`. Doit être ≤ max position embeddings du target + du draft." placeholder="32768" value={form.ctx_size} onChange={v => update('ctx_size', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Arguments bruts" cols={1}>
          <TextareaField
            label="extra_args (un par ligne, brut, forwardé à server.py)"
            tooltip="Spécifiques Lucebox : --budget N (DDTree, sweet spot gfx1151 = 22) · --cache-type-k/v · --fa-window N · --draft-swa/--draft-ctx-max · --target-gpus/--target-layer-split/--target-gpu/--draft-gpu. Les flags llama.cpp (-fa, -ngl, --no-mmap, --jinja, …) sont ignorés."
            value={form.extra_args}
            onChange={v => update('extra_args', v)}
            disabled={busy}
            rows={6}
            monospaced
            placeholder={'--budget 22\n--cache-type-k\nq8_0\n--fa-window\n2048'}
          />
        </TemplateSection>

        <TemplateSection title="Variables d'environnement" cols={1}>
          <TextareaField
            label="env_vars (une ligne KEY=VAL, injectées au process server.py)"
            tooltip="Variables d'environnement injectées au process Lucebox server.py via brain-daemon."
            value={form.env_vars}
            onChange={v => update('env_vars', v)}
            disabled={busy}
            rows={3}
            monospaced
            placeholder={'PYTORCH_HIP_ALLOC_CONF=expandable_segments:True'}
          />
        </TemplateSection>
      </TemplateSectionGroup>

      <TemplateSectionGroup title="Valeurs par défaut (defaults — injectées si absentes de la requête)">
        <TemplateSection title="Sampling" cols={3}>
          <NumberField label="temperature" tooltip="Contrôle l'aléatoire. 0 = déterministe. 0.2–0.7 = stable. 0.8–1.2 = créatif." placeholder="—" step="0.05" min="0" max="2" value={form.temperature} onChange={v => update('temperature', v)} disabled={busy} />
          <NumberField label="top_p" tooltip="Nucleus sampling : garde les tokens dont la somme des probabilités ≤ top_p." placeholder="—" step="0.05" min="0" max="1" value={form.top_p} onChange={v => update('top_p', v)} disabled={busy} />
          <NumberField label="top_k" tooltip="Limite le sampling aux k meilleurs tokens. 0 = désactivé." placeholder="—" min="0" value={form.top_k} onChange={v => update('top_k', v)} disabled={busy} />
          <NumberField label="min_p" tooltip="Minimum-p sampling : écarte les tokens dont la probabilité < min_p × (prob du token le plus probable)." placeholder="—" step="0.01" min="0" max="1" value={form.min_p} onChange={v => update('min_p', v)} disabled={busy} />
          <NumberField label="repeat_penalty" tooltip="Pénalise les tokens récemment générés. 1.0 = désactivé." placeholder="—" step="0.05" min="0" value={form.repeat_penalty} onChange={v => update('repeat_penalty', v)} disabled={busy} />
          <NumberField label="frequency_penalty" tooltip="Pénalité fréquence (standard OpenAI). 0 = désactivé. Plage : -2 à 2." placeholder="—" step="0.05" min="-2" max="2" value={form.frequency_penalty} onChange={v => update('frequency_penalty', v)} disabled={busy} />
          <NumberField label="presence_penalty" tooltip="Pénalité présence (standard OpenAI). 0 = désactivé. Plage : -2 à 2." placeholder="—" step="0.05" min="-2" max="2" value={form.presence_penalty} onChange={v => update('presence_penalty', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Divers" cols={4}>
          <NumberField label="seed" tooltip="Graine aléatoire pour la génération. -1 = aléatoire à chaque requête." placeholder="— (-1)" min="-1" value={form.seed} onChange={v => update('seed', v)} disabled={busy} />
          <BooleanField
            id={`lucebox-reasoning-${modelId}`}
            label="reasoning (enable_thinking)"
            tooltip="Active le bloc <think> côté Lucebox/server.py via chat_template_kwargs.enable_thinking. Requis pour Qwen3-thinking et autres modèles avec template Jinja qui gate le thinking sur cette clé. Le brain-daemon forward tel quel au rendu Jinja."
            checked={form.reasoning}
            onChange={v => update('reasoning', v)}
            disabled={busy}
          />
        </TemplateSection>

        <TemplateSection title="Chat template (avancé)" cols={1}>
          <TextareaField
            label="chat_template_kwargs (avancé, JSON)"
            tooltip="Dict JSON libre passé au template Jinja. La clé enable_thinking est gérée par la checkbox reasoning ci-dessus — ne la mettez pas ici. Exemples : { &quot;reasoning_effort&quot;: &quot;low&quot; } pour les templates qui le supportent (Qwen3 récents, GPT-OSS)."
            value={form.chat_template_kwargs_extra}
            onChange={v => update('chat_template_kwargs_extra', v)}
            disabled={busy}
            rows={4}
            monospaced
            placeholder={'{\n  "reasoning_effort": "low"\n}'}
          />
        </TemplateSection>
      </TemplateSectionGroup>
    </TemplateEditorShell>
  )
}

function LuceboxModelRow({
  model,
  onLoad,
  onUnload,
  busy,
  backendType,
}: {
  model: LlamacppModelEntry
  onLoad: (id: string) => void
  onUnload: (id: string) => void
  busy: boolean
  backendType?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const draftMissing = !(typeof model.template?.load?.lucebox_draft === 'string' && model.template.load.lucebox_draft.trim())

  return (
    <div className="border-b border-neutral-800 last:border-b-0">
      <div className="flex items-center justify-between gap-3 py-2.5 px-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white font-mono">{model.model_id}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-500/20 text-orange-400 border border-orange-500/30">
              Lucebox
            </span>
            {model.running && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-500/20 text-green-400 border border-green-500/30">
                running · port {model.port ?? '?'}
                {backendType && backendType !== 'lucebox' && ` · backend ${backendType}`}
              </span>
            )}
            {typeof model.size_gb === 'number' && (
              <span className="text-xs text-neutral-500">{model.size_gb.toFixed(1)} GB</span>
            )}
            {draftMissing && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/20 text-red-400 border border-red-500/30"
                title="lucebox_draft (chemin safetensors) non configuré — le brain-daemon refusera le load avec HTTP 400."
              >
                draft manquant
              </span>
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
              disabled={busy || draftMissing}
              title={draftMissing ? "Configure d'abord lucebox_draft (Config → champ ci-dessous)" : ''}
            >
              Load
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3">
          <LuceboxTemplateEditor
            modelId={model.model_id}
            existingTemplate={model.template}
            onClose={() => setExpanded(false)}
          />
        </div>
      )}
    </div>
  )
}

export default function LuceboxModelsCard() {
  const { data, isLoading, refetch } = useLlamacppModels()
  const loadMut = useLoadLlamacppModelMutation()
  const unloadMut = useUnloadLlamacppModelMutation()
  const tplMut = useSetLlamacppTemplateMutation()
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  const luceboxModels = useMemo(
    () => (data?.models ?? []).filter(m => m.template?.load?.backend === LUCEBOX_BACKEND),
    [data?.models],
  )
  const runningCount = luceboxModels.filter(m => m.running).length

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
          <h2 className="text-lg font-semibold text-white m-0">Lucebox</h2>
          {runningCount > 0 && (
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-500/20 text-green-400 border border-green-500/30">
              {runningCount} running
            </span>
          )}
          <span className="text-xs text-neutral-500">{luceboxModels.length} modèle{luceboxModels.length > 1 ? 's' : ''} configuré{luceboxModels.length > 1 ? 's' : ''}</span>
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
        {!isLoading && luceboxModels.length === 0 && (
          <p className="px-6 py-4 text-xs text-neutral-500 leading-relaxed">
            Aucun modèle configuré en backend Lucebox. Pour en déclarer un : ouvre la card <span className="text-neutral-400">LlamaCPP</span>,
            sélectionne un modèle GGUF compatible (target + draft DFlash), <span className="text-neutral-400">Modifier template</span>,
            puis change le <span className="font-mono">backend</span> en <span className="font-mono text-orange-400">native-lucebox</span> et saisis le chemin
            <span className="font-mono"> lucebox_draft</span>. Au save le modèle migrera automatiquement ici.
          </p>
        )}
        {!isLoading && luceboxModels.map(m => (
          <LuceboxModelRow
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
