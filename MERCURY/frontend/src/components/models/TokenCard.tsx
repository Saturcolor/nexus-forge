import { useState } from 'react'
import { useHfToken, useSetHfTokenMutation } from '../../api/queries'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`
const btnRed = `${btn} bg-red-600/80 hover:bg-red-500 text-white`
const btnGray = `${btn} bg-neutral-700 hover:bg-neutral-600 text-neutral-200`

export default function TokenCard() {
  const { data, isLoading } = useHfToken()
  const setMut = useSetHfTokenMutation()
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)

  const handleSave = () => {
    if (!input.trim()) return
    setMut.mutate(input.trim(), {
      onSuccess: () => {
        setInput('')
        setEditing(false)
      },
    })
  }

  const handleClear = () => {
    if (!confirm('Supprimer le token HuggingFace ?')) return
    setMut.mutate(null)
  }

  const showInput = !data?.configured || editing

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="px-4 py-2.5 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">HuggingFace Token</h2>
      </div>
      <div className="px-4 py-3">
        {isLoading ? (
          <p className="text-xs text-neutral-500">Chargement…</p>
        ) : (
          <div className="flex flex-col gap-2">
            {data?.configured && !editing && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-mono text-neutral-300">
                  Configuré : <span className="text-emerald-400">{data.masked}</span>
                </span>
                <div className="flex gap-2">
                  <button className={btnGray} onClick={() => setEditing(true)} disabled={setMut.isPending}>
                    Modifier
                  </button>
                  <button className={btnRed} onClick={handleClear} disabled={setMut.isPending}>
                    Effacer
                  </button>
                </div>
              </div>
            )}
            {showInput && (
              <>
                {!data?.configured && (
                  <p className="text-xs text-neutral-400">
                    Optionnel pour les repos publics, requis pour les repos gated. Créer un token sur{' '}
                    <a
                      href="https://huggingface.co/settings/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline"
                    >
                      huggingface.co/settings/tokens
                    </a>.
                  </p>
                )}
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                    placeholder="hf_..."
                    autoFocus={editing}
                    className="flex-1 px-3 py-1.5 bg-neutral-950 border border-neutral-700 rounded text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button className={btnBlue} onClick={handleSave} disabled={setMut.isPending || !input.trim()}>
                    Enregistrer
                  </button>
                  {editing && (
                    <button
                      className={btnGray}
                      onClick={() => { setEditing(false); setInput('') }}
                      disabled={setMut.isPending}
                    >
                      Annuler
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
