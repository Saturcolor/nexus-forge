import { useQueue, useCancelQueueMutation } from '../../api/queries'
import Spinner from '../Spinner'

export default function QueueStatsCard() {
  const { data: queue, error, isLoading, refetch } = useQueue()
  const cancelMutation = useCancelQueueMutation()

  const thresholdActive = queue?.threshold_active === true
  const thresholdRemaining = queue?.threshold_remaining ?? 0

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col min-h-0 h-full">
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">File locale</h2>
        <button type="button" className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium rounded transition-colors" onClick={() => refetch()}>Rafraichir</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        {isLoading && <Spinner />}
        {error && <p className="text-red-500 text-xs mb-2">{error instanceof Error ? error.message : String(error)}</p>}
        {queue && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col items-center justify-center p-2 bg-neutral-950 border border-neutral-800 rounded-lg">
                <span className="text-xl font-bold text-white">{queue.size ?? 0}</span>
                <span className="text-[10px] text-neutral-400 uppercase tracking-wide font-medium">Attente</span>
              </div>
              <div className="flex flex-col items-center justify-center p-2 bg-blue-950/20 border border-blue-900/50 rounded-lg ring-1 ring-blue-500/20">
                <span className="text-xl font-bold text-blue-400">{queue.in_progress ?? 0}</span>
                <span className="text-[10px] text-blue-400 uppercase tracking-wide font-medium">En cours</span>
              </div>
              <div className="flex flex-col items-center justify-center p-2 bg-neutral-950 border border-neutral-800 rounded-lg">
                <span className="text-xl font-bold text-neutral-300">{queue.processed ?? 0}</span>
                <span className="text-[10px] text-neutral-500 uppercase tracking-wide font-medium">Traitees</span>
              </div>
            </div>

            {/* Requête en cours — bouton annuler */}
            {queue.current_request && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-red-950/20 border-red-900/40">
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-red-300 font-medium truncate block">{queue.current_request.model}</span>
                  <span className="text-[10px] text-red-400/60 truncate block">{queue.current_request.user_id}</span>
                </div>
                <button
                  type="button"
                  className="px-2 py-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-[11px] font-medium rounded transition-colors shrink-0"
                  disabled={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate()}
                >
                  {cancelMutation.isPending ? '...' : 'Annuler'}
                </button>
              </div>
            )}

            {/* Priority threshold indicator */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
              thresholdActive
                ? 'bg-amber-950/30 border-amber-700/50'
                : 'bg-neutral-950 border-neutral-800'
            }`}>
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                thresholdActive ? 'bg-amber-400 animate-pulse' : 'bg-neutral-600'
              }`} />
              <div className="flex-1 min-w-0">
                <span className={`text-xs font-medium ${thresholdActive ? 'text-amber-300' : 'text-neutral-500'}`}>
                  Threshold
                </span>
              </div>
              {thresholdActive && (
                <span className="text-xs font-mono font-bold text-amber-400 tabular-nums">
                  {thresholdRemaining.toFixed(0)}s
                </span>
              )}
              {!thresholdActive && (
                <span className="text-[10px] text-neutral-600">inactif</span>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
