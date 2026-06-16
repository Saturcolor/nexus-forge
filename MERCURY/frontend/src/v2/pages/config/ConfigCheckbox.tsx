import { clsx } from 'clsx'
import { Check } from 'lucide-react'

type Props = {
  id: string
  checked: boolean
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  disabled?: boolean
  label: string
  hint?: string
}

export function ConfigCheckbox({ id, checked, onChange, disabled, label, hint }: Props) {
  return (
    <label htmlFor={id} className={clsx('flex items-start gap-2.5 cursor-pointer group/cb', disabled && 'opacity-50 cursor-not-allowed')}>
      <input id={id} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="sr-only" />
      <span className={clsx(
        'mt-0.5 inline-flex items-center justify-center shrink-0 w-3.5 h-3.5 rounded border transition-colors',
        checked ? 'bg-primary border-primary' : 'bg-background border-border/80 group-hover/cb:border-primary/50',
      )}>
        {checked && <Check size={9} className="text-primary-foreground" strokeWidth={3} />}
      </span>
      <span className="flex flex-col">
        <span className="text-[11px] text-foreground leading-none">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground/70 mt-0.5 leading-tight">{hint}</span>}
      </span>
    </label>
  )
}
