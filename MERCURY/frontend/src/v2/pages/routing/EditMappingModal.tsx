import { useEffect, useState } from 'react'
import { X, Save, Trash2 } from 'lucide-react'
import { Button } from '../../ui/Button'
import { inputCls, selectCls, labelCls, fieldCls } from '../config/shared'

const BACKEND_OPTIONS = [
  'ollama',
  'lm_studio',
  'mlx',
  'llamacpp',
  'vllm',
  'lucebox',
  'openrouter',
]

type Props = {
  initialTag: string
  initialBackend: string
  initialBackendModelId: string
  isNew: boolean
  onSave: (canonical: string, backend: string, backend_model_id: string, isNew: boolean) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}

/** V2 modal for adding / editing / deleting an entry in `model_mapping`. */
export function EditMappingModal({
  initialTag,
  initialBackend,
  initialBackendModelId,
  isNew,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const [tag, setTag] = useState(initialTag)
  const [backend, setBackend] = useState(initialBackend)
  const [backendModelId, setBackendModelId] = useState(initialBackendModelId)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const canonical = tag.trim()
    const bid = backendModelId.trim()
    if (!canonical || !bid) return
    setSaving(true)
    try {
      await onSave(canonical, backend, bid, isNew)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete) return
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border/60 rounded-xl shadow-xl max-w-md w-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
          <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest m-0">
            {isNew ? 'Ajouter une entrée mapping' : "Modifier l'entrée"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground/60 hover:text-foreground transition-colors"
            aria-label="Fermer"
          >
            <X size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-4 py-4 flex flex-col gap-4">
          <div className={fieldCls}>
            <label htmlFor="map-tag" className={labelCls}>Tag (nom canonique)</label>
            <input
              id="map-tag"
              type="text"
              value={tag}
              onChange={e => setTag(e.target.value)}
              placeholder="ex. ollama/llama3.2 ou openrouter/openai/gpt-4o"
              className={`${inputCls} font-mono`}
              required
              autoFocus
            />
          </div>
          <div className={fieldCls}>
            <label htmlFor="map-backend" className={labelCls}>Backend</label>
            <select
              id="map-backend"
              value={backend}
              onChange={e => setBackend(e.target.value)}
              className={selectCls}
            >
              {BACKEND_OPTIONS.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className={fieldCls}>
            <label htmlFor="map-bid" className={labelCls}>Backend model ID</label>
            <input
              id="map-bid"
              type="text"
              value={backendModelId}
              onChange={e => setBackendModelId(e.target.value)}
              placeholder="ID envoyé au provider"
              className={`${inputCls} font-mono`}
              required
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={saving || !tag.trim() || !backendModelId.trim()}
            >
              <Save size={11} />
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={onClose}>
              Annuler
            </Button>
            {onDelete && !isNew && (
              <Button
                variant="destructive"
                size="sm"
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="ml-auto"
              >
                <Trash2 size={11} />
                {deleting ? 'Suppression…' : 'Supprimer'}
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
