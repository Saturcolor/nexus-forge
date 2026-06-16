import { useQueue, useConfig, useSaveConfigMutation } from '../../api/queries'
import type { Config } from '../../api/admin'

export default function CloudStatsSection() {
  const { data: queue } = useQueue()
  const { data: config } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()

  const cloudBypass = config?.cloud_bypass_queue !== false

  const handleToggleBypass = async () => {
    if (!config) return
    const next = !cloudBypass
    try {
      await saveConfigMutation.mutateAsync({ ...config, cloud_bypass_queue: next } as Config)
    } catch { /* ignore */ }
  }

  const inProgress = queue?.cloud_in_progress ?? 0
  const processed = queue?.cloud_processed ?? 0
  const inProgressList = queue?.cloud_in_progress_list ?? []

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white m-0">Requetes cloud</h3>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-neutral-400">Bypass queue</span>
          <button
            type="button"
            role="switch"
            aria-checked={cloudBypass}
            onClick={handleToggleBypass}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${cloudBypass ? 'bg-indigo-600' : 'bg-neutral-600'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${cloudBypass ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
          </button>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col items-center justify-center p-4 bg-indigo-950/20 border border-indigo-900/50 rounded-lg ring-1 ring-indigo-500/20">
          <span className="text-3xl font-bold text-indigo-400 mb-1">{inProgress}</span>
          <span className="text-xs text-indigo-400 uppercase tracking-wider font-medium">En cours</span>
        </div>
        <div className="flex flex-col items-center justify-center p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
          <span className="text-3xl font-bold text-neutral-300 mb-1">{processed}</span>
          <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">Traitees</span>
        </div>
      </div>

      {inProgressList.length > 0 && (
        <div className="overflow-auto max-h-40 rounded-lg border border-neutral-800 bg-neutral-950">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 bg-neutral-950">
              <tr>
                <th className="p-2.5 font-medium text-neutral-400 border-b border-neutral-800">Modele</th>
                <th className="p-2.5 font-medium text-neutral-400 border-b border-neutral-800">User</th>
                <th className="p-2.5 font-medium text-neutral-400 border-b border-neutral-800">Backend</th>
              </tr>
            </thead>
            <tbody>
              {inProgressList.map((item, i) => (
                <tr key={i}>
                  <td className="p-2.5 border-b border-neutral-800/50 text-neutral-200"><code>{item.model}</code></td>
                  <td className="p-2.5 border-b border-neutral-800/50 text-neutral-300">{item.user_id}</td>
                  <td className="p-2.5 border-b border-neutral-800/50">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                      {item.backend}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!cloudBypass && (
        <p className="text-xs text-amber-400 m-0">
          Bypass desactive : les requetes cloud passent par la file sequentielle.
        </p>
      )}
    </section>
  )
}
