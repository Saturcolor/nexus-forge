import { useState, useCallback, useEffect, useRef } from 'react'
import * as api from '../api/admin'
import type { UserEntry } from '../api/admin'

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'
const fieldClass = 'flex flex-col gap-1.5'

export default function UsersPanel() {
  const [users, setUsers] = useState<UserEntry[]>([])
  const [usersErr, setUsersErr] = useState<string | null>(null)
  const [createUserId, setCreateUserId] = useState('')
  const [createPriority, setCreatePriority] = useState(1)
  const [createThreshold, setCreateThreshold] = useState(false)
  const [newKeyModal, setNewKeyModal] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  const loadUsers = useCallback(async () => {
    try {
      setUsersErr(null)
      setUsers(await api.getUsers())
    } catch (e) {
      setUsersErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  useEffect(() => {
    if (!newKeyModal) return
    const el = modalRef.current
    if (el) el.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setNewKeyModal(null); setCopyFeedback(false) }
      if (e.key === 'Tab' && el) {
        const focusable = el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [newKeyModal])

  const handleCreateUser = async () => {
    if (!createUserId.trim()) return
    try {
      const res = await api.createUser({ user_id: createUserId.trim(), priority: createPriority, threshold: createThreshold })
      setNewKeyModal(res.api_key)
      setCreateUserId('')
      setCreatePriority(1)
      setCreateThreshold(false)
      loadUsers()
    } catch (e) {
      setUsersErr(e instanceof Error ? e.message : String(e))
    }
  }

  const handleToggleThreshold = async (user_id: string, current: boolean) => {
    try {
      await api.updateUser({ user_id, threshold: !current })
      loadUsers()
    } catch (e) {
      setUsersErr(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDeleteUser = async (user_id: string) => {
    if (!confirm(`Supprimer l'utilisateur « ${user_id} » ?`)) return
    try {
      await api.deleteUser(user_id)
      loadUsers()
    } catch (e) {
      setUsersErr(e instanceof Error ? e.message : String(e))
    }
  }

  const copyKey = async () => {
    if (!newKeyModal) return
    setCopyFeedback(false)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(newKeyModal)
        setCopyFeedback(true)
        setTimeout(() => setCopyFeedback(false), 2000)
        return
      }
    } catch { /* clipboard API refusée */ }
    const ta = document.createElement('textarea')
    ta.value = newKeyModal
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      setCopyFeedback(true)
      setTimeout(() => setCopyFeedback(false), 2000)
    } finally {
      document.body.removeChild(ta)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-xl font-semibold text-white m-0">Utilisateurs</h2>
        {usersErr && <p className="text-red-500 text-sm m-0">{usersErr}</p>}
      </div>

      {/* Tuile Ajouter un utilisateur */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Ajouter un utilisateur</h3>
        <p className="text-xs text-neutral-500 mb-4">Créez un utilisateur et récupérez une clé API. La clé ne sera affichée qu’une seule fois.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 items-end">
          <div className={fieldClass}>
            <label htmlFor="create-user-id" className={labelClass}>Identifiant</label>
            <input id="create-user-id" value={createUserId} onChange={e => setCreateUserId(e.target.value)} placeholder="Utilisateur" className={inputClass} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="create-priority" className={labelClass}>Priorité (1 = haute)</label>
            <input id="create-priority" type="number" value={createPriority} min={1} className={inputClass} onChange={e => setCreatePriority(Number(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1.5 justify-end">
            <label htmlFor="create-threshold" className="flex items-center gap-2 cursor-pointer py-2">
              <input
                id="create-threshold"
                type="checkbox"
                checked={createThreshold}
                onChange={e => setCreateThreshold(e.target.checked)}
                className="w-4 h-4 rounded border-neutral-600 bg-neutral-950 text-amber-500 focus:ring-2 focus:ring-amber-500 focus:ring-offset-0 focus:ring-offset-neutral-900"
              />
              <span className="text-sm text-neutral-300" title="Activer le grace period pour cet utilisateur : après ses requêtes, le worker attend avant de servir un user moins prioritaire.">Threshold</span>
            </label>
          </div>
          <div className="sm:col-span-2 xl:col-span-2 flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-400 invisible">Action</span>
            <button
              type="button"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-neutral-900"
              onClick={handleCreateUser}
            >
              Créer et générer une clé
            </button>
          </div>
        </div>
      </section>

      {/* Tuile Utilisateurs existants */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Utilisateurs existants</h3>
        <p className="text-xs text-neutral-500 mb-4">Liste des utilisateurs et préfixes de clé. Supprimez un utilisateur pour invalider sa clé.</p>
        {users.length === 0 ? (
          <p className="text-sm text-neutral-500 m-0">Aucun utilisateur. Créez-en un ci-dessus.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
            <table className="w-full min-w-[500px] text-left border-collapse text-sm">
              <thead>
                <tr>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Identifiant</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Priorité</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 text-center">Threshold</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Clé (masquée)</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.user_id}>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-200 font-medium">{u.user_id}</td>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{u.priority}</td>
                    <td className="p-3 border-b border-neutral-800/50 text-center">
                      <button
                        type="button"
                        className={`inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                          u.threshold
                            ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/40'
                            : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700 border border-neutral-700'
                        }`}
                        title={u.threshold ? 'Threshold actif — cliquer pour désactiver' : 'Threshold inactif — cliquer pour activer'}
                        onClick={() => handleToggleThreshold(u.user_id, u.threshold)}
                      >
                        {u.threshold ? '\u25CF' : '\u25CB'}
                      </button>
                    </td>
                    <td className="p-3 border-b border-neutral-800/50 text-neutral-400 font-mono text-xs">{u.key_prefix}</td>
                    <td className="p-3 border-b border-neutral-800/50">
                      <button
                        type="button"
                        className="px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/30 rounded-md text-sm font-medium transition-colors"
                        onClick={() => handleDeleteUser(u.user_id)}
                      >
                        Supprimer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Modal clé API générée */}
      {newKeyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={() => { setNewKeyModal(null); setCopyFeedback(false) }}
        >
          <div
            ref={modalRef}
            className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-xl p-6 w-full max-w-lg"
            role="dialog"
            aria-modal="true"
            aria-label="Clé API générée"
            tabIndex={-1}
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white m-0 mb-2">Clé API générée</h3>
            <p className="text-sm text-amber-400/90 mb-4">Copiez cette clé maintenant. Elle ne sera plus affichée.</p>
            <p className="mb-4 break-all font-mono text-sm text-neutral-200 bg-neutral-950 border border-neutral-800 rounded-lg p-3">{newKeyModal}</p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors"
                onClick={copyKey}
              >
                Copier
              </button>
              {copyFeedback && <span className="text-sm font-medium text-emerald-400">Copié !</span>}
              <button
                type="button"
                className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-md transition-colors"
                onClick={() => setNewKeyModal(null)}
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
