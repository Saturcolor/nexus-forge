import { Shield } from 'lucide-react'
import type { Config } from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { inputCls, labelCls, fieldCls } from '../config/shared'

type Props = {
  config: Config
  updateField: <K extends keyof Config>(key: K, value: Config[K]) => void
}

export function ResilienceCard({ config, updateField }: Props) {
  return (
    <Card>
      <CardHeader
        title="Résilience"
        icon={<Shield size={13} />}
        subtitle="Comportement en cas d'échec des providers cloud"
      />
      <CardBody>
        <div className="max-w-sm flex flex-col gap-3">
          <div className={fieldCls}>
            <label htmlFor="cloud-max-retry" className={labelCls}>
              Tentatives fallback
            </label>
            <input
              id="cloud-max-retry"
              type="number"
              min={1}
              max={5}
              value={config.max_retry_on_fallback ?? 1}
              onChange={e => updateField('max_retry_on_fallback', Number(e.target.value))}
              title="Nombre de tentatives sur le provider cloud fallback avant abandon"
              className={inputCls}
            />
            <p className="text-[10px] text-muted-foreground/60">
              Nombre de retry si le fallback cloud échoue (1 = pas de retry).
            </p>
          </div>
          <p className="text-[10px] text-muted-foreground/50">
            L'ordre des providers cloud est configurable dans la card Priorité des providers (Dashboard).
          </p>
        </div>
      </CardBody>
    </Card>
  )
}
