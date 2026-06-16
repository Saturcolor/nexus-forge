import { useHfJobs, useCancelHfJobMutation } from '../../api/queries'
import type { HfDownloadJob } from '../../api/admin'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnRed = `${btn} bg-red-600/80 hover:bg-red-500 text-white`

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
}

function JobRow({ job, onCancel }: { job: HfDownloadJob; onCancel: () => void }) {
  const pct = Math.min(100, Math.max(0, job.pct))
  const stateLabel =
    job.state === 'queued' ? 'En attente'
    : job.state === 'running' ? (job.cancel_requested ? 'Annulation…' : 'En cours')
    : job.state
  const barColor =
    job.state === 'error' ? 'bg-red-500'
    : job.state === 'cancelled' ? 'bg-neutral-500'
    : job.state === 'done' ? 'bg-emerald-500'
    : 'bg-blue-500'
  return (
    <div className="py-2 px-3 border border-neutral-800 rounded-lg bg-neutral-950">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-mono text-white truncate" title={`${job.repo_id}/${job.filename}`}>
            <span className="text-neutral-400">{job.repo_id}</span> / {job.filename}
          </span>
          <span className="text-[10px] text-neutral-500 mt-0.5">
            {stateLabel} · {fmtBytes(job.bytes_done)} / {fmtBytes(job.bytes_total)} · {fmtSpeed(job.speed_bps)}
          </span>
        </div>
        <button
          className={btnRed}
          onClick={onCancel}
          disabled={job.state !== 'queued' && job.state !== 'running'}
        >
          Annuler
        </button>
      </div>
      <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function QueueCard() {
  const { data } = useHfJobs()
  const cancelMut = useCancelHfJobMutation()
  // Afficher queued + running + erreurs/annulations (pour que l'user voie les echecs).
  // Les jobs 'done' sont caches car le fichier apparait dans LocalModelsCard.
  const visible = (data ?? []).filter((j) => j.state !== 'done')
  const active = visible.filter((j) => j.state === 'queued' || j.state === 'running')

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="px-4 py-2.5 border-b border-neutral-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white m-0">Téléchargements</h2>
        <span className="text-[10px] text-neutral-500">
          {active.length > 0 ? `${active.length} actif(s)` : 'Aucun en cours'}
        </span>
      </div>
      <div className="px-4 py-3">
        {visible.length === 0 ? (
          <p className="text-xs text-neutral-500 italic">Aucun téléchargement en cours.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {visible.map((j) => (
              <div key={j.id}>
                <JobRow job={j} onCancel={() => cancelMut.mutate(j.id)} />
                {j.error && (
                  <p className="text-[10px] text-red-400 font-mono mt-1 px-3">{j.error}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
