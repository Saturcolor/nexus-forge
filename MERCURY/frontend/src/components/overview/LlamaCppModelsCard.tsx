import { useState, useCallback, useEffect, useRef } from 'react'
import {
  useLlamacppModels,
  useLlamacppProbe,
  useLlamacppDaemonLogs,
  useLlamacppSlots,
  useLlamacppInstanceLogs,
  useLoadLlamacppModelMutation,
  useUnloadLlamacppModelMutation,
  useSetLlamacppTemplateMutation,
  useDeleteLlamacppTemplateMutation,
  useCacheModels,
  useSetModelPriorityMutation,
  useSetHiddenModelMutation,
  useSetModelCategoryMutation,
  useSaveKvCacheMutation,
  useDeleteKvCacheMutation,
  useBrainMemoryProtectMutation,
  useBrainMemoryUnprotectMutation,
} from '../../api/queries'
import type { LlamacppTemplate, LlamacppModelEntry, LlamaTiming } from '../../api/admin'
import Spinner from '../Spinner'
import TemplateEditorShell from '../templates/TemplateEditorShell'
import TemplateSection from '../templates/TemplateSection'
import TemplateSectionGroup from '../templates/TemplateSectionGroup'
import BooleanField from '../templates/BooleanField'
import NumberField from '../templates/NumberField'
import TextField from '../templates/TextField'
import SelectField from '../templates/SelectField'
import TextareaField from '../templates/TextareaField'
import BackendSelector from '../templates/BackendSelector'
import { setTemplateClipboard, useTemplateClipboard } from '../templates/clipboard'

function formatGb(n: number | undefined): string {
  if (n == null) return '—'
  return `${n.toFixed(1)} Go`
}

function formatActivity(ts: number | undefined): string {
  if (ts == null) return '—'
  const delta = Date.now() / 1000 - ts
  if (delta < 0) return '—'
  if (delta < 60) return `${Math.floor(delta)}s`
  if (delta < 3600) return `${Math.floor(delta / 60)}m`
  const h = Math.floor(delta / 3600)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  const r = h % 24
  return r > 0 ? `${d}j ${r}h` : `${d}j`
}

type TemplateFormState = {
  // Load — essentiels
  ctx_size: string
  n_gpu_layers: string
  flash_attn: boolean
  jinja: boolean
  debug: boolean
  no_mmap: boolean
  ctx_shift: boolean
  unified_kv_cache: boolean
  swa_full: boolean
  parallel: string
  // Load — performance CPU/batch
  n_batch: string
  n_ubatch: string
  n_threads: string
  n_threads_batch: string
  // Load — memory / cache tuning
  mlock: boolean
  cache_ram: string              // empty = défaut llama.cpp (8192 MiB)
  ctx_checkpoints: string        // empty = défaut llama.cpp (32)
  cache_idle_slots: boolean      // true = défaut llama.cpp ; false = --no-cache-idle-slots
  // Load — KV cache quantization
  type_k: string
  type_v: string
  // Load — RoPE
  rope_freq_base: string
  rope_freq_scale: string
  // Load — brut
  extra_args: string
  // Load — env vars (KEY=VAL, une par ligne, injectées au process serveur)
  env_vars: string
  // Load — Speculative decoding (MTP / Draft)
  spec_type: string                    // '' / 'mtp' / 'mtp-legacy' / 'draft' / 'ngram'  → --spec-type (remap mainline-side via _common.py)
  spec_draft_n_max: string             // → --spec-draft-n-max (MTP embedded mainline)
  mtp_head: string                     // chemin GGUF head MTP → --mtp-head (fork turboquant)
  draft_block_size: string             // → --draft-block-size (fork turboquant)
  draft_model: string                  // chemin GGUF draft → -md (draft classique)
  draft_n_gpu_layers: string           // → -ngld (commun MTP head + draft classique)
  draft_ctx_size: string               // → -cd (draft classique)
  draft_max: string                    // → --draft-max
  draft_min: string                    // → --draft-min
  draft_p_min: string                  // → --draft-p-min
  // Defaults — sampling
  temperature: string
  top_p: string
  top_k: string
  min_p: string
  typical_p: string
  tfs_z: string
  // Defaults — pénalités
  repeat_penalty: string
  frequency_penalty: string
  presence_penalty: string
  // Defaults — Mirostat
  mirostat_mode: string
  mirostat_tau: string
  mirostat_eta: string
  // Defaults — divers
  seed: string
  reasoning: boolean  // shortcut UI → chat_template_kwargs.enable_thinking
  thinking_budget_low: string     // override per-model du budget low (tokens). Vide = config globale
  thinking_budget_medium: string  // override per-model du budget medium
  thinking_budget_high: string    // override per-model du budget high
  chat_template_kwargs_extra: string  // textarea JSON libre (kwargs avancées, hors enable_thinking)
  n_keep: string
  cache_prompt: boolean
  // KV cache save/restore
  kv_cache_auto_dump: boolean
  // Backend GPU — string accepts builtin (vulkan/rocm/native-vulkan) and any
  // extra_native_backends declared in BRAIN-DAEMON config.yaml (e.g. native-dflash, native-mtp).
  backend: string
  // Custom chat template Jinja (override du bundled dans le GGUF)
  chat_template_file: string
  // Fusion des messages adjacents de meme role (sans suppression)
  mergeConsecutiveMessages: boolean
}

const DEFAULT_FORM: TemplateFormState = {
  ctx_size: '32768',
  n_gpu_layers: '999',
  flash_attn: true,
  jinja: false,
  debug: false,
  no_mmap: true,
  ctx_shift: true,
  unified_kv_cache: false,
  swa_full: false,
  parallel: '1',
  n_batch: '',
  n_ubatch: '',
  n_threads: '',
  n_threads_batch: '',
  mlock: true,
  cache_ram: '0',
  ctx_checkpoints: '1',
  cache_idle_slots: false,
  type_k: '',
  type_v: '',
  rope_freq_base: '',
  rope_freq_scale: '',
  extra_args: '',
  env_vars: '',
  spec_type: '',
  spec_draft_n_max: '',
  mtp_head: '',
  draft_block_size: '',
  draft_model: '',
  draft_n_gpu_layers: '',
  draft_ctx_size: '',
  draft_max: '',
  draft_min: '',
  draft_p_min: '',
  temperature: '',
  top_p: '',
  top_k: '',
  min_p: '',
  typical_p: '',
  tfs_z: '',
  repeat_penalty: '',
  frequency_penalty: '',
  presence_penalty: '',
  mirostat_mode: '',
  mirostat_tau: '',
  mirostat_eta: '',
  seed: '',
  reasoning: false,
  thinking_budget_low: '',
  thinking_budget_medium: '',
  thinking_budget_high: '',
  chat_template_kwargs_extra: '',
  n_keep: '',
  cache_prompt: true,
  kv_cache_auto_dump: false,
  backend: 'native-vulkan',
  chat_template_file: '',
  mergeConsecutiveMessages: false,
}

// Liste des types KV cache exposés par llama-server (`--cache-type-k` / `-v`).
// `turbo2/3/4` ne sont disponibles que sur le backend `native-turboquant`
// (fork AtomicBot-ai/atomic-llama-cpp-turboquant) — le binaire mainline
// rejettera ces valeurs avec `unsupported quantization type`.
const KV_TYPE_OPTIONS = [
  '', 'f32', 'f16', 'bf16',
  'q8_0', 'q5_1', 'q5_0', 'iq4_nl', 'q4_1', 'q4_0',
  'turbo2', 'turbo3', 'turbo4',
]

function templateToForm(tpl: LlamacppTemplate | undefined): TemplateFormState {
  if (!tpl) return { ...DEFAULT_FORM }
  const load = tpl.load ?? {}
  const defaults = tpl.defaults ?? {}
  // Lecture reasoning : priorité au nouveau format (chat_template_kwargs.enable_thinking),
  // fallback sur l'ancien format legacy (defaults.reasoning).
  const ctk = (defaults.chat_template_kwargs ?? {}) as Record<string, unknown>
  const reasoningFromCtk = ctk.enable_thinking
  const reasoningValue = typeof reasoningFromCtk === 'boolean'
    ? reasoningFromCtk
    : defaults.reasoning === true
  // Extraire les kwargs "extra" = toutes les kwargs sauf enable_thinking (géré par la checkbox)
  const ctkExtra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ctk)) {
    if (k !== 'enable_thinking') ctkExtra[k] = v
  }
  const ctkExtraStr = Object.keys(ctkExtra).length > 0 ? JSON.stringify(ctkExtra, null, 2) : ''
  return {
    ctx_size: load.ctx_size != null ? String(load.ctx_size) : '32768',
    n_gpu_layers: load.n_gpu_layers != null ? String(load.n_gpu_layers) : '999',
    flash_attn: load.flash_attn !== false,
    jinja: load.jinja === true,
    debug: load.debug === true,
    no_mmap: load.no_mmap !== false,
    ctx_shift: load.ctx_shift !== false,
    unified_kv_cache: load.unified_kv_cache === true,
    swa_full: load.swa_full === true,
    parallel: load.parallel != null ? String(load.parallel) : '1',
    n_batch: load.n_batch != null ? String(load.n_batch) : '',
    n_ubatch: load.n_ubatch != null ? String(load.n_ubatch) : '',
    n_threads: load.n_threads != null ? String(load.n_threads) : '',
    n_threads_batch: load.n_threads_batch != null ? String(load.n_threads_batch) : '',
    mlock: load.mlock === true,
    cache_ram: load.cache_ram != null ? String(load.cache_ram) : '',
    ctx_checkpoints: load.ctx_checkpoints != null ? String(load.ctx_checkpoints) : '',
    cache_idle_slots: load.cache_idle_slots !== false,
    type_k: load.type_k ?? '',
    type_v: load.type_v ?? '',
    rope_freq_base: load.rope_freq_base != null ? String(load.rope_freq_base) : '',
    rope_freq_scale: load.rope_freq_scale != null ? String(load.rope_freq_scale) : '',
    extra_args: (load.extra_args ?? []).filter((a): a is string => typeof a === 'string').join(' '),
    env_vars: (load.env_vars && typeof load.env_vars === 'object')
      ? Object.entries(load.env_vars).map(([k, v]) => `${k}=${v}`).join('\n')
      : '',
    spec_type: typeof load.spec_type === 'string' ? load.spec_type : '',
    spec_draft_n_max: load.spec_draft_n_max != null ? String(load.spec_draft_n_max) : '',
    mtp_head: typeof load.mtp_head === 'string' ? load.mtp_head : '',
    draft_block_size: load.draft_block_size != null ? String(load.draft_block_size) : '',
    draft_model: typeof load.draft_model === 'string' ? load.draft_model : '',
    draft_n_gpu_layers: load.draft_n_gpu_layers != null ? String(load.draft_n_gpu_layers) : '',
    draft_ctx_size: load.draft_ctx_size != null ? String(load.draft_ctx_size) : '',
    draft_max: load.draft_max != null ? String(load.draft_max) : '',
    draft_min: load.draft_min != null ? String(load.draft_min) : '',
    draft_p_min: load.draft_p_min != null ? String(load.draft_p_min) : '',
    temperature: defaults.temperature != null ? String(defaults.temperature) : '',
    top_p: defaults.top_p != null ? String(defaults.top_p) : '',
    top_k: defaults.top_k != null ? String(defaults.top_k) : '',
    min_p: defaults.min_p != null ? String(defaults.min_p) : '',
    typical_p: defaults.typical_p != null ? String(defaults.typical_p) : '',
    tfs_z: defaults.tfs_z != null ? String(defaults.tfs_z) : '',
    repeat_penalty: defaults.repeat_penalty != null ? String(defaults.repeat_penalty) : '',
    frequency_penalty: defaults.frequency_penalty != null ? String(defaults.frequency_penalty) : '',
    presence_penalty: defaults.presence_penalty != null ? String(defaults.presence_penalty) : '',
    mirostat_mode: defaults.mirostat_mode != null ? String(defaults.mirostat_mode) : '',
    mirostat_tau: defaults.mirostat_tau != null ? String(defaults.mirostat_tau) : '',
    mirostat_eta: defaults.mirostat_eta != null ? String(defaults.mirostat_eta) : '',
    seed: defaults.seed != null ? String(defaults.seed) : '',
    reasoning: reasoningValue,
    thinking_budget_low: defaults.thinking_budget_low != null ? String(defaults.thinking_budget_low) : '',
    thinking_budget_medium: defaults.thinking_budget_medium != null ? String(defaults.thinking_budget_medium) : '',
    thinking_budget_high: defaults.thinking_budget_high != null ? String(defaults.thinking_budget_high) : '',
    chat_template_kwargs_extra: ctkExtraStr,
    n_keep: defaults.n_keep != null ? String(defaults.n_keep) : '',
    cache_prompt: defaults.cache_prompt !== false,
    kv_cache_auto_dump: load.kv_cache_auto_dump === true,
    // Preserve any backend name string from the template — the daemon validates it
    // against its registry at load time. Fall back to native-vulkan if missing.
    backend: typeof load.backend === 'string' && load.backend ? load.backend : 'native-vulkan',
    chat_template_file: load.chat_template_file ?? '',
    mergeConsecutiveMessages: tpl.merge_consecutive_messages === true,
  }
}

function formToTemplate(form: TemplateFormState): LlamacppTemplate {
  const extra = form.extra_args.trim() ? form.extra_args.trim().split(/\s+/) : []
  const load: LlamacppTemplate['load'] = {
    ctx_size: form.ctx_size ? Number(form.ctx_size) : 32768,
    n_gpu_layers: form.n_gpu_layers ? Number(form.n_gpu_layers) : 999,
    flash_attn: form.flash_attn,
    jinja: form.jinja,
    debug: form.debug,
    no_mmap: form.no_mmap,
    ctx_shift: form.ctx_shift,
    unified_kv_cache: form.unified_kv_cache,
    swa_full: form.swa_full,
    parallel: form.parallel ? Number(form.parallel) : 1,
    extra_args: extra,
    kv_cache_auto_dump: form.kv_cache_auto_dump,
    backend: form.backend,
  }
  if (form.chat_template_file.trim()) load.chat_template_file = form.chat_template_file.trim()
  // env_vars : parse les lignes KEY=VAL → Record<string,string>
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
  if (Object.keys(env).length > 0) load.env_vars = env
  // Speculative decoding — n'écrit que les clés non vides (les flags inconnus du
  // binaire ciblé sont laissés à brain-daemon qui retournera HTTP 400 au load
  // si incompat, pas de risque silencieux).
  if (form.spec_type) load.spec_type = form.spec_type as 'mtp' | 'mtp-legacy' | 'draft' | 'ngram'
  if (form.spec_draft_n_max !== '') load.spec_draft_n_max = Number(form.spec_draft_n_max)
  if (form.mtp_head.trim()) load.mtp_head = form.mtp_head.trim()
  if (form.draft_block_size !== '') load.draft_block_size = Number(form.draft_block_size)
  if (form.draft_model.trim()) load.draft_model = form.draft_model.trim()
  if (form.draft_n_gpu_layers !== '') load.draft_n_gpu_layers = Number(form.draft_n_gpu_layers)
  if (form.draft_ctx_size !== '') load.draft_ctx_size = Number(form.draft_ctx_size)
  if (form.draft_max !== '') load.draft_max = Number(form.draft_max)
  if (form.draft_min !== '') load.draft_min = Number(form.draft_min)
  if (form.draft_p_min !== '') load.draft_p_min = Number(form.draft_p_min)
  if (form.n_batch !== '') load.n_batch = Number(form.n_batch)
  if (form.n_ubatch !== '') load.n_ubatch = Number(form.n_ubatch)
  if (form.n_threads !== '') load.n_threads = Number(form.n_threads)
  if (form.n_threads_batch !== '') load.n_threads_batch = Number(form.n_threads_batch)
  if (form.mlock) load.mlock = true
  if (form.cache_ram !== '') load.cache_ram = Number(form.cache_ram)
  if (form.ctx_checkpoints !== '') load.ctx_checkpoints = Number(form.ctx_checkpoints)
  if (!form.cache_idle_slots) load.cache_idle_slots = false
  if (form.type_k) load.type_k = form.type_k
  if (form.type_v) load.type_v = form.type_v
  if (form.rope_freq_base !== '') load.rope_freq_base = Number(form.rope_freq_base)
  if (form.rope_freq_scale !== '') load.rope_freq_scale = Number(form.rope_freq_scale)

  const defaults: LlamacppTemplate['defaults'] = {}
  if (form.temperature !== '') defaults.temperature = Number(form.temperature)
  if (form.top_p !== '') defaults.top_p = Number(form.top_p)
  if (form.top_k !== '') defaults.top_k = Number(form.top_k)
  if (form.min_p !== '') defaults.min_p = Number(form.min_p)
  if (form.typical_p !== '') defaults.typical_p = Number(form.typical_p)
  if (form.tfs_z !== '') defaults.tfs_z = Number(form.tfs_z)
  if (form.repeat_penalty !== '') defaults.repeat_penalty = Number(form.repeat_penalty)
  if (form.frequency_penalty !== '') defaults.frequency_penalty = Number(form.frequency_penalty)
  if (form.presence_penalty !== '') defaults.presence_penalty = Number(form.presence_penalty)
  if (form.mirostat_mode !== '') defaults.mirostat_mode = Number(form.mirostat_mode)
  if (form.mirostat_tau !== '') defaults.mirostat_tau = Number(form.mirostat_tau)
  if (form.mirostat_eta !== '') defaults.mirostat_eta = Number(form.mirostat_eta)
  if (form.seed !== '') defaults.seed = Number(form.seed)
  // Reasoning → chat_template_kwargs.enable_thinking (vraie clé que llama-server comprend).
  // Merge avec les kwargs extra du textarea JSON libre.
  let ctkExtraObj: Record<string, unknown> = {}
  if (form.chat_template_kwargs_extra.trim()) {
    try {
      const parsed = JSON.parse(form.chat_template_kwargs_extra)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        ctkExtraObj = parsed as Record<string, unknown>
      }
    } catch {
      // Ignore silencieusement : la validation est faite au save-time via handleSave
    }
  }
  const ctk: Record<string, unknown> = { ...ctkExtraObj, enable_thinking: form.reasoning }
  defaults.chat_template_kwargs = ctk
  if (form.thinking_budget_low !== '') defaults.thinking_budget_low = Number(form.thinking_budget_low)
  if (form.thinking_budget_medium !== '') defaults.thinking_budget_medium = Number(form.thinking_budget_medium)
  if (form.thinking_budget_high !== '') defaults.thinking_budget_high = Number(form.thinking_budget_high)
  if (form.n_keep !== '') defaults.n_keep = Number(form.n_keep)
  defaults.cache_prompt = form.cache_prompt
  return {
    load,
    defaults,
    merge_consecutive_messages: form.mergeConsecutiveMessages,
  }
}

function TemplateEditor({
  modelId,
  existingTemplate,
  onClose,
}: {
  modelId: string
  existingTemplate: LlamacppTemplate | undefined
  onClose: () => void
}) {
  const [form, setForm] = useState<TemplateFormState>(() => templateToForm(existingTemplate))
  const setTemplateMutation = useSetLlamacppTemplateMutation()
  const deleteTemplateMutation = useDeleteLlamacppTemplateMutation()
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null)
  const clipboard = useTemplateClipboard<TemplateFormState>()

  const update = <K extends keyof TemplateFormState>(key: K, value: TemplateFormState[K]) => {
    setForm(f => ({ ...f, [key]: value }))
  }

  const handleCopy = () => {
    // Snapshot of current form (shallow clone — TemplateFormState is flat, primitives + bool)
    setTemplateClipboard({ sourceModelId: modelId, form: { ...form } })
    setStatus({ msg: `Template copié (depuis ${modelId})`, ok: true })
  }

  const handlePaste = () => {
    if (!clipboard) return
    if (clipboard.sourceModelId === modelId) {
      setStatus({ msg: 'Source et destination identiques, rien à coller', ok: false })
      return
    }
    setForm({ ...clipboard.form })
    setStatus({ msg: `Template collé depuis ${clipboard.sourceModelId} — vérifie puis Sauvegarder`, ok: true })
  }

  const handleSave = async () => {
    setStatus(null)
    // Validation client : le textarea JSON doit parser si non vide
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

  const kvTypeOptions = KV_TYPE_OPTIONS.map(o => ({ value: o, label: o || '— (défaut)' }))

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
        <TemplateSection title="Contexte & GPU" cols={4}>
          <NumberField label="ctx_size" tooltip="Taille du contexte en tokens (-c N). Détermine la fenêtre prompt+réponse. Plus grand = plus de VRAM pour le KV cache. Valeurs typiques : 4096, 16384, 32768, 131072." placeholder="32768" value={form.ctx_size} onChange={v => update('ctx_size', v)} disabled={busy} />
          <NumberField label="n_gpu_layers" tooltip="Couches offloadées sur GPU (-ngl N). 999 = tout sur GPU. 0 = CPU uniquement. Augmenter progressivement selon la VRAM disponible." placeholder="999" value={form.n_gpu_layers} onChange={v => update('n_gpu_layers', v)} disabled={busy} />
          <BooleanField id={`fa-${modelId}`} label="flash_attn" checked={form.flash_attn} onChange={v => update('flash_attn', v)} disabled={busy} tooltip="Flash Attention (-fa 1). Accélère le calcul d'attention sur GPU compatible. Fortement recommandé si le build le supporte." />
          <BooleanField id={`jinja-${modelId}`} label="jinja" checked={form.jinja} onChange={v => update('jinja', v)} disabled={busy} tooltip="--jinja : active le template Jinja bundled dans le GGUF (au lieu du template par défaut llama-server). Requis pour tool-use natif, thinking blocks, et formats de chat avancés (Qwen3, Gemma-thinking, GPT-OSS, etc). Désactivé par défaut." />
          <BooleanField id={`debug-${modelId}`} label={form.debug ? 'debug (verbose)' : 'debug'} checked={form.debug} onChange={v => update('debug', v)} disabled={busy} highlightWhen={form.debug} tooltip="--verbose --verbose-prompt : dump le prompt complet rendu après application du chat template Jinja dans les logs daemon llama-server. Utile pour diagnostiquer pourquoi un modèle (ex: Mistral) part en vrille en mode agentique vs fresh. À activer le temps du diag puis re-désactiver (verbose = logs lourds). Voir 'Logs daemon' pour lire la sortie." />
          <BooleanField id={`nm-${modelId}`} label="no_mmap" checked={form.no_mmap} onChange={v => update('no_mmap', v)} disabled={busy} tooltip="Désactiver le memory mapping (--no-mmap). Recommandé quand n_gpu_layers > 0 : charge les poids entièrement en RAM avant l'offload GPU, évite les page faults pendant l'inférence." />
          <BooleanField id={`cs-${modelId}`} label="ctx_shift" checked={form.ctx_shift} onChange={v => update('ctx_shift', v)} disabled={busy} tooltip="Fenêtre glissante de contexte (stocké dans le template). Note : --no-ctx-shift n'est pas supporté par toutes les versions de llama-server. Pour désactiver manuellement, passer --no-ctx-shift dans extra_args." />
          <BooleanField id={`ukv-${modelId}`} label="unified_kv_cache" checked={form.unified_kv_cache} onChange={v => update('unified_kv_cache', v)} disabled={busy} tooltip="Buffer KV unifié partagé entre toutes les séquences (--kv-unified). Peut améliorer l'utilisation mémoire quand parallel > 1. Sans effet si parallel = 1." />
          <NumberField label="parallel" tooltip="Nombre de slots parallèles (--parallel N). 1 = une seule conversation active, tout le KV cache disponible. Augmenter uniquement pour des contextes courts ou pour du batching." placeholder="1" min={1} max={8} value={form.parallel} onChange={v => update('parallel', v)} disabled={busy} />
          <BackendSelector value={form.backend} onChange={v => update('backend', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Performance CPU / batch" cols={4}>
          <NumberField label="n_threads" tooltip="Threads pour la génération token par token (-t N). Laisser vide = auto (détection CPU). Régler selon les cœurs physiques disponibles." placeholder="— (auto)" min={1} value={form.n_threads} onChange={v => update('n_threads', v)} disabled={busy} />
          <NumberField label="n_threads_batch" tooltip="Threads pour le traitement du prompt initial (-tb N). Laisser vide = auto. Peut être supérieur à n_threads pour accélérer l'ingestion du contexte." placeholder="— (auto)" min={1} value={form.n_threads_batch} onChange={v => update('n_threads_batch', v)} disabled={busy} />
          <NumberField label="n_batch" tooltip="Taille de batch logique pour le prompt (-b N, défaut 2048). Plus grand = traitement prompt plus rapide mais plus de VRAM. Puissance de 2 recommandée." placeholder="— (2048)" min={1} value={form.n_batch} onChange={v => update('n_batch', v)} disabled={busy} />
          <NumberField label="n_ubatch" tooltip="Taille de sous-batch physique (-ub N, défaut 512). Optimisation avancée du pipeline. Doit être ≤ n_batch. Puissance de 2." placeholder="— (512)" min={1} value={form.n_ubatch} onChange={v => update('n_ubatch', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="KV cache & RoPE" cols={4}>
          <SelectField label="type_k" tooltip="Quantization des clés du KV cache (--cache-type-k). f16 = précision maximale (défaut llama.cpp). q8_0 = bon compromis mémoire/qualité (−50% VRAM vs f16). q4_0 = compression maximale. turbo2/3/4 = TurboQuant WHT (~2/3/4 bits, fork native-turboquant uniquement) — REQUIERT -fa 1 + --kv-unified et head_dim % 128 == 0 (casse sur Gemma 4 head_dim 512 cache non-SWA)." value={form.type_k} onChange={v => update('type_k', v)} options={kvTypeOptions} disabled={busy} />
          <SelectField label="type_v" tooltip="Quantization des valeurs du KV cache (--cache-type-v). Mêmes options que type_k. Mixage utile : turbo3 K + turbo4 V garde V un poil plus précis (souvent plus sensible) tout en compressant K à fond. Sweet spot validé sur Qwen3.6-35B-A3B : turbo3/turbo3." value={form.type_v} onChange={v => update('type_v', v)} options={kvTypeOptions} disabled={busy} />
          <NumberField label="rope_freq_base" tooltip="Base de fréquence RoPE (--rope-freq-base). Laisser vide = valeur native du modèle. Augmenter pour étendre le contexte (ex : 500000 pour certains modèles Llama 3)." placeholder="— (modèle)" step="1000" min={0} value={form.rope_freq_base} onChange={v => update('rope_freq_base', v)} disabled={busy} />
          <NumberField label="rope_freq_scale" tooltip="Facteur d'échelle RoPE (--rope-freq-scale). Laisser vide = défaut. < 1 compresse les positions (étend le contexte), > 1 les dilate." placeholder="— (défaut)" step="0.01" min={0} value={form.rope_freq_scale} onChange={v => update('rope_freq_scale', v)} disabled={busy} />
          <BooleanField id={`swa-${modelId}`} label="swa_full" checked={form.swa_full} onChange={v => update('swa_full', v)} disabled={busy} tooltip="Cache KV pleine taille pour modèles SWA (--swa-full). Désactive le token pruning SWA : élimine les 'forced full reprocessing' sur les modèles hybrides (Qwen3, Nemotron). Contrepartie : VRAM plus élevée (le cache garde tous les tokens au lieu d'une fenêtre glissante)." />
          <BooleanField id={`kvdump-${modelId}`} label="kv_cache_auto_dump" checked={form.kv_cache_auto_dump} onChange={v => update('kv_cache_auto_dump', v)} disabled={busy} tooltip="Auto-save/restore du KV cache : sauvegarde automatiquement le contexte à l'unload, et le restaure au chargement suivant. Permet de reprendre une session sans reprocesser le prompt. Nécessite kv_cache_dir configuré dans le daemon." />
          <BooleanField id={`mergeconsec-${modelId}`} label="merge_consecutive_messages" checked={form.mergeConsecutiveMessages} onChange={v => update('mergeConsecutiveMessages', v)} disabled={busy} tooltip="Sanity check : fusionne deux messages adjacents de meme role (user+user, assistant+assistant) en concatenant le content avec \n\n. Aucune suppression. Necessaire pour les templates stricts (Mistral PEG-native) qui plantent sur l'alternance cassee — par exemple si un double-submit UI a inject deux user identiques." />
        </TemplateSection>

        <TemplateSection title="Memory / Cache host" cols={4}>
          <NumberField label="cache_ram (MiB)" tooltip="--cache-ram MiB : taille maximum du prompt cache host (PR #16391). Entrer 0 pour désactiver complètement (workaround bug Gemma-4 RAM bloat). Laisser vide = défaut llama.cpp (8192 MiB)." placeholder="— (8192)" min={0} value={form.cache_ram} onChange={v => update('cache_ram', v)} disabled={busy} />
          <NumberField label="ctx_checkpoints" tooltip="--ctx-checkpoints N : nombre max de snapshots SWA créés par slot pendant le PP. 1 = minimum effectif (workaround bug Gemma-4 RAM bloat où chaque checkpoint consomme ~1.2 GiB). Laisser vide = défaut llama.cpp (32, peut consommer 30+ GiB RAM)." placeholder="— (32)" min={0} max={32} value={form.ctx_checkpoints} onChange={v => update('ctx_checkpoints', v)} disabled={busy} />
          <BooleanField id={`mlock-${modelId}`} label="mlock" checked={form.mlock} onChange={v => update('mlock', v)} disabled={busy} tooltip="--mlock : force le kernel à garder le modèle en RAM (pas de page-out vers le swap). Utile quand RAM disponible >> taille modèle. Recommandé sur Strix Halo avec 128 GiB unifiée." />
          <BooleanField id={`cidle-${modelId}`} label="cache_idle_slots" checked={form.cache_idle_slots} onChange={v => update('cache_idle_slots', v)} disabled={busy} tooltip="Quand un slot devient idle, llama-server sérialise son KV sur disque (slot-save-path) pour restauration. Décocher = --no-cache-idle-slots. Redondant si kv_cache_auto_dump est activé côté Mercury." />
        </TemplateSection>

        <TemplateSection title="Speculative decoding (MTP / Draft)" cols={3}>
          <SelectField
            label="spec_type"
            tooltip="Type de spéculation. 'mtp' = mainline propre (PR #22673, mappé vers --spec-type draft-mtp). 'mtp-legacy' = fork atomic-llama-cpp-turboquant (deprecated, voué à disparaître ; --spec-type mtp brut). 'draft' = draft model classique (--spec-type draft-simple). 'ngram' = n-gram simple. Laisser vide = désactivé."
            value={form.spec_type}
            onChange={v => update('spec_type', v)}
            options={[
              { value: '', label: '— (désactivé)' },
              { value: 'mtp', label: 'mtp (mainline)' },
              { value: 'mtp-legacy', label: 'mtp-legacy (fork turboquant)' },
              { value: 'draft', label: 'draft' },
              { value: 'ngram', label: 'ngram' },
            ]}
            disabled={busy}
          />
          <NumberField
            label="spec_draft_n_max"
            tooltip="--spec-draft-n-max N : nombre max de tokens drafted par cycle de spéculation. Utilisé en MTP embedded (mainline native-mtp) ET draft classique. Sweet spot Qwen3 = 3, Gemma 4 = 4-7."
            placeholder="— (3)"
            min={1}
            max={16}
            value={form.spec_draft_n_max}
            onChange={v => update('spec_draft_n_max', v)}
            disabled={busy}
          />
          <NumberField
            label="draft_block_size"
            tooltip="--draft-block-size N : taille du block draft côté fork atomic-llama-cpp-turboquant. Ne pas confondre avec spec_draft_n_max (qui est le param mainline)."
            placeholder="— (3)"
            min={1}
            value={form.draft_block_size}
            onChange={v => update('draft_block_size', v)}
            disabled={busy}
          />
          <NumberField
            label="draft_n_gpu_layers"
            tooltip="-ngld N : couches du modèle draft offloadées sur GPU. 999 = tout le draft sur GPU (recommandé pour la latence)."
            placeholder="— (999)"
            min={0}
            value={form.draft_n_gpu_layers}
            onChange={v => update('draft_n_gpu_layers', v)}
            disabled={busy}
          />
          <NumberField
            label="draft_ctx_size"
            tooltip="-cd N : taille du contexte du modèle draft. Laisser vide pour utiliser la même valeur que ctx_size principal. Réduire pour économiser de la VRAM si le draft est très petit."
            placeholder="— (= ctx_size)"
            min={0}
            value={form.draft_ctx_size}
            onChange={v => update('draft_ctx_size', v)}
            disabled={busy}
          />
          <div /> {/* spacer pour aligner la grid */}
        </TemplateSection>

        <TemplateSection title="Speculative decoding — chemins & seuils" cols={1}>
          <TextField
            label="mtp_head (chemin GGUF du head MTP — fork atomic-llama-cpp-turboquant uniquement)"
            tooltip="--mtp-head <path> : chemin absolu vers le GGUF du head MTP entraîné. Utilisé sur le fork atomic-llama-cpp-turboquant (assistants par modèle, ex: gemma-4-31B-it-assistant.Q4_K_M.gguf). En mode MTP embedded (PR mainline), laisser vide — le head est dans le GGUF principal."
            placeholder="/opt/llama-native-turboquant/share/assistants/gemma-4-31B-it-assistant.Q4_K_M.gguf"
            value={form.mtp_head}
            onChange={v => update('mtp_head', v)}
            disabled={busy}
          />
          <TextField
            label="draft_model (chemin GGUF d'un draft classique — alternative à MTP)"
            tooltip="-md <path> : chemin absolu vers le GGUF d'un modèle draft (architecture compatible avec le target). Mode draft classique mainline llama.cpp, exclusif avec MTP. Sweet spot : draft ~10-20× plus petit que le target (ex: Qwen3-0.6B pour drafter Qwen3-30B)."
            placeholder="/path/to/draft-model.Q4_K_M.gguf"
            value={form.draft_model}
            onChange={v => update('draft_model', v)}
            disabled={busy}
          />
        </TemplateSection>

        <TemplateSection title="Speculative decoding — tuning fin draft classique" cols={3}>
          <NumberField
            label="draft_max"
            tooltip="--draft-max N : nombre max de tokens drafted par étape (draft classique uniquement, défaut 16)."
            placeholder="— (16)"
            min={0}
            max={64}
            value={form.draft_max}
            onChange={v => update('draft_max', v)}
            disabled={busy}
          />
          <NumberField
            label="draft_min"
            tooltip="--draft-min N : nombre min de tokens drafted avant verification (défaut 0). Augmenter si le draft est très fiable."
            placeholder="— (0)"
            min={0}
            value={form.draft_min}
            onChange={v => update('draft_min', v)}
            disabled={busy}
          />
          <NumberField
            label="draft_p_min"
            tooltip="--draft-p-min P : probabilité minimum d'acceptation d'un token drafted (0.0-1.0, défaut 0.75). Plus haut = plus strict, meilleure qualité mais moins d'accélération."
            placeholder="— (0.75)"
            step="0.05"
            min={0}
            max={1}
            value={form.draft_p_min}
            onChange={v => update('draft_p_min', v)}
            disabled={busy}
          />
        </TemplateSection>

        <TemplateSection title="Arguments bruts" cols={1}>
          <TextField label="extra_args" tooltip="Arguments CLI supplémentaires pour llama-server, séparés par des espaces (ex : --poll 100 --numa distribute). Ajoutés EN FIN de la liste d'arguments, après tous les paramètres du template." placeholder="--poll 100 --numa distribute" value={form.extra_args} onChange={v => update('extra_args', v)} disabled={busy} />
          <TextareaField label="env_vars (une ligne KEY=VAL, injectées au process serveur)" tooltip="Variables d'environnement injectées au process llama-server via brain-daemon (`env KEY=VAL ...`). Ex: GGML_VK_DISABLE_F16=1, LLAMA_LOG_PREFIX=1." placeholder={"GGML_VK_DISABLE_F16=1\nLLAMA_LOG_PREFIX=1"} value={form.env_vars} onChange={v => update('env_vars', v)} disabled={busy} rows={3} monospaced />
        </TemplateSection>
      </TemplateSectionGroup>

      <TemplateSectionGroup title="Valeurs par défaut (defaults — injectées si absentes de la requête)">
        <TemplateSection title="Sampling" cols={3}>
          <NumberField label="temperature" tooltip="Contrôle l'aléatoire. 0 = déterministe. 0.2–0.7 = stable et cohérent. 0.8–1.2 = créatif. > 1.5 = chaotique. Valeur par défaut llama-server : 0.8." placeholder="—" step="0.05" min="0" max="2" value={form.temperature} onChange={v => update('temperature', v)} disabled={busy} />
          <NumberField label="top_p" tooltip="Nucleus sampling : garde les tokens dont la somme des probabilités ≤ top_p. 0.9–0.95 = standard. Réduire pour des réponses plus focalisées." placeholder="—" step="0.05" min="0" max="1" value={form.top_p} onChange={v => update('top_p', v)} disabled={busy} />
          <NumberField label="top_k" tooltip="Limite le sampling aux k meilleurs tokens. 0 = désactivé. 40–50 = valeurs classiques. Réduire pour des réponses moins aléatoires." placeholder="—" min="0" value={form.top_k} onChange={v => update('top_k', v)} disabled={busy} />
          <NumberField label="min_p" tooltip="Minimum-p sampling : écarte les tokens dont la probabilité < min_p × (prob du token le plus probable). Alternative plus stable à top_p. Ex : 0.05." placeholder="—" step="0.01" min="0" max="1" value={form.min_p} onChange={v => update('min_p', v)} disabled={busy} />
          <NumberField label="typical_p" tooltip="Locally-typical sampling : sélectionne les tokens dont la surprise est proche de la moyenne. 1.0 = désactivé. Généralement exclusif à top_p." placeholder="—" step="0.05" min="0" max="1" value={form.typical_p} onChange={v => update('typical_p', v)} disabled={busy} />
          <NumberField label="tfs_z" tooltip="Tail-free sampling : élimine les tokens de la queue de distribution par dérivée seconde. 1.0 = désactivé. Valeurs utiles : 0.95–0.99." placeholder="—" step="0.01" min="0" max="1" value={form.tfs_z} onChange={v => update('tfs_z', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Pénalités" cols={3}>
          <NumberField label="repeat_penalty" tooltip="Pénalise les tokens récemment générés pour éviter les répétitions. 1.0 = désactivé. 1.1–1.3 = valeurs classiques. Trop élevé = texte chaotique." placeholder="—" step="0.05" min="0" value={form.repeat_penalty} onChange={v => update('repeat_penalty', v)} disabled={busy} />
          <NumberField label="frequency_penalty" tooltip="Réduit la probabilité des tokens proportionnellement à leur nombre d'apparitions dans la réponse en cours (standard OpenAI). 0 = désactivé. Plage : -2 à 2." placeholder="—" step="0.05" min="-2" max="2" value={form.frequency_penalty} onChange={v => update('frequency_penalty', v)} disabled={busy} />
          <NumberField label="presence_penalty" tooltip="Pénalise tout token déjà apparu au moins une fois, indépendamment de sa fréquence (standard OpenAI). Favorise la diversité thématique. 0 = désactivé. Plage : -2 à 2." placeholder="—" step="0.05" min="-2" max="2" value={form.presence_penalty} onChange={v => update('presence_penalty', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Mirostat" cols={3}>
          <NumberField label="mirostat_mode" tooltip="Activer Mirostat pour contrôler dynamiquement l'entropie. 0 = désactivé (défaut). 1 = Mirostat v1. 2 = Mirostat v2 (recommandé). Remplace top_p/top_k si activé." placeholder="— (0)" min="0" max="2" value={form.mirostat_mode} onChange={v => update('mirostat_mode', v)} disabled={busy} />
          <NumberField label="mirostat_tau" tooltip="Entropie cible Mirostat (mirostat_mode > 0). Plus haut = sortie plus surprenante/créative. Plus bas = plus prévisible. Valeur typique : 5.0." placeholder="— (5.0)" step="0.5" min="0" value={form.mirostat_tau} onChange={v => update('mirostat_tau', v)} disabled={busy} />
          <NumberField label="mirostat_eta" tooltip="Taux d'apprentissage de l'ajustement Mirostat. Contrôle la vitesse de convergence vers tau. Valeur typique : 0.1. Rarement besoin de modifier." placeholder="— (0.1)" step="0.01" min="0" value={form.mirostat_eta} onChange={v => update('mirostat_eta', v)} disabled={busy} />
        </TemplateSection>

        <TemplateSection title="Divers" cols={4}>
          <NumberField label="seed" tooltip="Graine aléatoire pour la génération. -1 = aléatoire à chaque requête. Même seed + même prompt + même modèle = résultat reproductible. Utile pour les tests." placeholder="— (-1)" min="-1" value={form.seed} onChange={v => update('seed', v)} disabled={busy} />
          <NumberField label="n_keep" tooltip="Tokens à préserver en tête du contexte lors du ctx_shift. -1 = tout garder (coûteux). 0 = rien. Ex : 512 pour préserver le system prompt. Ignoré si ctx_shift = false." placeholder="— (-1)" min="-1" value={form.n_keep} onChange={v => update('n_keep', v)} disabled={busy} />
          <NumberField label="thinking_budget_low" tooltip="Budget low (tokens) override per-model. Vide = config globale Mercury." placeholder="low" min="0" value={form.thinking_budget_low} onChange={v => update('thinking_budget_low', v)} disabled={busy} />
          <NumberField label="thinking_budget_medium" tooltip="Budget medium (tokens) override per-model. Vide = config globale." placeholder="med" min="0" value={form.thinking_budget_medium} onChange={v => update('thinking_budget_medium', v)} disabled={busy} />
          <NumberField label="thinking_budget_high" tooltip="Budget high (tokens) override per-model. -1 = illimité. Vide = config globale." placeholder="high" min="-1" value={form.thinking_budget_high} onChange={v => update('thinking_budget_high', v)} disabled={busy} />
          <BooleanField id={`rea-${modelId}`} label="reasoning (enable_thinking)" checked={form.reasoning} onChange={v => update('reasoning', v)} disabled={busy} tooltip="Active le mode thinking / reasoning du modèle via chat_template_kwargs.enable_thinking (Qwen3, Gemma-thinking, DeepSeek-R1, etc.). Décocher pour désactiver le bloc <think> au niveau du template Jinja. Si le thinking est baked-in dans les poids du modèle, utiliser plutôt un chat_template_file custom." />
          <BooleanField id={`cp-${modelId}`} label="cache prompt" checked={form.cache_prompt} onChange={v => update('cache_prompt', v)} disabled={busy} tooltip="Active la réutilisation du KV cache entre requêtes (cache_prompt). Quand activé, llama-server ne retraite que les nouveaux tokens au lieu du prompt entier. Désactiver uniquement pour débugger ou forcer un recalcul complet." />
        </TemplateSection>

        <TemplateSection title="Chat template" cols={1}>
          <TextareaField label="chat_template_kwargs (avancé, JSON)" tooltip={`Dict JSON libre passé au template Jinja via chat_template_kwargs. La clé enable_thinking est gérée par la checkbox reasoning au-dessus — ne la mettez pas ici. Exemples : { "reasoning_effort": "low" } pour les templates qui le supportent (GPT-OSS, Qwen3), ou toute autre kwarg spécifique au modèle.`} placeholder={"{\n  \"reasoning_effort\": \"low\"\n}"} value={form.chat_template_kwargs_extra} onChange={v => update('chat_template_kwargs_extra', v)} disabled={busy} monospaced spellCheck={false} />
          <TextField label="chat_template_file (override Jinja)" tooltip="Override complet du template Jinja bundled dans le GGUF via --chat-template-file. Chemin absolu, ou nom de fichier (résolu sous ~/mercury/chat-templates/). Use case : tools cassés sur Qwen3, thinking baked-in à bypass, formats custom. NÉCESSITE UN RELOAD DU MODÈLE pour prendre effet." placeholder="ex: gemma4-no-think.jinja  ou  /chemin/absolu/template.jinja" value={form.chat_template_file} onChange={v => update('chat_template_file', v)} disabled={busy} spellCheck={false} />
        </TemplateSection>
      </TemplateSectionGroup>
    </TemplateEditorShell>
  )
}

// ── Détection de phase depuis les logs de chargement ────────────────────────

function detectLoadPhase(line: string): string {
  if (line.includes('server is listening')) return 'Prêt'
  if (line.includes('model loaded')) return 'Modèle prêt'
  if (line.includes('warming up')) return 'Préchauffage…'
  // Progression du prefill — rétrocompat deux formats llama.cpp :
  //   ancien (<2026)   : "srv  update_slots: ... prompt processing progress, ... progress = 0.XX"
  //   nouveau (≥2026)  : "slot print_timing: ... | prompt processing, n_tokens = N, progress = 0.XX, t = ..."
  // Le `.*` greedy avale le mot "progress" de l'ancien format pour atteindre `progress = NUM`.
  // À tester AVANT le fallback "slot print_timing:" — sinon en ≥2026 chaque ligne de
  // progression serait étiquetée "Génération terminée".
  const progressMatch = line.match(/prompt processing.*progress\s*=\s*([\d.]+)/)
  if (progressMatch) {
    const pct = Math.round(parseFloat(progressMatch[1]) * 100)
    return `Traitement prompt ${pct}%`
  }
  // Fin — `prompt eval time` et `slot release:` communs aux deux ; `slot print_timing:`
  // sans progress reste un fallback safe (ancien : marqueur de fin ; nouveau : en-tête du bloc final).
  if (
    line.includes('slot      release:') ||
    line.includes('prompt eval time') ||
    line.includes('slot print_timing:')
  ) return 'Génération terminée'
  if (line.includes('load_tensors: offloaded')) return 'GPU chargé'
  if (line.includes('load_tensors: offloading')) return 'Chargement GPU…'
  if (line.includes('buffer size') && (line.includes('Vulkan') || line.includes('CUDA') || line.includes('Metal'))) return 'VRAM alloué'
  if (line.includes('llama_kv_cache:') || line.includes('llama_context:')) return 'Init contexte…'
  if (line.includes('load_tensors:')) return 'Chargement tenseurs…'
  if (line.includes('load_tensors: loading') || line.includes('print_info: model type')) return 'Lecture modèle…'
  return ''
}

// ── Panel de logs SSE pendant le chargement ──────────────────────────────────

function LoadingLogPanel({ modelId, onDismiss }: { modelId: string; onDismiss: () => void }) {
  const { lines, connected, error } = useLlamacppInstanceLogs(modelId, true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const VISIBLE = 20
  const visibleLines = lines.slice(-VISIBLE)
  const lastLine = lines[lines.length - 1] ?? ''
  const phase = detectLoadPhase(lastLine)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <div className="mx-3 mb-3 p-3 bg-black/40 border border-neutral-700 rounded-lg space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {connected
            ? <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
            : <span className="w-2 h-2 rounded-full bg-neutral-600" />}
          <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Chargement</span>
          {phase && <span className="text-[11px] text-yellow-300/80 font-mono">{phase}</span>}
        </div>
        <button type="button" onClick={onDismiss} className="text-neutral-600 hover:text-neutral-300 text-xs">✕</button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {lastLine && (
        <p className="text-[11px] text-neutral-500 font-mono truncate" title={lastLine}>{lastLine}</p>
      )}
      <div ref={scrollRef} className="max-h-40 overflow-y-auto font-mono text-[10px] text-neutral-500 space-y-0.5">
        {visibleLines.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all leading-relaxed ${line.toLowerCase().includes('error') ? 'text-red-400/80' : line.includes('VRAM') ? 'text-blue-400/80' : ''}`}>{line}</div>
        ))}
      </div>
    </div>
  )
}

// ── Stats temps réel d'une instance running ──────────────────────────────────

function RunningStats({ modelId, ctxSize, lastTiming, fallbackTokens }: {
  modelId: string
  ctxSize?: number
  lastTiming: LlamaTiming | null
  fallbackTokens?: number | null  // depuis last_metrics (probe) — persisté entre remounts
}) {
  const { data: slots } = useLlamacppSlots(modelId, true)
  const allSlots = slots ?? []
  // is_processing est un boolean dans le nouveau format llama-server
  const isProcessing = allSlots.some(s => s.is_processing)
  // Priorité : timing SSE temps réel → probe persistée → 0
  const tokensCached = lastTiming?.totalTokens ?? fallbackTokens ?? 0
  const nCtx = allSlots[0]?.n_ctx ?? ctxSize ?? 0
  const ctxPct = nCtx > 0 ? Math.min(100, Math.round((tokensCached / nCtx) * 100)) : 0

  return (
    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
      {isProcessing ? (
        <span className="flex items-center gap-1 text-[10px] font-bold text-yellow-400 uppercase tracking-wider">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />generating
        </span>
      ) : (
        <span className="text-[10px] text-neutral-600 uppercase tracking-wider font-medium">idle</span>
      )}
      {nCtx > 0 && (
        <div className="flex items-center gap-1.5">
          <div className="w-16 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${ctxPct > 80 ? 'bg-orange-500' : 'bg-blue-500/70'}`} style={{ width: `${ctxPct}%` }} />
          </div>
          <span className="text-[10px] text-neutral-500 font-mono tabular-nums">{tokensCached.toLocaleString()}/{nCtx.toLocaleString()}</span>
        </div>
      )}
      {lastTiming?.evalTokensPerSecond != null && (
        <span className="text-[10px] text-neutral-400 font-mono tabular-nums">{lastTiming.evalTokensPerSecond.toFixed(1)} tok/s</span>
      )}
    </div>
  )
}

function ModelRow({
  model,
  onMessage,
  priority,
  totalCount,
  onPriorityChange,
  category,
  categoryOptions,
  onCategoryChange,
  categoryPending,
  isHidden,
  onToggleHidden,
  probeTokens,
  memoryInfo,
}: {
  model: LlamacppModelEntry
  onMessage: (msg: string, type: 'info' | 'error') => void
  priority?: number
  totalCount: number
  onPriorityChange?: (newPriority: number) => void
  category?: string
  categoryOptions: string[]
  onCategoryChange?: (newCategory: string | null) => void
  categoryPending?: boolean
  isHidden?: boolean
  onToggleHidden?: () => void
  probeTokens?: number | null
  memoryInfo?: { vram_delta_mb?: number; ram_delta_mb?: number; ram_estimated_mb?: number; ram_rss_mb?: number; protected?: boolean; load_order?: number }
}) {
  const loadMutation = useLoadLlamacppModelMutation()
  const unloadMutation = useUnloadLlamacppModelMutation()
  const saveKvMutation = useSaveKvCacheMutation()
  const deleteKvMutation = useDeleteKvCacheMutation()
  const [showTemplate, setShowTemplate] = useState(false)
  const [showLoadingPanel, setShowLoadingPanel] = useState(false)
  const [lastTiming, setLastTiming] = useState<LlamaTiming | null>(null)
  const busy = loadMutation.isPending || unloadMutation.isPending || saveKvMutation.isPending || deleteKvMutation.isPending
  const protectMut = useBrainMemoryProtectMutation()
  const unprotectMut = useBrainMemoryUnprotectMutation()
  const pinPending = protectMut.isPending || unprotectMut.isPending

  const handleTogglePin = () => {
    if (model.protected) {
      unprotectMut.mutate(model.model_id)
    } else {
      protectMut.mutate(model.model_id)
    }
  }

  const hasConfiguredTemplate = Boolean(
    model.template &&
      ((model.template.load && Object.keys(model.template.load).length > 0) ||
        (model.template.defaults && Object.keys(model.template.defaults).length > 0))
  )

  // SSE actif pendant le chargement ET quand le modèle tourne (pour capturer les timings)
  const sseActive = (showLoadingPanel && loadMutation.isPending) || !!model.running
  const logState = useLlamacppInstanceLogs(model.model_id, sseActive)
  // Capturer le lastTiming depuis les logs SSE
  useEffect(() => {
    if (logState.lastTiming) setLastTiming(logState.lastTiming)
  }, [logState.lastTiming])

  const handleLoad = async () => {
    setShowLoadingPanel(true)  // Ouvrir AVANT le await pour démarrer la connexion SSE immédiatement
    try {
      const res = await loadMutation.mutateAsync(model.model_id)
      if (res.ok) {
        onMessage(`"${model.model_id}" chargé`, 'info')
        // Fermer le panel après 3s (laisser voir les dernières lignes)
        setTimeout(() => setShowLoadingPanel(false), 3000)
      } else {
        const b = res.body as Record<string, unknown> | undefined
        onMessage(String(b?.detail ?? b?.error ?? `Erreur ${res.status}`), 'error')
        // Garder le panel ouvert en cas d'erreur pour diagnostic
      }
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleUnload = async () => {
    try {
      const res = await unloadMutation.mutateAsync(model.model_id)
      if (res.ok) {
        onMessage(`"${model.model_id}" déchargé`, 'info')
      } else {
        const b = res.body as Record<string, unknown> | undefined
        onMessage(String(b?.detail ?? b?.error ?? `Erreur ${res.status}`), 'error')
      }
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleSaveKv = async () => {
    try {
      const res = await saveKvMutation.mutateAsync(model.model_id)
      if (res.ok) {
        onMessage(`KV cache sauvegardé pour "${model.model_id}"`, 'info')
      } else {
        const b = res.body as Record<string, unknown> | undefined
        onMessage(String(b?.detail ?? b?.error ?? `Erreur ${res.status}`), 'error')
      }
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleDeleteKv = async () => {
    try {
      const res = await deleteKvMutation.mutateAsync(model.model_id)
      if (res.ok) {
        onMessage(`KV cache supprimé pour "${model.model_id}"`, 'info')
      } else {
        const b = res.body as Record<string, unknown> | undefined
        onMessage(String(b?.detail ?? b?.error ?? `Erreur ${res.status}`), 'error')
      }
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  return (
    <li className={`flex flex-col rounded-lg border transition-colors ${model.running ? 'bg-green-950/20 border-green-800/60' : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'}`}>
      <div className="flex items-center gap-3 p-3">
        <div className="min-w-0 flex-1">
          <span className="font-medium text-neutral-200 text-sm block truncate" title={model.model_id}>
            {model.model_id}
          </span>
          {model.running && (
            <>
              <span className="text-[11px] text-green-400 font-mono">
                {model.ctx_size ? `ctx ${model.ctx_size.toLocaleString()} · ` : ''}port {model.port ?? '?'}
              </span>
              <RunningStats modelId={model.model_id} ctxSize={model.ctx_size} lastTiming={lastTiming} fallbackTokens={probeTokens} />
              {memoryInfo && (memoryInfo.vram_delta_mb != null || memoryInfo.ram_rss_mb != null) && (
                <span className="text-[10px] text-neutral-400 font-mono flex items-center gap-1.5 mt-0.5">
                  {memoryInfo.vram_delta_mb != null && <span title="VRAM delta">V {memoryInfo.vram_delta_mb >= 1024 ? `${(memoryInfo.vram_delta_mb / 1024).toFixed(1)}G` : `${memoryInfo.vram_delta_mb.toFixed(0)}M`}</span>}
                  {(() => { const r = memoryInfo.ram_delta_mb || memoryInfo.ram_estimated_mb || memoryInfo.ram_rss_mb; return r != null ? <span title="RAM">R {r >= 1024 ? `${(r / 1024).toFixed(1)}G` : `${r.toFixed(0)}M`}</span> : null })()}
                  {memoryInfo.protected && (
                    <span className="px-1 py-0 rounded text-[9px] font-bold uppercase bg-blue-600/20 text-blue-400 border border-blue-500/30">pin</span>
                  )}
                </span>
              )}
            </>
          )}
        </div>
        {model.size_gb != null && (
          <span className="shrink-0 text-xs text-neutral-500 tabular-nums">{formatGb(model.size_gb)}</span>
        )}
        {model.kv_cache_exists && (
          <span className="shrink-0 inline-flex items-center gap-1">
            <span className="text-[10px] text-teal-400 border border-teal-700/40 rounded px-1 py-0.5 bg-teal-950/30" title="Un KV cache sauvegardé existe pour ce modèle. Sera restauré automatiquement au prochain chargement si kv_cache_auto_dump est activé dans le template.">KV</span>
            <button
              type="button"
              className="text-[10px] text-red-400 hover:text-red-300 border border-red-700/40 hover:border-red-600/60 rounded px-1 py-0.5 bg-red-950/30 hover:bg-red-900/40 transition-colors disabled:opacity-50"
              disabled={busy}
              onClick={handleDeleteKv}
              title="Supprimer le fichier KV cache sauvegardé pour ce modèle"
            >
              {deleteKvMutation.isPending ? '…' : '✕'}
            </button>
          </span>
        )}
        {hasConfiguredTemplate && (
          <span
            className="shrink-0 text-[10px] text-amber-400 border border-amber-700/40 rounded px-1 py-0.5 bg-amber-950/30"
            title="Template de chargement configuré (load/defaults)."
          >
            TPL
          </span>
        )}
        <button
          type="button"
          className={`shrink-0 text-[10px] font-bold border rounded px-1.5 py-0.5 transition-colors cursor-pointer disabled:opacity-40
            ${model.protected
              ? 'text-blue-400 border-blue-500/40 bg-blue-950/40 hover:bg-blue-900/50'
              : 'text-neutral-500 border-neutral-700/40 bg-neutral-800/30 hover:bg-neutral-700/40 hover:text-neutral-300'
            }`}
          disabled={pinPending}
          onClick={handleTogglePin}
          title={model.protected ? 'Modele protege — cliquer pour depingler' : 'Epingler ce modele (protege de l\'eviction)'}
        >
          {model.protected ? 'PIN' : 'pin'}
        </button>
        {model.running ? (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-green-500/20 text-green-400 border border-green-500/30">running</span>
        ) : (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-neutral-700/40 text-neutral-500 border border-neutral-700/60">idle</span>
        )}
        <div className="shrink-0 flex items-center gap-2">
          {onPriorityChange && totalCount > 1 && (
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Priorité</span>
              <select
                className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-12"
                value={priority ?? 1}
                onChange={e => onPriorityChange(Number(e.target.value))}
                aria-label={`Priorité ${model.model_id}`}
              >
                {Array.from({ length: totalCount }, (_, i) => i + 1).map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          )}
          {onCategoryChange && (
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Tag</span>
              <select
                className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-36"
                value={category ?? ''}
                disabled={categoryPending}
                onChange={(e) => {
                  const val = e.target.value
                  const NEW_TAG_VALUE = '__new__'
                  if (val === NEW_TAG_VALUE) {
                    const next = window.prompt('Nom du tag (catégorie) :')
                    if (next == null) return
                    const trimmed = next.trim()
                    onCategoryChange(trimmed ? trimmed : null)
                  } else {
                    onCategoryChange(val ? val : null)
                  }
                }}
                aria-label={`Tag ${model.model_id}`}
              >
                <option value="">Sans tag</option>
                {categoryOptions.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
                <option value="__new__">+ Nouveau…</option>
              </select>
            </label>
          )}
          {model.running ? (
            <button
              type="button"
              className="w-20 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-medium rounded transition-colors disabled:opacity-50"
              disabled={busy}
              onClick={handleUnload}
            >
              Décharger
            </button>
          ) : (
            <button
              type="button"
              className="w-20 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
              disabled={busy}
              onClick={handleLoad}
            >
              Charger
            </button>
          )}
          {model.running && (
            <button
              type="button"
              className="px-2 py-1 bg-neutral-800 hover:bg-teal-900/50 text-neutral-400 hover:text-teal-300 border border-neutral-700 hover:border-teal-700 text-xs font-medium rounded transition-colors disabled:opacity-50"
              disabled={busy}
              onClick={handleSaveKv}
              title="Sauvegarder le KV cache maintenant (slot 0). Le fichier sera restauré automatiquement si kv_cache_auto_dump est activé dans le template."
            >
              {saveKvMutation.isPending ? '…' : 'Save KV'}
            </button>
          )}
          <button
            type="button"
            className={`px-2 py-1 border text-xs font-medium rounded transition-colors ${showTemplate ? 'bg-neutral-700 border-neutral-600 text-neutral-200' : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-400'}`}
            onClick={() => setShowTemplate(v => !v)}
            title="Éditer le template (ctx, GPU layers, defaults)"
          >
            Template
          </button>
          {onToggleHidden && (
            <button
              type="button"
              className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 border border-neutral-700 text-xs font-medium rounded transition-colors"
              onClick={onToggleHidden}
              title={isHidden ? 'Afficher ce modèle dans la liste et la priorité' : 'Masquer ce modèle (ne compte plus en priorité)'}
            >
              {isHidden ? 'Démasquer' : 'Masquer'}
            </button>
          )}
        </div>
      </div>
      {showLoadingPanel && (
        <LoadingLogPanel modelId={model.model_id} onDismiss={() => setShowLoadingPanel(false)} />
      )}
      {showTemplate && (
        <div className="px-3 pb-3">
          <TemplateEditor
            modelId={model.model_id}
            existingTemplate={model.template}
            onClose={() => setShowTemplate(false)}
          />
        </div>
      )}
    </li>
  )
}

function DaemonLogsPanel() {
  const { data, refetch } = useLlamacppDaemonLogs(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const logs = data?.logs ?? []

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  return (
    <div className="mt-2 p-3 bg-neutral-950 border border-neutral-700 rounded-lg space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Logs daemon ({logs.length})</span>
        <button type="button" onClick={() => refetch()} className="text-[11px] text-neutral-500 hover:text-neutral-300">↺ Rafraîchir</button>
      </div>
      {data?.error && <p className="text-xs text-red-400">{data.error}</p>}
      <div ref={scrollRef} className="max-h-64 overflow-y-auto font-mono text-[11px] text-neutral-300 space-y-0.5">
        {logs.length === 0 && <span className="text-neutral-600">Aucun log disponible</span>}
        {logs.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all leading-relaxed ${line.includes('[ERROR]') ? 'text-red-400' : line.includes('[WARNING]') ? 'text-yellow-400' : ''}`}>{line}</div>
        ))}
      </div>
    </div>
  )
}

export default function LlamaCppModelsCard() {
  const { data: modelsData, isLoading, refetch } = useLlamacppModels()
  const { data: probeData } = useLlamacppProbe(true)
  const { data: cacheModelsData, refetch: refetchCache } = useCacheModels()
  const setPriorityMutation = useSetModelPriorityMutation()
  const setHiddenMutation = useSetHiddenModelMutation()
  const setCategoryMutation = useSetModelCategoryMutation()
  const [message, setMessage] = useState<string | null>(null)
  const [messageType, setMessageType] = useState<'info' | 'error'>('info')
  const [showDaemonLogs, setShowDaemonLogs] = useState(false)
  const [showHiddenModels, setShowHiddenModels] = useState(false)

  const showMessage = useCallback((msg: string, type: 'info' | 'error' = 'info') => {
    setMessage(msg)
    setMessageType(type)
  }, [])

  // Exclure les HF dirs (vLLM → VllmModelsCard) et les GGUF configurés Lucebox
  // (→ LuceboxModelsCard). Le filtre Lucebox lit le template Mercury, pas le daemon —
  // un GGUF sans template apparaît ici par défaut. Le backend selector du form garde
  // l'option `native-lucebox` comme passerelle de conversion (le modèle migre alors
  // de card automatiquement au save).
  const models = (modelsData?.models ?? []).filter(
    m => m.kind !== 'hf' && m.template?.load?.backend !== 'native-lucebox',
  )
  const runningCount = models.filter(m => m.running).length

  // Build memory info map from probe instances
  const memoryInfoMap = new Map<string, { vram_delta_mb?: number; ram_delta_mb?: number; ram_estimated_mb?: number; ram_rss_mb?: number; protected?: boolean; load_order?: number }>()
  for (const inst of probeData?.instances ?? []) {
    if (inst.model_id) {
      memoryInfoMap.set(inst.model_id, {
        vram_delta_mb: inst.vram_delta_mb,
        ram_delta_mb: inst.ram_delta_mb,
        ram_estimated_mb: inst.ram_estimated_mb,
        ram_rss_mb: inst.ram_rss_mb,
        protected: inst.protected,
        load_order: inst.load_order,
      })
    }
  }

  // Index du cache par nom complet (llamacpp/model_id) pour récupérer la priorité
  const cacheByName = new Map((cacheModelsData?.models ?? [])
    .filter(e => e.backend === 'llamacpp')
    .map(e => [e.name, e]))
  const hiddenSet = new Set(cacheModelsData?.hidden_model_names ?? [])
  const hiddenCount = models.filter(m => hiddenSet.has(`llamacpp/${m.model_id ?? ''}`)).length

  const categoryOrder = cacheModelsData?.category_order ?? []
  const categoriesInBackend = new Set(
    (cacheModelsData?.models ?? [])
      .filter(e => e.backend === 'llamacpp' && typeof e.category === 'string' && e.category.trim())
      .map(e => e.category as string)
  )
  const categoryOptions = [
    ...categoryOrder,
    ...Array.from(categoriesInBackend).filter((c) => !categoryOrder.includes(c)).sort((a, b) => a.localeCompare(b)),
  ]

  const handleToggleHidden = async (modelId: string, hidden: boolean) => {
    try {
      await setHiddenMutation.mutateAsync({ modelName: `llamacpp/${modelId}`, hidden })
      refetchCache()
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const handleSetCategory = async (modelId: string, category: string | null) => {
    try {
      await setCategoryMutation.mutateAsync({ modelName: `llamacpp/${modelId}`, category })
      showMessage(category ? `Tag "${category}" enregistré` : 'Tag supprimé', 'info')
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const categoryRank = (category?: string) => {
    const c = (category ?? '').trim()
    if (!c) return { group: categoryOrder.length + 1, sub: '' }
    const idx = categoryOrder.indexOf(c)
    if (idx >= 0) return { group: idx, sub: '' }
    return { group: categoryOrder.length, sub: c }
  }

  // Tri principal : par tag (catégorie) ; puis priorité cache (running en tête à égalité de priorité)
  const sortedModels = [...models].sort((a, b) => {
    const aFull = `llamacpp/${a.model_id ?? ''}`
    const bFull = `llamacpp/${b.model_id ?? ''}`
    const ca = cacheByName.get(aFull)?.category ?? ''
    const cb = cacheByName.get(bFull)?.category ?? ''
    const ra = categoryRank(ca)
    const rb = categoryRank(cb)
    if (ra.group !== rb.group) return ra.group - rb.group
    if (ra.sub !== rb.sub) return ra.sub.localeCompare(rb.sub)

    const pa = cacheByName.get(aFull)?.priority ?? 99
    const pb = cacheByName.get(bFull)?.priority ?? 99
    if (pa !== pb) return pa - pb
    if (a.running && !b.running) return -1
    if (!a.running && b.running) return 1
    return (a.model_id ?? '').localeCompare(b.model_id ?? '')
  })

  const visibleModelCount = models.filter(x => !hiddenSet.has(`llamacpp/${x.model_id ?? ''}`)).length
  const filteredSortedModels = sortedModels.filter(m => showHiddenModels || !hiddenSet.has(`llamacpp/${m.model_id ?? ''}`))

  const modelsByTag: Record<string, LlamacppModelEntry[]> = {}
  for (const m of filteredSortedModels) {
    const fullName = `llamacpp/${m.model_id ?? ''}`
    const tag = cacheByName.get(fullName)?.category ?? ''
    if (!modelsByTag[tag]) modelsByTag[tag] = []
    modelsByTag[tag].push(m)
  }

  const tagKeys = Object.keys(modelsByTag)
  const tagOrderFromDb = categoryOrder.filter(t => t && tagKeys.includes(t))
  const unknownTags = tagKeys.filter(t => t && !categoryOrder.includes(t)).sort((a, b) => a.localeCompare(b))
  const groupOrder = [...tagOrderFromDb, ...unknownTags, ...(tagKeys.includes('') ? [''] : [])]

  const renderedList = groupOrder.flatMap((tag) => {
    const groupModels = modelsByTag[tag] ?? []
    if (groupModels.length === 0) return []

    const headerLabel = tag ? tag : 'Sans tag'
    const header = (
      <li key={`tag-${tag || 'none'}`} className="px-3 pt-3 pb-1 border-t border-neutral-800">
        <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">{headerLabel}</span>
      </li>
    )

    const rows = groupModels.map(m => {
      const fullName = `llamacpp/${m.model_id ?? ''}`
      const cacheEntry = cacheByName.get(fullName)
      const isHidden = hiddenSet.has(fullName)
      return (
        <ModelRow
          key={m.model_id}
          model={m}
          onMessage={showMessage}
          priority={cacheEntry?.priority}
          totalCount={visibleModelCount}
          onPriorityChange={!isHidden && visibleModelCount > 1 ? (p) => handlePriorityChange(m.model_id ?? '', p) : undefined}
          category={cacheEntry?.category}
          categoryOptions={categoryOptions}
          onCategoryChange={(cat) => handleSetCategory(m.model_id ?? '', cat)}
          categoryPending={setCategoryMutation.isPending}
          isHidden={isHidden}
          onToggleHidden={() => handleToggleHidden(m.model_id ?? '', !isHidden)}
          memoryInfo={m.running ? memoryInfoMap.get(m.model_id ?? '') : undefined}
          probeTokens={
            m.running
              ? (() => {
                  const bm = probeData?.by_model?.[m.model_id ?? '']
                  if (!bm) return null
                  return (bm.last_prompt_tokens ?? 0) + (bm.last_generation_tokens ?? 0)
                })()
              : null
          }
        />
      )
    })

    return [header, ...rows]
  })

  const handlePriorityChange = async (modelId: string, newPriority: number) => {
    if (setPriorityMutation.isPending) return
    // Récupère l'ordre actuel de tous les backends depuis le cache
    const allEntries = cacheModelsData?.models ?? []
    const byBackend: Record<string, string[]> = {}
    for (const e of allEntries) {
      if (!e.backend) continue
      if (!byBackend[e.backend]) byBackend[e.backend] = []
      byBackend[e.backend].push(e.name)
    }
    // Réordonne llamacpp
    const llamacppList = (byBackend.llamacpp ?? []).slice().sort((a, b) => {
      const ea = cacheByName.get(a), eb = cacheByName.get(b)
      return (ea?.priority ?? 99) - (eb?.priority ?? 99)
    })
    const fullName = `llamacpp/${modelId}`
    const without = llamacppList.filter(n => n !== fullName)
    without.splice(newPriority - 1, 0, fullName)
    byBackend.llamacpp = without
    await setPriorityMutation.mutateAsync(byBackend)
    refetchCache()
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col min-h-0">
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-6 py-4 border-b border-neutral-800">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white m-0">LlamaCPP</h2>
          {runningCount > 0 && (
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-500/20 text-green-400 border border-green-500/30">
              {runningCount} running
            </span>
          )}
          {probeData?.last_generation_tokens_per_second != null && (
            <span className="text-xs text-neutral-400 font-mono">
              {probeData.last_generation_tokens_per_second.toFixed(1)} tok/s
              {probeData.last_activity_ts != null && (
                <span className="text-neutral-600"> · {formatActivity(probeData.last_activity_ts)}</span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              onClick={() => setShowHiddenModels(v => !v)}
            >
              {showHiddenModels ? 'Masquer les masqués' : `Afficher les masqués (${hiddenCount})`}
            </button>
          )}
          <button
            type="button"
            className={`px-3 py-1.5 border text-sm font-medium rounded-md transition-colors ${showDaemonLogs ? 'bg-neutral-700 border-neutral-600 text-neutral-200' : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-400'}`}
            onClick={() => setShowDaemonLogs(v => !v)}
          >
            Logs daemon
          </button>
          <button
            type="button"
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-sm font-medium rounded-md transition-colors"
            onClick={() => { refetch(); refetchCache() }}
          >
            Rafraîchir
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-6 space-y-4">
        {showDaemonLogs && <DaemonLogsPanel />}
        {message && (
          <p className={`text-sm ${messageType === 'error' ? 'text-red-500' : 'text-neutral-400'}`}>{message}</p>
        )}

        {isLoading && <Spinner />}

        {modelsData?.error && (
          <p className="text-red-500 text-sm">{modelsData.error}</p>
        )}

        {!isLoading && models.length === 0 && !modelsData?.error && (
          <p className="text-neutral-500 text-sm">Aucun modèle GGUF disponible. Vérifiez que le daemon est démarré et que models_path est configuré.</p>
        )}

        {models.length > 0 && filteredSortedModels.length > 0 && (
          <ul className="flex flex-col gap-2">
            {renderedList}
          </ul>
        )}
      </div>
    </section>
  )
}
