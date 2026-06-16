import { Zap } from 'lucide-react'
import { useHostStats, useQueue } from '../../../api/queries'
import type { HostStats, LlamacppModelMetrics } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge, StatusDot } from '../../ui/Badge'
import { ProgressBar } from '../../ui/Progress'

function formatActivity(ts: number | undefined | null): string {
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

function shortModel(id: string | undefined | null): string {
  if (!id) return '—'
  const parts = id.split('/').filter(Boolean)
  const seg = parts[parts.length - 1] ?? id
  return seg.length > 48 ? `${seg.slice(0, 45)}…` : seg
}

function providerForInstance(
  inst: NonNullable<NonNullable<HostStats['llamacpp']>['instances']>[number],
): 'lucebox' | 'vllm' | 'llamacpp' {
  if (inst.backend_type === 'lucebox') return 'lucebox'
  if (inst.kind === 'hf') return 'vllm'
  if (typeof inst.backend_type === 'string' && inst.backend_type.includes('vllm')) return 'vllm'
  return 'llamacpp'
}

const PROVIDER_TONE = {
  llamacpp: 'primary',
  lucebox:  'purple',
  vllm:     'success',
} as const

const PROVIDER_LABELS = {
  llamacpp: 'llamacpp',
  lucebox:  'lucebox',
  vllm:     'vllm',
} as const

const PROVIDER_TOOLTIPS = {
  llamacpp: 'llama.cpp — GGUF natif (mainline ou fork atomic-turboquant), backend par défaut',
  lucebox:  'Lucebox — wrapper batchable au-dessus de llama-server',
  vllm:     'vLLM — backend HF (kind=hf), modèles non-GGUF',
} as const

function instanceState(
  inst: NonNullable<NonNullable<HostStats['llamacpp']>['instances']>[number],
  isServing: boolean,
): { status: 'loading' | 'prompt' | 'generating' | 'ready' | 'idle'; pct?: number } {
  const running = inst.running === true
  const ready = inst.ready === true
  if (running && !ready) {
    return { status: 'loading', pct: inst.loading_pct ?? 0 }
  }
  if (ready) {
    const pp = inst.prompt_pct ?? 0
    if (pp > 0) return { status: 'prompt', pct: Math.min(100, Math.round(pp)) }
    if (isServing) return { status: 'generating' }
    return { status: 'ready' }
  }
  return { status: 'idle' }
}

function InstanceRow({
  inst,
  metrics,
  isServing,
}: {
  inst: NonNullable<NonNullable<HostStats['llamacpp']>['instances']>[number]
  metrics?: LlamacppModelMetrics
  isServing: boolean
}) {
  const provider = providerForInstance(inst)
  const { status, pct } = instanceState(inst, isServing)

  const ctxSize = inst.ctx_size ?? null
  const promptTok = metrics?.last_prompt_tokens ?? null
  const ctxPct = ctxSize != null && ctxSize > 0 && promptTok != null
    ? Math.min(100, Math.round((promptTok / ctxSize) * 100))
    : null
  const tps = metrics?.last_generation_tokens_per_second ?? null
  const outTok = metrics?.last_generation_tokens ?? null

  const statusBadge = (() => {
    switch (status) {
      case 'loading':    return <Badge tone="warning">⟳ chargement {pct ? `${pct}%` : ''}</Badge>
      case 'prompt':     return <Badge tone="primary">⚡ prompt {pct}%</Badge>
      case 'generating': return <Badge tone="primary">▶ generating</Badge>
      case 'ready':      return <Badge tone="success">ready</Badge>
      case 'idle':       return <Badge tone="muted">idle</Badge>
    }
  })()

  const ready = status === 'ready' || status === 'prompt' || status === 'generating'

  return (
    <li className="p-3 bg-background/60 border border-border/40 rounded-lg flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <StatusDot
          tone={ready ? 'success' : status === 'idle' ? 'muted' : 'warning'}
          pulse={status === 'loading' || status === 'prompt' || status === 'generating'}
        />
        <span title={PROVIDER_TOOLTIPS[provider]} className="inline-flex">
          <Badge tone={PROVIDER_TONE[provider]}>{PROVIDER_LABELS[provider]}</Badge>
        </span>
        <span className="text-xs font-mono text-foreground truncate flex-1 min-w-0" title={inst.model_id ?? undefined}>
          {shortModel(inst.model_id)}
        </span>
        {statusBadge}
      </div>

      {(ctxPct != null || tps != null || outTok != null) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
          {ctxPct != null && ctxSize != null && promptTok != null && (
            <div className="flex items-center gap-2 min-w-[180px] flex-1">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground shrink-0">Ctx</span>
              <span className="flex-1 min-w-[60px]">
                <ProgressBar value={ctxPct} tone={ctxPct > 80 ? 'warning' : 'primary'} thickness="xs" />
              </span>
              <span className="font-mono tabular-nums text-foreground/80 text-[10px] shrink-0">
                {promptTok.toLocaleString()}/{ctxSize.toLocaleString()}
              </span>
            </div>
          )}
          {tps != null && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Gen</span>
              <span className="font-mono text-foreground">{tps.toFixed(1)} tok/s</span>
            </span>
          )}
          {outTok != null && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Out</span>
              <span className="font-mono text-foreground">{outTok.toLocaleString()} tok</span>
            </span>
          )}
          {metrics?.last_activity_ts != null && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Last</span>
              <span className="font-mono text-muted-foreground">{formatActivity(metrics.last_activity_ts)}</span>
            </span>
          )}
        </div>
      )}
    </li>
  )
}

export function NowRunningCard() {
  const { data: stats } = useHostStats()
  const { data: queue } = useQueue()
  const llamacpp = stats?.llamacpp
  const byModel = llamacpp?.by_model ?? {}
  const running = (llamacpp?.instances ?? []).filter(i => i.running === true)

  const servingModel = queue?.current_request?.model ?? null

  const orderRank = { lucebox: 0, vllm: 1, llamacpp: 2 } as const
  const sorted = [...running].sort((a, b) => {
    const ra = orderRank[providerForInstance(a)]
    const rb = orderRank[providerForInstance(b)]
    if (ra !== rb) return ra - rb
    return (a.model_id ?? '').localeCompare(b.model_id ?? '')
  })

  return (
    <Card>
      <CardHeader
        title="Modèles actifs"
        icon={<Zap size={13} />}
        right={
          <Badge tone={running.length > 0 ? 'primary' : 'muted'} mono>
            {running.length} actif{running.length > 1 ? 's' : ''}
          </Badge>
        }
      />
      <CardBody className="!py-3">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-4 gap-1.5 text-center">
            <StatusDot tone="muted" />
            <span className="text-[11px] text-muted-foreground">
              Aucune instance llamacpp active
            </span>
            <span className="text-[10px] text-muted-foreground/50">
              Charge un modèle depuis la card ci-dessous
            </span>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {sorted.map(inst => {
              const id = inst.model_id ?? ''
              const isServing = servingModel != null && (
                servingModel === id || id.endsWith(servingModel) || servingModel.endsWith(id)
              )
              return (
                <InstanceRow
                  key={id || Math.random()}
                  inst={inst}
                  metrics={byModel[id]}
                  isServing={isServing}
                />
              )
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
