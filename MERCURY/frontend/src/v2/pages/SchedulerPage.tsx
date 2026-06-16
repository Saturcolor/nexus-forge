import { useState } from 'react'
import { useSchedules } from '../../api/queries'
import { ActiveSlotCard }    from './scheduler/ActiveSlotCard'
import { LoadedModelsCard }  from './scheduler/LoadedModelsCard'
import { SchedulesListCard } from './scheduler/SchedulesListCard'
import { HistoryCard }       from './scheduler/HistoryCard'

/**
 * Scheduler V2 — gestion des slots de réservation modèle (cron load/unload).
 *
 * Refonte visuelle 1:1 du V1 `SchedulerPanel` sur la base du kit V2 (Card, Badge,
 * Button…). Toutes les actions (create / edit / delete / trigger / enable / disable
 * / deactivate-slot) restent câblées aux mêmes hooks `useXxxScheduleMutation`,
 * et l'on conserve les invalidations et le polling (`refetchInterval: 5s`).
 */
export function SchedulerPage() {
  const { data, isLoading } = useSchedules()
  const [showCreate, setShowCreate] = useState(false)

  const schedules = data?.schedules || []
  const activeSlot = data?.active_slot || null

  return (
    <div className="flex flex-col gap-5">
      {/* Strip modèles chargés (auto-refresh cache au montage, identique V1). */}
      <LoadedModelsCard />

      {/* Bandeau slot actif — visible uniquement quand un slot tourne. */}
      {activeSlot && <ActiveSlotCard slot={activeSlot} />}

      {/* Liste schedules + bouton "Nouveau" inline. */}
      <SchedulesListCard
        schedules={schedules}
        activeSlot={activeSlot}
        isLoading={isLoading}
        showCreate={showCreate}
        onToggleCreate={() => setShowCreate(v => !v)}
      />

      {/* Historique des 20 derniers runs. */}
      <HistoryCard />
    </div>
  )
}

export default SchedulerPage
