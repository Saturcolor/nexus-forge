import { inputClass, labelClass } from './shared'

export default function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  tooltip,
  disabled,
  rows,
  monospaced,
  spellCheck,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  tooltip?: string
  disabled?: boolean
  rows?: number
  /** Adds `font-mono text-[10px] min-h-[60px]` for code / JSON content. */
  monospaced?: boolean
  spellCheck?: boolean
}) {
  const cls = monospaced ? `${inputClass} font-mono text-[10px] min-h-[60px]` : inputClass
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass} title={tooltip}>{label}</label>
      <textarea
        className={cls}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        spellCheck={spellCheck}
      />
    </div>
  )
}
