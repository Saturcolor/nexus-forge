import { checkboxClass } from './shared'

/**
 * Checkbox + label, matching the LlamaCpp TemplateEditor pattern:
 *   <div className="flex items-center gap-2 pt-4">
 *     <input type="checkbox" id=... />
 *     <label htmlFor=... ...>label</label>
 *   </div>
 *
 * highlightWhen=true → label uses text-amber-400 font-semibold (used for the
 * debug verbose flag where ON state is "loud / temporary").
 */
export default function BooleanField({
  id,
  label,
  checked,
  onChange,
  tooltip,
  disabled,
  highlightWhen,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  tooltip?: string
  disabled?: boolean
  highlightWhen?: boolean
}) {
  const labelCls = highlightWhen
    ? 'text-[11px] cursor-pointer text-amber-400 font-semibold'
    : 'text-[11px] text-neutral-400 cursor-pointer'
  return (
    <div className="flex items-center gap-2 pt-4">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className={checkboxClass}
      />
      <label htmlFor={id} className={labelCls} title={tooltip}>
        {label}
      </label>
    </div>
  )
}
