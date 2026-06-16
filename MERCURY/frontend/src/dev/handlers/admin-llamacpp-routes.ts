import { json } from '../http-helpers'
import { randomId, s } from './shared-admin'

export function tryAdminLlamacpp(pathname: string, method: string, body: unknown): Response | null {
  const hf = tryHf(pathname, method, body)
  if (hf) return hf
  return tryLlamacppRoutes(pathname, method, body)
}

function tryHf(pathname: string, method: string, body: unknown): Response | null {
  const st = s()
  if (pathname.startsWith('/admin/llamacpp/downloader/search') && method === 'GET') {
    return json([
      {
        repo_id: 'TheBloke/Llama-2-7B-GGUF',
        downloads: 1_200_000,
        likes: 800,
        last_modified: new Date().toISOString(),
        tags: ['gguf'],
        gated: false,
      },
    ])
  }
  const repoFiles = /^\/admin\/llamacpp\/downloader\/repo\/([^/]+)\/files$/.exec(pathname)
  if (repoFiles && method === 'GET') {
    return json({
      repo_id: decodeURIComponent(repoFiles[1]),
      files: [{ path: 'model.gguf', size: 4e9, quant: 'Q4_K_M', is_shard: false }],
    })
  }
  if (pathname === '/admin/llamacpp/downloader/download' && method === 'POST') {
    const b = body as { repo_id: string; filename: string }
    const id = randomId('job')
    st.hfJobs.push({
      id,
      repo_id: b.repo_id,
      filename: b.filename,
      revision: null,
      state: 'queued',
      bytes_done: 0,
      bytes_total: 1,
      pct: 0,
      speed_bps: 0,
      error: null,
      local_path: null,
      cancel_requested: false,
      queued_at: Date.now(),
      started_at: null,
      finished_at: null,
    })
    return json({ job_id: id, status: 'queued' })
  }
  if (pathname === '/admin/llamacpp/downloader/jobs' && method === 'GET') return json(st.hfJobs)
  const jobDel = /^\/admin\/llamacpp\/downloader\/jobs\/([^/]+)$/.exec(pathname)
  if (jobDel && method === 'DELETE') {
    const j = st.hfJobs.find(x => x.id === jobDel[1])
    if (j) j.state = 'cancelled'
    return json(j ?? { id: jobDel[1], state: 'cancelled' })
  }
  if (pathname === '/admin/llamacpp/downloader/token' && method === 'GET') {
    return json({ configured: st.hfTokenConfigured, masked: st.hfTokenMasked })
  }
  if (pathname === '/admin/llamacpp/downloader/token' && method === 'PUT') {
    const t = (body as { token: string | null }).token
    st.hfTokenConfigured = !!t
    st.hfTokenMasked = t ? `${t.slice(0, 4)}…` : null
    return json({ configured: st.hfTokenConfigured })
  }
  if (pathname === '/admin/llamacpp/downloader/disk' && method === 'GET') {
    return json({
      models_path: '/models',
      models_used_gb: 120,
      disk_used_gb: 400,
      free_gb: 200,
      total_gb: 600,
    })
  }
  const delModel = /^\/admin\/llamacpp\/downloader\/models\/([^/]+)$/.exec(pathname)
  if (delModel && method === 'DELETE') {
    return json({ deleted: ['file.gguf'], model_id: delModel[1] })
  }
  return null
}

function tryLlamacppRoutes(pathname: string, method: string, body: unknown): Response | null {
  const st = s()
  if (pathname === '/admin/llamacpp/models' && method === 'GET') {
    // Join templates into each model entry (production /admin/llamacpp/models does this).
    const models = st.llamacppModels.map(m => {
      const tpl = st.llamacppTemplates[m.model_id]
      return tpl ? { ...m, template: tpl } : m
    })
    return json({ models })
  }
  if (pathname === '/admin/llamacpp/probe' && method === 'GET') {
    // Realistic memory/protect/load_order/last_inference per running instance,
    // so the dashboard exercises the PIN badge, VRAM Δ chip, "last X" timestamp etc.
    const now = Date.now() / 1000
    const PROTECTED_SET = new Set([
      'unsloth/Qwen2.5-Coder-32B-Instruct-GGUF', // pinned in mock
    ])
    const instances = st.llamacppModels
      .filter(m => m.running)
      .map((m, idx) => ({
        model_id: m.model_id,
        ctx_size: m.ctx_size,
        port: m.port,
        pid: m.pid,
        ready: true,
        running: true,
        protected: PROTECTED_SET.has(m.model_id),
        vram_delta_mb: Math.round((m.size_gb ?? 4) * 1024 * 0.9),
        ram_rss_mb: Math.round((m.size_gb ?? 4) * 1024 * 0.15),
        ram_delta_mb: Math.round((m.size_gb ?? 4) * 1024 * 0.05),
        load_order: idx + 1,
        last_inference_ts: now - (idx === 0 ? 4 : 18),
      }))
    const by_model: Record<string, {
      last_generation_tokens_per_second: number
      last_prompt_tokens: number
      last_generation_tokens: number
      last_activity_ts: number
    }> = {}
    if (instances[0]) {
      by_model[instances[0].model_id] = {
        last_generation_tokens_per_second: 18.4,
        last_prompt_tokens: 6232,
        last_generation_tokens: 542,
        last_activity_ts: now - 4,
      }
    }
    if (instances[1]) {
      by_model[instances[1].model_id] = {
        last_generation_tokens_per_second: 42.7,
        last_prompt_tokens: 1204,
        last_generation_tokens: 318,
        last_activity_ts: now - 18,
      }
    }
    return json({
      configured: true,
      running_models: instances.length,
      instances,
      last_generation_tokens_per_second: 42.7,
      last_prompt_tokens: 1204,
      last_generation_tokens: 318,
      last_activity_ts: now - 4,
      by_model,
    })
  }
  if (pathname === '/admin/llamacpp/daemon-version' && method === 'GET') {
    return json({ version: 'b/mock', name: 'llama-server-mock' })
  }
  const sess = /^\/admin\/llamacpp\/session\/([^/]+)$/.exec(pathname)
  if (sess && method === 'GET') {
    return json({
      model_id: decodeURIComponent(sess[1]),
      ts: Date.now() / 1000,
      slots: {},
      proxy_metrics: null,
      n_ctx_max: 8192,
      slot_http_status: 200,
      slot_error: null,
    })
  }
  const lms = /^\/admin\/lm-studio\/session\/([^/]+)$/.exec(pathname)
  if (lms && method === 'GET') {
    return json({
      model_key: decodeURIComponent(lms[1]),
      ts: Date.now() / 1000,
      loaded_instances: [],
      models_http_status: 200,
    })
  }
  const osess = /^\/admin\/ollama\/session\/([^/]+)$/.exec(pathname)
  if (osess && method === 'GET') {
    return json({
      model_name: decodeURIComponent(osess[1]),
      ts: Date.now() / 1000,
      show: {},
      ps: {},
      show_http_status: 200,
    })
  }
  if (pathname === '/admin/llamacpp/templates' && method === 'GET') return json(st.llamacppTemplates)
  const tplPost = /^\/admin\/llamacpp\/templates\/([^/]+)$/.exec(pathname)
  if (tplPost && method === 'POST') {
    st.llamacppTemplates[decodeURIComponent(tplPost[1])] = body as never
    return json({ ok: true })
  }
  if (tplPost && method === 'DELETE') {
    delete st.llamacppTemplates[decodeURIComponent(tplPost[1])]
    return json({ ok: true })
  }
  if (pathname === '/admin/llamacpp/load' && method === 'POST') {
    const mid = (body as { model_id: string }).model_id
    let m = st.llamacppModels.find(x => x.model_id === mid)
    if (!m) {
      m = { model_id: mid, running: true, kind: 'gguf' }
      st.llamacppModels.push(m)
    }
    m.running = true
    return json({ ok: true, status: 200, body: {} })
  }
  if (pathname === '/admin/llamacpp/unload' && method === 'POST') {
    const mid = (body as { model_id: string }).model_id
    const m = st.llamacppModels.find(x => x.model_id === mid)
    if (m) m.running = false
    return json({ ok: true, status: 200, body: {} })
  }
  const kvSave = /^\/admin\/llamacpp\/kv-cache\/save\/([^/]+)$/.exec(pathname)
  if (kvSave && method === 'POST') return json({ ok: true, status: 200, body: {} })
  const kvDel = /^\/admin\/llamacpp\/kv-cache\/([^/]+)$/.exec(pathname)
  if (kvDel && method === 'DELETE') return json({ ok: true, status: 200, body: {} })
  if (pathname.startsWith('/admin/llamacpp/daemon-logs') && method === 'GET') {
    return json({ logs: ['[mock] daemon started'], error: undefined })
  }
  const slots = /^\/admin\/llamacpp\/slots\/([^/]+)$/.exec(pathname)
  if (slots && method === 'GET') {
    return json([{ id: 0, is_processing: false, n_ctx: 8192 }])
  }
  if (pathname === '/admin/llamacpp/perf/custom' && method === 'POST') {
    return json({ mode: 'custom', custom_stapm_w: null, custom_tctl_c: null })
  }
  if (pathname === '/admin/llamacpp/thermal/status' && method === 'GET') {
    return json({
      running: false,
      level: 'off',
      emergency: false,
      throttle_pct: null,
      temp_c: 55,
      power_w: 25,
      cpu_freq_khz: 3_200_000,
      gpu_level: 'low',
      governor: 'schedutil',
      stopped_pid: null,
      thresholds: { throttle_start_c: 75, throttle_full_c: 85, emergency_c: 95, resume_c: 65 },
    })
  }
  if (pathname === '/admin/llamacpp/thermal/start' && method === 'POST') return json({ status: 'started' })
  if (pathname === '/admin/llamacpp/thermal/stop' && method === 'POST') return json({ status: 'stopped' })
  if (pathname === '/admin/llamacpp/thermal/config' && method === 'POST') {
    return json({
      running: false,
      level: 'off',
      emergency: false,
      throttle_pct: null,
      temp_c: 55,
      power_w: 25,
      cpu_freq_khz: 3_200_000,
      gpu_level: 'low',
      governor: 'schedutil',
      stopped_pid: null,
      thresholds: { throttle_start_c: 75, throttle_full_c: 85, emergency_c: 95, resume_c: 65 },
    })
  }
  if (pathname === '/admin/llamacpp/perf/status' && method === 'GET') {
    return json({
      current_mode: 'balanced',
      governors: ['schedutil'],
      gpu_level: 'low',
      swappiness: '60',
      dirty_ratio: '20',
      thp: 'always',
      root: false,
      available_modes: ['performance', 'eco'],
      custom_stapm_w: null,
      custom_tctl_c: null,
    })
  }
  const perfMode = /^\/admin\/llamacpp\/perf\/([^/]+)$/.exec(pathname)
  if (perfMode && method === 'POST') return json({ mode: perfMode[1] })
  if (pathname === '/admin/llamacpp/updater/status' && method === 'GET') {
    return json({
      update_in_progress: false,
      vulkan: { type: 'toolbox', toolbox_name: 'vulkan', exists: true, version: '1.0', has_backup: false },
    })
  }
  const upd = /^\/admin\/llamacpp\/updater\/([^/]+)\/([^/]+)$/.exec(pathname)
  if (upd && method === 'POST') return json({ ok: true, version: 'mock' })
  if (pathname === '/admin/llamacpp/updater/lucebox/status' && method === 'GET') {
    return json({
      local_sha: 'abc',
      remote_sha: 'abc',
      behind: 0,
      build_exists: true,
      in_progress: false,
      phase: '',
      log_tail: [],
    })
  }
  if (pathname === '/admin/llamacpp/updater/lucebox/log' && method === 'GET') {
    return json({ log: [], in_progress: false, phase: '', error: undefined })
  }
  if (pathname === '/admin/llamacpp/updater/lucebox/update' && method === 'POST') {
    return json({ ok: true })
  }
  if (pathname === '/admin/llamacpp/updater/lucebox/build' && method === 'POST') {
    return json({ ok: true })
  }
  if (pathname === '/admin/llamacpp/reboot' && method === 'POST') return json({ status: 'scheduled' })
  if (pathname === '/admin/llamacpp/brain-settings' && method === 'GET') {
    return json({
      thermal_auto_start: false,
      perf_mode: 'balanced',
      thermal_thresholds: { throttle_start_c: 75, throttle_full_c: 85, emergency_c: 95, resume_c: 65 },
      memory_auto_start: true,
      memory_thresholds: { ram_warn_percent: 80, ram_evict_percent: 90, ram_emergency_percent: 95, swap_flush_percent: 85 },
    })
  }
  if (pathname === '/admin/llamacpp/brain-settings' && method === 'PUT') {
    return json({ settings: body as never, push: {} })
  }
  return null
}
