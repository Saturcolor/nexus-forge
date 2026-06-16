import QueueStatsCard from './overview/QueueStatsCard'
import CloudQueueCard from './overview/CloudQueueCard'
import BackendsCard from './overview/BackendsCard'
import FallbackCard from './overview/FallbackCard'
import HostStatsCard from './overview/HostStatsCard'
import ModelsCacheCard from './overview/ModelsCacheCard'
import OllamaModelsCard from './overview/OllamaModelsCard'
import LlamaCppModelsCard from './overview/LlamaCppModelsCard'
import VllmModelsCard from './overview/VllmModelsCard'
import LuceboxModelsCard from './overview/LuceboxModelsCard'
import RecentLogsCard from './overview/RecentLogsCard'
import AudioLocalCard from './overview/AudioLocalCard'
import { useConfig } from '../api/queries'

// lm_studio et mlx partagent la même card (ModelsCacheCard)
// On normalise ces deux backends vers un même "slot" pour éviter la duplication
const BACKEND_TO_SLOT: Record<string, string> = {
  ollama: 'ollama',
  llamacpp: 'llamacpp',
  vllm: 'vllm',
  lucebox: 'lucebox',
  lm_studio: 'cache',
  mlx: 'cache',
}
const SLOT_CARDS: Record<string, React.ReactNode> = {
  ollama: <OllamaModelsCard key="ollama" />,
  llamacpp: <LlamaCppModelsCard key="llamacpp" />,
  vllm: <VllmModelsCard key="vllm" />,
  lucebox: <LuceboxModelsCard key="lucebox" />,
  cache: <ModelsCacheCard key="cache" />,
}
const DEFAULT_PROVIDER_ORDER = ['ollama', 'llamacpp', 'vllm', 'lucebox', 'lm_studio']

export default function OverviewPanel() {
  const { data: config } = useConfig()
  const providerPriority = config?.provider_priority ?? DEFAULT_PROVIDER_ORDER

  // Filtre les rangées providers si un backend est désactivé.
  // - `cache` regroupe lm_studio + mlx (même carte).
  const ollamaEnabled = config?.ollama_enabled !== false
  const llamacppEnabled = config?.llamacpp_enabled !== false
  const vllmEnabled = config?.vllm_enabled === true  // opt-in
  const luceboxEnabled = config?.lucebox_enabled === true  // opt-in
  const cacheEnabled = (config?.lm_studio_enabled !== false) || (config?.mlx_enabled !== false)
  const slotEnabled: Record<string, boolean> = {
    ollama: ollamaEnabled,
    llamacpp: llamacppEnabled,
    vllm: vllmEnabled,
    lucebox: luceboxEnabled,
    cache: cacheEnabled,
  }

  // Convertit les backends en slots, déduplique, ajoute les slots manquants en fin
  const seenSlots = new Set<string>()
  const orderedSlots: string[] = []
  for (const p of [...providerPriority, ...DEFAULT_PROVIDER_ORDER]) {
    const slot = BACKEND_TO_SLOT[p]
    if (slot && !seenSlots.has(slot)) {
      seenSlots.add(slot)
      orderedSlots.push(slot)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Rangée 1 : gauche = File locale + Cloud + Aperçu cloud | droite = Backends */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:min-h-[580px]">
        <div className="flex flex-col gap-4 min-h-0 lg:h-[580px]">
          <div className="shrink-0 lg:h-[180px]">
            <QueueStatsCard />
          </div>
          <div className="shrink-0 lg:h-[110px]">
            <CloudQueueCard />
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <FallbackCard />
          </div>
        </div>
        <div className="min-h-0 lg:h-[580px]">
          <BackendsCard />
        </div>
      </div>

      {/* Rangée 2 : Stats machine (condensé) */}
      <HostStatsCard />

      {/* Rangées providers : ordonnées selon provider_priority (filtrées) */}
      {orderedSlots.filter(slot => slotEnabled[slot]).map(slot => SLOT_CARDS[slot])}

      {/* Audio Local (si activé) */}
      {config?.audio_local_enabled && (
        <AudioLocalCard />
      )}

      {/* Dernière rangée : Actions récentes (pleine largeur) */}
      <RecentLogsCard />
    </div>
  )
}
