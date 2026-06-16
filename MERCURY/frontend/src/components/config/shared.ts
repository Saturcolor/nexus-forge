import type { Config } from '../../api/admin'

export const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
export const labelClass = 'text-sm font-medium text-neutral-300'
export const fieldClass = 'flex flex-col gap-1.5'
export const sectionClass = 'bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-6'
export const legendClass = 'text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-1'

export type SectionProps = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  markDirty: () => void
}

export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    if (Number.isNaN(d.getTime())) return isoString
    return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', hour12: false })
  } catch {
    return isoString
  }
}
