import { useEffect, useRef, useState } from 'react'
import { Copy, KeyRound, X } from 'lucide-react'
import { Button } from '../../ui/Button'

type Props = {
  apiKey: string
  onClose: () => void
}

/**
 * Modal « Clé API générée ».
 * Reprend strictement le comportement V1 :
 *  - Échap ferme
 *  - Focus trap (Tab / Shift+Tab)
 *  - Clic sur le backdrop ferme
 *  - Copie avec fallback execCommand si Clipboard API refusée
 *  - Feedback « Copié ! » pendant 2 s
 */
export function NewApiKeyModal({ apiKey, onClose }: Props) {
  const modalRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const el = modalRef.current
    if (el) el.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCopied(false)
        onClose()
      }
      if (e.key === 'Tab' && el) {
        const focusable = el.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last  = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const copyKey = async () => {
    setCopied(false)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(apiKey)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        return
      }
    } catch { /* clipboard API refusée */ }
    // Fallback execCommand
    const ta = document.createElement('textarea')
    ta.value = apiKey
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } finally {
      document.body.removeChild(ta)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={() => { setCopied(false); onClose() }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Clé API générée"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className="bg-card border border-border/60 rounded-xl shadow-2xl w-full max-w-lg flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-muted-foreground shrink-0"><KeyRound size={13} /></span>
            <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest m-0">
              Clé API générée
            </h2>
          </div>
          <button
            type="button"
            onClick={() => { setCopied(false); onClose() }}
            className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded focus:outline-none focus:ring-2 focus:ring-ring/40"
            aria-label="Fermer"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-[11px] text-theme-amber m-0">
            Copiez cette clé maintenant. Elle ne sera plus affichée.
          </p>
          <p className="break-all font-mono text-[11px] text-foreground bg-background border border-border/40 rounded-lg px-3 py-2 m-0">
            {apiKey}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="md" onClick={copyKey}>
              <Copy size={11} />
              Copier
            </Button>
            {copied && (
              <span className="text-[11px] font-medium text-theme-green">Copié !</span>
            )}
            <Button variant="subtle" size="md" onClick={() => { setCopied(false); onClose() }}>
              Fermer
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
