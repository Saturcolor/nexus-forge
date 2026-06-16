/**
 * Cross-provider template clipboard.
 *
 * Module-level state shared across all open TemplateEditor instances
 * (LlamaCpp / vLLM / Lucebox). Copy snapshots the current form, Paste
 * applies it. The form shape is opaque (unknown) — each provider's
 * editor decides what fields to read/apply.
 *
 * Sharing across providers means the user can paste defaults overlapping
 * fields (ctx_size, sampler, etc.) between e.g. a LlamaCpp template and
 * a vLLM template. Each editor is responsible for mapping its own subset.
 */
import { useSyncExternalStore } from 'react'

export type ClipboardEntry<F = unknown> = {
  sourceModelId: string
  /** Snapshot of the source form state. Opaque from the clipboard's POV. */
  form: F
}

let _clipboard: ClipboardEntry | null = null
const _clipboardListeners = new Set<() => void>()

export function setTemplateClipboard(entry: ClipboardEntry | null) {
  _clipboard = entry
  _clipboardListeners.forEach(l => l())
}

export function useTemplateClipboard<F = unknown>(): ClipboardEntry<F> | null {
  return useSyncExternalStore(
    (cb) => { _clipboardListeners.add(cb); return () => { _clipboardListeners.delete(cb) } },
    () => _clipboard,
    () => _clipboard,
  ) as ClipboardEntry<F> | null
}
