import { useState } from 'react'
import { useLogs, useDates } from '../api/queries'
import { formatLogDateTime, formatLogStatus, formatDurationMs, formatUsageSummary, logStatusBadgeClass } from '../utils/format'
import Spinner from './Spinner'

const PAGE_SIZE = 50
const ERROR_PREVIEW_LEN = 60

/** Normalise le champ error (string ou objet sérialisé côté backend) en chaîne pour affichage. */
function errorToString(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err, null, 2)
  } catch {
    return String(err)
  }
}

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'

export default function LogsPanel() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const { data: allLogs = [], error, isLoading, refetch } = useLogs(selectedDate)
  const { data: dates = [] } = useDates()

  const logsErr = error instanceof Error ? error.message : String(error || '')

  const [page, setPage] = useState(0)
  const [filterText, setFilterText] = useState('')
  const [errorDetailModal, setErrorDetailModal] = useState<string | null>(null)

  const filtered = filterText
    ? allLogs.filter(e =>
      (e.user_id ?? '').toLowerCase().includes(filterText.toLowerCase()) ||
      e.model.toLowerCase().includes(filterText.toLowerCase()) ||
      e.backend.toLowerCase().includes(filterText.toLowerCase()) ||
      e.status.toLowerCase().includes(filterText.toLowerCase()) ||
      e.request_id.toLowerCase().includes(filterText.toLowerCase()) ||
      errorToString(e.error).toLowerCase().includes(filterText.toLowerCase())
    )
    : allLogs

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const paginated = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-xl font-semibold text-white m-0">Logs</h2>
        {error && <p className="text-red-500 text-sm m-0">{logsErr}</p>}
      </div>

      {/* Tuile Filtres */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Filtres</h3>
        <p className="text-xs text-neutral-500 mb-4">Choisissez une date (ou « Aujourd'hui » pour le temps réel), filtrez par utilisateur, modèle, backend, statut ou ID, puis rafraîchissez.</p>
        <div className="flex flex-col sm:flex-row flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1.5 min-w-[180px]">
            <label htmlFor="logs-date" className={labelClass}>Date</label>
            <select
              id="logs-date"
              value={selectedDate ?? ''}
              onChange={e => setSelectedDate(e.target.value || null)}
              className={inputClass}
            >
              <option value="">Aujourd'hui (temps réel)</option>
              {dates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
            <label htmlFor="logs-filter" className={labelClass}>Filtrer</label>
            <input
              id="logs-filter"
              type="text"
              placeholder="Utilisateur, modèle, backend, statut, ID…"
              value={filterText}
              onChange={e => { setFilterText(e.target.value); setPage(0) }}
              className={inputClass}
            />
          </div>
          <div className="flex items-end gap-3">
            <button
              type="button"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-neutral-900"
              onClick={() => refetch()}
            >
              Rafraîchir
            </button>
            {filtered.length > 0 && (
              <span className="text-sm text-neutral-400 py-2">
                {filtered.length} requête{filtered.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Contenu : chargement / vide / tableau */}
      {isLoading && <Spinner />}
      {!isLoading && filtered.length === 0 && !error && (
        <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
          <p className="text-neutral-500 text-sm m-0">Aucune requête pour cette date.</p>
        </section>
      )}

      {!isLoading && paginated.length > 0 && (
        <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
          <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Requêtes</h3>
          <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
            <table className="w-full min-w-[900px] text-left border-collapse text-sm">
              <thead>
                <tr>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Date / heure</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Utilisateur</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 hidden md:table-cell">ID</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Modèle</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Backend</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Statut</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Durée</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800 hidden md:table-cell">Tokens</th>
                  <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Erreur</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((entry, i) => {
                  const errorStr = errorToString(entry.error)
                  const hasError = errorStr.length > 0
                  const errorPreview = errorStr.length > ERROR_PREVIEW_LEN
                    ? errorStr.slice(0, ERROR_PREVIEW_LEN) + '…'
                    : (errorStr || '—')
                  return (
                    <tr key={`${entry.request_id}-${i}`}>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200 whitespace-nowrap">{formatLogDateTime(entry.timestamp ?? entry.date ?? undefined)}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{entry.user_id ?? '—'}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-400 font-mono text-xs hidden md:table-cell">{entry.request_id}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{entry.model}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{entry.backend === '-' ? '—' : entry.backend}</td>
                      <td className="p-3 border-b border-neutral-800/50">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${logStatusBadgeClass(entry.status)}`}>
                          {formatLogStatus(entry.status)}
                        </span>
                      </td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{entry.duration_ms != null ? formatDurationMs(entry.duration_ms) : '—'}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200 text-xs hidden md:table-cell">{formatUsageSummary(entry.usage, entry.duration_ms)}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200 max-w-xs">
                        <span className="block truncate" title={hasError ? errorStr : undefined}>
                          {errorPreview}
                        </span>
                        {hasError && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-blue-400 hover:text-blue-300 font-medium"
                            onClick={() => setErrorDetailModal(errorStr)}
                          >
                            Détail
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-4 mt-4 pt-4 border-t border-neutral-800">
              <button
                type="button"
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                disabled={safePage === 0}
                onClick={() => setPage(p => p - 1)}
              >
                ← Précédent
              </button>
              <span className="text-sm text-neutral-400">Page {safePage + 1} / {totalPages}</span>
              <button
                type="button"
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage(p => p + 1)}
              >
                Suivant →
              </button>
            </div>
          )}
        </section>
      )}

      {/* Popup détail erreur */}
      {errorDetailModal != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-labelledby="error-detail-title"
          onClick={() => setErrorDetailModal(null)}
        >
          <div
            className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="shrink-0 flex items-center justify-between gap-4 p-4 border-b border-neutral-800">
              <h3 id="error-detail-title" className="text-lg font-semibold text-white m-0">Détail de l'erreur</h3>
              <button
                type="button"
                className="p-1.5 text-neutral-400 hover:text-white rounded transition-colors"
                onClick={() => setErrorDetailModal(null)}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>
            <pre className="flex-1 min-h-0 p-4 overflow-auto text-sm text-neutral-200 whitespace-pre-wrap break-words font-mono bg-neutral-950 m-0 rounded-b-xl">
              {errorDetailModal}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
