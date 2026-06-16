import { Boxes } from 'lucide-react'
import { HostHeroCard } from './cards/HostHeroCard'
import { ActivityStrip } from './cards/ActivityStrip'
import { NowRunningCard } from './cards/NowRunningCard'
import { ProvidersHealthCard } from './cards/ProvidersHealthCard'
import { FallbackCloudCard } from './cards/FallbackCloudCard'
import { AudioIndicatorCard } from './cards/AudioIndicatorCard'
import { RecentLogsCard } from './cards/RecentLogsCard'
import { SectionHeader } from '../ui/SectionHeader'

// Mercury is llamacpp-only in practice today — only the LlamaCPP models card
// is surfaced on the dashboard. Ollama/vLLM/Lucebox/Cache cards stay reachable
// through their dedicated panels until their dashboard mention becomes useful.
import { LlamaCppCard } from './cards/llamacpp/LlamaCppCard'

type DashboardPageProps = {
  onOpenRouting?: (tab?: 'resolution' | 'audio') => void
  onOpenBrain?: () => void
}

export function DashboardPage({ onOpenRouting, onOpenBrain }: DashboardPageProps) {
  return (
    <div className="flex flex-col gap-5">
      {/* 1. Host hero — la zone reine, regardée en premier */}
      <HostHeroCard />

      {/* 2. Activité — strip 4 KPI compacts (local / queue / cloud / threshold) */}
      <ActivityStrip />

      {/* 3. Maintenant — instances llamacpp actives */}
      <NowRunningCard />

      {/* 4. Modèles locaux — load/unload/pin/template/visibilité (focus llamacpp).
            La row reste calme, les actions secondaires vivent dans le menu kebab,
            et l'édition du template + logs s'ouvre dans un drawer side panel. */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Modèles locaux"
          icon={<Boxes size={14} />}
          hint="llamacpp"
        />
        <LlamaCppCard />
      </section>

      {/* 5. Indicateurs read-only — providers locaux · fallback cloud · audio */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ProvidersHealthCard onManage={() => onOpenRouting?.('resolution')} />
        <FallbackCloudCard onManage={() => onOpenRouting?.('resolution')} />
        <AudioIndicatorCard
          onOpenRouting={() => onOpenRouting?.('audio')}
          onOpenBrain={onOpenBrain}
        />
      </div>

      {/* 6. Actions récentes — pleine largeur en bas */}
      <RecentLogsCard />
    </div>
  )
}
