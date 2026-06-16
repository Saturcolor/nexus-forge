import { useConfig } from '../../api/queries'
import { LiveCard }       from './brain/LiveCard'
import { MemoryCard }     from './brain/MemoryCard'
import { SettingsCard }   from './brain/SettingsCard'
import { ToolboxesCard }  from './brain/ToolboxesCard'
import { LuceboxCard }    from './brain/LuceboxCard'
import { AudioCard }      from './brain/AudioCard'
import { OmniVoiceCard }  from './brain/OmniVoiceCard'
import { AtlasCard }      from './brain/AtlasCard'
import { DaemonLogsCard } from './brain/DaemonLogsCard'

export function BrainPage() {
  const { data: config } = useConfig()
  return (
    <div className="flex flex-col gap-4">

      {/* ── Hero 2-col: Live (3/5) + Memory pools (2/5) ────────────── */}
      <div className="grid grid-cols-1 2xl:grid-cols-5 gap-4">
        <div className="2xl:col-span-3">
          <LiveCard />
        </div>
        <div className="2xl:col-span-2">
          <MemoryCard />
        </div>
      </div>

      <SettingsCard />
      <ToolboxesCard />
      {config?.lucebox_enabled === true && <LuceboxCard />}
      {config?.audio_local_enabled      && <AudioCard />}
      {config?.audio_local_enabled      && <OmniVoiceCard />}
      <AtlasCard />
      <DaemonLogsCard />
    </div>
  )
}
