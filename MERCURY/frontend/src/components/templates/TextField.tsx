import { inputClass, labelClass } from './shared'

export default function TextField({
  label,
  value,
  onChange,
  placeholder,
  tooltip,
  disabled,
  spellCheck,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  tooltip?: string
  disabled?: boolean
  spellCheck?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass} title={tooltip}>{label}</label>
      <input
        type="text"
        className={inputClass}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={spellCheck}
      />
    </div>
  )
}
