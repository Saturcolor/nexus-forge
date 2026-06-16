import { useCallback, useState } from 'react'
import { clsx } from 'clsx'
import { Network, Volume2 } from 'lucide-react'
import { useAudioVoices } from '../../api/queries'
import { RoutingTagsCard } from './routing/RoutingTagsCard'
import { ModelMappingCard } from './routing/ModelMappingCard'
import { ModelRoutesCard } from './routing/ModelRoutesCard'
import { AudioRoutingCard } from './routing/AudioRoutingCard'

type RoutingTab = 'resolution' | 'audio'

const TAB_KEY = 'mercury_v2_routing_tab'
const VALID_TABS: RoutingTab[] = ['resolution', 'audio']

/**
 * V2 Routing page — migrated from `src/components/ModelRoutingPanel.tsx`.
 *
 * Behavior preserved 1:1:
 *  - resolve mapping rows from `getModelMapping` (config + cache + backend)
 *  - add / edit / delete entries in `config.model_mapping` via `useSaveConfigMutation`
 *  - hide / unhide models via `useSetHiddenModelMutation`
 *  - refresh / flush cache via admin API
 *  - list audio STT/TTS models + voices via `useAudioVoices`
 */
export function RoutingPage() {
  const [tab, setTab] = useState<RoutingTab>(() => {
    try {
      const s = localStorage.getItem(TAB_KEY)
      if (VALID_TABS.includes(s as RoutingTab)) return s as RoutingTab
    } catch { /* ignore */ }
    return 'resolution'
  })

  const handleTabChange = useCallback((id: RoutingTab) => {
    setTab(id)
    try { localStorage.setItem(TAB_KEY, id) } catch { /* ignore */ }
  }, [])

  const { data: audioVoicesData } = useAudioVoices()
  const audioCount =
    (audioVoicesData?.stt_models.length ?? 0) +
    (audioVoicesData?.tts_models.length ?? 0)

  const TABS: { id: RoutingTab; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: 'resolution', label: 'Résolution', icon: Network },
    { id: 'audio',      label: 'Audio',      icon: Volume2, badge: audioCount || undefined },
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

      {tab === 'resolution' && (
        <div className="flex flex-col gap-4">
          <ModelMappingCard />
          <ModelRoutesCard />
          <RoutingTagsCard />
        </div>
      )}

      {tab === 'audio' && (
        <div className="flex flex-col gap-4">
          <AudioRoutingCard />
        </div>
      )}
    </div>
  )
}

export default RoutingPage
