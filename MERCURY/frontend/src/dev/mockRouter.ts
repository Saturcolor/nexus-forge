import { tryAdminRoutes } from './handlers/admin-routes'
import { tryInference } from './handlers/inference'
import { tryEmbeddings } from './handlers/embeddings'
import { tryHealthz } from './handlers/healthz'
import { llamacppLogsSseStream } from './stream-utils'

function sameOrigin(urlStr: string): boolean {
  try {
    const u = new URL(urlStr, window.location.origin)
    return u.origin === window.location.origin
  } catch {
    return false
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const ct = req.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) return undefined
  return req.clone().json().catch(() => undefined)
}

/**
 * Point d’entrée unique mock. Retourne null → laisser passer au fetch d’origine.
 */
export async function routeMockRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  if (!sameOrigin(url.href)) return null

  // On colle ?query au pathname pour que les handlers qui parsent avec
  // `pathname.slice(pathname.indexOf('?'))` puissent y accéder. Les checks
  // d'égalité stricte (`pathname === '/admin/foo'`) sur des routes sans query
  // string restent valides.
  const pathname = url.pathname + (url.search || '')
  const method = req.method
  const headers = req.headers
  const signal = req.signal
  const body = await readJsonBody(req)

  const logsMatch = /^\/admin\/llamacpp\/logs-stream\/([^/]+)$/.exec(pathname)
  if (logsMatch && method === 'GET') {
    const modelId = decodeURIComponent(logsMatch[1])
    return new Response(llamacppLogsSseStream(signal, modelId), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    })
  }

  if (pathname === '/atlas/health' && method === 'GET') {
    const cfg = (await import('./mockState')).getState().config
    if (!cfg.atlas_enabled) {
      return new Response(
        JSON.stringify({ enabled: false, configured_brain_url: cfg.atlas_brain_url }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ enabled: true, initialized: true, current_job: null }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  // ── /atlas/presets — liste des presets AtlasMind pour un modèle ───────────
  if (url.pathname === '/atlas/presets' && method === 'GET') {
    const st = (await import('./mockState')).getMutableState()
    const modelId = url.searchParams.get('model_id')
    // Sans model_id : renvoie tous les presets exportables (comme le vrai backend
    // qui proxy AtlasMind /presets/export sans filtre). Dédup par id.
    let presets
    if (modelId) {
      presets = st.atlasPresetsByModel[modelId] ?? []
    } else {
      const byId = new Map<number, (typeof st.atlasPresetsByModel)[string][number]>()
      for (const list of Object.values(st.atlasPresetsByModel)) {
        for (const p of list) byId.set(p.id, p)
      }
      presets = [...byId.values()]
    }
    return new Response(
      JSON.stringify({ presets, count: presets.length }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (url.pathname === '/atlas/mgmt/apply-preset' && method === 'POST') {
    const st = (await import('./mockState')).getMutableState()
    const b = (body ?? {}) as { model_id?: string; preset_id?: number }
    const model = st.llamacppModels.find(m => m.model_id === b.model_id)
    const presets = b.model_id ? (st.atlasPresetsByModel[b.model_id] ?? []) : []
    const preset = presets.find(p => p.id === b.preset_id)
    if (!model || !preset) {
      return new Response(
        JSON.stringify({ detail: `[mock] model or preset not found` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }
    model.active_preset_id = preset.id
    model.active_preset_ids = [preset.id]
    model.active_preset_name = preset.name
    return new Response(
      JSON.stringify({ applied: true, preset_id: preset.id, preset_name: preset.name, model_id: b.model_id }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (url.pathname === '/atlas/mgmt/apply-presets' && method === 'POST') {
    const st = (await import('./mockState')).getMutableState()
    const b = (body ?? {}) as { model_id?: string; preset_ids?: number[] }
    const model = st.llamacppModels.find(m => m.model_id === b.model_id)
    const presetIds = Array.isArray(b.preset_ids) ? b.preset_ids : []
    if (!model || presetIds.length === 0) {
      return new Response(
        JSON.stringify({ detail: `[mock] model not found or preset_ids empty` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const presets = b.model_id ? (st.atlasPresetsByModel[b.model_id] ?? []) : []
    const matched = presetIds
      .map(pid => presets.find(p => p.id === pid))
      .filter((p): p is NonNullable<typeof p> => !!p)
    if (matched.length === 0) {
      return new Response(
        JSON.stringify({ detail: `[mock] aucun preset matché parmi ${presetIds}` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }
    model.active_preset_id = matched[0].id
    model.active_preset_ids = matched.map(p => p.id)
    model.active_preset_name = matched.map(p => p.name).join(' + ')
    return new Response(
      JSON.stringify({
        assigned: true,
        preset_ids: model.active_preset_ids,
        preset_name: model.active_preset_name,
        model_id: b.model_id,
        loras_count: matched.filter(p => p.lora_path).length,
        cv_count: matched[0].control_vectors.length,
        cv_skipped: matched.slice(1).filter(p => p.control_vectors.length > 0).map(p => p.id),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (url.pathname === '/atlas/mgmt/clear-preset' && method === 'POST') {
    const st = (await import('./mockState')).getMutableState()
    const b = (body ?? {}) as { model_id?: string }
    const model = st.llamacppModels.find(m => m.model_id === b.model_id)
    if (!model) {
      return new Response(
        JSON.stringify({ detail: `[mock] model not found` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }
    model.active_preset_id = null
    model.active_preset_ids = []
    model.active_preset_name = null
    return new Response(
      JSON.stringify({ cleared: true, model_id: b.model_id }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (pathname === '/api/voices' && method === 'GET') {
    return new Response(
      JSON.stringify({
        stt_models: [{ name: 'whisper-1', provider: 'openai' }],
        tts_models: [{ name: 'tts-1', provider: 'openai' }],
        voices: [{ name: 'Alloy', provider: 'openai', voice_id: 'alloy' }],
        realtime_models: [{ name: 'gpt-4o-realtime-preview', provider: 'openai' }],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  const h = tryHealthz(pathname, method)
  if (h) return h

  const e = tryEmbeddings(pathname, method, headers)
  if (e) return e

  const inf = tryInference(pathname, method, body, signal, headers)
  if (inf) return inf

  const a = tryAdminRoutes(pathname, method, body, signal)
  if (a) return a

  return jsonNotImplemented(pathname, method)
}

function jsonNotImplemented(pathname: string, method: string): Response {
  return new Response(
    JSON.stringify({
      detail: `[mock] Route non implémentée: ${method} ${pathname}`,
    }),
    { status: 501, headers: { 'Content-Type': 'application/json' } },
  )
}
