import { useState } from 'react'
import type { Config } from '../../api/admin'

const inputClass =
  'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'

const ALL_TRIGGERS = ['timeout', 'payment', 'server_error', 'connection', 'rate_limit', 'auth'] as const
const DEFAULT_TRIGGERS = ['timeout', 'payment', 'server_error', 'connection']

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
}

/**
 * UI fallback model OpenRouter — schema simplifié 2026-05-04.
 * Une chain globale de fallbacks, peu importe le model demandé.
 * Triggers = catégories d'erreur qui déclenchent la cascade.
 */
export default function OpenRouterFallbackModelSection({ config, updateField }: Props) {
  const fb = config.openrouter_model_fallback || {}
  const enabled = fb.enabled === true
  const triggers = fb.triggers && fb.triggers.length > 0 ? fb.triggers : DEFAULT_TRIGGERS
  // Defensive : config malformée peut faire arriver autre chose qu'un array
  const chain: string[] = Array.isArray(fb.chain) ? fb.chain : []

  const setFb = (patch: NonNullable<Config['openrouter_model_fallback']>) => {
    updateField('openrouter_model_fallback', { ...fb, ...patch })
  }

  const toggleTrigger = (trig: string) => {
    const next = triggers.includes(trig) ? triggers.filter((t) => t !== trig) : [...triggers, trig]
    setFb({ triggers: next })
  }

  const setChain = (next: string[]) => setFb({ chain: next })
  const removeAt = (idx: number) => setChain(chain.filter((_, i) => i !== idx))
  const moveUp = (idx: number) => {
    if (idx === 0) return
    const next = [...chain]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    setChain(next)
  }
  const moveDown = (idx: number) => {
    if (idx === chain.length - 1) return
    const next = [...chain]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    setChain(next)
  }

  const [newModel, setNewModel] = useState('')
  const addModel = () => {
    const m = newModel.trim()
    if (!m || chain.includes(m)) return
    setChain([...chain, m])
    setNewModel('')
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white m-0">Fallback model OpenRouter</h3>
          <p className="text-xs text-neutral-500 m-0 mt-0.5">
            Quand le model principal échoue (timeout / wallet / 5xx) Mercury cascade sur la chain ci-dessous,
            dans l'ordre, jusqu'à un succès. Le caller reçoit la réponse du fallback ; un champ{' '}
            <code className="text-[10px]">x_mercury_fallback</code> est ajouté au body pour traçabilité.
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <span className="text-xs text-neutral-400">Activé</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setFb({ enabled: !enabled })}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-neutral-600'}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}`}
            />
          </button>
        </label>
      </div>

      {/* Triggers */}
      <fieldset className={`border-0 p-0 m-0 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
          Déclencheurs (catégories d'erreur qui basculent sur la chain)
        </legend>
        <div className="flex flex-wrap gap-2">
          {ALL_TRIGGERS.map((trig) => {
            const active = triggers.includes(trig)
            return (
              <button
                key={trig}
                type="button"
                onClick={() => toggleTrigger(trig)}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                  active
                    ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300'
                    : 'bg-neutral-950 border-neutral-700 text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {trig}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-neutral-500 m-0 mt-2">
          Recommandé : timeout, payment, server_error, connection.{' '}
          <code className="text-[10px]">auth</code> et <code className="text-[10px]">rate_limit</code> = config OR
          (basculer ne règlera rien).
        </p>
      </fieldset>

      {/* Chain */}
      <fieldset className={`border-0 p-0 m-0 ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <legend className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
          Chain de fallback (essayée dans l'ordre)
        </legend>
        <p className="text-[11px] text-neutral-500 m-0 mb-3">
          Le model demandé est automatiquement skippé s'il apparaît dans la chain — pas la peine de re-tester
          ce qui vient d'échouer. Premier succès gagne.
        </p>

        <div className="flex flex-col gap-1.5">
          {chain.length === 0 && (
            <p className="text-xs text-neutral-500 italic m-0 py-2">
              Aucun fallback configuré. Ajoute des modèles ci-dessous (le 1er sera essayé en premier).
            </p>
          )}
          {chain.map((model, idx) => (
            <ChainRow
              key={`${model}-${idx}`}
              index={idx}
              model={model}
              isFirst={idx === 0}
              isLast={idx === chain.length - 1}
              onUp={() => moveUp(idx)}
              onDown={() => moveDown(idx)}
              onRemove={() => removeAt(idx)}
            />
          ))}
        </div>

        <div className="flex items-center gap-2 mt-3">
          <input
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addModel()
              }
            }}
            placeholder="ex. anthropic/claude-haiku-4-5"
            className={inputClass + ' max-w-md font-mono'}
          />
          <button
            type="button"
            onClick={addModel}
            disabled={!newModel.trim() || chain.includes(newModel.trim())}
            className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-white transition-colors"
          >
            Ajouter
          </button>
        </div>
      </fieldset>

      <p className="text-[11px] text-neutral-500 m-0">
        💡 Sauvegarde via le bouton "Enregistrer" en bas de la page.
      </p>
    </section>
  )
}

function ChainRow({
  index,
  model,
  isFirst,
  isLast,
  onUp,
  onDown,
  onRemove,
}: {
  index: number
  model: string
  isFirst: boolean
  isLast: boolean
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2">
      <span className="text-xs font-mono text-neutral-500 w-6 shrink-0">{index + 1}.</span>
      <span className="font-mono text-sm text-neutral-200 flex-1 truncate">{model}</span>
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={onUp}
          disabled={isFirst}
          title="Monter"
          className="px-1.5 py-1 text-xs text-neutral-500 hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onDown}
          disabled={isLast}
          title="Descendre"
          className="px-1.5 py-1 text-xs text-neutral-500 hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Supprimer"
          className="px-1.5 py-1 text-xs text-neutral-500 hover:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
