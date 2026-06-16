import { clsx } from 'clsx'

type Tone = 'primary' | 'success' | 'warning' | 'destructive' | 'muted'

const TONE: Record<Tone, string> = {
  primary:     'bg-primary',
  success:     'bg-theme-green',
  warning:     'bg-theme-amber',
  destructive: 'bg-destructive',
  muted:       'bg-muted-foreground/40',
}

/** Slim horizontal bar — pure visual, no labels. */
export function ProgressBar({
  value,
  tone = 'primary',
  className,
  thickness = 'sm',
}: {
  value: number  // 0..100
  tone?: Tone
  className?: string
  thickness?: 'xs' | 'sm' | 'md'
}) {
  const v = Math.max(0, Math.min(100, value))
  const h = thickness === 'xs' ? 'h-1' : thickness === 'md' ? 'h-2' : 'h-1.5'
  return (
    <span className={clsx('block w-full rounded-full bg-secondary overflow-hidden', h, className)}>
      <span
        className={clsx('block h-full rounded-full transition-all duration-500', TONE[tone])}
        style={{ width: `${v}%` }}
      />
    </span>
  )
}

/** Metric row: label · big value · progress bar. Designed for vertical stacks. */
export function MetricRow({
  label,
  value,
  hint,
  pct,
  tone = 'primary',
}: {
  label: string
  value: string
  hint?: string
  pct?: number  // when set, renders progress bar
  tone?: Tone
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
          {label}
        </span>
        <span className="text-sm font-mono tabular-nums text-foreground">
          {value}
          {hint && <span className="text-muted-foreground/60 text-[11px] ml-1">{hint}</span>}
        </span>
      </div>
      {pct != null && <ProgressBar value={pct} tone={tone} thickness="xs" />}
    </div>
  )
}
