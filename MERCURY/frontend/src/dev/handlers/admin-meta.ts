import type {
  BenchmarkResult,
  ConvTemplate,
  ModelMetadata,
  ModelSchedule,
} from '../../api/admin'
import { json } from '../http-helpers'
import * as mockState from '../mockState'
import { randomId, s } from './shared-admin'

export function tryAdminMeta(pathname: string, method: string, body: unknown): Response | null {
  const st = s()
  if (pathname === '/admin/benchmark/presets' && method === 'GET') return json({ presets: st.benchmarkPresets })
  if (pathname === '/admin/benchmark/run' && method === 'POST') {
    const p = body as { model_id: string }
    return json({
      model_id: p.model_id,
      preset_category: 'pp',
      cache_prompt: false,
      response_text: 'Mock benchmark completion.',
      wall_ms: 400,
      pp_tok_s: 800,
      gen_tok_s: 60,
    })
  }
  if (pathname === '/admin/benchmark/run-suite' && method === 'POST') {
    const p = body as { model_id: string }
    return json({
      model_id: p.model_id,
      results: [],
      auto_score: '8.5',
      tool_score: null,
    })
  }
  if (pathname === '/admin/benchmark/results' && method === 'GET') return json({ results: st.benchmarkResults })
  if (pathname === '/admin/benchmark/results' && method === 'POST') {
    const r = body as Omit<BenchmarkResult, 'id' | 'timestamp'>
    const id = randomId('br')
    st.benchmarkResults.push({
      ...r,
      id,
      timestamp: new Date().toISOString(),
    } as BenchmarkResult)
    return json({ ok: true, id })
  }
  const brRes = /^\/admin\/benchmark\/results\/([^/]+)$/.exec(pathname)
  if (brRes && method === 'PATCH') {
    const row = st.benchmarkResults.find(x => x.id === brRes[1])
    if (row) Object.assign(row, body as object)
    return json({ ok: true })
  }
  if (brRes && method === 'DELETE') {
    st.benchmarkResults = st.benchmarkResults.filter(x => x.id !== brRes[1])
    return json({ ok: true })
  }
  if (pathname === '/admin/benchmark/models' && method === 'GET') return json({ models: st.benchmarkModels })
  const bmPut = /^\/admin\/benchmark\/models\/([^/]+)$/.exec(pathname)
  if (bmPut && method === 'PUT') {
    st.benchmarkModels[decodeURIComponent(bmPut[1])] = body as ModelMetadata
    return json({ ok: true })
  }
  if (bmPut && method === 'DELETE') {
    delete st.benchmarkModels[decodeURIComponent(bmPut[1])]
    return json({ ok: true })
  }
  if (pathname === '/admin/benchmark/conv-templates' && method === 'GET') return json({ templates: st.convTemplates })
  const ctPut = /^\/admin\/benchmark\/conv-templates\/([^/]+)$/.exec(pathname)
  if (ctPut && method === 'PUT') {
    st.convTemplates[decodeURIComponent(ctPut[1])] = body as ConvTemplate
    return json({ ok: true })
  }
  if (ctPut && method === 'DELETE') {
    delete st.convTemplates[decodeURIComponent(ctPut[1])]
    return json({ ok: true })
  }

  if (pathname === '/admin/schedules' && method === 'GET') {
    return json(mockState.buildSchedulesResponse())
  }
  if (pathname === '/admin/schedules' && method === 'POST') {
    const data = body as Omit<ModelSchedule, 'id' | 'created_at' | 'next_start_at'>
    const id = randomId('sched')
    const created: ModelSchedule = {
      ...data,
      id,
      created_at: new Date().toISOString(),
      next_start_at: null,
    }
    st.schedules.push(created)
    return json(created)
  }
  const schPut = /^\/admin\/schedules\/([^/]+)$/.exec(pathname)
  if (schPut && method === 'PUT') {
    const id = schPut[1]
    const row = st.schedules.find(x => x.id === id)
    if (row) Object.assign(row, body as Partial<ModelSchedule>)
    return json(row!)
  }
  if (schPut && method === 'DELETE') {
    st.schedules = st.schedules.filter(x => x.id !== schPut[1])
    return json({ ok: true })
  }
  const trig = /^\/admin\/schedules\/([^/]+)\/trigger$/.exec(pathname)
  if (trig && method === 'POST') {
    st.activeSlotScheduleId = trig[1]
    return json({ ok: true })
  }
  if (pathname === '/admin/schedules/deactivate' && method === 'POST') {
    st.activeSlotScheduleId = null
    return json({ ok: true })
  }
  if (pathname === '/admin/schedules-history' && method === 'GET') {
    return json({ runs: st.scheduleHistory })
  }

  const benchStart = /^\/admin\/ext-bench\/([^/]+)\/(start|stop)$/.exec(pathname)
  if (benchStart && method === 'POST') {
    return json({ ok: true })
  }
  if (pathname === '/admin/toolcall15/status' && method === 'GET') {
    return json({
      bench_id: 'toolcall15',
      label: 'ToolCall-15',
      enabled: true,
      ...st.extBenchToolcall,
      service_url: 'http://localhost:3015',
      configured_daemon: 'mock',
    })
  }
  if (pathname === '/admin/toolcall15/sandbox-status' && method === 'GET') {
    return json({ online: !!st.extBenchToolcall.sandbox_online })
  }
  if (pathname === '/admin/toolcall15/sync-env' && method === 'POST') {
    return json({ ok: true, models: (body as { models: string[] }).models })
  }
  if (pathname === '/admin/bugfind15/status' && method === 'GET') {
    return json({
      bench_id: 'bugfind15',
      label: 'BugFind-15',
      enabled: true,
      ...st.extBenchBugfind,
      service_url: 'http://localhost:3016',
      configured_daemon: 'mock',
    })
  }
  if (pathname === '/admin/bugfind15/sandbox-status' && method === 'GET') {
    return json({ online: !!st.extBenchBugfind.sandbox_online })
  }
  if (pathname === '/admin/bugfind15/sync-env' && method === 'POST') {
    return json({ ok: true, models: (body as { models: string[] }).models })
  }
  if (
    (pathname === '/admin/toolcall15/sandbox-start' || pathname === '/admin/toolcall15/sandbox-stop'
      || pathname === '/admin/bugfind15/sandbox-start' || pathname === '/admin/bugfind15/sandbox-stop')
    && method === 'POST'
  ) {
    return new Response(null, { status: 204 })
  }

  if (pathname === '/admin/brain/memory/status' && method === 'GET') {
    return json({
      running: true,
      ram: { total_mb: 32768, used_mb: 16384, available_mb: 16384, percent: 50 },
      vram: { total_mb: 16384, used_mb: 8192, available_mb: 8192, percent: 50 },
      pressure: { ram: false, vram: false },
      models: [],
      thresholds: {},
      events_count: 0,
    })
  }
  if (pathname === '/admin/brain/memory/events' && method === 'GET') return json({ events: [] })
  if (pathname === '/admin/brain/memory/start' && method === 'POST') return json({ status: 'started' })
  if (pathname === '/admin/brain/memory/stop' && method === 'POST') return json({ status: 'stopped' })
  if (pathname === '/admin/brain/memory/config' && method === 'PATCH') {
    return json({ status: 'ok', thresholds: (body as Record<string, number>) ?? {} })
  }
  if (pathname.match(/^\/admin\/brain\/memory\/(protect|unprotect|evict)\//) && method === 'POST') {
    return json({ status: 'ok' })
  }
  if (pathname === '/admin/brain/memory/swap-clear' && method === 'POST') {
    return json({ status: 'ok' })
  }

  return null
}
