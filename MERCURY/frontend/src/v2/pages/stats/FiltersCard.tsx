import { RefreshCw, Calendar } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'

type FiltersCardProps = {
  dates: string[]
  selectedDate: string | null
  onDateChange: (date: string | null) => void
  onRefresh: () => void
  isFetching?: boolean
}

export function FiltersCard({ dates, selectedDate, onDateChange, onRefresh, isFetching }: FiltersCardProps) {
  return (
    <Card>
      <CardHeader
        title="Filtres"
        icon={<Calendar size={13} />}
        subtitle="Choisissez une date pour afficher les statistiques d'utilisation."
      />
      <CardBody className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex flex-col gap-1.5 min-w-[180px]">
          <label
            htmlFor="stats-date"
            className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold"
          >
            Date
          </label>
          <select
            id="stats-date"
            value={selectedDate ?? ''}
            onChange={e => onDateChange(e.target.value || null)}
            className="px-2.5 py-1.5 bg-background border border-border/60 rounded-md text-xs text-foreground font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/40"
          >
            <option value="">Aujourd'hui</option>
            {dates.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <Button variant="primary" size="md" onClick={onRefresh} disabled={isFetching}>
          <RefreshCw size={11} className={isFetching ? 'animate-spin' : ''} />
          Rafraîchir
        </Button>
      </CardBody>
    </Card>
  )
}
