import { clsx } from 'clsx'
import type { ReactNode } from 'react'

type CardProps = {
  children: ReactNode
  className?: string
  /** Optional outline accent for emphasized cards. */
  accent?: 'primary' | 'destructive' | 'warning' | 'success'
}

/**
 * V2 card surface — flat dark panel with subtle border, mirrors Mastermind
 * `bg-card rounded-xl border border-border/60`.
 */
export function Card({ children, className, accent }: CardProps) {
  const accentRing =
    accent === 'primary' ? 'ring-1 ring-primary/20' :
    accent === 'destructive' ? 'ring-1 ring-destructive/30' :
    accent === 'warning' ? 'ring-1 ring-theme-amber/30' :
    accent === 'success' ? 'ring-1 ring-theme-green/30' : ''
  return (
    <section className={clsx(
      'bg-card rounded-xl border border-border/60 flex flex-col min-h-0',
      accentRing,
      className,
    )}>
      {children}
    </section>
  )
}

type CardHeaderProps = {
  title: string
  subtitle?: string
  right?: ReactNode
  icon?: ReactNode
}

export function CardHeader({ title, subtitle, right, icon }: CardHeaderProps) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60">
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest m-0">
            {title}
          </h2>
          {subtitle && (
            <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  )
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex-1 min-h-0 overflow-auto px-4 py-3', className)}>
      {children}
    </div>
  )
}
