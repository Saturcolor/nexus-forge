import type {
  BackendStatus,
  BenchmarkPreset,
  BenchmarkResult,
  CachedModelEntry,
  Config,
  LogEntry,
  ModelMappingEntry,
  ModelSchedule,
  ModelsCacheState,
  QueueStats,
  StatsEntry,
  UserEntry,
  ModelMetadata,
  ConvTemplate,
  HfDownloadJob,
  ScheduleRun,
  LlamacppModelEntry,
  LlamacppTemplate,
  OpenRouterModelEntry,
  AtlasPreset,
} from '../api/admin'

export type MockUserRow = { entry: UserEntry; apiKey: string }

export type MockServerSeed = {
  config: Config
  backends: BackendStatus[]
  users: MockUserRow[]
  schedules: ModelSchedule[]
  /** Slot actif logique ; ends_at recalculé à chaque GET /admin/schedules */
  activeSlotScheduleId: string | null
  scheduleHistory: ScheduleRun[]
  hiddenModels: string[]
  protectedModels: string[]
  categoryOrder: string[]
  providerPriority: string[]
  modelPriority: Record<string, string[]>
  modelMappingFromConfig: ModelMappingEntry[]
  cacheModels: CachedModelEntry[]
  cacheState: ModelsCacheState
  dates: string[]
  logsByDate: Record<string, LogEntry[]>
  statsByDate: Record<string, StatsEntry>
  queue: QueueStats
  debug: boolean
  cloudFallbackOrder: string[]
  benchmarkPresets: BenchmarkPreset[]
  benchmarkResults: BenchmarkResult[]
  benchmarkModels: Record<string, ModelMetadata>
  convTemplates: Record<string, ConvTemplate>
  openRouterModels: OpenRouterModelEntry[]
  ollamaModelNames: string[]
  ollamaRunning: string[]
  llamacppModels: LlamacppModelEntry[]
  llamacppTemplates: Record<string, LlamacppTemplate>
  /** Presets AtlasMind par model_id (mock pour le selecteur dans ModelRow). */
  atlasPresetsByModel: Record<string, AtlasPreset[]>
  hfJobs: HfDownloadJob[]
  hfTokenConfigured: boolean
  hfTokenMasked: string | null
  extBenchToolcall: ExtBenchServiceState
  extBenchBugfind: ExtBenchServiceState
}

export type ExtBenchServiceState = {
  service_online: boolean
  env_exists: boolean
  configured_models: string[]
  default_port: number
  managed_pid: number | null
  sandbox_online?: boolean
}

function iso(d: Date): string {
  return d.toISOString()
}

export function createSeed(): MockServerSeed {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)

  const config: Config = {
    server_host: '127.0.0.1',
    server_port: 17890,
    queue_max_size: 64,
    queue_timeout_seconds: 120,
    debug: false,
    ollama_url: 'http://127.0.0.1:11434',
    ollama_enabled: true,
    lm_studio_url: 'http://127.0.0.1:1234',
    lm_studio_enabled: true,
    llamacpp_url: 'http://127.0.0.1:17891',
    llamacpp_enabled: true,
    require_api_key: false,
    provider_priority: ['llamacpp', 'ollama', 'lm_studio', 'openrouter'],
    anonymous_priority: 99,
    priority_threshold_enabled: true,
    priority_threshold_seconds: 30,
    models_cache_ttl_seconds: 300,
    admin_token_set: true,
    openrouter_enabled: true,
    openrouter_api_key_set: true,
    openrouter_fallback_model: 'anthropic/claude-3.5-sonnet',
    anthropic_enabled: false,
    anthropic_credentials_set: false,
    anthropic_fallback_model: 'claude-3-5-haiku-20241022',
    audio_openai_api_key_set: true,
    audio_groq_api_key_set: false,
    audio_elevenlabs_api_key_set: false,
    audio_local_enabled: true,
    realtime_enabled: false,
    atlas_enabled: true,
    atlas_brain_url: 'http://127.0.0.1:4321',
    atlas_atlasmind_url: 'http://127.0.0.1:9300',
    atlas_timeout_sec: 1800,
    credits: { enabled: true, openrouter_key_set: true },
    hidden_models: [],
    fallback_providers_order: ['anthropic', 'openrouter'],
    toolcall15_enabled: true,
    bugfind15_enabled: true,
    toolcall15_url: 'http://localhost:3015',
    bugfind15_url: 'http://localhost:3016',
    local_embedding_models: [
      { id: 'nomic', model: 'nomic-embed-text', dim: 768, priority: 1 },
    ],
  }

  const users: MockUserRow[] = [
    { entry: { user_id: 'alice', priority: 1, threshold: true, key_prefix: 'sk-mock-al' }, apiKey: 'sk-mock-alice-full-key' },
    { entry: { user_id: 'bob', priority: 50, threshold: false, key_prefix: 'sk-mock-bo' }, apiKey: 'sk-mock-bob-full-key' },
    { entry: { user_id: 'anon', priority: 99, threshold: false, key_prefix: 'sk-mock-an' }, apiKey: 'sk-mock-anon-full-key' },
  ]

  const deepworkId = 'sched-deepwork'
  const schedules: ModelSchedule[] = [
    {
      id: deepworkId,
      name: 'deepwork',
      cron_start: '0 9 * * 1-5',
      duration_minutes: 480,
      exclusive: true,
      allowed_consumers: ['alice'],
      actions_start: [{ type: 'snapshot_state' }],
      actions_end: [{ type: 'restore_state' }],
      guard: { wait_idle: true, max_wait_seconds: 120 },
      enabled: true,
      timezone: 'Europe/Paris',
      next_start_at: iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 9, 0)),
      created_at: iso(new Date(Date.now() - 86400e6 * 7)),
    },
    {
      id: 'sched-night',
      name: 'night-ollama',
      cron_start: '0 2 * * *',
      duration_minutes: 360,
      exclusive: false,
      allowed_consumers: ['alice', 'bob'],
      actions_start: [{ type: 'load', backend: 'ollama', model: 'llama3.2:3b' }],
      actions_end: [{ type: 'unload', backend: 'ollama', model: 'llama3.2:3b' }],
      guard: { wait_idle: false, max_wait_seconds: 60 },
      enabled: true,
      timezone: 'UTC',
      next_start_at: null,
      created_at: iso(new Date(Date.now() - 86400e6 * 3)),
    },
  ]

  const cacheModels: CachedModelEntry[] = [
    // Other backends (kept for the rest of the dashboard mocks)
    { name: 'llama3.2:3b',                              backend: 'ollama',     priority: 1,  category: 'general',  loaded: true },
    { name: 'qwen2.5:7b',                               backend: 'ollama',     priority: 2,  category: 'general' },
    { name: 'mistral-7b-v0.3',                          backend: 'lm_studio',  priority: 3,  category: 'general' },
    { name: 'meta-llama/Llama-3.2-3B-Instruct',         backend: 'vllm',       priority: 5,  category: 'general' },
    { name: 'openai/gpt-4o-mini',                       backend: 'openrouter', priority: 10, category: 'cloud' },
    { name: 'anthropic/claude-3-5-haiku',               backend: 'openrouter', priority: 11, category: 'cloud' },
    { name: 'nomic-embed-text',                         backend: 'ollama',     priority: 20, category: 'embedding' },
    { name: 'text-embedding-3-small',                   backend: 'openrouter', priority: 21, category: 'embedding' },
    { name: 'mlx-community/Llama-3.2-3B-Instruct-4bit', backend: 'mlx',        priority: 30, category: 'general' },

    // llamacpp models — keyed with the `llamacpp/<id>` prefix that the prod
    // backend uses (mirrors V1 convention, see LlamaCppModelsCard handleSet*).
    { name: 'llamacpp/unsloth/Qwen2.5-Coder-32B-Instruct-GGUF',         backend: 'llamacpp', priority: 1, category: 'coding',     template_configured: true,  loaded: true },
    { name: 'llamacpp/unsloth/Qwen2.5-Coder-7B-Instruct-GGUF',          backend: 'llamacpp', priority: 2, category: 'coding',     template_configured: true },
    { name: 'llamacpp/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF',  backend: 'llamacpp', priority: 3, category: 'coding' },
    { name: 'llamacpp/unsloth/Mistral-Small-Instruct-2409-GGUF',        backend: 'llamacpp', priority: 1, category: 'general',    template_configured: true,  loaded: true },
    { name: 'llamacpp/unsloth/gemma-2-27b-it-GGUF',                     backend: 'llamacpp', priority: 2, category: 'general',    template_configured: true },
    { name: 'llamacpp/unsloth/Meta-Llama-3.1-8B-Instruct-GGUF',         backend: 'llamacpp', priority: 3, category: 'general' },
    { name: 'llamacpp/bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF',     backend: 'llamacpp', priority: 1, category: 'reasoning',  template_configured: true },
    { name: 'llamacpp/unsloth/Qwen3-32B-GGUF',                          backend: 'llamacpp', priority: 2, category: 'reasoning',  template_configured: true },
    { name: 'llamacpp/unsloth/Qwen2-VL-7B-Instruct-GGUF',               backend: 'llamacpp', priority: 1, category: 'vision' },
    { name: 'llamacpp/bartowski/Llama-3.2-11B-Vision-Instruct-GGUF',    backend: 'llamacpp', priority: 2, category: 'vision' },
    { name: 'llamacpp/nomic-ai/nomic-embed-text-v1.5-GGUF',             backend: 'llamacpp', priority: 1, category: 'embedding' },
    { name: 'llamacpp/Snowflake/snowflake-arctic-embed-l-v2.0-GGUF',    backend: 'llamacpp', priority: 2, category: 'embedding' },
    { name: 'llamacpp/unsloth/Llama-3.2-3B-Instruct-GGUF',              backend: 'llamacpp', priority: 1, category: 'utility' },
    { name: 'llamacpp/unsloth/Llama-3.2-1B-Instruct-GGUF',              backend: 'llamacpp', priority: 2, category: 'utility' },
    { name: 'llamacpp/unsloth/Phi-3.5-mini-instruct-GGUF',              backend: 'llamacpp', priority: 3, category: 'utility' },
  ]

  const modelMappingFromConfig: ModelMappingEntry[] = [
    { canonical: 'fast', backend: 'llamacpp', backend_model_id: 'Qwen/Qwen2.5-7B-Instruct-GGUF' },
    { canonical: 'chat', backend: 'ollama', backend_model_id: 'llama3.2:3b' },
  ]

  const logs: LogEntry[] = [
    {
      request_id: 'req-001',
      user_id: 'alice',
      model: 'llama3.2:3b',
      backend: 'ollama',
      status: 'ok',
      duration_ms: 842,
      timestamp: iso(new Date(Date.now() - 120_000)),
      date: dateStr,
      usage: { input_tokens: 120, output_tokens: 45, ttft_seconds: 0.08, tokens_per_second: 52 },
    },
    {
      request_id: 'req-002',
      user_id: 'bob',
      model: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
      backend: 'llamacpp',
      status: 'ok',
      duration_ms: 2100,
      timestamp: iso(new Date(Date.now() - 300_000)),
      date: dateStr,
    },
  ]

  const stats: StatsEntry = {
    date: dateStr,
    by_user: {
      alice: { requests: 12, total_duration_ms: 12000, total_input_tokens: 4000, total_output_tokens: 800, requests_with_usage: 10 },
      bob: { requests: 3, total_duration_ms: 4500, requests_with_usage: 2 },
    },
    total_requests: 15,
    total_duration_ms: 16500,
    total_input_tokens: 5000,
    total_output_tokens: 900,
    requests_with_usage: 12,
  }

  const benchmarkPresets: BenchmarkPreset[] = [
    {
      id: 'pp_smoke',
      name: 'PP smoke',
      category: 'pp',
      description: 'Court test prompt processing',
      messages: [{ role: 'user', content: 'Count to three.' }],
      expected_gen_tokens: 32,
    },
  ]

  const benchmarkResults: BenchmarkResult[] = [
    {
      id: 'br-1',
      timestamp: iso(new Date(Date.now() - 3600_000)),
      model_id: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
      preset_id: 'pp_smoke',
      preset_category: 'pp',
      response_preview: '1, 2, 3.',
      pp_tok_s: 1200,
      gen_tok_s: 85,
      wall_ms: 450,
      auto_score: 9.2,
      manual_rating: null,
    },
  ]

  const benchmarkModels: Record<string, ModelMetadata> = {
    'Qwen/Qwen2.5-7B-Instruct-GGUF': {
      display_name: 'Qwen2.5 7B',
      architecture: 'dense',
      params_b: 7,
      quant: 'Q4_K_M',
      notes: 'Mock',
    },
  }

  const convTemplates: Record<string, ConvTemplate> = {
    default: {
      name: 'default',
      system_prompt: 'You are a helpful assistant.',
      questions: ['Hello', 'Explain Mercury in one sentence.'],
    },
  }

  // 15 mock llamacpp models — realistic spread across tags / sizes / states
  // so the dashboard list rendering reflects production density.
  const llamacppModels: LlamacppModelEntry[] = [
    // — coding —
    {
      model_id: 'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF',
      path: '/models/Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf',
      size_gb: 19.8, running: true, ctx_size: 16384, port: 8081, pid: 4242,
      kind: 'gguf', kv_cache_exists: true,
    },
    {
      model_id: 'unsloth/Qwen2.5-Coder-7B-Instruct-GGUF',
      path: '/models/Qwen2.5-Coder-7B-Instruct-Q5_K_M.gguf',
      size_gb: 5.4, running: false, kind: 'gguf', kv_cache_exists: false,
    },
    {
      model_id: 'bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF',
      path: '/models/DeepSeek-Coder-V2-Lite-Q4_K_M.gguf',
      size_gb: 10.4, running: false, kind: 'gguf',
    },
    // — reasoning / général —
    {
      model_id: 'unsloth/Mistral-Small-Instruct-2409-GGUF',
      path: '/models/Mistral-Small-Instruct-2409-Q4_K_M.gguf',
      size_gb: 13.3, running: true, ctx_size: 32768, port: 8082, pid: 4243,
      kind: 'gguf', kv_cache_exists: true,
      // Stack multi-LoRA (mock) — démontre l'affichage indexé "0·nom 1·nom".
      // L'ordre = id côté llama-server. Les paths matchent les presets LoRA
      // ci-dessous (id 6/7) pour résoudre le label depuis leur nom.
      active_preset_id: 6,
      active_preset_ids: [6, 7],
      active_preset_name: 'demo lora + demo mastermind',
      loras: [
        { path: '/mock/lora/demo-lora.gguf', default_scale: 1.0 },
        { path: '/mock/lora/demo-mastermind.gguf', default_scale: 1.5 },
      ],
    },
    {
      model_id: 'unsloth/gemma-2-27b-it-GGUF',
      path: '/models/gemma-2-27b-it-Q4_K_M.gguf',
      size_gb: 16.7, running: false, kind: 'gguf', kv_cache_exists: true,
    },
    {
      model_id: 'unsloth/Meta-Llama-3.1-8B-Instruct-GGUF',
      path: '/models/Meta-Llama-3.1-8B-Instruct-Q5_K_M.gguf',
      size_gb: 5.7, running: false, kind: 'gguf',
    },
    {
      model_id: 'bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF',
      path: '/models/DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf',
      size_gb: 19.9, running: false, kind: 'gguf',
    },
    {
      model_id: 'unsloth/Qwen3-32B-GGUF',
      path: '/models/Qwen3-32B-Q4_K_M.gguf',
      size_gb: 19.5, running: false, kind: 'gguf',
    },
    // — vision / multimodal —
    {
      model_id: 'unsloth/Qwen2-VL-7B-Instruct-GGUF',
      path: '/models/Qwen2-VL-7B-Instruct-Q5_K_M.gguf',
      size_gb: 5.8, running: false, kind: 'gguf',
    },
    {
      model_id: 'bartowski/Llama-3.2-11B-Vision-Instruct-GGUF',
      path: '/models/Llama-3.2-11B-Vision-Q4_K_M.gguf',
      size_gb: 7.4, running: false, kind: 'gguf',
    },
    // — embeddings —
    {
      model_id: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
      path: '/models/nomic-embed-text-v1.5-Q8_0.gguf',
      size_gb: 0.4, running: false, kind: 'gguf',
    },
    {
      model_id: 'Snowflake/snowflake-arctic-embed-l-v2.0-GGUF',
      path: '/models/snowflake-arctic-embed-l-v2.0-Q8_0.gguf',
      size_gb: 0.6, running: false, kind: 'gguf',
    },
    // — petits / utilitaires —
    {
      model_id: 'unsloth/Llama-3.2-3B-Instruct-GGUF',
      path: '/models/Llama-3.2-3B-Instruct-Q5_K_M.gguf',
      size_gb: 2.3, running: false, kind: 'gguf',
    },
    {
      model_id: 'unsloth/Llama-3.2-1B-Instruct-GGUF',
      path: '/models/Llama-3.2-1B-Instruct-Q5_K_M.gguf',
      size_gb: 0.8, running: false, kind: 'gguf',
    },
    {
      model_id: 'unsloth/Phi-3.5-mini-instruct-GGUF',
      path: '/models/Phi-3.5-mini-instruct-Q5_K_M.gguf',
      size_gb: 2.7, running: false, kind: 'gguf',
    },
  ]

  // Templates configurés sur quelques modèles (badge TPL) — exercer aussi l'éditeur
  // avec des valeurs non-default sur des modèles courants.
  const llamacppTemplates: Record<string, LlamacppTemplate> = {
    'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF': {
      load: { ctx_size: 16384, n_gpu_layers: 999, flash_attn: true, no_mmap: true, parallel: 1, backend: 'native-vulkan' },
      defaults: { temperature: 0.2, top_p: 0.95, cache_prompt: true, chat_template_kwargs: { enable_thinking: false } },
    },
    'unsloth/Qwen2.5-Coder-7B-Instruct-GGUF': {
      load: { ctx_size: 32768, n_gpu_layers: 999, flash_attn: true, parallel: 1, backend: 'native-vulkan' },
      defaults: { temperature: 0.3, cache_prompt: true },
    },
    'unsloth/Mistral-Small-Instruct-2409-GGUF': {
      load: { ctx_size: 32768, n_gpu_layers: 999, flash_attn: true, no_mmap: true, mlock: true, parallel: 1, backend: 'native-vulkan' },
      defaults: { temperature: 0.6, top_p: 0.9, cache_prompt: true },
      merge_consecutive_messages: true,
    },
    'unsloth/gemma-2-27b-it-GGUF': {
      load: { ctx_size: 8192, n_gpu_layers: 999, flash_attn: true, ctx_checkpoints: 1, cache_ram: 0, parallel: 1, backend: 'native-vulkan' },
      defaults: { temperature: 0.7, cache_prompt: true },
    },
    'bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF': {
      load: { ctx_size: 16384, n_gpu_layers: 999, flash_attn: true, parallel: 1, backend: 'native-mtp', spec_type: 'mtp', spec_draft_n_max: 3 },
      defaults: { temperature: 0.6, top_p: 0.95, chat_template_kwargs: { enable_thinking: true }, thinking_budget_high: 8192 },
    },
    'unsloth/Qwen3-32B-GGUF': {
      load: { ctx_size: 32768, n_gpu_layers: 999, flash_attn: true, swa_full: true, type_k: 'turbo3', type_v: 'turbo3', unified_kv_cache: true, parallel: 1, backend: 'native-turboquant' },
      defaults: { temperature: 0.7, chat_template_kwargs: { enable_thinking: true } },
    },
  }

  const openRouterModels: OpenRouterModelEntry[] = [
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
    { id: 'anthropic/claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
  ]

  const hfJobs: HfDownloadJob[] = []

  const backends: BackendStatus[] = [
    { name: 'ollama', url: config.ollama_url ?? '', status: 'ok', priority: 2 },
    { name: 'lm_studio', url: config.lm_studio_url ?? '', status: 'ok', priority: 3 },
    { name: 'llamacpp', url: config.llamacpp_url ?? '', status: 'ok', priority: 1 },
    { name: 'openrouter', url: 'https://openrouter.ai/api/v1', status: 'ok', priority: 10 },
    { name: 'anthropic',  url: 'https://api.anthropic.com',     status: 'ok', priority: 11 },
  ]

  return {
    config,
    backends,
    users,
    schedules,
    activeSlotScheduleId: null,
    scheduleHistory: [],
    // 2 modèles "masqués" pour exercer le toggle "afficher masqués" (clés prefixées comme en prod)
    hiddenModels: [
      'llamacpp/unsloth/Llama-3.2-1B-Instruct-GGUF',
      'llamacpp/bartowski/Llama-3.2-11B-Vision-Instruct-GGUF',
    ],
    // 1 modèle chargé pré-épinglé (protégé de l'unload scheduler) pour exercer l'état 🔒
    protectedModels: [
      'llamacpp/unsloth/Mistral-Small-Instruct-2409-GGUF',
    ],
    categoryOrder: ['coding', 'general', 'reasoning', 'vision', 'embedding', 'utility', 'cloud'],
    providerPriority: ['llamacpp', 'ollama', 'lm_studio', 'openrouter'],
    modelPriority: {
      llamacpp: ['Qwen/Qwen2.5-7B-Instruct-GGUF', 'meta-llama/Llama-3.2-3B-Instruct-GGUF'],
      ollama: ['llama3.2:3b', 'qwen2.5:7b'],
      lm_studio: ['mistral-7b-v0.3'],
      openrouter: ['openai/gpt-4o-mini'],
    },
    modelMappingFromConfig,
    cacheModels,
    cacheState: { count: cacheModels.length, updated_at: iso(new Date()) },
    dates: [dateStr],
    logsByDate: { [dateStr]: logs },
    statsByDate: { [dateStr]: stats },
    queue: {
      size: 0,
      in_progress: 0,
      processed: 142,
      cloud_in_progress: 0,
      cloud_processed: 12,
    },
    debug: false,
    cloudFallbackOrder: ['anthropic', 'openrouter'],
    benchmarkPresets,
    benchmarkResults,
    benchmarkModels,
    convTemplates,
    openRouterModels,
    ollamaModelNames: ['llama3.2:3b', 'qwen2.5:7b', 'nomic-embed-text'],
    ollamaRunning: ['llama3.2:3b'],
    llamacppModels,
    llamacppTemplates,
    // Mock presets AtlasMind par model_id — 3 presets sur le Mistral running
    // (id 2 = actif via active_preset_id), 2 sur le Qwen Coder.
    atlasPresetsByModel: {
      'unsloth/Mistral-Small-Instruct-2409-GGUF': [
        {
          id: 1, name: 'concise_reasoning',
          description: 'Raccourcit le chain-of-thought, garde la précision',
          model: 'unsloth/Mistral-Small-Instruct-2409-GGUF',
          control_vectors: [{ path: '/mock/cv/concise.gguf', scale: 2.0 }],
          layer_range: [20, 25], exportable: true,
        },
        {
          id: 2, name: 'dark_poetic',
          description: 'Style noir & poétique (validé terrain)',
          model: 'unsloth/Mistral-Small-Instruct-2409-GGUF',
          control_vectors: [
            { path: '/mock/cv/dark.gguf', scale: 2.5 },
            { path: '/mock/cv/poetic.gguf', scale: 1.5 },
          ],
          layer_range: [22, 28], exportable: true,
        },
        {
          id: 3, name: 'geek_humour',
          description: 'Ton geek décalé',
          model: 'unsloth/Mistral-Small-Instruct-2409-GGUF',
          control_vectors: [{ path: '/mock/cv/geek.gguf', scale: 1.8 }],
          layer_range: [18, 24], exportable: true,
        },
        {
          id: 6, name: 'persona_a lora',
          description: 'Persona A (LoRA pur)',
          model: 'unsloth/Mistral-Small-Instruct-2409-GGUF',
          control_vectors: [],
          lora_path: '/mock/lora/persona-a-lora.gguf', lora_scale: 1.0,
          exportable: true,
        },
        {
          id: 7, name: 'persona_b lora',
          description: 'Persona B (LoRA pur)',
          model: 'unsloth/Mistral-Small-Instruct-2409-GGUF',
          control_vectors: [],
          lora_path: '/mock/lora/persona-b-lora.gguf', lora_scale: 1.5,
          exportable: true,
        },
      ],
      'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF': [
        {
          id: 4, name: 'no_apologize',
          description: 'Supprime les "I apologize" et hedging',
          model: 'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF',
          control_vectors: [{ path: '/mock/cv/no_apologize.gguf', scale: 2.2 }],
          layer_range: [24, 30], exportable: true,
        },
        {
          id: 5, name: 'verbose_comments',
          description: 'Pousse à commenter le code généré',
          model: 'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF',
          control_vectors: [{ path: '/mock/cv/comments.gguf', scale: 1.5 }],
          layer_range: [20, 26], exportable: true,
        },
      ],
    },
    hfJobs,
    hfTokenConfigured: false,
    hfTokenMasked: null,
    extBenchToolcall: {
      service_online: true,
      env_exists: true,
      configured_models: ['Qwen/Qwen2.5-7B-Instruct-GGUF'],
      default_port: 3015,
      managed_pid: null,
    },
    extBenchBugfind: {
      service_online: false,
      env_exists: true,
      configured_models: [],
      default_port: 3016,
      managed_pid: null,
      sandbox_online: false,
    },
  }
}
