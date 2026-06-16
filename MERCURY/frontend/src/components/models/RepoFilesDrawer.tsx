import { useHfRepoFiles, useStartHfDownloadMutation, useStartHfDownloadBatchMutation } from '../../api/queries'
import type { HfFile } from '../../api/admin'

const btn = 'px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer'
const btnBlue = `${btn} bg-blue-600 hover:bg-blue-500 text-white`

function fmtSize(n: number): string {
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const SHARD_RE = /-\d{5}-of-\d{5}\.gguf$/i

type DisplayItem =
  | { type: 'single'; file: HfFile }
  | { type: 'shard_group'; basePath: string; files: HfFile[]; totalSize: number }

function buildDisplayItems(files: HfFile[]): DisplayItem[] {
  const shardMap = new Map<string, HfFile[]>()
  const items: DisplayItem[] = []

  for (const f of files) {
    if (f.is_shard) {
      const base = f.path.replace(SHARD_RE, '')
      if (!shardMap.has(base)) shardMap.set(base, [])
      shardMap.get(base)!.push(f)
    } else {
      items.push({ type: 'single', file: f })
    }
  }

  for (const [base, shards] of shardMap) {
    items.push({
      type: 'shard_group',
      basePath: base,
      files: shards.sort((a, b) => a.path.localeCompare(b.path)),
      totalSize: shards.reduce((s, f) => s + f.size, 0),
    })
  }

  return items
}

export default function RepoFilesDrawer({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const { data, isLoading, error } = useHfRepoFiles(repoId, true)
  const startMut = useStartHfDownloadMutation()
  const batchMut = useStartHfDownloadBatchMutation()

  const groups: Record<string, HfFile[]> = {}
  for (const f of data?.files ?? []) {
    const key = f.quant ?? (f.path.toLowerCase().includes('mmproj') ? 'MMPROJ' : 'OTHER')
    if (!groups[key]) groups[key] = []
    groups[key].push(f)
  }

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const order = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q4_K_M', 'Q4_K_S', 'Q3_K_M', 'Q3_K_S', 'Q2_K', 'F16', 'BF16', 'F32']
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })

  return (
    <div className="mt-2 border-l-2 border-blue-600 bg-neutral-950/60 rounded-r-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-neutral-300">
          Fichiers de <span className="text-white font-bold">{repoId}</span>
        </span>
        <button onClick={onClose} className="text-xs text-neutral-500 hover:text-white">✕ Fermer</button>
      </div>
      {isLoading && <p className="text-xs text-neutral-500">Chargement…</p>}
      {error && <p className="text-xs text-red-400">Erreur : {(error as Error).message}</p>}
      {data && data.files.length === 0 && (
        <p className="text-xs text-neutral-500 italic">Aucun fichier GGUF dans ce repo.</p>
      )}
      {sortedKeys.map((quant) => {
        const items = buildDisplayItems(groups[quant])
        return (
          <div key={quant} className="mb-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 mb-1">{quant}</div>
            <div className="flex flex-col gap-1">
              {items.map((item) =>
                item.type === 'single' ? (
                  <div
                    key={item.file.path}
                    className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 bg-neutral-900 rounded hover:bg-neutral-800/80"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-mono text-white truncate" title={item.file.path}>{item.file.path}</span>
                      <span className="text-[10px] text-neutral-500">{fmtSize(item.file.size)}</span>
                    </div>
                    <button
                      className={btnBlue}
                      onClick={() => startMut.mutate({ repo_id: repoId, filename: item.file.path })}
                      disabled={startMut.isPending}
                      title="Télécharger"
                    >
                      ↓ Télécharger
                    </button>
                  </div>
                ) : (
                  <div
                    key={item.basePath}
                    className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 bg-neutral-900 rounded hover:bg-neutral-800/80"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-mono text-white truncate" title={item.basePath}>
                        {item.basePath}.gguf
                      </span>
                      <span className="text-[10px] text-neutral-500">
                        {fmtSize(item.totalSize)} · {item.files.length} parts
                      </span>
                    </div>
                    <button
                      className={btnBlue}
                      onClick={() => batchMut.mutate({ repo_id: repoId, filenames: item.files.map(f => f.path) })}
                      disabled={batchMut.isPending}
                      title={`Télécharger ${item.files.length} fichiers`}
                    >
                      {batchMut.isPending ? '⏳ …' : `↓ ${item.files.length} shards`}
                    </button>
                  </div>
                ),
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
