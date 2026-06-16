/**
 * Shared Tailwind class constants for provider template editors
 * (LlamaCpp / vLLM / Lucebox). Extracted from LlamaCppModelsCard so the
 * three editors render identically.
 *
 * KEEP IN SYNC: any change here propagates to all three cards.
 */

export const inputClass =
  'w-full bg-neutral-900 border border-neutral-700 text-white text-sm rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-neutral-500'

export const selectClass =
  'w-full bg-neutral-900 border border-neutral-700 text-white text-sm rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500'

export const labelClass = 'text-[11px] text-neutral-500 cursor-default'

export const checkboxClass = 'w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-blue-600'

export const sectionTitle =
  'text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-2 mt-1'

export type TemplateStatus = { msg: string; ok: boolean } | null
