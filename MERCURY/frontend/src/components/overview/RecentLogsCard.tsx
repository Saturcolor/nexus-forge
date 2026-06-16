import { useRecentLogs } from '../../api/queries'
import { formatLogDateTime, formatLogStatus, formatDurationMs, formatUsageSummary, logStatusBadgeClass } from '../../utils/format'

export default function RecentLogsCard() {
  const { data: recentLogs = [] } = useRecentLogs()

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 lg:col-span-2">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h2 className="text-lg font-semibold text-white m-0">Actions récentes</h2>
      </div>
      {recentLogs.length === 0 && <p className="text-neutral-500 text-sm">Aucune requête récente.</p>}
      {recentLogs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {recentLogs.slice(0, 8).map((e, i) => (
            <li key={`${e.request_id}-${i}`} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 bg-neutral-950 border border-neutral-800/60 rounded-md gap-2 hover:bg-neutral-800/50 transition-colors">
              <span className="text-sm text-neutral-300 truncate">
                <strong className="text-white font-medium">{e.user_id ?? '—'}</strong>
                <span className="mx-2 text-neutral-600">·</span>
                <span className="text-neutral-200">{e.model}</span>
                <span className="mx-2 text-neutral-600">→</span>
                <span className="text-neutral-400">{e.backend === '-' ? '—' : e.backend}</span>
              </span>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`px-2 py-0.5 rounded text-xs font-medium border ${logStatusBadgeClass(e.status)}`}>
                  {formatLogStatus(e.status)}
                </span>
                <span className="text-xs text-neutral-500 flex flex-col items-end">
                  <span>{formatLogDateTime(e.timestamp ?? e.date ?? undefined)} · {formatDurationMs(e.duration_ms)}</span>
                  {(e.usage || e.error) && (
                    <span className="mt-0.5">
                      {e.usage && <span>{formatUsageSummary(e.usage, e.duration_ms)}</span>}
                      {e.error && <span className="text-red-400 ml-1">{e.error}</span>}
                    </span>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}