import type { ReactNode } from 'react'

/**
 * Visual shell shared by all provider template editors.
 *
 * Renders: top bar (title + Copy/Paste/Close), children (form sections),
 * status footer, Save/Delete buttons. The parent owns clipboard logic,
 * mutations, and form state — this component is presentation only.
 *
 * The Copy/Paste buttons are wired through `onCopy`/`onPaste`. The
 * parent passes `clipboardSourceModelId` so the Paste button can show
 * the source name + disable when empty / self-paste.
 */
export default function TemplateEditorShell({
  modelId,
  title,
  existingTemplate,
  onClose,
  onSave,
  onDelete,
  onCopy,
  onPaste,
  clipboardSourceModelId,
  busy,
  status,
  saveLabel,
  deleteLabel,
  children,
}: {
  modelId: string
  title?: string
  existingTemplate?: unknown
  onClose: () => void
  onSave: () => Promise<void> | void
  onDelete?: () => Promise<void> | void
  onCopy?: () => void
  onPaste?: () => void
  clipboardSourceModelId?: string | null
  busy?: boolean
  status?: { msg: string; ok: boolean } | null
  /** Default "Sauvegarder" / "Sauvegarde…". Pass to override. */
  saveLabel?: string
  /** Default "Supprimer template". */
  deleteLabel?: string
  children: ReactNode
}) {
  const headerTitle = title ?? `Template · ${modelId}`
  const pasteEnabled =
    !!onPaste && !!clipboardSourceModelId && clipboardSourceModelId !== modelId
  const pasteTitle = !onPaste
    ? undefined
    : !clipboardSourceModelId
      ? 'Aucun template en presse-papier. Copie d\'abord un template depuis un autre modèle.'
      : clipboardSourceModelId === modelId
        ? 'Source identique, copie un autre template d\'abord'
        : `Remplit le formulaire avec les valeurs copiées depuis ${clipboardSourceModelId} (sans sauvegarder, tu peux vérifier puis Sauvegarder)`

  const pasteLabel =
    clipboardSourceModelId && clipboardSourceModelId !== modelId
      ? `Coller (depuis ${clipboardSourceModelId.length > 30 ? clipboardSourceModelId.slice(0, 30) + '…' : clipboardSourceModelId})`
      : 'Coller le template'

  return (
    <div className="mt-2 p-4 bg-neutral-900 border border-neutral-700 rounded-lg space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">{headerTitle}</span>
        <div className="flex items-center gap-2">
          {onCopy && (
            <button
              type="button"
              onClick={onCopy}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 disabled:opacity-40 cursor-pointer"
              title="Copie l'état actuel du formulaire (sans sauvegarder) dans un presse-papier partagé. Tu peux ensuite ouvrir un autre template et coller pour réutiliser ces paramètres."
            >
              Copier le template
            </button>
          )}
          {onPaste && (
            <button
              type="button"
              onClick={onPaste}
              disabled={busy || !pasteEnabled}
              className="text-[11px] px-2 py-1 rounded-md bg-blue-700 hover:bg-blue-600 text-white border border-blue-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title={pasteTitle}
            >
              {pasteLabel}
            </button>
          )}
          <button type="button" onClick={onClose} className="text-neutral-500 hover:text-neutral-200 text-xs ml-1">✕ Fermer</button>
        </div>
      </div>

      {children}

      {status && (
        <p className={`text-xs ${status.ok ? 'text-green-400' : 'text-red-400'}`}>{status.msg}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50"
          disabled={busy}
          onClick={() => { void onSave() }}
        >
          {saveLabel ?? (busy ? 'Sauvegarde…' : 'Sauvegarder')}
        </button>
        {!!existingTemplate && onDelete && (
          <button
            type="button"
            className="px-3 py-1.5 bg-neutral-800 hover:bg-red-900/50 text-neutral-400 hover:text-red-400 border border-neutral-700 hover:border-red-800 text-xs font-medium rounded-md transition-colors disabled:opacity-50"
            disabled={busy}
            onClick={() => { void onDelete() }}
          >
            {deleteLabel ?? 'Supprimer template'}
          </button>
        )}
      </div>
    </div>
  )
}
