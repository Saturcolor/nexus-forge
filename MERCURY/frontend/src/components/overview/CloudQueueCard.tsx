import { useQueue } from '../../api/queries'

export default function CloudQueueCard() {
  const { data: queue, isLoading } = useQueue()

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-4 py-2 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-white m-0">Cloud</h2>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-neutral-500 text-xs">...</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col items-center justify-center p-2 bg-indigo-950/20 border border-indigo-900/50 rounded-lg ring-1 ring-indigo-500/20">
              <span className="text-xl font-bold text-indigo-400">{queue?.cloud_in_progress ?? 0}</span>
              <span className="text-[10px] text-indigo-400 uppercase tracking-wide font-medium">En cours</span>
            </div>
            <div className="flex flex-col items-center justify-center p-2 bg-neutral-950 border border-neutral-800 rounded-lg">
              <span className="text-xl font-bold text-neutral-300">{queue?.cloud_processed ?? 0}</span>
              <span className="text-[10px] text-neutral-500 uppercase tracking-wide font-medium">Traitees</span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
