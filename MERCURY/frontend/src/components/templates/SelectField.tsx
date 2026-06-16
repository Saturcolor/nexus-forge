import { selectClass, labelClass } from './shared'

export type SelectOption = { value: string; label: string }

export default function SelectField({
  label,
  value,
  onChange,
  options,
  tooltip,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  tooltip?: string
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass} title={tooltip}>{label}</label>
      <select
        className={selectClass}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
