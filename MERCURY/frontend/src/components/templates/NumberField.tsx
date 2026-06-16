import { inputClass, labelClass } from './shared'

export default function NumberField({
  label,
  value,
  onChange,
  placeholder,
  tooltip,
  min,
  max,
  step,
  disabled,
  widthClass,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  tooltip?: string
  min?: number | string
  max?: number | string
  step?: number | string
  disabled?: boolean
  /** Optional override for input width (e.g. 'w-28' for inline use). */
  widthClass?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass} title={tooltip}>{label}</label>
      <input
        type="number"
        className={widthClass ? `${inputClass} ${widthClass}` : inputClass}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
      />
    </div>
  )
}
