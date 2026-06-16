import { useLlamacppModels, useDeleteLocalModelMutation } from '../../api/queries'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnRed = `${btn} bg-red-600/80 hover:bg-red-500 text-white`
const badge = (bg: string, text: string, border: string) =>
  `px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${bg} ${text} border ${border}`

export default function LocalModelsCard() {
  const { data, isLoading } = useLlamacppModels()
  const deleteMut = useDeleteLocalModelMutation()

  const models = data?.models ?? []
  const totalSize = models.reduce((sum, m) => sum + (m.size_gb ?? 0), 0)

  const handleDelete = (modelId: string, running: boolean) => {
    if (running) {
      alert(`Le modèle ${modelId} est en cours d'exécution. Déchargez-le d'abord via Brain.`)
      return
    }
    if (!confirm(`Supprimer définitivement ${modelId} du disque ?`)) return
    deleteMut.mutate(modelId)
  }

  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm">
      <div className="px-4 py-2.5 border-b border-neutral-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white m-0">Modèles locaux</h2>
        <span className="text-[10px] text-neutral-500">
          {models.length} modèle(s) · {totalSize.toFixed(1)} GB
        </span>
      </div>
      <div className="px-4 py-3">
        {isLoading ? (
          <p className="text-xs text-neutral-500">Chargement…</p>
        ) : models.length === 0 ? (
          <p className="text-xs text-neutral-500 italic">Aucun modèle local.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {models.map((m) => (
              <div
                key={m.model_id}
                className="flex items-center justify-between gap-2 text-xs px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="font-mono text-white truncate" title={m.model_id}>{m.model_id}</span>
                  {m.running && (
                    <span className={badge('bg-emerald-500/20', 'text-emerald-400', 'border-emerald-500/30')}>
                      running
                    </span>
                  )}
                  {m.protected && (
                    <span className={badge('bg-blue-500/20', 'text-blue-400', 'border-blue-500/30')}>
                      protected
                    </span>
                  )}
                </div>
                <span className="text-neutral-400 font-mono tabular-nums">
                  {m.size_gb?.toFixed(1) ?? '?'} GB
                </span>
                <button
                  className={btnRed}
                  onClick={() => handleDelete(m.model_id, !!m.running)}
                  disabled={m.running || deleteMut.isPending}
                  title={m.running ? 'Déchargez le modèle d\'abord' : 'Supprimer du disque'}
                >
                  Supprimer
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
