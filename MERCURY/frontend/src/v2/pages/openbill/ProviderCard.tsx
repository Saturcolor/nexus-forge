import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import type { CreditsReport } from '../../../api/admin'
import { formatCreditValue, getProviderDisplayData } from '../../../utils/credits'

type Props = {
  providerId: string
  data: CreditsReport['providers'][string] | undefined
}

export function ProviderCard({ providerId, data }: Props) {
  const display = getProviderDisplayData(providerId, data)
  const isOk = display.statusClass === 'ok'
  const isNonDemande = display.statusText === 'Non demandé'
  const tone = isOk ? 'success' : isNonDemande ? 'muted' : 'destructive'

  return (
    <Card>
      <CardHeader
        title={display.name}
        right={<Badge tone={tone}>{display.statusText}</Badge>}
      />
      <CardBody className="flex flex-col gap-2">
        {display.restant != null && (
          <Row label={display.restantLabel} value={formatCreditValue(display.restant)} strong />
        )}
        {display.depense30j != null && (
          <Row label={display.depense30jLabel} value={formatCreditValue(display.depense30j, true)} />
        )}
        {display.details.map((d, i) => (
          <Row key={i} label={d.label} value={d.value} />
        ))}
        {display.restant == null && display.depense30j == null && display.details.length === 0 && (
          <p className="text-[11px] text-muted-foreground/70 m-0">Aucune donnée.</p>
        )}
      </CardBody>
    </Card>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">{label}</span>
      <span className={
        strong
          ? 'font-mono tabular-nums text-[12px] font-semibold text-foreground'
          : 'font-mono tabular-nums text-[11px] text-foreground/90'
      }>
        {value}
      </span>
    </div>
  )
}
