import type { BackendStatus, Config } from '../../api/admin'
import { json } from '../http-helpers'
import { ndjsonStatusStream } from '../stream-utils'
import { scenarios } from '../mockScenarios'
import { s } from './shared-admin'
import { tryAdminMeta } from './admin-meta'
import { tryAdminLlamacpp } from './admin-llamacpp-routes'
import { tryAdminOmnivoiceRoutes, getOmniMockState } from './admin-omnivoice-routes'

/** Routes /admin/* hors logs-stream (mockRouter). */
export function tryAdminRoutes(
  pathname: string,
  method: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Response | null {
  const st = s()

  if (pathname === '/admin/version' && method === 'GET') {
    return json({ version: '0.0.0-mock' })
  }

  if (pathname === '/admin/config' && method === 'GET') {
    return json(st.config)
  }
  if (pathname === '/admin/config' && method === 'POST') {
    st.config = { ...st.config, ...(body as Config) }
    return json({ ok: true })
  }

  if (pathname === '/admin/queue' && method === 'GET') {
    return json(st.queue)
  }
  if (pathname === '/admin/queue/cancel' && method === 'POST') {
    st.queue = { ...st.queue, current_request: undefined, in_progress: 0 }
    return json({ cancelled: true })
  }

  if (pathname === '/admin/backends' && method === 'GET') {
    let list: BackendStatus[] = st.backends
    if (scenarios.ollamaDown) {
      list = st.backends.map(b =>
        b.name === 'ollama' ? { ...b, status: 'error', error: 'connection refused (mock)', status_code: 500 } : b,
      )
    }
    return json(list)
  }

  if (pathname === '/admin/lm-studio/probe' && method === 'GET') {
    return json({
      configured: true,
      system: { cpu_percent: 22, memory: { used_mb: 8192, total_mb: 32768, percent: 25 } },
      lmstudio: {},
      last_generation_tokens_per_second: 42,
    })
  }
  if (pathname === '/admin/ollama/probe' && method === 'GET') {
    if (scenarios.ollamaDown) {
      return json({
        configured: true,
        error: 'ollama_url unreachable (mock)',
        status_code: 500,
        detail: 'ECONNREFUSED',
      })
    }
    return json({
      configured: true,
      system: { cpu_percent: 18, memory: { used_mb: 4096, total_mb: 32768, percent: 12 } },
      ollama: {},
    })
  }

  if (pathname === '/admin/lm-studio/models' && method === 'GET') {
    return json({
      models: [
        { key: 'mistral-7b-v0.3', display_name: 'Mistral 7B', loaded_instances: [{ id: 'lm-1', config: {} }] },
      ],
    })
  }

  if (pathname === '/admin/host-stats' && method === 'GET') {
    // Mock shaped like the real /admin/host-stats payload (HostStats type).
    // Pre-rebuild this returned flat fields (cpu_percent, ram_used_mb…) which
    // never matched the typed nested shape — the dashboard rendered everything
    // as "—". Now we feed a realistic snapshot so the V2 viz exercises.
    const t = Date.now() / 1000
    return json({
      cpu:  { percent: 31 },
      gpu:  { name: 'RX 7900 XT', percent: 45 },
      ram:  { used_mb: 41 * 1024, total_mb: 128 * 1024 },
      vram: { used_mb: 19 * 1024, total_mb: 24 * 1024 },
      uptime_seconds: 3 * 86400 + 12 * 3600 + 47 * 60,
      temperature: { cpu_c: 52, gpu_c: 68, nvme_c: 44 },
      network: { rx_mb: 142, tx_mb: 28 },
      brain: {
        power_w: 180,
        governor: 'performance',
        gpu_level: 'high',
        thermal_level: 'off',
      },
      llamacpp: {
        instances: [
          {
            model_id: 'unsloth/Mistral-Small-Instruct-2409-GGUF',
            ctx_size: 32768,
            port: 8080,
            pid: 12345,
            ready: true,
            running: true,
            prompt_pct: 0,
            kind: 'gguf',
          },
          {
            model_id: 'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF',
            ctx_size: 16384,
            port: 8081,
            pid: 12346,
            ready: true,
            running: true,
            prompt_pct: 38,
            kind: 'gguf',
          },
        ],
        by_model: {
          'unsloth/Mistral-Small-Instruct-2409-GGUF': {
            last_generation_tokens_per_second: 42.7,
            last_prompt_tokens: 1204,
            last_generation_tokens: 318,
            last_activity_ts: t - 18,
          },
          'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF': {
            last_generation_tokens_per_second: 18.4,
            last_prompt_tokens: 6232,
            last_generation_tokens: 542,
            last_activity_ts: t - 4,
          },
        },
      },
    })
  }

  if (pathname === '/admin/lm-studio/load' && method === 'POST') return json({ ok: true, status: 200, body: {} })
  if (pathname === '/admin/lm-studio/unload' && method === 'POST') return json({ ok: true, status: 200, body: {} })
  if (pathname === '/admin/lm-studio/inject-prompt' && method === 'POST') return json({ ok: true, status: 200, body: {} })

  if (pathname === '/admin/provider-priority' && method === 'PUT') {
    st.providerPriority = (body as { order: string[] }).order
    st.config.provider_priority = st.providerPriority
    return new Response(null, { status: 204 })
  }
  if (pathname === '/admin/model-priority' && method === 'PUT') {
    st.modelPriority = { ...(body as { order_by_backend: Record<string, string[]> }).order_by_backend }
    return new Response(null, { status: 204 })
  }
  if (pathname === '/admin/hidden-models' && method === 'PATCH') {
    const { model_name, hidden } = body as { model_name: string; hidden: boolean }
    if (hidden) {
      if (!st.hiddenModels.includes(model_name)) st.hiddenModels.push(model_name)
    } else {
      st.hiddenModels = st.hiddenModels.filter(x => x !== model_name)
    }
    return json({ ok: true, hidden_model_names: [...st.hiddenModels] })
  }
  if (pathname === '/admin/unload-protected-models' && method === 'PATCH') {
    const { model_name, protected: isProtected } = body as { model_name: string; protected: boolean }
    if (isProtected) {
      if (!st.protectedModels.includes(model_name)) st.protectedModels.push(model_name)
    } else {
      st.protectedModels = st.protectedModels.filter(x => x !== model_name)
    }
    return json({ ok: true, protected_model_names: [...st.protectedModels] })
  }
  if (pathname === '/admin/model-categories' && method === 'PATCH') {
    const { model_name, category } = body as { model_name: string; category: string | null }
    const m = st.cacheModels.find(x => x.name === model_name)
    if (m && category) m.category = category
    return json({ ok: true, category_order: st.categoryOrder })
  }

  if (pathname.startsWith('/admin/logs') && method === 'GET') {
    const q = pathname.includes('?') ? pathname.slice(pathname.indexOf('?')) : ''
    const date = new URLSearchParams(q).get('date') ?? st.dates[0] ?? ''
    return json(st.logsByDate[date] ?? [])
  }
  if (pathname.startsWith('/admin/stats-range') && method === 'GET') {
    const q = pathname.includes('?') ? pathname.slice(pathname.indexOf('?')) : ''
    const sp = new URLSearchParams(q)
    const days = Math.max(1, Math.min(366, parseInt(sp.get('days') ?? '7', 10) || 7))
    const bucket = (sp.get('bucket') === 'hour' ? 'hour' : 'day') as 'day' | 'hour'
    const now = new Date()
    const points: Array<{
      t: string; requests: number; duration_ms: number;
      input_tokens: number; output_tokens: number; reasoning_tokens: number;
    }> = []
    const seed = (k: number) => Math.abs(Math.sin(k * 12.9898) * 43758.5453) % 1
    if (bucket === 'hour') {
      const total = Math.max(24, days * 24)
      for (let i = total - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 3600_000)
        d.setMinutes(0, 0, 0)
        const t = d.toISOString().slice(0, 13) + ':00:00Z'
        const r = Math.floor(seed(i + 1) * 12)
        points.push({
          t,
          requests: r,
          duration_ms: r * 1500 + Math.floor(seed(i + 7) * 500),
          input_tokens: r * 800,
          output_tokens: r * 350,
          reasoning_tokens: 0,
        })
      }
    } else {
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400_000)
        const t = d.toISOString().slice(0, 10)
        const r = Math.floor(seed(i + 3) * 80)
        points.push({
          t,
          requests: r,
          duration_ms: r * 1800,
          input_tokens: r * 950,
          output_tokens: r * 420,
          reasoning_tokens: Math.floor(r * 20),
        })
      }
    }
    // Breakdown mock (déterministe, basé sur les seeds des points)
    const totalReq = points.reduce((s, p) => s + p.requests, 0)
    const totalTok = points.reduce((s, p) => s + p.input_tokens + p.output_tokens, 0)
    const totalDur = points.reduce((s, p) => s + p.duration_ms, 0)
    const backendMix: Record<string, number> = {
      llamacpp: 0.55,
      ollama: 0.22,
      lm_studio: 0.13,
      openrouter: 0.10,
    }
    const by_backend: Record<string, { requests: number; duration_ms: number; tokens: number }> = {}
    for (const [k, frac] of Object.entries(backendMix)) {
      by_backend[k] = {
        requests: Math.round(totalReq * frac),
        duration_ms: Math.round(totalDur * frac),
        tokens: Math.round(totalTok * frac),
      }
    }
    const modelMix: Record<string, number> = {
      'Mistral-Small-Instruct-2409': 0.30,
      'Qwen2.5-Coder-32B-Instruct': 0.25,
      'gemma-3-27b-distill': 0.18,
      'llama-3.3-70b-instruct': 0.12,
      'phi-4-14b': 0.08,
      'claude-3-5-sonnet': 0.07,
    }
    const by_model: Record<string, { requests: number; duration_ms: number; tokens: number }> = {}
    for (const [k, frac] of Object.entries(modelMix)) {
      by_model[k] = {
        requests: Math.round(totalReq * frac),
        duration_ms: Math.round(totalDur * frac),
        tokens: Math.round(totalTok * frac),
      }
    }
    // Heatmap 7×24 : intensité de fin d'aprèm en semaine, calme le weekend / nuit
    const by_dow_hour: number[][] = []
    for (let d = 0; d < 7; d++) {
      const row: number[] = []
      for (let h = 0; h < 24; h++) {
        const workday = d < 5 ? 1 : 0.35
        const peak = Math.exp(-Math.pow(h - 15, 2) / 28)
        const morning = Math.exp(-Math.pow(h - 10, 2) / 18) * 0.6
        const base = (peak + morning) * workday
        const noise = seed(d * 31 + h + 11) * 0.4
        row.push(Math.max(0, Math.round((base + noise) * 18)))
      }
      by_dow_hour.push(row)
    }
    return json({ bucket, points, breakdown: { by_backend, by_model, by_dow_hour } })
  }
  if (pathname.startsWith('/admin/stats') && method === 'GET') {
    const q = pathname.includes('?') ? pathname.slice(pathname.indexOf('?')) : ''
    const date = new URLSearchParams(q).get('date') ?? st.dates[0] ?? ''
    return json(
      st.statsByDate[date] ?? {
        date,
        by_user: {},
        total_requests: 0,
        total_duration_ms: 0,
      },
    )
  }
  if (pathname === '/admin/dates' && method === 'GET') {
    return json(st.dates)
  }

  if (pathname === '/admin/users' && method === 'GET') {
    return json(st.users.map(u => u.entry))
  }
  if (pathname === '/admin/users' && method === 'POST') {
    const b = body as { user_id: string; priority: number; threshold?: boolean }
    st.users.push({
      entry: {
        user_id: b.user_id,
        priority: b.priority,
        threshold: b.threshold ?? false,
        key_prefix: `sk-mock-${b.user_id.slice(0, 2)}`,
      },
      apiKey: `sk-mock-${b.user_id}-generated`,
    })
    return json({ user_id: b.user_id, priority: b.priority, api_key: `sk-mock-${b.user_id}-generated` })
  }
  if (pathname === '/admin/users' && method === 'PATCH') {
    const b = body as { user_id: string; priority?: number; threshold?: boolean; new_user_id?: string }
    const row = st.users.find(u => u.entry.user_id === b.user_id)
    if (row) {
      if (b.priority != null) row.entry.priority = b.priority
      if (b.threshold != null) row.entry.threshold = b.threshold
      if (b.new_user_id) row.entry.user_id = b.new_user_id
    }
    return json({ ok: true })
  }
  if (pathname.startsWith('/admin/users') && method === 'DELETE') {
    const u = new URL(`http://x${pathname}`)
    const uid = u.searchParams.get('user_id')
    if (uid) st.users = st.users.filter(x => x.entry.user_id !== uid)
    return json({ ok: true })
  }

  if (pathname.startsWith('/admin/credits') && method === 'GET') {
    if (pathname.includes('/totals')) {
      return json({
        fetchedAt: new Date().toISOString(),
        totalRemaining: 42.5,
        remaining: { openrouter: 42.5, anthropic: null },
      })
    }
    return json({
      fetchedAt: new Date().toISOString(),
      providers: {
        openrouter: { ok: true, remaining: 42.5, totalCredits: 100, currency: 'USD' },
        anthropic: { ok: false, error: 'not configured (mock)' },
      },
      errors: [],
    })
  }

  if (pathname === '/admin/cache' && method === 'GET') return json(st.cacheState)
  if (pathname === '/admin/cache/models' && method === 'GET') {
    return json({
      models: st.cacheModels,
      hidden_model_names: st.hiddenModels,
      protected_model_names: st.protectedModels,
      category_order: st.categoryOrder,
    })
  }
  if (pathname === '/admin/cache/refresh' && method === 'POST') {
    st.cacheState = { ...st.cacheState, updated_at: new Date().toISOString(), count: st.cacheModels.length }
    return json({ ok: true, count: st.cacheModels.length })
  }
  if (pathname === '/admin/cache/flush' && method === 'POST') {
    return json({ ok: true, count: 0 })
  }

  if (pathname === '/admin/model-mapping' && method === 'GET') {
    const from_cache = st.cacheModels.map(m => ({
      canonical: m.name,
      backend: m.backend ?? 'ollama',
      backend_model_id: m.name,
    }))
    return json({
      from_config: st.modelMappingFromConfig,
      from_cache,
      backend_models: st.cacheModels.map(m => ({
        name: m.name,
        backend: m.backend ?? 'ollama',
        backend_model_id: m.name,
        normalized: m.name.toLowerCase(),
      })),
    })
  }

  if (pathname === '/admin/openrouter/models' && method === 'GET') {
    return json({ data: st.openRouterModels })
  }
  if (pathname === '/admin/openrouter/health' && method === 'GET') {
    return json({
      metrics: {
        by_model: {},
        by_provider: {},
        in_flight: {},
        last_generation_tokens_per_second: null,
      },
      circuit_breaker: {
        config: { failure_window_s: 60, failure_threshold: 5, tracked_categories: [] },
        providers: {},
        blacklist: [],
      },
      fallback: { enabled: false, triggers: [], chain: [] },
      api_key_set: true,
    })
  }
  if (pathname === '/admin/openrouter/circuit_breaker/reset' && method === 'POST') {
    return json({ reset: true, providers: {} })
  }
  if (pathname === '/admin/openrouter/credits' && method === 'GET') {
    return json({ data: { total_credits: 100, total_usage: 57.5 } })
  }

  if (pathname === '/admin/anthropic/models' && method === 'GET') {
    return json({ models: [{ id: 'claude-3-5-haiku-20241022', name: 'Haiku' }] })
  }
  if (pathname === '/admin/anthropic/credentials' && method === 'POST') {
    return json({ ok: true })
  }

  if (pathname === '/admin/audio/openai/models' && method === 'GET') {
    return json({
      stt_models: [{ id: 'whisper-1', name: 'Whisper' }],
      tts_models: [{ id: 'tts-1', name: 'TTS' }],
      voices: [{ id: 'alloy', name: 'Alloy' }],
    })
  }
  if (pathname === '/admin/audio/groq/models' && method === 'GET') {
    return json({ stt_models: [{ id: 'whisper-large-v3', name: 'Whisper large v3' }] })
  }
  if (pathname === '/admin/audio/elevenlabs/voices' && method === 'GET') {
    return json({ voices: [{ voice_id: 'v1', name: 'Rachel' }], models: [] })
  }
  if (pathname === '/admin/audio/local/health' && method === 'GET') return json({
    configured: true,
    whisper_loaded: true,
    whisper_model: 'large-v3-turbo',
    kokoro_loaded: true,
    kokoro_lang: 'f',
    default_voice: 'ff_siwis',
    voices_count: 30,
    ...getOmniMockState(),
  })
  if (pathname === '/admin/audio/local/voices' && method === 'GET') {
    return json({ voices: [{ id: 'local-1', name: 'Local', provider: 'mock' }] })
  }
  if (pathname === '/admin/audio/local/libs/status' && method === 'GET') {
    return json({
      libs: { ffmpeg: '6.1.0', soundfile: '0.12.1', scipy: '1.11.0', kokoro: '0.9.4' },
      configured: true,
      upgrade_in_progress: false,
    })
  }
  if (pathname === '/admin/audio/local/libs/upgrade' && method === 'POST') return json({ ok: true })
  if (pathname === '/admin/audio/local/libs/log' && method === 'GET') {
    return json({ log: ['[mock] libs ok'], in_progress: false })
  }

  if (pathname === '/admin/cloud-fallback-order' && method === 'PUT') {
    st.cloudFallbackOrder = (body as { order: string[] }).order
    st.config.fallback_providers_order = st.cloudFallbackOrder
    return json({ ok: true })
  }

  if (pathname === '/admin/debug' && method === 'GET') return json({ debug: st.debug })
  if (pathname === '/admin/debug' && method === 'PATCH') {
    st.debug = !!(body as { debug: boolean }).debug
    st.config.debug = st.debug
    return json({ debug: st.debug })
  }

  if (pathname === '/admin/ollama/models' && method === 'GET') {
    return json({
      models: st.ollamaModelNames.map(name => ({ name, size: 4e9, modified_at: new Date().toISOString() })),
    })
  }
  if (pathname === '/admin/ollama/ps' && method === 'GET') {
    return json({
      models: st.ollamaRunning.map(name => ({ name, model: name })),
    })
  }
  if (pathname === '/admin/ollama/pull' && method === 'POST') {
    return new Response(
      ndjsonStatusStream(signal, [{ status: 'pulling' }, { status: 'complete' }]),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    )
  }
  if (pathname === '/admin/ollama/create' && method === 'POST') {
    return new Response(ndjsonStatusStream(signal, [{ status: 'creating' }, { status: 'success' }]), {
      headers: { 'Content-Type': 'application/x-ndjson' },
    })
  }
  if (pathname === '/admin/ollama/load' && method === 'POST') {
    const m = (body as { model: string }).model
    if (!st.ollamaRunning.includes(m)) st.ollamaRunning.push(m)
    return json({ ok: true, status: 200, body: {} })
  }
  if (pathname === '/admin/ollama/unload' && method === 'POST') {
    const m = (body as { model: string }).model
    st.ollamaRunning = st.ollamaRunning.filter(x => x !== m)
    return json({ ok: true, status: 200, body: {} })
  }
  if (pathname === '/admin/ollama/model' && method === 'DELETE') {
    const m = (body as { model: string }).model
    st.ollamaModelNames = st.ollamaModelNames.filter(x => x !== m)
    return json({ ok: true, status: 200, body: {} })
  }

  const meta = tryAdminMeta(pathname, method, body)
  if (meta) return meta

  const llm = tryAdminLlamacpp(pathname, method, body)
  if (llm) return llm

  const omni = tryAdminOmnivoiceRoutes(pathname, method, body)
  if (omni) return omni

  return null
}
