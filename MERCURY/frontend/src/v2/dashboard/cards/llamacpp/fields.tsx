import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { clsx } from 'clsx'
import { useBrainUpdater } from '../../../../api/queries'
import type { BrainBackendInfo } from '../../../../api/admin'

/** Form primitives for the V2 template editor — tokens-aware, tooltip-ready. */

function FieldLabel({ label, tooltip, htmlFor }: { label: string; tooltip?: string; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
    >
      <span className="truncate">{label}</span>
      {tooltip && (
        <span title={tooltip} className="text-muted-foreground/50 hover:text-foreground shrink-0 cursor-help" aria-label="info">
          <Info size={11} />
        </span>
      )}
    </label>
  )
}

const INPUT_BASE =
  'w-full px-2 py-1 bg-background border border-border/60 rounded-md text-[12px] text-foreground placeholder:text-muted-foreground/40 font-mono ' +
  'focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'

export function NumberInput({
  label, tooltip, value, onChange, placeholder, min, max, step, disabled, id,
}: {
  label: string
  tooltip?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  min?: number | string
  max?: number | string
  step?: number | string
  disabled?: boolean
  id?: string
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0" title={tooltip}>
      <FieldLabel label={label} tooltip={tooltip} htmlFor={id} />
      <input
        id={id}
        type="number"
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={INPUT_BASE}
      />
    </div>
  )
}

export function TextInput({
  label, tooltip, value, onChange, placeholder, disabled, id, spellCheck,
}: {
  label: string
  tooltip?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  id?: string
  spellCheck?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0" title={tooltip}>
      <FieldLabel label={label} tooltip={tooltip} htmlFor={id} />
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        spellCheck={spellCheck}
        className={INPUT_BASE}
      />
    </div>
  )
}

export function SelectInput({
  label, tooltip, value, onChange, options, disabled, id,
}: {
  label: string
  tooltip?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
  id?: string
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0" title={tooltip}>
      <FieldLabel label={label} tooltip={tooltip} htmlFor={id} />
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={clsx(INPUT_BASE, 'pr-7 appearance-none')}
        style={{
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%236c7380\' stroke-width=\'2\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' d=\'M19 9l-7 7-7-7\'/%3E%3C/svg%3E")',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 0.4rem center',
          backgroundSize: '0.9em',
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

export function TextareaInput({
  label, tooltip, value, onChange, placeholder, rows = 4, disabled, id, monospaced = true, spellCheck,
}: {
  label: string
  tooltip?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
  id?: string
  monospaced?: boolean
  spellCheck?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0 col-span-full" title={tooltip}>
      <FieldLabel label={label} tooltip={tooltip} htmlFor={id} />
      <textarea
        id={id}
        value={value}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        spellCheck={spellCheck}
        className={clsx(
          'w-full px-2 py-1.5 bg-background border border-border/60 rounded-md text-[12px] text-foreground placeholder:text-muted-foreground/40',
          monospaced && 'font-mono',
          'focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40 disabled:opacity-50 resize-y',
        )}
      />
    </div>
  )
}

export function BooleanSwitch({
  label, tooltip, checked, onChange, disabled, id, highlight,
}: {
  label: string
  tooltip?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  id?: string
  highlight?: boolean
}) {
  return (
    <label
      className={clsx(
        'flex items-center gap-2 px-2 py-1.5 rounded-md border cursor-pointer select-none transition-colors',
        checked
          ? highlight
            ? 'bg-theme-amber/10 border-theme-amber/40 text-theme-amber'
            : 'bg-primary/10 border-primary/30 text-primary'
          : 'bg-background border-border/60 text-muted-foreground hover:text-foreground',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      title={tooltip}
      htmlFor={id}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        className={clsx(
          'inline-flex items-center justify-center w-3.5 h-3.5 rounded border shrink-0',
          checked ? 'bg-current border-current' : 'border-border bg-background',
        )}
      >
        {checked && (
          <svg width="9" height="9" viewBox="0 0 12 12" className="text-background">
            <path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="text-[11px] font-medium truncate">{label}</span>
    </label>
  )
}

/**
 * Backend GPU picker — dropdown built from brain-daemon `/updater/status`.
 * Greys out backends that aren't installed/built. Falls back to the 3 builtins
 * (vulkan, rocm, native-vulkan) if brain is unreachable.
 *
 * Mirrors the V1 BackendSelector logic, but as a styled select (V2 tokens).
 */
export function BackendSelector({
  value, onChange, disabled, label = 'backend GPU', id,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  label?: string
  id?: string
}) {
  const { data: brainUpdater } = useBrainUpdater()

  const tooltip =
    "Backend GPU utilisé pour lancer llama-server. Vulkan (RADV via toolbox), ROCm (HIP officiel AMD via toolbox, meilleures perfs sur RDNA récentes), Native Vulkan (binaire compilé sur l'hôte). Les backends extra (native-mtp, native-turboquant, ...) sont déclarés dans BRAIN-DAEMON config.yaml ; un backend grisé n'est pas encore buildé (BrainPanel → Build)."

  const known = ['vulkan', 'rocm', 'native-vulkan'] as const
  const seen = new Set<string>()
  const entries: Array<{ name: string; info?: BrainBackendInfo; present: boolean }> = []

  const isPresent = (info: BrainBackendInfo | undefined): boolean => {
    if (!info) return false
    return info.type === 'native' ? info.installed : info.exists
  }

  if (brainUpdater) {
    for (const k of known) {
      const v = brainUpdater[k]
      const info = (v && typeof v === 'object' && 'type' in v) ? (v as BrainBackendInfo) : undefined
      entries.push({ name: k, info, present: isPresent(info) })
      seen.add(k)
    }
    const extras = Object.entries(brainUpdater)
      .filter(([k, v]) => k !== 'update_in_progress' && !seen.has(k) && v && typeof v === 'object' && 'type' in v)
      .sort(([a], [b]) => a.localeCompare(b)) as Array<[string, BrainBackendInfo]>
    for (const [k, info] of extras) entries.push({ name: k, info, present: isPresent(info) })
  } else {
    for (const k of known) entries.push({ name: k, present: false })
  }

  // Ensure the currently selected backend is always rendered.
  if (value && !entries.some(e => e.name === value)) {
    entries.push({ name: value, present: false })
  }

  const labelOf = (name: string): string => {
    if (name === 'vulkan')        return 'Vulkan'
    if (name === 'rocm')          return 'ROCm'
    if (name === 'native-vulkan') return 'Native Vulkan'
    return name
  }

  return (
    <div className="flex flex-col gap-1 min-w-0" title={tooltip}>
      <FieldLabel label={label} tooltip={tooltip} htmlFor={id} />
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={clsx(INPUT_BASE, 'pr-7 appearance-none')}
        style={{
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%236c7380\' stroke-width=\'2\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' d=\'M19 9l-7 7-7-7\'/%3E%3C/svg%3E")',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 0.4rem center',
          backgroundSize: '0.9em',
        }}
      >
        {entries.map(e => (
          <option key={e.name} value={e.name} disabled={!e.present && e.name !== value}>
            {labelOf(e.name)}{!e.present && ' (non installé)'}
          </option>
        ))}
      </select>
    </div>
  )
}

export function Section({
  title, hint, children, cols = 2,
}: {
  title: string
  hint?: string
  cols?: 1 | 2 | 3 | 4
  children: ReactNode
}) {
  const colsCls =
    cols === 1 ? 'grid-cols-1' :
    cols === 2 ? 'grid-cols-1 sm:grid-cols-2' :
    cols === 3 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' :
    'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-foreground m-0">
          {title}
        </h4>
        {hint && <span className="text-[10px] text-muted-foreground/60">{hint}</span>}
      </div>
      <div className={clsx('grid gap-2.5', colsCls)}>{children}</div>
    </div>
  )
}
