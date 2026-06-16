import { clsx } from 'clsx'
import type { ReactNode } from 'react'

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'muted' | 'purple'

const TONE: Record<Tone, string> = {
  neutral:     'bg-secondary text-foreground border-border/60',
  primary:     'bg-primary/10 text-primary border-primary/30',
  success:     'bg-theme-green/10 text-theme-green border-theme-green/30',
  warning:     'bg-theme-amber/10 text-theme-amber border-theme-amber/30',
  destructive: 'bg-destructive/10 text-destructive border-destructive/30',
  muted:       'bg-background text-muted-foreground border-border/40',
  purple:      'bg-theme-purple/10 text-theme-purple border-theme-purple/30',
}

export function Badge({
  children,
  tone = 'neutral',
  mono = false,
  className,
  title,
}: {
  children: ReactNode
  tone?: Tone
  mono?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={clsx(
      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border',
      mono && 'font-mono normal-case tracking-normal',
      TONE[tone],
      className,
    )}>
      {children}
    </span>
  )
}

/** Pulsating status dot used inside status rows. */
export function StatusDot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const color =
    tone === 'success' ? 'bg-theme-green' :
    tone === 'primary' ? 'bg-primary' :
    tone === 'warning' ? 'bg-theme-amber' :
    tone === 'destructive' ? 'bg-destructive' :
    tone === 'purple' ? 'bg-theme-purple' :
    'bg-muted-foreground'
  return <span className={clsx('inline-block w-2 h-2 rounded-full shrink-0', color, pulse && 'animate-pulse')} />
}
