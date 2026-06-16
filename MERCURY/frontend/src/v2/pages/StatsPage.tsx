import { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { useStats, useDates } from '../../api/queries'
import { SectionHeader } from '../ui/SectionHeader'
import { Spinner } from '../ui/Spinner'
import { Card, CardBody } from '../ui/Card'
import { FiltersCard } from './stats/FiltersCard'
import { SummaryCard } from './stats/SummaryCard'
import { ByUserCard } from './stats/ByUserCard'
import { UsageChartCard } from './stats/UsageChartCard'
import { BackendDonutCard, HeatmapCard, TopModelsCard } from './stats/BreakdownCards'

export function StatsPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const { data: stats, error, isLoading, isFetching, refetch } = useStats(selectedDate)
  const { data: dates = [] } = useDates()

  const statsErr = error instanceof Error ? error.message : String(error || '')

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Statistiques d'utilisation"
        icon={<BarChart3 size={14} />}
        right={
          error ? (
            <span className="text-[11px] text-destructive font-medium">{statsErr}</span>
          ) : undefined
        }
      />

      <FiltersCard
        dates={dates}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        onRefresh={() => refetch()}
        isFetching={isFetching}
      />

      {isLoading && (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Spinner size={20} />
        </div>
      )}

      {!isLoading && stats && <SummaryCard stats={stats} />}

      <UsageChartCard />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BackendDonutCard />
        <TopModelsCard />
      </div>

      <HeatmapCard />

      {!isLoading && stats && <ByUserCard stats={stats} />}

      {!isLoading && !stats && !error && (
        <Card>
          <CardBody>
            <p className="text-[11px] text-muted-foreground m-0">
              Sélectionnez une date et rafraîchissez pour charger les statistiques.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
