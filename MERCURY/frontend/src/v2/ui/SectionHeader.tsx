import type { ReactNode } from 'react'
import { clsx } from 'clsx'

/** Page-level section header — uppercase, tracked, divider underneath. */
export function SectionHeader({
  title,
  hint,
  icon,
  right,
  className,
}: {
  title: string
  hint?: string
  icon?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={clsx('flex items-center justify-between gap-3', className)}>
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="text-primary shrink-0">{icon}</span>}
        <h3 className="text-[11px] font-bold text-foreground uppercase tracking-widest m-0">
          {title}
        </h3>
        {hint && <span className="text-[10px] text-muted-foreground/70 truncate">· {hint}</span>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}
