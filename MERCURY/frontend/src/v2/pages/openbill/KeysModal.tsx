import { useState } from 'react'
import { clsx } from 'clsx'
import { X, KeyRound } from 'lucide-react'
import type { Config } from '../../../api/admin'
import { useSaveConfigMutation } from '../../../api/queries'
import { Button } from '../../ui/Button'

type KeyName = 'openrouter_key' | 'openai_key' | 'anthropic_key' | 'elevenlabs_key'
type KeySetName = 'openrouter_key_set' | 'openai_key_set' | 'anthropic_key_set' | 'elevenlabs_key_set'

const KEYS: { label: string; keyName: KeyName; keySetKey: KeySetName }[] = [
  { label: 'OpenRouter', keyName: 'openrouter_key',  keySetKey: 'openrouter_key_set' },
  { label: 'OpenAI',     keyName: 'openai_key',      keySetKey: 'openai_key_set'     },
  { label: 'Anthropic',  keyName: 'anthropic_key',   keySetKey: 'anthropic_key_set'  },
  { label: 'ElevenLabs', keyName: 'elevenlabs_key',  keySetKey: 'elevenlabs_key_set' },
]

type Props = {
  config: Config
  creditProviders: string[]
  onClose: () => void
}

export function KeysModal({ config, creditProviders, onClose }: Props) {
  const saveConfigMutation = useSaveConfigMutation()
  const [inputs, setInputs] = useState<Record<string, string>>({
    openrouter_key: '', openai_key: '', anthropic_key: '', elevenlabs_key: '',
  })
  const [status, setStatus] = useState<string | null>(null)

  const onSave = async () => {
    setStatus(null)
    try {
      const credits: Config['credits'] = {
        ...config.credits,
        enabled: config.credits?.enabled,
        timeout_ms: config.credits?.timeout_ms ?? 30000,
        providers_preferred: creditProviders.length ? creditProviders : config.credits?.providers_preferred,
      }
      if ((inputs.openrouter_key ?? '').trim()) credits.openrouter_key = inputs.openrouter_key!.trim()
      if ((inputs.openai_key     ?? '').trim()) credits.openai_key     = inputs.openai_key!.trim()
      if ((inputs.anthropic_key  ?? '').trim()) credits.anthropic_key  = inputs.anthropic_key!.trim()
      if ((inputs.elevenlabs_key ?? '').trim()) credits.elevenlabs_key = inputs.elevenlabs_key!.trim()
      await saveConfigMutation.mutateAsync({ ...config, credits })
      setStatus('Enregistré.')
      setTimeout(() => { onClose() }, 1200)
    } catch (e) {
      setStatus('Erreur : ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="openbill-keys-modal-title"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl border border-border/60 shadow-xl max-w-md w-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <KeyRound size={13} className="text-muted-foreground shrink-0" />
            <h3
              id="openbill-keys-modal-title"
              className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest m-0"
            >
              Clés API des providers
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Fermer"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 flex flex-col gap-3">
          <p className="text-[11px] text-muted-foreground/80 m-0">
            Modifier les clés utilisées pour récupérer les crédits. Laisser vide pour ne pas modifier une clé existante.
          </p>
          <div className="flex flex-col gap-2.5">
            {KEYS.map(({ label, keyName, keySetKey }) => (
              <div key={keyName} className="flex flex-col gap-1">
                <label
                  htmlFor={`openbill-keys-${keyName}`}
                  className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground"
                >
                  {label}
                </label>
                <input
                  id={`openbill-keys-${keyName}`}
                  type="password"
                  value={inputs[keyName] ?? ''}
                  onChange={e => setInputs(prev => ({ ...prev, [keyName]: e.target.value }))}
                  placeholder={config?.credits?.[keySetKey] ? '•••••••• (vide = ne pas modifier)' : 'Saisir la clé API'}
                  autoComplete="off"
                  className="w-full px-2.5 py-1.5 bg-background border border-border/60 rounded-md focus:outline-none focus:ring-2 focus:ring-ring/40 text-[11px] font-mono text-foreground placeholder:text-muted-foreground/60"
                />
              </div>
            ))}
          </div>
          {status && (
            <p className={clsx(
              'text-[11px] font-medium m-0',
              status.startsWith('Erreur') ? 'text-destructive' : 'text-theme-green',
            )}>
              {status}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-border/60">
          <Button variant="subtle" size="sm" onClick={onClose}>Annuler</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={saveConfigMutation.isPending}
          >
            {saveConfigMutation.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </div>
      </div>
    </div>
  )
}
