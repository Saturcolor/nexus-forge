import { parseErrorResponse } from './errors'

const BASE = ''

export type QueueStats = {
  size?: number
  in_progress?: number
  processed?: number
  /** Grace period actif : le worker attend avant de servir un user moins prioritaire. */
  threshold_active?: boolean
  /** Temps restant du grace period (secondes). */
  threshold_remaining?: number
  /** Priorité du dernier user servi (pendant le grace period). */
  threshold_priority?: number
  /** Requêtes cloud en cours (bypass queue). */
  cloud_in_progress?: number
  /** Requêtes cloud traitées aujourd'hui. */
  cloud_processed?: number
  /** Détail des requêtes cloud en cours. */
  cloud_in_progress_list?: Array<{ model: string; user_id: string; backend: string; started_at: string }>
  /** Requête locale actuellement traitée par le worker (pour bouton annuler). */
  current_request?: { request_id: string; model: string; user_id: string }
}

/** Métriques proxy llamacpp pour un model_id (aligné sur last_metrics / by_model). */
export type LlamacppModelMetrics = {
  last_generation_tokens_per_second?: number | null
  last_prompt_tokens?: number | null
  last_generation_tokens?: number | null
  last_activity_ts?: number | null
}

/** Stats machine hôte (CPU, GPU, RAM, VRAM, uptime, température, réseau) + état LM Studio. */
export type HostStats = {
  cpu?: { percent?: number }
  gpu?: { name?: string; percent?: number }
  ram?: { used_mb?: number; total_mb?: number; percent?: number }
  vram?: { used_mb?: number; total_mb?: number; percent?: number }
  uptime_seconds?: number
  temperature?: { cpu_c?: number; gpu_c?: number; nvme_c?: number } | number
  network?: { rx_mb?: number; tx_mb?: number; rx_mbps?: number; tx_mbps?: number }
  lmstudio?: {
    model_loading?: boolean
    loading_progress?: string | null   // "idle" | "loaded" | "loading" | "loading:45" | "prompt:41"
    running_models?: number | null
    loaded_model?: string | null
    ctx_size?: number | null
    last_generation_tokens_per_second?: number | null
    last_prompt_tokens?: number | null
    last_generation_tokens?: number | null
    last_activity_ts?: number | null   // unix timestamp (seconds)
  }
  ollama?: {
    model_loading?: boolean
    loading_progress?: string
    last_generation_tokens_per_second?: number
    last_prompt_tokens?: number
    last_generation_tokens?: number
    last_activity_ts?: number
    loaded_models?: string[]
  }
  llamacpp?: {
    model_loading?: boolean
    loading_progress?: string | null
    running_models?: number
    instances?: Array<{
      model_id: string
      ctx_size?: number
      port?: number
      pid?: number
      ready?: boolean
      running?: boolean
      loading_pct?: number
      prompt_pct?: number
      /** Type de backend natif côté brain-daemon. "lucebox" pour Lucebox, sinon absent ou "native". */
      backend_type?: string
      /** Type de modèle côté brain-daemon. "hf" = vLLM (HF dir), "gguf" = llama.cpp/Lucebox. */
      kind?: string
    }>
    last_generation_tokens_per_second?: number | null
    last_prompt_tokens?: number | null
    last_generation_tokens?: number | null
    last_activity_ts?: number | null
    /** Métriques proxy par model_id daemon (dernière requête par modèle). */
    by_model?: Record<string, LlamacppModelMetrics>
  }
  brain?: {
    thermal_level?: string
    thermal_running?: boolean
    temp_c?: number | null
    power_w?: number | null
    governor?: string | null
    gpu_level?: string | null
    cpu_freq_khz?: number | null
  }
}
export type BackendStatus = { name: string; url: string; status: string; status_code?: number; error?: string; priority?: number }
export type UsageEntry = {
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  ttft_seconds?: number
  tokens_per_second?: number
}
export type LogEntry = {
  request_id: string
  user_id?: string
  model: string
  backend: string
  status: string
  duration_ms?: number
  timestamp?: string
  date?: string
  error?: string
  usage?: UsageEntry
}
export type UserEntry = { user_id: string; priority: number; threshold: boolean; key_prefix: string }
export type UserStats = {
  requests: number
  total_duration_ms: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_reasoning_tokens?: number
  requests_with_usage?: number
}
export type StatsEntry = {
  date: string
  by_user: Record<string, UserStats>
  total_requests: number
  total_duration_ms: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_reasoning_tokens?: number
  requests_with_usage?: number
}
export type Config = {
  /** UI: thème actif du dashboard V2 (catalogue dans src/v2/lib/themes.ts). Lu au boot, persisté ici. */
  ui_theme?: string
  server_host?: string
  server_port?: number
  queue_max_size?: number
  /** Timeout de la file d'attente (secondes). Les requêtes en attente au-delà sont rejetées. */
  queue_timeout_seconds?: number
  debug?: boolean
  /** Logs debug : JSON complets (sans troncature) */
  debug_full_json?: boolean
  /** LM Studio : forcer le reasoning (off | low | medium | high | on), '' = désactivé */
  lm_studio_reasoning?: string
  /** Session init : envoyer un pré-prompt pour créer la session avant le contenu (fix template jinja qwen3.5). */
  lm_studio_session_init_enabled?: boolean
  /** Texte du pré-prompt d'initialisation de session. Défaut "Ready." */
  lm_studio_session_init_prompt?: string
  ollama_url?: string
  mlx_url?: string
  llamacpp_url?: string
  llamacpp_enabled?: boolean
  /** vLLM partage le brain-daemon avec llamacpp ; URL override optionnelle si daemon dédié. */
  vllm_url?: string
  vllm_enabled?: boolean
  /** Lucebox partage le brain-daemon avec llamacpp (backend natif extra `native-lucebox`) ; URL override optionnelle si daemon dédié. */
  lucebox_url?: string
  lucebox_enabled?: boolean
  lm_studio_url?: string
  /** LM Studio proxy : forward tel quel vers /v1/chat/completions (pas de traduction format). */
  lm_studio_proxy_only?: boolean
  /** URL de la probe LM Studio (machine hôte) pour stats système + logs. Ex. http://192.168.1.10:9090 */
  lm_studio_probe_url?: string
  /** URL de la probe Ollama (machine hôte) pour stats système + modèles chargés. Ex. http://192.168.1.10:9090 */
  ollama_probe_url?: string
  ollama_enabled?: boolean
  mlx_enabled?: boolean
  lm_studio_enabled?: boolean
  /** Activer stateful POST /v1/responses (previous_response_id pour réduire les tokens entrée). */
  stateful_responses_enabled?: boolean
  /** TTL du cache response_id par session (secondes). Défaut 600. */
  stateful_responses_ttl_seconds?: number
  /** N'utiliser previous_response_id que si enregistré il y a moins de X secondes (évite 400 LM Studio). 0 = pas de limite. Défaut 120. */
  stateful_responses_send_max_age_seconds?: number
  /** Header optionnel pour id de conversation (ex. X-Conversation-Id). Vide = session user_id:model. */
  stateful_responses_session_header?: string
  /** TTL du cache des modèles (GET /api/tags) en secondes. 0 = toujours rafraîchir. */
  models_cache_ttl_seconds?: number
  /** Présent uniquement en GET (masqué). En POST : envoyer '' pour désactiver l'auth, ou la valeur pour la définir. */
  admin_token?: string
  admin_token_set?: boolean
  /** Si true, /v1/chat/completions renvoie 401 sans token ou token utilisateur inconnu */
  require_api_key?: boolean
  /** Accepte les clés users[].api_key sur /admin/* en plus du token admin. */
  admin_accept_user_api_key?: boolean
  backend_timeout?: number
  model_routes?: { pattern: string; backend: string }[]
  model_mapping?: Record<string, { backend: string; backend_model_id: string }>
  credits?: {
    enabled?: boolean
    timeout_ms?: number
    providers_configured?: string[]
    providers_preferred?: string[]
    openrouter_key_set?: boolean
    openai_key_set?: boolean
    anthropic_key_set?: boolean
    elevenlabs_key_set?: boolean
    openrouter_key?: string
    openai_key?: string
    anthropic_key?: string
    elevenlabs_key?: string
  }
  /** OpenRouter (provider web) : clé API standard (pas OpenBill). Masquée en GET, remplacée par openrouter_api_key_set. */
  openrouter_api_key?: string
  openrouter_api_key_set?: boolean
  openrouter_enabled?: boolean
  /** Coché = forcer le fallback OpenRouter (modèles non matchés → openrouter). Décoché = fallback seulement si aucun backend local. */
  openrouter_fallback_force?: boolean
  openrouter_fallback_model?: string
  /** Modèle vision OpenRouter utilisé par /admin/vision/describe (fallback vision pour modèles texte-only). */
  openrouter_vision_model?: string
  /** Modèle de raisonnement OpenRouter utilisé par /admin/reasoning/ask (outil extended_reasoning dans Mastermind). */
  openrouter_reasoning_model?: string
  /** Modèle d'embedding OpenRouter utilisé par /v1/embeddings (broker Mercury, fallback cloud). */
  openrouter_embedding_model?: string
  /** Dimensionnalité des vecteurs renvoyés par openrouter_embedding_model (utilisé pour validation cohérence côté Mastermind). */
  openrouter_embedding_dim?: number | null
  /** Priorité du modèle cloud dans la chaine embedding (plus petit = essayé en premier). Défaut 99. */
  openrouter_embedding_priority?: number
  /** Fallback automatique sur un modèle alternatif quand le primary échoue.
   * Activé via .enabled ; .triggers liste les catégories d'erreur qui déclenchent le swap
   * (timeout, payment, server_error, connection) ; .chain liste ordonnée des modèles à
   * essayer en cascade (ex: ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"]).
   * Le model primary est automatiquement filtré de la chain. */
  openrouter_model_fallback?: {
    enabled?: boolean
    triggers?: string[]
    chain?: string[]
  }
  /** Modèles d'embedding locaux exposés via brain-daemon (chaine ordonnée par priorité). */
  local_embedding_models?: Array<{ id?: string; model: string; dim?: number | null; priority?: number }>
  /** Triggers de fallback en cascade pour /v1/embeddings. */
  embedding_fallback_triggers?: {
    retryable_status?: number[]
    timeout_ms?: number
    model_unavailable?: boolean
  }
  /** HTTP-Referer header pour l'attribution OpenRouter */
  openrouter_http_referer?: string
  /** Titre affiché dans l'attribution OpenRouter */
  openrouter_title?: string
  /** Ollama proxy : forward tel quel vers /v1/chat/completions (pas de traduction format). */
  ollama_proxy_only?: boolean
  /** Ollama auto-pull : pull automatiquement les modèles non présents lors d'une requête. */
  ollama_auto_pull?: boolean
  /** Mode priorité auto : true = utiliser provider_priority/model_priority, false = privilégier les modèles déjà chargés puis provider prio 1. */
  auto_priority_enabled?: boolean
  /** Ordre de priorité des providers (ex. ["llamacpp", "ollama", "lm_studio"]). */
  provider_priority?: string[]
  /** Priorité des utilisateurs anonymes (sans clé API). Défaut 99. */
  anonymous_priority?: number
  /** Timeout du health check des backends (secondes). Défaut 2. */
  health_check_timeout?: number
  /** Nombre de tentatives sur le fallback OpenRouter avant abandon. Défaut 1. */
  max_retry_on_fallback?: number
  /** Rétention des logs texte (jours). 0 = pas de nettoyage. Les rotations `mercury.log.*` plus vieilles sont supprimées au démarrage. Les `usage_*.jsonl` (stats dashboard) ne sont jamais touchés. */
  log_retention_days?: number
  /** Répertoire des logs LM Studio pour la probe. */
  lmstudio_logs_dir?: string
  /** Répertoire des logs Ollama pour la probe. */
  ollama_logs_dir?: string
  /** Liste des modèles masqués (pas dans /api/tags). */
  hidden_models?: string[]
  /** Anthropic via OAuth Claude Code (même flux que l'extension VS Code). */
  anthropic_enabled?: boolean
  /** Chemin du fichier credentials OAuth. Vide = ~/.claude/.credentials.json automatique. */
  anthropic_credentials_file?: string
  /** Modèle Anthropic utilisé comme fallback (ex. claude-sonnet-4-6). */
  anthropic_fallback_model?: string
  /** Modèle Anthropic utilisé pour le raisonnement étendu (extended_reasoning). */
  anthropic_reasoning_model?: string
  /** Présent en GET uniquement : true si le fichier credentials contient un accessToken. */
  anthropic_credentials_set?: boolean
  /** Ordre des providers cloud fallback. Ex. ["anthropic", "openrouter"] = Anthropic en premier. */
  fallback_providers_order?: string[]
  /** Activer le grace period de priorité : après traitement d'un user prioritaire, attend avant de servir un user moins prioritaire. */
  priority_threshold_enabled?: boolean
  /** Durée du grace period (secondes). Défaut 30. */
  priority_threshold_seconds?: number
  /** Bypass la queue séquentielle pour les requêtes cloud (openrouter/anthropic). Défaut true. */
  cloud_bypass_queue?: boolean
  /** Benchmarks externes */
  toolcall15_enabled?: boolean
  toolcall15_url?: string
  bugfind15_enabled?: boolean
  bugfind15_url?: string
  /** Audio providers */
  audio_openai_enabled?: boolean
  audio_openai_api_key?: string
  audio_openai_api_key_set?: boolean
  audio_groq_enabled?: boolean
  audio_groq_api_key?: string
  audio_groq_api_key_set?: boolean
  audio_elevenlabs_enabled?: boolean
  audio_elevenlabs_api_key?: string
  audio_elevenlabs_api_key_set?: boolean
  audio_elevenlabs_voice_map?: Record<string, string>
  audio_default_stt_provider?: string
  audio_default_tts_provider?: string
  /** Audio local (daemon brain) */
  audio_local_enabled?: boolean
  audio_local_url?: string
  /** OpenAI Realtime API (WebSocket bidir, consommé par NCM Interpreter) */
  realtime_enabled?: boolean
  /** Atlas (extraction de control vectors via brain-daemon /atlas/*) */
  atlas_enabled?: boolean
  atlas_brain_url?: string
  /** URL de l'app AtlasMind (source des presets cocktail control_vector). */
  atlas_atlasmind_url?: string
  /** Optionnel : Bearer token si AtlasMind a son auth activée (auth.api_key set). */
  atlas_atlasmind_api_key?: string
  atlas_timeout_sec?: number
  /** Thinking budget defaults (tokens). Utilisés quand Mastermind envoie low/medium/high. */
  thinking_budget_low?: number
  thinking_budget_medium?: number
  thinking_budget_high?: number
  /** Quant module (proxy vers brain-daemon /quant/*) */
  quant_enabled?: boolean
  /** URL du brain-daemon pour le module quant. Défaut http://127.0.0.1:4321. */
  quant_brain_url?: string
  /** Timeout des routes sync (secondes). Défaut 60. */
  quant_timeout_sec?: number
  /** Timeout des routes cartographie/surgical (secondes). Défaut 600. */
  quant_cartography_timeout_sec?: number
  /** Timeout du stream SSE job (secondes). Défaut 3600. */
  quant_stream_timeout_sec?: number
  /** Whitelist routes JSON (mode défaut = toutes si absent). Laisser vide (recommandé). */
  quant_allowed_routes?: unknown
}

export type ModelsCacheState = { count: number; updated_at: string }
export type CachedModelEntry = { name: string; modified_at?: string; size?: number; backend?: string; priority?: number; category?: string; template_configured?: boolean; loaded?: boolean }
export type CacheModelsResponse = { models: CachedModelEntry[]; hidden_model_names?: string[]; protected_model_names?: string[]; category_order?: string[] }

export type ModelMappingEntry = { canonical: string; backend: string; backend_model_id: string }
export type BackendModelWithNormalized = { name: string; backend: string; backend_model_id: string; normalized: string }
export type ModelMappingResponse = {
  from_config: ModelMappingEntry[]
  from_cache: ModelMappingEntry[]
  backend_models: BackendModelWithNormalized[]
}

export type ProviderId = 'openrouter' | 'openai' | 'anthropic'
export type CreditsReport = {
  fetchedAt: string
  providers: Record<string, { ok: boolean; error?: string; remaining?: number; totalCredits?: number; totalUsage?: number; periodSpend?: number; currency?: string; [key: string]: unknown }>
  errors: string[]
}
export type CreditsTotals = {
  fetchedAt: string
  totalRemaining: number | null
  remaining: Record<string, number | null>
  errors?: string[]
}
export type VersionInfo = { version: string }

/** Réponse GET openrouter.ai/api/v1/models (data[] avec id, name, etc.) */
export type OpenRouterModelEntry = { id: string; name?: string; [key: string]: unknown }
export type OpenRouterModelsResponse = { data: OpenRouterModelEntry[]; detail?: string }

/** Anthropic GET /admin/anthropic/models */
export type AnthropicModelEntry = { id: string; name?: string }
export type AnthropicModelsResponse = { models: AnthropicModelEntry[]; detail?: string }

/** Audio discovery types */
export type AudioModelEntry = { id: string; name?: string }
export type AudioVoiceEntry = { id: string; name: string }
export type OpenAIAudioModelsResponse = { stt_models: AudioModelEntry[]; tts_models: AudioModelEntry[]; voices: AudioVoiceEntry[]; detail?: string }
export type GroqAudioModelsResponse = { stt_models: AudioModelEntry[]; detail?: string }
export type ElevenLabsVoiceEntry = { voice_id: string; name: string; category?: string; labels?: Record<string, string> }
export type ElevenLabsVoicesResponse = { voices: ElevenLabsVoiceEntry[]; models: AudioModelEntry[]; detail?: string }

/** GET /api/voices — modèles/voix audio disponibles */
export type AudioVoicesModelEntry = { name: string; provider: string }
export type AudioVoicesVoiceEntry = {
  name: string
  provider: string
  voice_id?: string
  display_name?: string
  /** Pour provider='local' : 'kokoro' (preset) ou 'omnivoice' (clone). Absent pour les providers cloud. */
  engine?: string
}
export type AudioVoicesResponse = {
  stt_models: AudioVoicesModelEntry[]
  tts_models: AudioVoicesModelEntry[]
  voices: AudioVoicesVoiceEntry[]
  /** Modèles OpenAI Realtime (GA only). Présent si une clé openai est configurée. */
  realtime_models?: AudioVoicesModelEntry[]
}

/** LM Studio GET /admin/lm-studio/models */
export type LmStudioLoadedInstance = { id: string; config?: Record<string, unknown> }
export type LmStudioModelEntry = {
  key: string
  display_name?: string
  loaded_instances: LmStudioLoadedInstance[]
}
export type LmStudioModelsResponse = { models: LmStudioModelEntry[]; error?: string }

export type LmStudioActionResponse = { ok: boolean; status: number; body?: unknown }

/** Ollama model management types */
export type OllamaModelEntry = {
  name: string
  size?: number
  modified_at?: string
  digest?: string
  details?: Record<string, unknown>
  running?: boolean
}
export type OllamaModelsResponse = { models: OllamaModelEntry[]; error?: string }
export type OllamaPsEntry = {
  name: string
  model?: string
  size?: number
  digest?: string
  details?: Record<string, unknown>
  expires_at?: string
  size_vram?: number
}
export type OllamaPsResponse = { models: OllamaPsEntry[]; error?: string }
export type OllamaPullProgress = {
  status: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}
export type OllamaActionResponse = { ok: boolean; status: number; body?: unknown }

const ADMIN_TOKEN_KEY = 'mercury_admin_token'

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
}
export function setAdminToken(token: string) {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token)
  else localStorage.removeItem(ADMIN_TOKEN_KEY)
}

function authHeaders(): Record<string, string> {
  const token = getAdminToken()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

async function clientFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...(options.headers || {}) }
  return fetch(`${BASE}${endpoint}`, { ...options, headers })
}

async function checkResponse(r: Response): Promise<void> {
  if (r.ok) return
  throw await parseErrorResponse(r)
}

async function apiGet<T>(endpoint: string): Promise<T> {
  const r = await clientFetch(endpoint)
  await checkResponse(r)
  return r.json()
}

async function apiPost<T>(endpoint: string, data?: unknown): Promise<T> {
  const r = await clientFetch(endpoint, {
    method: 'POST',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  })
  await checkResponse(r)
  return r.json()
}

async function apiPut<T>(endpoint: string, data?: unknown): Promise<T> {
  const r = await clientFetch(endpoint, {
    method: 'PUT',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  })
  await checkResponse(r)
  return r.json()
}

async function apiPatch<T>(endpoint: string, data?: unknown): Promise<T> {
  const r = await clientFetch(endpoint, {
    method: 'PATCH',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  })
  await checkResponse(r)
  return r.json()
}

async function apiDelete<T>(endpoint: string): Promise<T> {
  const r = await clientFetch(endpoint, { method: 'DELETE' })
  await checkResponse(r)
  return r.json()
}

export async function getVersion(): Promise<VersionInfo> {
  return apiGet('/admin/version')
}

export async function getConfig(): Promise<Config> {
  return apiGet('/admin/config')
}

export async function getQueue(): Promise<QueueStats> {
  return apiGet('/admin/queue')
}

export async function cancelCurrentQueueRequest(): Promise<{ cancelled: boolean; request_id?: string; reason?: string }> {
  return apiPost('/admin/queue/cancel')
}

export async function getBackends(): Promise<BackendStatus[]> {
  return apiGet('/admin/backends')
}

/** Réponse GET /admin/lm-studio/probe : configured + error si échec, ou system/lmstudio si OK + métriques proxy */
export type LmStudioProbeResponse = {
  configured: boolean
  error?: string
  status_code?: number
  detail?: string
  system?: { cpu_percent?: number; memory?: { used_mb?: number; total_mb?: number; percent?: number }; temperature?: { available?: boolean; value_c?: number } }
  lmstudio?: Record<string, unknown>
  last_generation_tokens_per_second?: number | null
  last_prompt_tokens?: number | null
  last_generation_tokens?: number | null
  last_activity_ts?: number | null
}

/** Réponse GET /admin/ollama/probe : configured + error si échec, ou system/ollama si OK */
export type OllamaProbeResponse = {
  configured: boolean
  error?: string
  status_code?: number
  detail?: string
  system?: { cpu_percent?: number; memory?: { used_mb?: number; total_mb?: number; percent?: number }; temperature?: { available?: boolean; value_c?: number } }
  ollama?: Record<string, unknown>
}

export async function getLmStudioProbe(): Promise<LmStudioProbeResponse> {
  return apiGet<LmStudioProbeResponse>('/admin/lm-studio/probe')
}

export async function getOllamaProbe(): Promise<OllamaProbeResponse> {
  return apiGet<OllamaProbeResponse>('/admin/ollama/probe')
}

export async function getLmStudioModels(): Promise<LmStudioModelsResponse> {
  return apiGet('/admin/lm-studio/models')
}

/** Stats machine hôte. Retourne null si l’endpoint n’existe pas encore (backend à brancher). */
export async function getHostStats(): Promise<HostStats | null> {
  const r = await clientFetch('/admin/host-stats')
  if (!r.ok) return null
  try {
    return await r.json()
  } catch {
    return null
  }
}

export async function loadLmStudioModel(model: string): Promise<LmStudioActionResponse> {
  const r = await clientFetch('/admin/lm-studio/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function unloadLmStudioModel(instanceId: string): Promise<LmStudioActionResponse> {
  const r = await clientFetch('/admin/lm-studio/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instance_id: instanceId }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function injectLmStudioPrompt(model: string): Promise<LmStudioActionResponse> {
  const r = await clientFetch('/admin/lm-studio/inject-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

/** Met à jour l'ordre de priorité des providers pour le mode auto (1 = premier choix). */
export async function setProviderPriority(order: string[]): Promise<void> {
  await apiPut('/admin/provider-priority', { order })
}

/** Met à jour l'ordre de priorité des modèles par backend (1 = premier choix dans chaque provider). */
export async function setModelPriority(orderByBackend: Record<string, string[]>): Promise<void> {
  await apiPut('/admin/model-priority', { order_by_backend: orderByBackend })
}

/** Masque ou affiche un modèle (n'intervient plus dans la priorité auto). */
export async function setHiddenModel(modelName: string, hidden: boolean): Promise<{ ok: boolean; hidden_model_names: string[] }> {
  return apiPatch('/admin/hidden-models', { model_name: modelName, hidden }) as Promise<{ ok: boolean; hidden_model_names: string[] }>
}

/** Épingle/désépingle un modèle contre l'unload_all du scheduler (reste chargé la nuit). */
export async function setProtectedModel(modelName: string, isProtected: boolean): Promise<{ ok: boolean; protected_model_names: string[] }> {
  return apiPatch('/admin/unload-protected-models', { model_name: modelName, protected: isProtected }) as Promise<{ ok: boolean; protected_model_names: string[] }>
}

export async function setModelCategory(modelName: string, category: string | null): Promise<{ ok: boolean; category_order: string[] }> {
  return apiPatch('/admin/model-categories', { model_name: modelName, category }) as Promise<{ ok: boolean; category_order: string[] }>
}

export async function getLogs(date?: string): Promise<LogEntry[]> {
  const url = date ? `/admin/logs?date=${encodeURIComponent(date)}` : '/admin/logs'
  return apiGet(url)
}

export async function getStats(date?: string): Promise<StatsEntry> {
  const url = date ? `/admin/stats?date=${encodeURIComponent(date)}` : '/admin/stats'
  return apiGet(url)
}

export async function getDates(): Promise<string[]> {
  return apiGet('/admin/dates')
}

export type UsagePoint = {
  t: string
  requests: number
  duration_ms: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
}

export type UsageBreakdownEntry = { requests: number; duration_ms: number; tokens: number }
export type UsageBreakdown = {
  by_backend: Record<string, UsageBreakdownEntry>
  by_model: Record<string, UsageBreakdownEntry>
  by_dow_hour: number[][] // 7 × 24
}

export type UsageRange = {
  bucket: 'day' | 'hour'
  points: UsagePoint[]
  breakdown?: UsageBreakdown
}

export async function getStatsRange(days: number, bucket: 'day' | 'hour'): Promise<UsageRange> {
  return apiGet(`/admin/stats-range?days=${days}&bucket=${bucket}`)
}

export async function getUsers(): Promise<UserEntry[]> {
  return apiGet('/admin/users')
}

export async function createUser(body: { user_id: string; priority: number; threshold?: boolean }): Promise<{ user_id: string; priority: number; api_key: string }> {
  return apiPost('/admin/users', body)
}

export async function updateUser(body: { user_id: string; priority?: number; threshold?: boolean; new_user_id?: string }): Promise<{ ok: boolean }> {
  return apiPatch('/admin/users', body)
}

export async function deleteUser(user_id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/admin/users?user_id=${encodeURIComponent(user_id)}`)
}

export async function getCredits(providers?: string[], timeout_ms?: number): Promise<CreditsReport> {
  const params = new URLSearchParams()
  if (providers?.length) params.set('providers', providers.join(','))
  if (timeout_ms != null) params.set('timeout_ms', String(timeout_ms))
  const q = params.toString()
  return apiGet(`/admin/credits${q ? `?${q}` : ''}`)
}

export async function getCreditsTotals(providers?: string[], timeout_ms?: number): Promise<CreditsTotals> {
  const params = new URLSearchParams()
  if (providers?.length) params.set('providers', providers.join(','))
  if (timeout_ms != null) params.set('timeout_ms', String(timeout_ms))
  const q = params.toString()
  return apiGet(`/admin/credits/totals${q ? `?${q}` : ''}`)
}

export async function saveConfig(config: Config): Promise<{ ok: boolean }> {
  return apiPost('/admin/config', config)
}

export async function getCacheState(): Promise<ModelsCacheState> {
  return apiGet('/admin/cache')
}

export async function getCacheModels(): Promise<CacheModelsResponse> {
  return apiGet('/admin/cache/models')
}

export async function refreshModelsCache(): Promise<{ ok: boolean; count: number }> {
  return apiPost('/admin/cache/refresh')
}

export async function flushModelsCache(): Promise<{ ok: boolean; count: number }> {
  return apiPost('/admin/cache/flush')
}

export async function getModelMapping(): Promise<ModelMappingResponse> {
  return apiGet('/admin/model-mapping')
}

export async function getOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  return apiGet('/admin/openrouter/models')
}

// ── OpenRouter health & circuit breaker ────────────────────────────────────
export type OpenRouterModelMetrics = {
  last_generation_tokens_per_second: number | null
  last_prompt_tokens: number | null
  last_generation_tokens: number | null
  last_provider: string | null
  last_status: number | null
  last_ttfb_ms: number | null
  last_total_ms: number | null
  last_activity_ts: number | null
}

export type OpenRouterProviderMetrics = OpenRouterModelMetrics & {
  calls_count?: number
}

export type OpenRouterMetrics = OpenRouterModelMetrics & {
  by_model: Record<string, OpenRouterModelMetrics>
  by_provider: Record<string, OpenRouterProviderMetrics>
  in_flight: Record<string, number>
}

export type OpenRouterCircuitBreakerProvider = {
  fails_in_window: number
  blacklisted: boolean
  oldest_fail_ago_s: number | null
}

export type OpenRouterHealthResponse = {
  metrics: OpenRouterMetrics
  circuit_breaker: {
    config: { failure_window_s: number; failure_threshold: number; tracked_categories: string[] }
    providers: Record<string, OpenRouterCircuitBreakerProvider>
    blacklist: string[]
  }
  fallback: {
    enabled: boolean
    triggers: string[]
    chain: string[]
  }
  api_key_set: boolean
}

export type OpenRouterCreditsResponse = {
  data?: {
    total_credits?: number
    total_usage?: number
    [k: string]: unknown
  }
  detail?: string
  raw?: string
}

export async function getOpenRouterHealth(): Promise<OpenRouterHealthResponse> {
  return apiGet('/admin/openrouter/health')
}

export async function resetOpenRouterCircuitBreaker(): Promise<{ reset: boolean; providers: Record<string, OpenRouterCircuitBreakerProvider> }> {
  return apiPost('/admin/openrouter/circuit_breaker/reset')
}

export async function getOpenRouterCredits(): Promise<OpenRouterCreditsResponse> {
  return apiGet('/admin/openrouter/credits')
}

export async function getAnthropicModels(): Promise<AnthropicModelsResponse> {
  return apiGet('/admin/anthropic/models')
}

/** Audio discovery */
export async function getOpenAIAudioModels(): Promise<OpenAIAudioModelsResponse> {
  return apiGet('/admin/audio/openai/models')
}
export async function getGroqAudioModels(): Promise<GroqAudioModelsResponse> {
  return apiGet('/admin/audio/groq/models')
}
export async function getElevenLabsVoices(): Promise<ElevenLabsVoicesResponse> {
  return apiGet('/admin/audio/elevenlabs/voices')
}

/** GET /api/voices — modèles/voix audio disponibles (pas d'auth admin requise) */
export async function getAudioVoices(): Promise<AudioVoicesResponse> {
  const resp = await fetch(`${BASE}/api/voices`)
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
  return resp.json()
}

/** Audio Local proxy (via admin routes) */
export async function getAudioLocalHealth(): Promise<Record<string, unknown>> {
  return apiGet('/admin/audio/local/health')
}
export async function getAudioLocalVoices(): Promise<{ voices: Array<{ id: string; name: string; provider: string }> }> {
  return apiGet('/admin/audio/local/voices')
}
export async function getAudioLocalLibsStatus(): Promise<Record<string, unknown>> {
  return apiGet('/admin/audio/local/libs/status')
}
export async function postAudioLocalLibsUpgrade(): Promise<Record<string, unknown>> {
  return apiPost('/admin/audio/local/libs/upgrade')
}
export async function getAudioLocalLibsLog(): Promise<{ log: string[]; in_progress: boolean }> {
  return apiGet('/admin/audio/local/libs/log')
}

/** OmniVoice (TTS clone zero-shot) status + load/unload + profiles list. */
export type OmniVoiceStatus = {
  configured?: boolean
  loaded?: boolean
  device?: string
  sample_rate?: number
  num_step?: number
  guidance_scale?: number
  error?: string | null
  profiles_count?: number
}
export type OmniVoiceProfile = {
  id: string
  name: string
  ref_path?: string | null
  ref_text?: string | null
  language?: string
  instruct?: string | null
  description?: string | null
  master?: string
  tags?: string[]
  created_at?: number
  locked?: boolean
}
export async function getOmniVoiceStatus(): Promise<OmniVoiceStatus> {
  return apiGet('/admin/audio/omnivoice/status')
}
export async function postOmniVoiceLoad(body?: { num_step?: number; guidance_scale?: number; device?: string }): Promise<OmniVoiceStatus> {
  return apiPost('/admin/audio/omnivoice/load', body ?? {})
}
export async function postOmniVoiceUnload(): Promise<OmniVoiceStatus> {
  return apiPost('/admin/audio/omnivoice/unload')
}
export async function getOmniVoiceProfiles(): Promise<{ profiles: OmniVoiceProfile[] }> {
  return apiGet('/admin/audio/omnivoice/profiles')
}
export async function deleteOmniVoiceProfile(profileId: string): Promise<{ ok: boolean }> {
  return apiDelete(`/admin/audio/omnivoice/profiles/${encodeURIComponent(profileId)}`)
}

export async function setAnthropicCredentials(data: {
  access_token: string
  refresh_token?: string
  expires_at?: number
}): Promise<{ ok: boolean; path?: string; detail?: string }> {
  return apiPost('/admin/anthropic/credentials', data)
}

export async function setCloudFallbackOrder(order: string[]): Promise<{ ok: boolean; detail?: string }> {
  return apiPut('/admin/cloud-fallback-order', { order })
}

export async function getDebug(): Promise<{ debug: boolean }> {
  return apiGet('/admin/debug')
}

export async function setDebug(debug: boolean): Promise<{ debug: boolean }> {
  return apiPatch('/admin/debug', { debug })
}

// ─── Ollama Model Management ────────────────────────────────────────────

export async function getOllamaModels(): Promise<OllamaModelsResponse> {
  return apiGet('/admin/ollama/models')
}

export async function getOllamaPs(): Promise<OllamaPsResponse> {
  return apiGet('/admin/ollama/ps')
}

/** Pull un modèle Ollama avec streaming de progression NDJSON. */
export async function pullOllamaModel(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
): Promise<OllamaActionResponse> {
  const r = await clientFetch('/admin/ollama/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    return { ok: false, status: r.status, body }
  }
  const reader = r.body?.getReader()
  if (!reader) return { ok: true, status: r.status }
  const decoder = new TextDecoder()
  let buffer = ''
  let lastProgress: OllamaPullProgress | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (buffer.includes('\n')) {
        const idx = buffer.indexOf('\n')
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as OllamaPullProgress
          lastProgress = parsed
          if (parsed.error) return { ok: false, status: r.status, body: parsed }
          onProgress?.(parsed)
        } catch { /* ignore parse errors */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { ok: true, status: r.status, body: lastProgress }
}

/** Créer un modèle Ollama depuis un Modelfile. */
export async function createOllamaModelfile(
  name: string,
  modelfile: string,
  onProgress?: (progress: { status: string }) => void,
): Promise<OllamaActionResponse> {
  const r = await clientFetch('/admin/ollama/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, modelfile }),
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    return { ok: false, status: r.status, body }
  }
  const reader = r.body?.getReader()
  if (!reader) return { ok: true, status: r.status }
  const decoder = new TextDecoder()
  let buffer = ''
  let lastStatus: { status: string } | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (buffer.includes('\n')) {
        const idx = buffer.indexOf('\n')
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as { status: string; error?: string }
          lastStatus = parsed
          if (parsed.error) return { ok: false, status: r.status, body: parsed }
          onProgress?.(parsed)
        } catch { /* ignore */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { ok: true, status: r.status, body: lastStatus }
}

export async function loadOllamaModel(model: string): Promise<OllamaActionResponse> {
  const r = await clientFetch('/admin/ollama/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function unloadOllamaModel(model: string): Promise<OllamaActionResponse> {
  const r = await clientFetch('/admin/ollama/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function deleteOllamaModel(model: string): Promise<OllamaActionResponse> {
  const r = await clientFetch('/admin/ollama/model', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

// ─── LlamaCPP Daemon ────────────────────────────────────────────────────

export type LlamacppLoadOptions = {
  // Essentiels
  ctx_size?: number
  n_gpu_layers?: number
  flash_attn?: boolean
  jinja?: boolean              // --jinja : active le template Jinja bundled dans le GGUF (tool-use, thinking, formats avancés)
  debug?: boolean              // --verbose --verbose-prompt : dump le prompt rendu post-template, utile pour diagnostiquer les dérives (Mistral & co)
  no_mmap?: boolean
  ctx_shift?: boolean          // true (défaut) = fenêtre glissante ; false = --no-ctx-shift
  parallel?: number            // --parallel N (défaut 1 ; 0 = auto)
  unified_kv_cache?: boolean   // --kv-unified : buffer KV partagé entre séquences
  swa_full?: boolean           // --swa-full : désactive le token pruning SWA, élimine les forced full reprocessing sur modèles hybrides (Qwen3, Nemotron)
  // Memory / cache tuning
  mlock?: boolean              // --mlock : force le modèle à rester en RAM (pas de page-out)
  cache_ram?: number           // --cache-ram MiB : limite prompt cache host. 0 = désactivé (workaround bug Gemma-4)
  ctx_checkpoints?: number     // --ctx-checkpoints N : snapshots SWA pendant PP. 1 = minimum (workaround bug RAM bloat Gemma-4)
  cache_idle_slots?: boolean   // true = défaut llama.cpp ; false = --no-cache-idle-slots
  // Performance CPU/batch
  n_batch?: number             // -b N : taille de batch pour le traitement du prompt
  n_ubatch?: number            // -ub N : taille de sous-batch physique
  n_threads?: number           // -t N : threads de génération token par token
  n_threads_batch?: number     // -tb N : threads pour le traitement du prompt
  // KV cache quantization
  type_k?: string              // --cache-type-k : f32 / f16 / bf16 / q8_0 / q5_1 / q5_0 / iq4_nl / q4_1 / q4_0 / turbo2 / turbo3 / turbo4
  type_v?: string              // --cache-type-v : idem. turbo* = TurboQuant WHT, fork native-turboquant uniquement, requiert -fa 1 + --kv-unified + head_dim % 128 == 0
  // RoPE
  rope_freq_base?: number      // --rope-freq-base
  rope_freq_scale?: number     // --rope-freq-scale
  // Brut
  extra_args?: string[]
  // KV cache save/restore
  kv_cache_auto_dump?: boolean   // Auto-save KV à l'unload, auto-restore au load
  // Backend GPU — string libre. Builtins: "vulkan" (toolbox llama-vulkan-radv),
  // "rocm" (toolbox llama-rocm-7.2), "native-vulkan" (binaire natif host, défaut).
  // Plus tout backend déclaré dans BRAIN-DAEMON/config.yaml `extra_native_backends`
  // (ex: "native-dflash", "native-mtp"). Le brain-daemon valide le nom contre son
  // _BACKEND_MAP au load et retourne 400 si inconnu.
  backend?: string
  // Custom chat template — override le template Jinja bundled dans le GGUF.
  // Chemin absolu, ou nom de fichier (résolu sous ~/mercury/chat-templates/).
  // Use case : tools cassés Qwen3, thinking baked-in à bypass, formats custom.
  chat_template_file?: string
  /**
   * Variables d'environnement à injecter au process serveur (vLLM principalement).
   * Forwardé à brain-daemon `/mgmt/load` puis à `env KEY=VAL ...` dans le toolbox.
   * Exemples utiles vLLM/ROCm Strix Halo :
   *  - PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True (fragmentation UMA — note : nom
   *    "CUDA" gardé sur builds ROCm pour compat ; PYTORCH_HIP_ALLOC_CONF existe aussi
   *    en alias selon les versions)
   *  - HF_HUB_OFFLINE=1 (force offline si modèle en cache)
   *  - VLLM_LOGGING_LEVEL=DEBUG (verbose vLLM logs)
   */
  env_vars?: Record<string, string>
  /**
   * Chemin absolu vers le model.safetensors du draft model (backend `native-lucebox`).
   * Forwardé top-level dans POST /mgmt/load du brain-daemon. Persisté côté daemon
   * dans load_configs.json — reload-on-restart automatique. HTTP 400 si absent
   * lors du premier load. Ignoré pour les autres backends.
   */
  lucebox_draft?: string
  /**
   * Speculative decoding (MTP / Draft) — flags llama-server. Trois modes :
   *  - MTP embedded (mainline PR #22673, slot native-mtp) : `spec_type: 'mtp'`
   *    + `spec_draft_n_max` (head dans le GGUF principal). Mappe vers
   *    `--spec-type draft-mtp` côté binaire (renaming mainline récent).
   *  - MTP head séparé (fork atomic-llama-cpp-turboquant, deprecated) :
   *    `spec_type: 'mtp-legacy'` + `mtp_head: <path>` + `draft_block_size`.
   *    Mappe vers `--spec-type mtp` (ancien nom encore utilisé par le fork).
   *  - Draft classique : `draft_model: <path>` + `draft_ctx_size` + `draft_max`,
   *    etc. (`spec_type: 'draft'` → `--spec-type draft-simple`).
   * Tous ces champs sont des hints — laissés vides ils ne génèrent rien.
   */
  spec_type?: 'mtp' | 'mtp-legacy' | 'draft' | 'ngram' | ''
  spec_draft_n_max?: number
  mtp_head?: string
  draft_block_size?: number
  draft_model?: string
  draft_n_gpu_layers?: number
  draft_ctx_size?: number
  draft_max?: number
  draft_min?: number
  draft_p_min?: number
}

export type LlamacppDefaultOptions = {
  // Sampling de base
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number               // Minimum-p sampling (0-1)
  typical_p?: number           // Locally-typical sampling (0-1)
  tfs_z?: number               // Tail-free sampling
  // Pénalités
  repeat_penalty?: number
  frequency_penalty?: number   // Pénalité fréquence OpenAI (-2 à 2)
  presence_penalty?: number    // Pénalité présence OpenAI (-2 à 2)
  // Mirostat
  mirostat_mode?: number       // 0 = désactivé, 1 = Mirostat v1, 2 = Mirostat v2
  mirostat_tau?: number        // Entropie cible (~5.0)
  mirostat_eta?: number        // Taux d'apprentissage (~0.1)
  // Divers
  seed?: number                // -1 = aléatoire
  /** @deprecated Utiliser chat_template_kwargs.enable_thinking. Migré automatiquement par le backend. */
  reasoning?: boolean
  /**
   * Dict libre passé au template Jinja du modèle via llama-server.
   * Ex: { enable_thinking: false } pour désactiver le bloc <think> sur Qwen3/Gemma-thinking.
   * Ex: { reasoning_effort: "low" } pour les templates qui le supportent (GPT-OSS, Qwen3 derniers).
   */
  chat_template_kwargs?: Record<string, unknown>
  n_keep?: number              // tokens à préserver lors du ctx_shift (-1 = tout garder)
  cache_prompt?: boolean       // Active le KV cache côté llama-server (évite le re-processing du prompt)
  thinking_budget_low?: number     // Override per-model du budget low (tokens). Absent = config globale.
  thinking_budget_medium?: number  // Override per-model du budget medium.
  thinking_budget_high?: number    // Override per-model du budget high. -1 = illimité.
}

export type LlamacppTemplate = {
  load?: LlamacppLoadOptions
  defaults?: LlamacppDefaultOptions
  merge_consecutive_messages?: boolean // Fusionne les messages adjacents de meme role (user+user, assistant+assistant) avec content string. Utile pour les templates stricts (Mistral) qui plantent sur l'alternance cassée. Sans suppression — concat \\n\\n.
}

export type LlamacppModelEntry = {
  model_id: string
  path?: string
  size_gb?: number
  running?: boolean
  ctx_size?: number
  port?: number
  pid?: number
  template?: LlamacppTemplate
  kv_cache_exists?: boolean
  protected?: boolean
  kind?: 'gguf' | 'hf'  // gguf = llama.cpp, hf = vLLM (HF dir)
  /** Preset AtlasMind actuellement appliqué (None si modèle vanilla ou non chargé).
   * Joint depuis /mgmt/status côté Mercury admin route — sert au badge "🎯 X" dans ModelRow. */
  active_preset_id?: number | null
  active_preset_name?: string | null
  /** Liste exhaustive des presets cochés en multi-select. Fallback singleton si
   *  legacy mono-select (= `[active_preset_id]`). Vide si aucun preset assigné. */
  active_preset_ids?: number[]
  /** Stack LoRA ordonné tel que chargé côté llama-server : l'index dans ce tableau
   *  = l'`id` LoRA (0, 1, 2…) utilisé par les scales per-request (Mastermind).
   *  Vient du brain (/mgmt/models + /mgmt/status). Vide si modèle vanilla. */
  loras?: { path: string; default_scale?: number }[]
}

/** Preset cocktail AtlasMind tel qu'exposé par GET /atlas/presets.
 * Un preset peut combiner control_vectors + LoRA (ou avoir l'un sans l'autre).
 * exportable = true ssi le preset a au moins un control_vector avec brain_path
 * OU un lora_path résolvable côté brain. */
export type AtlasPreset = {
  id: number
  name: string
  description?: string | null
  model?: string | null
  control_vectors: Array<{ path: string; scale: number }>
  layer_range?: [number, number] | null
  exportable: boolean
  /** Chemin absolu du LoRA adapter sur brain (null si preset CV-only). */
  lora_path?: string | null
  /** Scale LoRA par défaut au boot du brain (0.0–2.0, défaut 1.0). */
  lora_scale?: number
}

export type AtlasPresetsResponse = { presets: AtlasPreset[]; count: number }

export type LlamacppModelsResponse = { models: LlamacppModelEntry[]; error?: string }
export type LlamacppActionResponse = { ok: boolean; status: number; body?: unknown }

export type LlamacppProbeResponse = {
  configured: boolean
  running_models?: number
  instances?: Array<{
    model_id: string
    ctx_size?: number
    port?: number
    pid?: number
    ready?: boolean
    running?: boolean
    loading_pct?: number
    prompt_pct?: number
    protected?: boolean
    vram_delta_mb?: number
    ram_delta_mb?: number
    ram_estimated_mb?: number
    ram_rss_mb?: number
    load_order?: number
    last_inference_ts?: number
    /** Type de backend natif exposé par brain-daemon /mgmt/status. "lucebox" pour les
     * instances `native-lucebox`, absent ou "native" pour les autres natifs. */
    backend_type?: string
  }>
  last_generation_tokens_per_second?: number
  last_prompt_tokens?: number
  last_generation_tokens?: number
  last_activity_ts?: number
  /** Dernières métriques proxy par model_id daemon. */
  by_model?: Record<string, LlamacppModelMetrics>
  error?: string
}

export type LlamacppDaemonVersionInfo = {
  version?: string
  name?: string
  error?: string
  detail?: string
}

export type LlamacppSessionResponse = {
  model_id: string
  ts: number
  slots: unknown
  proxy_metrics?: LlamacppModelMetrics | null
  n_ctx_max?: number | null
  slot_http_status?: number | null
  slot_error?: string | null
}

/** Snapshot GET /admin/lm-studio/session/{model_key} — métriques proxy globales (pas par modèle). */
export type LmStudioSessionResponse = {
  model_key: string
  ts: number
  display_name?: string
  loaded_instances: Array<{ id?: string; config?: Record<string, unknown> }>
  context_length?: number | null
  proxy_metrics?: LlamacppModelMetrics
  models_http_status?: number
}

/** Snapshot GET /admin/ollama/session/{model_name} — métriques proxy globales. */
export type OllamaSessionResponse = {
  model_name: string
  ts: number
  show: Record<string, unknown>
  ps: Record<string, unknown> | null
  context_length?: number | null
  proxy_metrics?: LlamacppModelMetrics
  show_http_status?: number
}

export async function getLlamacppModels(): Promise<LlamacppModelsResponse> {
  return apiGet('/admin/llamacpp/models')
}

export async function getLlamacppProbe(): Promise<LlamacppProbeResponse> {
  return apiGet('/admin/llamacpp/probe')
}

export async function getLlamacppDaemonVersion(): Promise<LlamacppDaemonVersionInfo> {
  const r = await clientFetch('/admin/llamacpp/daemon-version')
  const body = (await r.json().catch(() => ({}))) as LlamacppDaemonVersionInfo
  if (!r.ok) {
    return {
      error: typeof body.error === 'string' ? body.error : `HTTP ${r.status}`,
      detail: body.detail,
    }
  }
  return body
}

export async function getLlamacppSession(model_id: string): Promise<LlamacppSessionResponse> {
  return apiGet(`/admin/llamacpp/session/${model_id}`)
}

export async function getLmStudioSession(model_key: string): Promise<LmStudioSessionResponse> {
  return apiGet(`/admin/lm-studio/session/${model_key}`)
}

export async function getOllamaSession(model_name: string): Promise<OllamaSessionResponse> {
  return apiGet(`/admin/ollama/session/${model_name}`)
}

export async function getLlamacppTemplates(): Promise<Record<string, LlamacppTemplate>> {
  return apiGet('/admin/llamacpp/templates')
}

export async function setLlamacppTemplate(model_id: string, template: LlamacppTemplate): Promise<{ ok: boolean }> {
  // Ne pas encoder les '/' — la route FastAPI utilise {model_id:path} et attend des slashes réels
  return apiPost(`/admin/llamacpp/templates/${model_id}`, template)
}

export async function deleteLlamacppTemplate(model_id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/admin/llamacpp/templates/${model_id}`)
}

export async function loadLlamacppModel(model_id: string): Promise<LlamacppActionResponse> {
  const r = await clientFetch('/admin/llamacpp/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function unloadLlamacppModel(model_id: string): Promise<LlamacppActionResponse> {
  const r = await clientFetch('/admin/llamacpp/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function saveLlamacppKvCache(model_id: string): Promise<LlamacppActionResponse> {
  const r = await clientFetch(`/admin/llamacpp/kv-cache/save/${model_id}`, { method: 'POST' })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function deleteLlamacppKvCache(model_id: string): Promise<LlamacppActionResponse> {
  const r = await clientFetch(`/admin/llamacpp/kv-cache/${model_id}`, { method: 'DELETE' })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function getLlamacppDaemonLogs(last?: number): Promise<{ logs: string[]; error?: string }> {
  const url = last != null ? `/admin/llamacpp/daemon-logs?last=${last}` : '/admin/llamacpp/daemon-logs'
  return apiGet(url)
}

export type LlamacppSlot = {
  id: number
  is_processing: boolean  // nouveau format llama-server
  n_ctx: number
  [key: string]: unknown
}

export type LlamaTiming = {
  promptEvalMs?: number
  promptTokens?: number
  promptTokensPerSecond?: number
  evalMs?: number
  evalTokens?: number
  evalTokensPerSecond?: number
  totalMs?: number
  totalTokens?: number
}

export async function getLlamacppSlots(model_id: string): Promise<LlamacppSlot[]> {
  return apiGet(`/admin/llamacpp/slots/${model_id}`)
}

// ── Atlas health (route publique Mercury, proxy vers brain-daemon /atlas/*) ──
export type AtlasHealth = {
  enabled?: boolean
  initialized?: boolean
  current_job?: {
    job_id?: string
    model?: string
    started_at?: number
  } | null
  upstream_error?: string
  configured_brain_url?: string
}

export async function getAtlasHealth(): Promise<AtlasHealth> {
  return apiGet('/atlas/health')
}

// ── Atlas presets (cocktail control_vector AtlasMind) ────────────────────────
// Mercury proxy /atlas/presets vers AtlasMind, et /atlas/mgmt/{apply,clear}-preset
// orchestre fetch preset + /mgmt/load brain. Vu depuis le frontend, c'est trois
// méthodes simples.

export async function getAtlasPresets(model_id?: string): Promise<AtlasPresetsResponse> {
  const qs = model_id ? `?model_id=${encodeURIComponent(model_id)}` : ''
  return apiGet(`/atlas/presets${qs}`)
}

export async function applyAtlasPreset(model_id: string, preset_id: number): Promise<LlamacppActionResponse> {
  const r = await clientFetch('/atlas/mgmt/apply-preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id, preset_id }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

/** Multi-select : assigne N presets simultanément. Le brain stack les LoRA de
 *  tous les presets cochés (ordre = ordre de `preset_ids`). Pour les CV, seul
 *  le premier preset qui en a est appliqué (cf backend warn). preset_ids vide
 *  → 400 (use clearAtlasPreset à la place). */
export async function applyAtlasPresets(model_id: string, preset_ids: number[]): Promise<LlamacppActionResponse> {
  const r = await clientFetch('/atlas/mgmt/apply-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id, preset_ids }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

export async function clearAtlasPreset(model_id: string): Promise<LlamacppActionResponse> {
  const r = await clientFetch('/atlas/mgmt/clear-preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

// ── Brain Management ─────────────────────────────────────────────────────────

export type BrainThermalStatus = {
  running: boolean
  level: string          // "off" | "active" | "emergency"
  emergency: boolean
  throttle_pct: number | null  // 0-100
  temp_c: number | null
  power_w: number | null
  cpu_freq_khz: number | null
  gpu_level: string | null
  governor: string | null
  stopped_pid: number | null
  thresholds: {
    throttle_start_c: number
    throttle_full_c: number
    emergency_c: number
    resume_c: number
  }
}

export type BrainPerfStatus = {
  current_mode: string
  governors: string[]
  gpu_level: string | null
  swappiness: string | null
  dirty_ratio: string | null
  thp: string | null
  root: boolean
  available_modes: string[]
  custom_stapm_w: number | null
  custom_tctl_c: number | null
}

export async function postBrainPerfCustom(overrides: { stapm_w?: number | null; tctl_c?: number | null }): Promise<{ mode: string; custom_stapm_w: number | null; custom_tctl_c: number | null }> {
  return apiPost('/admin/llamacpp/perf/custom', overrides)
}

export type BrainToolboxInfo = {
  type: 'toolbox'
  toolbox_name: string
  exists: boolean
  version: string | null
  has_backup: boolean
}

export type BrainNativeInfo = {
  type: 'native'
  binary: string
  installed: boolean
  version: string | null
  build_info?: Record<string, string>
  has_backup: boolean
}

export type BrainBackendInfo = BrainToolboxInfo | BrainNativeInfo

// The brain-daemon /updater/status response contains one entry per registered
// backend (vulkan, rocm, native-vulkan, plus any extra_native_backends declared
// in BRAIN-DAEMON config.yaml) plus an `update_in_progress` flag. Use an index
// signature so any backend name is accepted; consumers must filter out
// `update_in_progress` before iterating backends.
export type BrainUpdaterStatus = {
  update_in_progress: boolean
} & {
  [backend: string]: BrainBackendInfo | boolean | undefined
}

export async function getBrainThermalStatus(): Promise<BrainThermalStatus> {
  return apiGet('/admin/llamacpp/thermal/status')
}

export async function postBrainThermalStart(): Promise<{ status: string }> {
  return apiPost('/admin/llamacpp/thermal/start', {})
}

export async function postBrainThermalStop(): Promise<{ status: string }> {
  return apiPost('/admin/llamacpp/thermal/stop', {})
}

export async function postBrainThermalConfig(config: Record<string, number>): Promise<BrainThermalStatus> {
  return apiPost('/admin/llamacpp/thermal/config', config)
}

export async function getBrainPerfStatus(): Promise<BrainPerfStatus> {
  return apiGet('/admin/llamacpp/perf/status')
}

export async function postBrainPerfMode(mode: string): Promise<{ mode: string }> {
  return apiPost(`/admin/llamacpp/perf/${mode}`, {})
}

export async function getBrainUpdaterStatus(): Promise<BrainUpdaterStatus> {
  return apiGet('/admin/llamacpp/updater/status')
}

export async function postBrainUpdaterAction(action: string, backend: string): Promise<{ ok: boolean; version?: string; error?: string; log?: string[] }> {
  return apiPost(`/admin/llamacpp/updater/${action}/${backend}`, {})
}

// ── Lucebox sub-updater ────────────────────────────────────────────────────
// Fork llama.cpp dédié au backend Lucebox (DFlash speculative decoding).
// `phase` parcourt les étapes du build : git-pull → submodule → cmake.
export type LuceboxUpdaterPhase = '' | 'git-pull' | 'submodule' | 'cmake'

export type LuceboxUpdaterStatus = {
  local_sha: string
  remote_sha: string
  /** Nombre de commits que `local_sha` est en retard sur `remote_sha`. > 0 → update dispo. */
  behind: number
  /** true si `test_dflash` (et server.py) est buildé et utilisable. */
  build_exists: boolean
  in_progress: boolean
  phase: LuceboxUpdaterPhase
  log_tail: string[]
  error?: string
}

export type LuceboxUpdaterLog = {
  log: string[]
  in_progress: boolean
  phase: string
  error?: string
}

export type LuceboxUpdaterResult = {
  ok: boolean
  local_sha?: string
  log_tail?: string[]
  detail?: string
  error?: string
}

export async function getLuceboxUpdaterStatus(): Promise<LuceboxUpdaterStatus> {
  return apiGet('/admin/llamacpp/updater/lucebox/status')
}

export async function getLuceboxUpdaterLog(): Promise<LuceboxUpdaterLog> {
  return apiGet('/admin/llamacpp/updater/lucebox/log')
}

export async function postLuceboxUpdate(): Promise<LuceboxUpdaterResult> {
  return apiPost('/admin/llamacpp/updater/lucebox/update', {})
}

export async function postLuceboxBuild(): Promise<LuceboxUpdaterResult> {
  return apiPost('/admin/llamacpp/updater/lucebox/build', {})
}

export async function postBrainReboot(): Promise<{ status: string }> {
  return apiPost('/admin/llamacpp/reboot', {})
}

// ── Brain Settings (persistés dans DB Mercury) ──────────────────────────────

export type BrainSettings = {
  thermal_auto_start: boolean
  perf_mode: 'performance' | 'turbo' | 'optimized' | 'eco' | null
  thermal_thresholds: {
    throttle_start_c: number
    throttle_full_c: number
    emergency_c: number
    resume_c: number
  }
  memory_auto_start: boolean
  memory_thresholds: {
    ram_warn_percent: number
    ram_evict_percent: number
    ram_emergency_percent: number
    swap_flush_percent: number
  }
}

export async function getBrainSettings(): Promise<BrainSettings> {
  return apiGet('/admin/llamacpp/brain-settings')
}

export async function saveBrainSettings(settings: Partial<BrainSettings>): Promise<{ settings: BrainSettings; push: Record<string, unknown> }> {
  return apiPut('/admin/llamacpp/brain-settings', settings)
}

// ── Benchmark ────────────────────────────────────────────────────────────────

export type BenchmarkPreset = {
  id: string
  name: string
  category: 'auto' | 'tool' | 'manual' | 'pp'
  difficulty?: 'simple' | 'medium' | 'complexe'
  description: string
  messages: Array<{ role: string; content: string }>
  expected_gen_tokens: number
  has_validators?: boolean
  has_tool_expected?: boolean
}

export type BenchmarkRunParams = {
  model_id: string
  messages?: Array<{ role: string; content: string }>
  preset_id?: string
  max_tokens?: number
  temperature?: number
  cache_prompt?: boolean
}

export type BenchmarkRunResponse = {
  prompt_tokens?: number
  generation_tokens?: number
  pp_ms?: number
  pp_tok_s?: number
  gen_ms?: number
  gen_tok_s?: number
  wall_ms?: number
  response_text: string
  model_id: string
  preset_id?: string
  preset_category: string
  cache_prompt: boolean
  auto_score?: number | null
  tool_score?: number | null
  validation_details?: string
  error?: string
}

export type ManualRating = {
  pertinence: number
  precision: number
  clarte: number
}

export type ModelMetadata = {
  model_id?: string
  display_name: string
  architecture: 'dense' | 'moe'
  params_b: number
  active_params_b?: number | null
  quant: string
  notes?: string
}

export type BenchmarkResult = {
  id: string
  timestamp: string
  model_id: string
  preset_id?: string
  preset_category: string
  prompt_tokens?: number
  generation_tokens?: number
  pp_ms?: number
  pp_tok_s?: number
  gen_ms?: number
  gen_tok_s?: number
  wall_ms?: number
  response_preview: string
  auto_score?: number | null
  tool_score?: number | null
  manual_rating?: ManualRating | null
  conv_rating?: number | null  // note conversation /10
  validation_details?: string
  notes?: string
  exchanges?: Array<{
    question: string
    response: string
    rating: number
    pp_tok_s?: number
    gen_tok_s?: number
    wall_ms?: number
  }>
}

export type BenchmarkSuiteResponse = {
  model_id: string
  results: Array<BenchmarkRunResponse & { preset_name?: string; error?: string }>
  auto_score: string | null
  tool_score: string | null
}

export async function getBenchmarkPresets(): Promise<{ presets: BenchmarkPreset[] }> {
  return apiGet('/admin/benchmark/presets')
}

export async function runBenchmark(params: BenchmarkRunParams): Promise<BenchmarkRunResponse> {
  return apiPost('/admin/benchmark/run', params)
}

export async function runBenchmarkSuite(params: { model_id: string; run_auto?: boolean; run_tool?: boolean }): Promise<BenchmarkSuiteResponse> {
  return apiPost('/admin/benchmark/run-suite', params)
}

export async function getBenchmarkResults(): Promise<{ results: BenchmarkResult[] }> {
  return apiGet('/admin/benchmark/results')
}

export async function saveBenchmarkResult(result: Omit<BenchmarkResult, 'id' | 'timestamp'>): Promise<{ ok: boolean; id: string }> {
  return apiPost('/admin/benchmark/results', result)
}

export async function updateBenchmarkResult(id: string, updates: Partial<BenchmarkResult>): Promise<{ ok: boolean }> {
  return apiPatch(`/admin/benchmark/results/${id}`, updates)
}

export async function deleteBenchmarkResult(id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/admin/benchmark/results/${id}`)
}

export async function getBenchmarkModels(): Promise<{ models: Record<string, ModelMetadata> }> {
  return apiGet('/admin/benchmark/models')
}

export async function setBenchmarkModel(modelId: string, data: ModelMetadata): Promise<{ ok: boolean }> {
  return apiPut(`/admin/benchmark/models/${encodeURIComponent(modelId)}`, data)
}

export async function deleteBenchmarkModel(modelId: string): Promise<{ ok: boolean }> {
  return apiDelete(`/admin/benchmark/models/${encodeURIComponent(modelId)}`)
}

export type ConvTemplate = {
  name: string
  system_prompt: string
  questions: string[]
  /** Optional OpenAI-style tools array (used by Live Chat to test tool-calling capacity).
   *  Stored as parsed JSON array; the Live Chat textarea displays it via JSON.stringify. */
  tools?: unknown[]
}

export async function getConvTemplates(): Promise<{ templates: Record<string, ConvTemplate> }> {
  return apiGet('/admin/benchmark/conv-templates')
}

export async function setConvTemplate(id: string, data: ConvTemplate): Promise<{ ok: boolean }> {
  return apiPut(`/admin/benchmark/conv-templates/${encodeURIComponent(id)}`, data)
}

export async function deleteConvTemplate(id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/admin/benchmark/conv-templates/${encodeURIComponent(id)}`)
}

// ── Brain Memory Management ─────────────────────────────────────────────────

export type MemoryPool = {
  total_mb: number; used_mb: number; available_mb: number; percent: number
  swap_used_mb?: number; swap_total_mb?: number; swap_percent?: number
}
export type MemoryModelInfo = {
  model_id: string; vram_delta_mb: number
  ram_delta_mb: number; ram_estimated_mb: number; ram_rss_mb: number; ram_display_mb: number
  load_order: number; idle_seconds: number
  protected: boolean; thermal_stopped: boolean
}
export type MemoryEvent = {
  ts: number; type: string; model_id: string; reason: string
  memory_before_pct: number; memory_after_pct: number
  freed_mb: number; kv_saved: boolean
}
export type MemoryStatus = {
  running: boolean
  ram: MemoryPool; vram: MemoryPool
  pressure: { ram: boolean; vram: boolean }
  models: MemoryModelInfo[]
  thresholds: Record<string, number>
  events_count: number
}
export type MemoryEventsResponse = { events: MemoryEvent[] }

export async function getBrainMemoryStatus(): Promise<MemoryStatus> {
  return apiGet('/admin/brain/memory/status')
}
export async function getBrainMemoryEvents(): Promise<MemoryEventsResponse> {
  return apiGet('/admin/brain/memory/events')
}
export async function postBrainMemoryStart(): Promise<{ status: string }> {
  return apiPost('/admin/brain/memory/start')
}
export async function postBrainMemoryStop(): Promise<{ status: string }> {
  return apiPost('/admin/brain/memory/stop')
}
export async function patchBrainMemoryConfig(cfg: Record<string, number>): Promise<{ status: string; thresholds: Record<string, number> }> {
  return apiPatch('/admin/brain/memory/config', cfg)
}
export async function postBrainMemoryProtect(modelId: string): Promise<{ status: string }> {
  return apiPost(`/admin/brain/memory/protect/${encodeURIComponent(modelId)}`)
}
export async function postBrainMemoryUnprotect(modelId: string): Promise<{ status: string }> {
  return apiPost(`/admin/brain/memory/unprotect/${encodeURIComponent(modelId)}`)
}
export async function postBrainMemoryEvict(modelId: string): Promise<{ status: string }> {
  return apiPost(`/admin/brain/memory/evict/${encodeURIComponent(modelId)}`)
}
export async function postBrainMemorySwapClear(): Promise<{ status: string; detail?: string }> {
  return apiPost('/admin/brain/memory/swap-clear')
}

// ── Models / Downloader (HuggingFace) ────────────────────────────────────────

export type HfModelSummary = {
  repo_id: string
  downloads: number
  likes: number
  last_modified: string | null
  tags: string[]
  gated: boolean
}

export type HfFile = {
  path: string
  size: number
  quant: string | null
  is_shard: boolean
}

export type HfDownloadJob = {
  id: string
  repo_id: string
  filename: string
  revision: string | null
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  bytes_done: number
  bytes_total: number
  pct: number
  speed_bps: number
  error: string | null
  local_path: string | null
  cancel_requested: boolean
  queued_at: number
  started_at: number | null
  finished_at: number | null
}

export type HfTokenStatus = { configured: boolean; masked: string | null }

export type HfDiskUsage = {
  models_path: string
  models_used_gb: number
  disk_used_gb: number
  free_gb: number
  total_gb: number
}

export type HfSortKey = 'downloads' | 'likes' | 'last_modified'
export type HfSearchParams = {
  q?: string
  limit?: number
  ggufOnly?: boolean
  author?: string
  sort?: HfSortKey
}

export async function searchHfModels(p: HfSearchParams): Promise<HfModelSummary[]> {
  const params = new URLSearchParams({
    q: p.q ?? '',
    limit: String(p.limit ?? 50),
    gguf_only: String(p.ggufOnly ?? true),
    author: p.author ?? '',
    sort: p.sort ?? 'downloads',
  })
  return apiGet(`/admin/llamacpp/downloader/search?${params.toString()}`)
}

export async function listHfRepoFiles(repoId: string): Promise<{ repo_id: string; files: HfFile[] }> {
  return apiGet(`/admin/llamacpp/downloader/repo/${repoId}/files`)
}

export async function startHfDownload(body: { repo_id: string; filename: string; revision?: string }): Promise<{ job_id: string; status: string }> {
  return apiPost('/admin/llamacpp/downloader/download', body)
}

export async function listHfJobs(): Promise<HfDownloadJob[]> {
  return apiGet('/admin/llamacpp/downloader/jobs')
}

export async function cancelHfJob(jobId: string): Promise<HfDownloadJob> {
  return apiDelete(`/admin/llamacpp/downloader/jobs/${jobId}`)
}

export async function getHfToken(): Promise<HfTokenStatus> {
  return apiGet('/admin/llamacpp/downloader/token')
}

export async function setHfToken(token: string | null): Promise<{ configured: boolean }> {
  return apiPut('/admin/llamacpp/downloader/token', { token })
}

export async function getHfDiskUsage(): Promise<HfDiskUsage> {
  return apiGet('/admin/llamacpp/downloader/disk')
}

export async function deleteLocalModel(modelId: string): Promise<{ deleted: string[]; model_id: string }> {
  return apiDelete(`/admin/llamacpp/downloader/models/${modelId}`)
}

// --- Scheduler (model schedules with exclusive slots) ---

export type ScheduleAction = {
  type: 'snapshot_state' | 'restore_state' | 'unload_all' | 'load' | 'unload'
  backend?: string
  model?: string
}

export type ScheduleGuard = {
  wait_idle: boolean
  max_wait_seconds: number
}

export type ModelSchedule = {
  id: string
  name: string
  cron_start: string
  duration_minutes: number
  exclusive: boolean
  allowed_consumers: string[]
  actions_start: ScheduleAction[]
  actions_end: ScheduleAction[]
  guard: ScheduleGuard
  enabled: boolean
  timezone: string
  next_start_at?: string | null
  created_at: string
}

export type ActiveSlot = {
  schedule_id: string
  schedule_name: string
  started_at: string
  ends_at: string
  exclusive: boolean
  allowed_consumers: string[]
  snapshot?: { loaded_models: { backend: string; model_id: string }[] } | null
}

export type ScheduleRun = {
  id: string
  schedule_id: string
  schedule_name: string
  phase: string
  status: string
  started_at: string
  finished_at?: string | null
  error?: string | null
  actions_log: string[]
}

export async function getSchedules(): Promise<{ schedules: ModelSchedule[]; active_slot: ActiveSlot | null }> {
  return apiGet('/admin/schedules')
}

export async function createSchedule(data: Omit<ModelSchedule, 'id' | 'created_at' | 'next_start_at'>): Promise<ModelSchedule> {
  return apiPost('/admin/schedules', data)
}

export async function updateSchedule(id: string, data: Partial<ModelSchedule>): Promise<ModelSchedule> {
  return apiPut(`/admin/schedules/${id}`, data)
}

export async function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/admin/schedules/${id}`)
}

export async function triggerSchedule(id: string): Promise<{ ok: boolean; error?: string }> {
  return apiPost(`/admin/schedules/${id}/trigger`)
}

export async function deactivateSlot(): Promise<{ ok: boolean }> {
  return apiPost('/admin/schedules/deactivate')
}

export async function getScheduleHistory(): Promise<{ runs: ScheduleRun[] }> {
  return apiGet('/admin/schedules-history')
}
