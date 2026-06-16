import { clsx } from 'clsx'

type SwitchProps = {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  label?: string
}

/** V2 toggle switch — themed, focus-ring compliant. */
export function Switch({ checked, onChange, disabled, label }: SwitchProps) {
  const toggle = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={clsx(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-ring/40',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        checked ? 'bg-primary' : 'bg-secondary border border-border',
      )}
    >
      <span className={clsx(
        'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
      )} />
    </button>
  )

  if (!label) return toggle

  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {toggle}
    </label>
  )
}
