import { clsx } from 'clsx'
import type { ReactNode } from 'react'

type StatTileProps = {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'muted'
}

const TONE_CLASSES: Record<NonNullable<StatTileProps['tone']>, { box: string; value: string; label: string }> = {
  default:     { box: 'bg-background border-border/60',                             value: 'text-foreground',         label: 'text-muted-foreground' },
  primary:     { box: 'bg-primary/5 border-primary/30 ring-1 ring-primary/15',      value: 'text-primary',            label: 'text-primary/80' },
  success:     { box: 'bg-theme-green/5 border-theme-green/30',                     value: 'text-theme-green',        label: 'text-theme-green/80' },
  warning:     { box: 'bg-theme-amber/5 border-theme-amber/30',                     value: 'text-theme-amber',        label: 'text-theme-amber/80' },
  destructive: { box: 'bg-destructive/5 border-destructive/30',                     value: 'text-destructive',        label: 'text-destructive/80' },
  muted:       { box: 'bg-background border-border/40',                             value: 'text-muted-foreground',   label: 'text-muted-foreground/70' },
}

/** Compact KPI tile — number on top, uppercase tracked label below. */
export function StatTile({ label, value, hint, tone = 'default' }: StatTileProps) {
  const t = TONE_CLASSES[tone]
  return (
    <div className={clsx(
      'flex flex-col items-center justify-center px-2 py-2.5 rounded-lg border',
      t.box,
    )}>
      <span className={clsx('text-xl font-bold tabular-nums leading-tight', t.value)}>{value}</span>
      <span className={clsx('text-[10px] uppercase tracking-widest font-semibold mt-0.5', t.label)}>{label}</span>
      {hint && <span className="text-[10px] text-muted-foreground/60 mt-0.5">{hint}</span>}
    </div>
  )
}
