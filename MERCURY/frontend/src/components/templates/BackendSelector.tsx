import { useBrainUpdater } from '../../api/queries'
import type { BrainBackendInfo } from '../../api/admin'
import { inputClass, labelClass } from './shared'

/**
 * Backend GPU picker (LlamaCpp gold-standard).
 *
 * - Builds the list from brain-daemon `useBrainUpdater()`: known order
 *   vulkan → rocm → native-vulkan, then extras alphabetically.
 * - Greys out backends that are not installed/built.
 * - Always shows the currently selected backend even if absent from registry.
 *
 * Lock mode: pass `lockedTo="native-lucebox"` to render a disabled input
 * showing the backend name instead of the picker (used by LuceboxModelsCard
 * where backend is hardcoded).
 */
export default function BackendSelector({
  value,
  onChange,
  disabled,
  lockedTo,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  lockedTo?: string
}) {
  const { data: brainUpdater } = useBrainUpdater()

  const tooltip =
    "Backend GPU utilisé pour lancer llama-server. Vulkan (RADV) = driver Mesa open-source via toolbox. ROCm = driver AMD officiel HIP via toolbox, meilleures performances sur RDNA récentes. Native Vulkan = binaire llama-server compilé sur l'hôte (pas de toolbox, latence signal réduite pour le thermal controller). Les backends extra (native-dflash, native-mtp, ...) sont ajoutés dynamiquement depuis le brain — un backend grisé n'est pas encore buildé (BrainPanel → Build)."

  if (lockedTo) {
    return (
      <div className="flex flex-col gap-1">
        <label className={labelClass} title={tooltip}>backend GPU</label>
        <input
          type="text"
          className={`${inputClass} cursor-not-allowed text-neutral-500 border-neutral-800`}
          value={lockedTo}
          disabled
          readOnly
        />
      </div>
    )
  }

  // Build the list: known order first (vulkan, rocm, native-vulkan), then extras alpha.
  const entries: Array<[string, BrainBackendInfo | undefined]> = []
  const known = ['vulkan', 'rocm', 'native-vulkan'] as const
  const seen = new Set<string>()
  if (brainUpdater) {
    for (const k of known) {
      const v = brainUpdater[k]
      if (v && typeof v === 'object') {
        entries.push([k, v as BrainBackendInfo])
        seen.add(k)
      } else {
        // Builtin not reported (brain unreachable, build script renamed, ...) — keep placeholder
        entries.push([k, undefined])
        seen.add(k)
      }
    }
    const extras = Object.entries(brainUpdater)
      .filter(([k, v]) => k !== 'update_in_progress' && !seen.has(k) && v && typeof v === 'object')
      .sort(([a], [b]) => a.localeCompare(b)) as Array<[string, BrainBackendInfo]>
    entries.push(...extras)
  } else {
    // Brain unreachable — show the 3 builtins as fallback so the form remains usable.
    for (const k of known) entries.push([k, undefined])
  }
  // Ensure the currently selected backend is always rendered (even if not in registry).
  if (value && !entries.some(([k]) => k === value)) {
    entries.push([value, undefined])
  }
  // Color helper: keep historic palette for the 3 builtins, teal for extras.
  const colorOf = (name: string): string => {
    if (name === 'vulkan') return 'bg-blue-600 text-white'
    if (name === 'rocm') return 'bg-purple-600 text-white'
    if (name === 'native-vulkan') return 'bg-emerald-600 text-white'
    return 'bg-teal-600 text-white'
  }
  // Label helper: short for builtins, name as-is for extras.
  const labelOf = (name: string): string => {
    if (name === 'vulkan') return 'Vulkan'
    if (name === 'rocm') return 'ROCm'
    if (name === 'native-vulkan') return 'Native'
    return name.replace(/^native-/, '')
  }
  // installed/exists check — disabled (greyed-out) if backend not built.
  const isPresent = (info: BrainBackendInfo | undefined): boolean => {
    if (!info) return false
    return info.type === 'native' ? info.installed : info.exists
  }

  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass} title={tooltip}>backend GPU</label>
      <div className="flex flex-wrap rounded overflow-hidden border border-neutral-600 text-[11px] font-medium">
        {entries.map(([name, info]) => {
          const present = isPresent(info)
          const selected = value === name
          const baseInactive = present
            ? 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
            : 'bg-neutral-900 text-neutral-600 cursor-not-allowed'
          return (
            <button
              key={name}
              type="button"
              onClick={() => present && onChange(name)}
              disabled={disabled || !present}
              title={present ? `Backend ${name}` : `${name} non installé — utilise BrainPanel → Build pour l'installer`}
              className={`flex-1 min-w-[60px] px-2 h-7 transition-colors ${selected ? colorOf(name) : baseInactive}`}
            >
              {labelOf(name)}{!present && selected && ' ⚠'}
            </button>
          )
        })}
      </div>
    </div>
  )
}
