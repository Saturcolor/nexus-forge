import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import type { BenchmarkRunResponse, ManualRating } from '../../../api/admin'

// ── Tokens shared by all benchmark sub-cards ────────────────────────────────

export const LBL_CLASS =
  'text-[10px] uppercase tracking-widest font-semibold text-muted-foreground'
export const VAL_CLASS = 'font-mono tabular-nums text-foreground'

export const inputSm =
  'px-2 py-1 bg-background border border-border/60 rounded text-[11px] text-foreground font-mono ' +
  'focus:outline-none focus:ring-2 focus:ring-ring/40'
export const selectSm =
  'px-2 py-1 bg-background border border-border/60 rounded text-[11px] text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-ring/40 cursor-pointer'
export const textareaSm =
  'w-full bg-background border border-border/60 rounded-lg p-2.5 text-[11px] text-foreground font-mono ' +
  'focus:outline-none focus:ring-2 focus:ring-ring/40'

// ── Tiny presentational helpers (V2 styling) ────────────────────────────────

export function Lbl({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx(LBL_CLASS, className)}>{children}</span>
}

export function Val({
  children,
  tone,
  className,
}: {
  children: ReactNode
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'muted' | 'purple'
  className?: string
}) {
  const c =
    tone === 'primary'     ? 'text-primary' :
    tone === 'success'     ? 'text-theme-green' :
    tone === 'warning'     ? 'text-theme-amber' :
    tone === 'destructive' ? 'text-destructive' :
    tone === 'muted'       ? 'text-muted-foreground' :
    tone === 'purple'      ? 'text-theme-purple' :
    'text-foreground'
  return <span className={clsx('font-mono tabular-nums font-bold', c, className)}>{children}</span>
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function fmt(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// ── Benchmark constants ─────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<string, string> = {
  pp: 'Prompt Processing',
  auto: 'Auto',
  tool: 'Tool Calling',
  manual: 'Manuel',
  custom: 'Custom',
}

export const CATEGORY_ORDER = ['pp', 'auto', 'tool', 'manual']

// ── MetricsRow — used by RunCard ────────────────────────────────────────────

export function MetricsRow({ run }: { run: BenchmarkRunResponse }) {
  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
      <MetricCell label="PP tok/s"  value={fmt(run.pp_tok_s)}  tone="primary" />
      <MetricCell label="Gen tok/s" value={fmt(run.gen_tok_s)} tone="success" />
      <MetricCell label="PP time"   value={fmtMs(run.pp_ms)} />
      <MetricCell label="Gen time"  value={fmtMs(run.gen_ms)} />
      <MetricCell label="Wall time" value={fmtMs(run.wall_ms)} />
      <MetricCell
        label="Tokens"
        value={`${run.prompt_tokens ?? '?'} / ${run.generation_tokens ?? '?'}`}
      />
    </div>
  )
}

function MetricCell({
  label, value, tone,
}: {
  label: string
  value: ReactNode
  tone?: 'primary' | 'success'
}) {
  const c = tone === 'primary' ? 'text-primary' : tone === 'success' ? 'text-theme-green' : 'text-foreground'
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-border/40 bg-background px-2 py-2">
      <span className={clsx('font-mono tabular-nums font-bold text-sm', c)}>{value}</span>
      <span className={clsx(LBL_CLASS, 'mt-0.5')}>{label}</span>
    </div>
  )
}

// ── RatingGrid — pertinence / précision / clarté ────────────────────────────

export function RatingGrid({
  rating, onChange,
}: {
  rating: ManualRating
  onChange: (r: ManualRating) => void
}) {
  const axes: Array<{ key: keyof ManualRating; label: string }> = [
    { key: 'pertinence', label: 'Pertinence' },
    { key: 'precision',  label: 'Précision' },
    { key: 'clarte',     label: 'Clarté' },
  ]
  return (
    <div className="flex gap-4 flex-wrap">
      {axes.map(({ key, label }) => (
        <div key={key}>
          <Lbl>{label}</Lbl>
          <div className="flex gap-1 mt-1">
            {[1, 2, 3, 4, 5].map(v => (
              <button
                key={v}
                type="button"
                className={clsx(
                  'w-7 h-7 rounded text-[11px] font-bold transition-colors',
                  rating[key] === v
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:bg-secondary/70',
                )}
                onClick={() => onChange({ ...rating, [key]: v })}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <Lbl>Moyenne</Lbl>
        <div className="mt-1">
          <Val tone="warning">
            {((rating.pertinence + rating.precision + rating.clarte) / 3).toFixed(1)}/5
          </Val>
        </div>
      </div>
    </div>
  )
}

// ── Difficulty weights for ranking scoring (identical to V1) ────────────────

export const DIFFICULTY_WEIGHTS: Record<string, number> = {
  math_arithmetic: 1, math_word_problem: 2,
  logic_deduction: 1, logic_sequence: 2,
  code_function: 1, code_debug: 2,
  extraction_facts: 1, extraction_structured: 2,
  instruction_format: 1, instruction_constraints: 3,
  tool_read_simple: 1, tool_bash_simple: 1, tool_list_dir: 1,
  tool_edit_medium: 2, tool_memory_medium: 2, tool_search_medium: 2,
  tool_multi_complex: 3, tool_edit_complex: 3, tool_no_narration: 3,
}
