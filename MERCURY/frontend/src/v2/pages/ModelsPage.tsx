import { useCallback, useState } from 'react'
import { HardDrive, Search, Download, Link2 } from 'lucide-react'
import { clsx } from 'clsx'
import { useHfJobs } from '../../api/queries'
import { LocalModelsCard } from './models/LocalModelsCard'
import { SearchCard }      from './models/SearchCard'
import { DownloadsCard }   from './models/DownloadsCard'
import { EmbeddingsCard }  from './models/EmbeddingsCard'

type ModelsTab = 'bibliotheque' | 'recherche' | 'telechargements' | 'embeddings'

const TAB_KEY = 'mercury_v2_models_tab'
const VALID_TABS: ModelsTab[] = ['bibliotheque', 'recherche', 'telechargements', 'embeddings']

export function ModelsPage() {
  const [tab, setTab] = useState<ModelsTab>(() => {
    try {
      const s = localStorage.getItem(TAB_KEY)
      if (VALID_TABS.includes(s as ModelsTab)) return s as ModelsTab
    } catch { /* ignore */ }
    return 'bibliotheque'
  })

  const handleTabChange = useCallback((id: ModelsTab) => {
    setTab(id)
    try { localStorage.setItem(TAB_KEY, id) } catch { /* ignore */ }
  }, [])

  const { data: jobs } = useHfJobs()
  const activeDownloads = (jobs ?? []).filter(j => j.state === 'queued' || j.state === 'running').length

  const TABS: { id: ModelsTab; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: 'bibliotheque',    label: 'Bibliothèque',   icon: HardDrive },
    { id: 'recherche',       label: 'Recherche HF',   icon: Search    },
    { id: 'telechargements', label: 'Téléchargements', icon: Download, badge: activeDownloads || undefined },
    { id: 'embeddings',      label: 'Embeddings',      icon: Link2     },
  ]

  return (
    <div className="flex flex-col gap-5">
      {/* ── Tab bar ──────────────────────────────────────────────── */}
      <div className="flex items-end border-b border-border/60 -mx-4 md:-mx-6 px-4 md:px-6 overflow-x-auto no-scrollbar">
        {TABS.map(({ id, label, icon: Icon, badge }) => (
          <button
            key={id}
            type="button"
            onClick={() => handleTabChange(id)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-semibold border-b-2 -mb-px transition-colors shrink-0',
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/60',
            )}
          >
            <Icon size={13} />
            {label}
            {badge !== undefined && (
              <span className="ml-0.5 min-w-[16px] px-1 py-px bg-primary text-primary-foreground text-[9px] font-bold rounded-full leading-tight text-center">
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'bibliotheque'    && <LocalModelsCard />}
      {tab === 'recherche'       && <SearchCard />}
      {tab === 'telechargements' && <DownloadsCard />}
      {tab === 'embeddings'      && <EmbeddingsCard />}
    </div>
  )
}
