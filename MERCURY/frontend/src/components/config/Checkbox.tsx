type CheckboxProps = {
  id: string
  checked: boolean
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  disabled?: boolean
  label: string
  tooltip?: string
}

export default function Checkbox({ id, checked, onChange, disabled, label, tooltip }: CheckboxProps) {
  return (
    <label htmlFor={id} className="group/label flex items-start gap-3 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:ring-offset-neutral-900"
      />
      <span className="text-sm text-neutral-200 relative" {...(tooltip ? { title: tooltip } : {})}>
        <span>{label}</span>
        {tooltip && (
          <span
            role="tooltip"
            className="absolute left-0 bottom-full mb-1 hidden group-hover/label:block z-50 px-2.5 py-1.5 text-xs text-neutral-200 bg-neutral-800 border border-neutral-600 rounded-md shadow-lg max-w-[280px] whitespace-normal pointer-events-none"
          >
            {tooltip}
          </span>
        )}
      </span>
    </label>
  )
}
