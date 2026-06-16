import { useHostStats } from '../../api/queries'
import type { HostStats, LlamacppModelMetrics } from '../../api/admin'
import Spinner from '../Spinner'

function formatUptime(seconds: number | undefined): string {
  if (seconds == null || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}j`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0 || parts.length === 0) parts.push(`${m}m`)
  return parts.join(' ')
}


function formatMb(n: number | undefined): string {
  if (n == null) return '—'
  return n >= 1024 ? `${(n / 1024).toFixed(1)} Go` : `${n} Mo`
}

function formatMbRange(used: number | undefined, total: number | undefined): string {
  if (used != null && total != null && total > 0) return `${formatMb(used)} / ${formatMb(total)}`
  if (used != null) return formatMb(used)
  return '—'
}

/** Temps relatif depuis last_activity_ts (ex. 45s, 2m, 2h, 1j 3h). */
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

function formatProgress(raw: string | undefined | null): { label: string; title?: string } {
  if (!raw || raw === 'loading') return { label: 'Chargement…' }
  // "loading:45" → "⟳ Chargement 45%"
  const loadPct = raw.match(/^loading:(\d+)$/)
  if (loadPct) return { label: `Chargement ${loadPct[1]}%` }
  // "23/50" → "46%", tooltip "23/50"
  const frac = raw.match(/^(\d+)\/(\d+)$/)
  if (frac) {
    const pct = Math.round((parseInt(frac[1]) / parseInt(frac[2])) * 100)
    return { label: `${pct}%`, title: `${raw}` }
  }
  return { label: raw }
}

function BackendStatusRow({
  label,
  loadedModel,
  model_loading,
  loading_progress,
  last_generation_tokens_per_second,
  last_prompt_tokens,
  last_generation_tokens,
  last_activity_ts,
  ctxSize,
}: {
  label: string
  loadedModel?: string
  model_loading?: boolean
  loading_progress?: string | null
  last_generation_tokens_per_second?: number | null
  last_prompt_tokens?: number | null
  last_generation_tokens?: number | null
  last_activity_ts?: number | null
  ctxSize?: number | null
}) {
  const promptPctMatch = loading_progress?.match(/^prompt:(\d+)$/)
  let statusEl: React.ReactNode
  if (model_loading) {
    const { label: pLabel, title } = formatProgress(loading_progress ?? undefined)
    statusEl = <span className="animate-pulse text-orange-400 font-mono" title={title}>⟳ {pLabel}</span>
  } else if (promptPctMatch) {
    statusEl = <span className="animate-pulse text-blue-400 font-mono">⚡ Prompt {promptPctMatch[1]}%</span>
  } else if (loading_progress === 'idle') {
    statusEl = <span className="text-neutral-500">Idle</span>
  } else if (loading_progress === 'loaded') {
    statusEl = <span className="text-green-400">Ready</span>
  } else if (loading_progress != null) {
    const { label: pLabel, title } = formatProgress(loading_progress)
    statusEl = <span className="text-neutral-300 font-mono" title={title}>{pLabel}</span>
  } else if (loadedModel) {
    statusEl = <span className="text-neutral-300 font-mono" title="Modèle chargé">{loadedModel}</span>
  } else {
    statusEl = <span className="text-neutral-500">—</span>
  }

  const ctxPct = ctxSize != null && ctxSize > 0 && last_prompt_tokens != null
    ? Math.min(100, Math.round((last_prompt_tokens / ctxSize) * 100))
    : null

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs pt-2 border-t border-neutral-800 mt-2">
      <span className="flex items-center gap-1.5">
        <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0" style={{ minWidth: '5rem' }}>{label}</span>
        {statusEl}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-neutral-500 uppercase tracking-wider font-medium">Génération</span>
        <span className="text-white font-mono">
          {last_generation_tokens_per_second != null ? `${last_generation_tokens_per_second.toFixed(1)} tok/s` : '—'}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-neutral-500 uppercase tracking-wider font-medium">Ctx</span>
        {ctxPct != null && ctxSize != null && last_prompt_tokens != null ? (
          <span className="flex items-center gap-1.5">
            <div className="w-14 h-1.5 bg-neutral-800 rounded-full overflow-hidden shrink-0">
              <div
                className={`h-full rounded-full transition-all ${ctxPct > 80 ? 'bg-orange-500' : 'bg-blue-500/70'}`}
                style={{ width: `${ctxPct}%` }}
              />
            </div>
            <span className="text-white font-mono tabular-nums">{last_prompt_tokens.toLocaleString()}/{ctxSize.toLocaleString()}</span>
          </span>
        ) : (
          <span className="text-white font-mono">
            {last_prompt_tokens != null ? `${last_prompt_tokens.toLocaleString()} tok` : '—'}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-neutral-500 uppercase tracking-wider font-medium">Output</span>
        <span className="text-white font-mono">
          {last_generation_tokens != null ? `${last_generation_tokens.toLocaleString()} tok` : '—'}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-neutral-500 uppercase tracking-wider font-medium">Activité</span>
        <span className="text-white font-mono">{formatActivity(last_activity_ts ?? undefined)}</span>
      </span>
    </div>
  )
}

function LmStudioStatus({ lm }: { lm: NonNullable<HostStats['lmstudio']> }) {
  return (
    <BackendStatusRow
      label="LM Studio"
      model_loading={lm.model_loading}
      loading_progress={lm.loading_progress}
      last_generation_tokens_per_second={lm.last_generation_tokens_per_second}
      last_prompt_tokens={lm.last_prompt_tokens}
      last_generation_tokens={lm.last_generation_tokens}
      last_activity_ts={lm.last_activity_ts}
      ctxSize={lm.ctx_size}
    />
  )
}

function OllamaStatus({ ollama }: { ollama: NonNullable<HostStats['ollama']> }) {
  // La probe Ollama ne renvoie jamais "idle" → le déduire de loaded_models si absent
  const effectiveProgress = ollama.loading_progress
    ?? (ollama.loaded_models?.length ? 'loaded' : 'idle')
  return (
    <BackendStatusRow
      label="Ollama"
      model_loading={ollama.model_loading}
      loading_progress={effectiveProgress}
      last_generation_tokens_per_second={ollama.last_generation_tokens_per_second}
      last_prompt_tokens={ollama.last_prompt_tokens}
      last_generation_tokens={ollama.last_generation_tokens}
      last_activity_ts={ollama.last_activity_ts}
    />
  )
}

function shortLlamacppLabel(modelId: string): string {
  if (!modelId) return '—'
  const parts = modelId.split('/').filter(Boolean)
  const seg = parts[parts.length - 1] ?? modelId
  return seg.length > 36 ? `${seg.slice(0, 33)}…` : seg
}

/** État affiché par instance (daemon : prompt_pct / loading_pct par llama-server, pas l’agrégat host-stats). */
function llamacppInstanceRowState(
  inst: NonNullable<NonNullable<HostStats['llamacpp']>['instances']>[number],
): { model_loading: boolean; loading_progress: string | null } {
  const running = inst.running === true
  const ready = inst.ready === true
  if (running && !ready) {
    const pct = inst.loading_pct ?? 0
    return { model_loading: true, loading_progress: pct ? `loading:${pct}` : 'loading' }
  }
  if (ready) {
    const pp = inst.prompt_pct ?? 0
    if (pp > 0) {
      return { model_loading: false, loading_progress: `prompt:${Math.min(100, Math.round(pp))}` }
    }
    return { model_loading: false, loading_progress: 'loaded' }
  }
  return { model_loading: false, loading_progress: 'idle' }
}

/** Détermine le provider Mercury d'une instance brain-daemon depuis les signaux de
 *  /mgmt/status (backend_type) + /mgmt/models (kind, enrichi côté Python).
 *  Tolère plusieurs signaux pour vLLM : `kind === 'hf'` est le plus fiable mais
 *  peut manquer si le join /mgmt/models a échoué côté Python. On accepte aussi
 *  un `backend_type` qui contient "vllm" (ex: "vllm-rocm") comme fallback. */
function providerForInstance(
  inst: NonNullable<NonNullable<HostStats['llamacpp']>['instances']>[number],
): 'lucebox' | 'vllm' | 'llamacpp' {
  if (inst.backend_type === 'lucebox') return 'lucebox'
  if (inst.kind === 'hf') return 'vllm'
  if (typeof inst.backend_type === 'string' && inst.backend_type.includes('vllm')) return 'vllm'
  return 'llamacpp'
}

const PROVIDER_LABELS = {
  lucebox: 'Lucebox',
  vllm: 'vLLM',
  llamacpp: 'LlamaCPP',
} as const

function LlamaCppInstanceRows({ llamacpp }: { llamacpp: NonNullable<HostStats['llamacpp']> }) {
  const byModel = llamacpp.by_model ?? {}
  const runningInst = (llamacpp.instances ?? []).filter(i => i.running === true)
  if (runningInst.length === 0) {
    // Pas d'instance running → rangée agrégée legacy (labellée LlamaCPP par défaut).
    // Les métriques agrégées du daemon ne distinguent pas le provider du dernier appel,
    // donc on garde un label générique tant qu'aucune instance n'est ready.
    return (
      <BackendStatusRow
        label="LlamaCPP"
        model_loading={llamacpp.model_loading}
        loading_progress={llamacpp.loading_progress}
        last_generation_tokens_per_second={llamacpp.last_generation_tokens_per_second}
        last_prompt_tokens={llamacpp.last_prompt_tokens}
        last_generation_tokens={llamacpp.last_generation_tokens}
        last_activity_ts={llamacpp.last_activity_ts}
        ctxSize={llamacpp.instances?.[0]?.ctx_size}
      />
    )
  }
  // Ordre d'affichage : lucebox, vllm puis llamacpp — providers spécialisés en haut.
  const orderRank = { lucebox: 0, vllm: 1, llamacpp: 2 } as const
  const sorted = [...runningInst].sort((a, b) => {
    const ra = orderRank[providerForInstance(a)]
    const rb = orderRank[providerForInstance(b)]
    if (ra !== rb) return ra - rb
    return (a.model_id ?? '').localeCompare(b.model_id ?? '')
  })
  return (
    <>
      {sorted.map(inst => {
        const mid = inst.model_id ?? ''
        const m: LlamacppModelMetrics | undefined = byModel[mid]
        const { model_loading, loading_progress } = llamacppInstanceRowState(inst)
        const provider = providerForInstance(inst)
        return (
          <BackendStatusRow
            key={mid}
            label={`${PROVIDER_LABELS[provider]} · ${shortLlamacppLabel(mid)}`}
            model_loading={model_loading}
            loading_progress={loading_progress}
            last_generation_tokens_per_second={m?.last_generation_tokens_per_second ?? null}
            last_prompt_tokens={m?.last_prompt_tokens ?? null}
            last_generation_tokens={m?.last_generation_tokens ?? null}
            last_activity_ts={m?.last_activity_ts ?? null}
            ctxSize={inst.ctx_size}
          />
        )
      })}
    </>
  )
}

export default function HostStatsCard() {
  const { data: stats, isLoading } = useHostStats()

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Stats machine</h2>
      </div>
      <div className="px-4 py-3">
        {isLoading && <Spinner />}
        {!isLoading && (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
              <span className="flex items-center gap-2">
                <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">CPU</span>
                <span className="text-white font-mono">{stats?.cpu?.percent != null ? `${stats.cpu.percent}%` : '—'}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">GPU</span>
                <span className="text-white font-mono">{stats?.gpu?.percent != null ? `${stats.gpu.percent}%` : stats?.gpu?.name ?? '—'}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">RAM</span>
                <span className="text-white font-mono">{formatMbRange(stats?.ram?.used_mb, stats?.ram?.total_mb)}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">VRAM</span>
                <span className="text-white font-mono">{formatMbRange(stats?.vram?.used_mb, stats?.vram?.total_mb)}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">Uptime</span>
                <span className="text-white font-mono">{formatUptime(stats?.uptime_seconds)}</span>
              </span>
              {stats?.temperature != null && typeof stats.temperature !== 'number' && (
                <>
                  {stats.temperature.cpu_c != null && (
                    <span className="flex items-center gap-2">
                      <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">CPU°</span>
                      <span className="text-white font-mono">{stats.temperature.cpu_c} °C</span>
                    </span>
                  )}
                  {stats.temperature.gpu_c != null && (
                    <span className="flex items-center gap-2">
                      <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">GPU°</span>
                      <span className="text-white font-mono">{stats.temperature.gpu_c} °C</span>
                    </span>
                  )}
                  {stats.temperature.nvme_c != null && (
                    <span className="flex items-center gap-2">
                      <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">NVMe°</span>
                      <span className="text-white font-mono">{stats.temperature.nvme_c} °C</span>
                    </span>
                  )}
                </>
              )}
              <span className="flex items-center gap-2">
                <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">Réseau</span>
                <span className="text-white font-mono">
                  {stats?.network != null && (stats.network.rx_mb != null || stats.network.tx_mb != null)
                    ? `↓${formatMb(stats.network.rx_mb)} ↑${formatMb(stats.network.tx_mb)}`
                    : stats?.network?.rx_mbps != null || stats?.network?.tx_mbps != null
                      ? `↓${stats.network.rx_mbps ?? 0} ↑${stats.network.tx_mbps ?? 0} Mbit/s`
                      : '—'}
                </span>
              </span>
              {stats?.brain != null && (
                <>
                  {stats.brain.power_w != null && (
                    <span className="flex items-center gap-2">
                      <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">Power</span>
                      <span className="text-white font-mono">{stats.brain.power_w} W</span>
                    </span>
                  )}
                  {stats.brain.governor != null && (
                    <span className="flex items-center gap-2">
                      <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">Gov</span>
                      <span className={`font-mono ${stats.brain.governor === 'performance' ? 'text-emerald-400' : 'text-neutral-400'}`}>
                        {stats.brain.governor === 'performance' ? 'perf' : stats.brain.governor}
                      </span>
                    </span>
                  )}
                  {stats.brain.gpu_level != null && (
                    <span className="flex items-center gap-2">
                      <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">GPU</span>
                      <span className={`font-mono ${stats.brain.gpu_level === 'high' ? 'text-emerald-400' : 'text-neutral-400'}`}>
                        {stats.brain.gpu_level}
                      </span>
                    </span>
                  )}
                  {stats.brain.thermal_level != null && stats.brain.thermal_level !== 'off' && (
                    <span className="flex items-center gap-2">
                      <span className="text-neutral-500 uppercase tracking-wider font-medium shrink-0">Thermal</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                        stats.brain.thermal_level === 'emergency'
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      }`}>
                        {stats.brain.thermal_level === 'emergency' ? 'EMERGENCY' : 'Active'}
                      </span>
                    </span>
                  )}
                </>
              )}
            </div>
            {stats?.lmstudio != null && <LmStudioStatus lm={stats.lmstudio} />}
            {stats?.ollama != null && <OllamaStatus ollama={stats.ollama} />}
            {stats?.llamacpp != null && <LlamaCppInstanceRows llamacpp={stats.llamacpp} />}
          </>
        )}
      </div>
    </section>
  )
}
