import { useCallback, useState } from 'react'
import { clsx } from 'clsx'
import { Play, ListChecks, MessagesSquare, Radio, Trophy, FlaskConical } from 'lucide-react'
import {
  useBenchmarkPresets, useBenchmarkModels, useLlamacppProbe,
} from '../../api/queries'
import { ModelConfigCard }   from './benchmark/ModelConfigCard'
import { RunCard }           from './benchmark/RunCard'
import { SuiteCard }         from './benchmark/SuiteCard'
import { ConversationCard }  from './benchmark/ConversationCard'
import { LiveChatWrapCard }  from './benchmark/LiveChatWrapCard'
import { RankingsCard }      from './benchmark/RankingsCard'
import { ExternalBenchCard } from './benchmark/ExternalBenchCard'

type BenchTab = 'run' | 'suite' | 'conv' | 'live' | 'rankings' | 'ext'

const TABS: { id: BenchTab; label: string; icon: React.ElementType }[] = [
  { id: 'run',       label: 'Run',         icon: Play          },
  { id: 'suite',     label: 'Suite',       icon: ListChecks    },
  { id: 'conv',      label: 'Conversation', icon: MessagesSquare },
  { id: 'live',      label: 'Live',        icon: Radio         },
  { id: 'rankings',  label: 'Classement',  icon: Trophy        },
  { id: 'ext',       label: 'Externe',     icon: FlaskConical  },
]

const TAB_KEY = 'mercury_v2_benchmark_tab'

export function BenchmarkPage() {
  const [tab, setTab] = useState<BenchTab>(() => {
    try {
      const s = localStorage.getItem(TAB_KEY)
      if (s && TABS.find(t => t.id === s)) return s as BenchTab
    } catch { /* ignore */ }
    return 'run'
  })
  const handleTabChange = useCallback((id: BenchTab) => {
    setTab(id)
    try { localStorage.setItem(TAB_KEY, id) } catch { /* ignore */ }
  }, [])

  const { data: probeData }    = useLlamacppProbe(true)
  const { data: presetsData }  = useBenchmarkPresets()
  const { data: modelsData }   = useBenchmarkModels()
  const [selectedModel, setSelectedModel] = useState('')

  const loadedModels = probeData?.instances ?? []
  const presets      = presetsData?.presets ?? []
  const modelsMeta   = modelsData?.models  ?? {}

  // Tabs that require an active model selection
  const needsModel: BenchTab[] = ['run', 'suite', 'conv', 'live']
  const showNoModelHint = needsModel.includes(tab) && !selectedModel

  return (
    <div className="flex flex-col gap-5">

      {/* Model picker — always visible at the top */}
      <ModelConfigCard
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        loadedModels={loadedModels}
        modelsMeta={modelsMeta}
      />

      {/* ── Tab bar ─────────────────────────────────────────────────── */}
      <div className="flex items-end border-b border-border/60 -mx-4 md:-mx-6 px-4 md:px-6 overflow-x-auto no-scrollbar">
        {TABS.map(({ id, label, icon: Icon }) => (
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
          </button>
        ))}
      </div>

      {showNoModelHint && (
        <p className="text-[11px] text-muted-foreground m-0">
          Sélectionnez un modèle ci-dessus pour activer cet onglet.
        </p>
      )}

      {tab === 'run'      && selectedModel && <RunCard selectedModel={selectedModel} presets={presets} />}
      {tab === 'suite'    && selectedModel && <SuiteCard selectedModel={selectedModel} presets={presets} />}
      {tab === 'conv'     && selectedModel && <ConversationCard selectedModel={selectedModel} />}
      {tab === 'live'     && selectedModel && <LiveChatWrapCard selectedModel={selectedModel} />}
      {tab === 'rankings' && <RankingsCard modelsMeta={modelsMeta} />}
      {tab === 'ext'      && <ExternalBenchCard />}
    </div>
  )
}

export default BenchmarkPage
