import type { Config } from '../../../api/admin'

export const inputCls = 'w-full px-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40'
/** Narrow numeric input (°C fields, threshold boxes, small inline values). */
export const inputSmCls = 'w-14 px-1.5 py-1 bg-background border border-border/60 rounded text-[11px] text-foreground font-mono text-center focus:outline-none focus:ring-2 focus:ring-ring/30'
/** Compact select without w-full — for inline controls (watts, tctl, etc.). */
export const selectSmCls = 'px-2 py-1 bg-background border border-border/60 rounded text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30'
export const selectCls = inputCls
export const labelCls = 'text-[10px] font-medium text-muted-foreground uppercase tracking-wider'
export const fieldCls = 'flex flex-col gap-1'
export const groupCls = 'text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest'

export type SectionProps = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
  markDirty: () => void
}

export function formatDT(isoString: string): string {
  try {
    const d = new Date(isoString)
    if (Number.isNaN(d.getTime())) return isoString
    return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', hour12: false })
  } catch {
    return isoString
  }
}
