import { clsx } from 'clsx'
import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'subtle' | 'destructive'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary:     'bg-primary text-primary-foreground hover:brightness-110',
  ghost:       'text-muted-foreground hover:text-foreground hover:bg-secondary',
  subtle:      'bg-secondary text-foreground hover:bg-secondary/80 border border-border/60',
  destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/30',
}

const SIZE: Record<Size, string> = {
  sm: 'px-2 py-1 text-[11px]',
  md: 'px-3 py-1.5 text-xs',
}

export function Button({
  variant = 'subtle',
  size = 'sm',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={rest.type ?? 'button'}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 font-medium rounded-md transition-all',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus:outline-none focus:ring-2 focus:ring-ring/40',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  )
}
