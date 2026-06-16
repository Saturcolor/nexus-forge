import type { LlamacppTemplate } from '../../../../api/admin'

// Mirror of the V1 inline template form state. Duplicated here to keep V1
// untouched (toggle still works); future polishing of the form lives in V2 only.

export type TemplateFormState = {
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
  cache_ram: string
  ctx_checkpoints: string
  cache_idle_slots: boolean
  // Load — KV cache quantization
  type_k: string
  type_v: string
  // Load — RoPE
  rope_freq_base: string
  rope_freq_scale: string
  // Load — brut
  extra_args: string
  env_vars: string
  // Load — Speculative decoding (MTP / Draft)
  spec_type: string
  spec_draft_n_max: string
  mtp_head: string
  draft_block_size: string
  draft_model: string
  draft_n_gpu_layers: string
  draft_ctx_size: string
  draft_max: string
  draft_min: string
  draft_p_min: string
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
  reasoning: boolean
  thinking_budget_low: string
  thinking_budget_medium: string
  thinking_budget_high: string
  chat_template_kwargs_extra: string
  n_keep: string
  cache_prompt: boolean
  kv_cache_auto_dump: boolean
  backend: string
  chat_template_file: string
  mergeConsecutiveMessages: boolean
}

export const DEFAULT_FORM: TemplateFormState = {
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
  n_batch: '', n_ubatch: '', n_threads: '', n_threads_batch: '',
  mlock: true,
  cache_ram: '0', ctx_checkpoints: '1', cache_idle_slots: false,
  type_k: '', type_v: '',
  rope_freq_base: '', rope_freq_scale: '',
  extra_args: '', env_vars: '',
  spec_type: '', spec_draft_n_max: '', mtp_head: '', draft_block_size: '',
  draft_model: '', draft_n_gpu_layers: '', draft_ctx_size: '',
  draft_max: '', draft_min: '', draft_p_min: '',
  temperature: '', top_p: '', top_k: '', min_p: '', typical_p: '', tfs_z: '',
  repeat_penalty: '', frequency_penalty: '', presence_penalty: '',
  mirostat_mode: '', mirostat_tau: '', mirostat_eta: '',
  seed: '', reasoning: false,
  thinking_budget_low: '', thinking_budget_medium: '', thinking_budget_high: '',
  chat_template_kwargs_extra: '',
  n_keep: '', cache_prompt: true, kv_cache_auto_dump: false,
  backend: 'native-vulkan',
  chat_template_file: '',
  mergeConsecutiveMessages: false,
}

/** KV cache types — turbo2/3/4 require backend `native-turboquant`. */
export const KV_TYPE_OPTIONS = [
  '', 'f32', 'f16', 'bf16',
  'q8_0', 'q5_1', 'q5_0', 'iq4_nl', 'q4_1', 'q4_0',
  'turbo2', 'turbo3', 'turbo4',
]

export function templateToForm(tpl: LlamacppTemplate | undefined): TemplateFormState {
  if (!tpl) return { ...DEFAULT_FORM }
  const load = tpl.load ?? {}
  const defaults = tpl.defaults ?? {}
  const ctk = (defaults.chat_template_kwargs ?? {}) as Record<string, unknown>
  const reasoningFromCtk = ctk.enable_thinking
  const reasoningValue = typeof reasoningFromCtk === 'boolean'
    ? reasoningFromCtk
    : defaults.reasoning === true
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
    backend: typeof load.backend === 'string' && load.backend ? load.backend : 'native-vulkan',
    chat_template_file: load.chat_template_file ?? '',
    mergeConsecutiveMessages: tpl.merge_consecutive_messages === true,
  }
}

export function formToTemplate(form: TemplateFormState): LlamacppTemplate {
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
  let ctkExtraObj: Record<string, unknown> = {}
  if (form.chat_template_kwargs_extra.trim()) {
    try {
      const parsed = JSON.parse(form.chat_template_kwargs_extra)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        ctkExtraObj = parsed as Record<string, unknown>
      }
    } catch { /* validation handled at save time */ }
  }
  defaults.chat_template_kwargs = { ...ctkExtraObj, enable_thinking: form.reasoning }
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
