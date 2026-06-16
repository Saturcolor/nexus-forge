import { useHfDisk } from '../../api/queries'

export default function DiskUsageBar() {
  const { data } = useHfDisk()
  if (!data) return null
  const { models_used_gb, disk_used_gb, free_gb, total_gb } = data
  const pct = total_gb > 0 ? Math.min(100, (disk_used_gb / total_gb) * 100) : 0
  const barColor = pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-orange-500' : 'bg-emerald-500'
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex flex-col">
        <span className="text-neutral-400 font-mono">
          Models: <span className="text-white font-bold">{models_used_gb.toFixed(1)} GB</span> ·
          Free: <span className="text-white font-bold">{free_gb.toFixed(1)} GB</span> / {total_gb.toFixed(1)} GB
        </span>
        <div className="w-64 h-1.5 bg-neutral-800 rounded-full overflow-hidden mt-0.5">
          <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  )
}
