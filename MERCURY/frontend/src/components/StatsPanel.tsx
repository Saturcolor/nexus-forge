import { useState } from 'react'
import { useStats, useDates } from '../api/queries'
import { formatDurationMs, formatTokenCount } from '../utils/format'
import Spinner from './Spinner'

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'

export default function StatsPanel() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const { data: stats, error, isLoading, refetch } = useStats(selectedDate)
  const { data: dates = [] } = useDates()

  const statsErr = error instanceof Error ? error.message : String(error || '')

  const hasTokens = (stats?.total_input_tokens != null && stats.total_input_tokens > 0) || (stats?.total_output_tokens != null && stats.total_output_tokens > 0)
  const hasReasoning = stats?.total_reasoning_tokens != null && stats.total_reasoning_tokens > 0
  const byUser = stats?.by_user ?? {}
  const hasByUser = Object.keys(byUser).length > 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-xl font-semibold text-white m-0">Statistiques d'utilisation</h2>
        {error && <p className="text-red-500 text-sm m-0">{statsErr}</p>}
      </div>

      {/* Tuile Filtres */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Filtres</h3>
        <p className="text-xs text-neutral-500 mb-4">Choisissez une date pour afficher les statistiques d'utilisation (requêtes, durée, tokens).</p>
        <div className="flex flex-col sm:flex-row flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1.5 min-w-[180px]">
            <label htmlFor="stats-date" className={labelClass}>Date</label>
            <select
              id="stats-date"
              value={selectedDate ?? ''}
              onChange={e => setSelectedDate(e.target.value || null)}
              className={inputClass}
            >
              <option value="">Aujourd'hui</option>
              {dates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <button
            type="button"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-neutral-900"
            onClick={() => refetch()}
          >
            Rafraîchir
          </button>
        </div>
      </section>

      {isLoading && <Spinner />}

      {!isLoading && stats && (
        <>
          {/* Tuile Résumé */}
          <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
            <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Résumé</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              <div className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                <span className="text-2xl font-bold text-white mb-1">{stats.total_requests}</span>
                <span className="text-xs text-neutral-400 uppercase tracking-wider font-medium">Total requêtes</span>
              </div>
              <div className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                <span className="text-xl font-bold text-neutral-200 mb-1">{formatDurationMs(stats.total_duration_ms)}</span>
                <span className="text-xs text-neutral-400 uppercase tracking-wider font-medium">Durée totale</span>
              </div>
              {hasTokens && (
                <>
                  <div className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                    <span className="text-xl font-bold text-neutral-200 mb-1">{formatTokenCount(stats.total_input_tokens)}</span>
                    <span className="text-xs text-neutral-400 uppercase tracking-wider font-medium">Tokens entrée</span>
                  </div>
                  <div className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                    <span className="text-xl font-bold text-neutral-200 mb-1">{formatTokenCount(stats.total_output_tokens)}</span>
                    <span className="text-xs text-neutral-400 uppercase tracking-wider font-medium">Tokens sortie</span>
                  </div>
                </>
              )}
              {stats.requests_with_usage != null && stats.requests_with_usage > 0 && (
                <div className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                  <span className="text-xl font-bold text-neutral-200 mb-1">{stats.requests_with_usage}</span>
                  <span className="text-xs text-neutral-400 uppercase tracking-wider font-medium">Requêtes avec usage</span>
                </div>
              )}
            </div>
          </section>

          {/* Tuile Par utilisateur */}
          <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
            <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2 mb-4">Par utilisateur</h3>
            {!hasByUser ? (
              <p className="text-sm text-neutral-500 m-0">Aucune donnée par utilisateur pour cette date.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950">
                <table className="w-full min-w-[500px] text-left border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Utilisateur</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Requêtes</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Durée</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Tokens entrée</th>
                      <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Tokens sortie</th>
                      {hasReasoning && <th className="p-3 font-medium text-neutral-400 border-b border-neutral-800">Tokens reasoning</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(byUser).map(([uid, v]) => (
                      <tr key={uid}>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200 font-medium">{uid}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{v.requests}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{formatDurationMs(v.total_duration_ms)}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{formatTokenCount(v.total_input_tokens)}</td>
                        <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{formatTokenCount(v.total_output_tokens)}</td>
                        {hasReasoning && (
                          <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{formatTokenCount(v.total_reasoning_tokens)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {!isLoading && !stats && !error && (
        <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
          <p className="text-neutral-500 text-sm m-0">Sélectionnez une date et rafraîchissez pour charger les statistiques.</p>
        </section>
      )}
    </div>
  )
}
