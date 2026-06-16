import { Server } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { inputCls, labelCls, fieldCls, groupCls, type SectionProps } from './shared'

export function NetworkCard({ config, updateField }: SectionProps) {
  return (
    <Card>
      <CardHeader title="Réseau & Serveur" icon={<Server size={13} />} />
      <CardBody className="!py-4 flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <span className={groupCls}>Écoute</span>
          <div className="grid grid-cols-2 gap-3">
            <div className={fieldCls}>
              <label htmlFor="cfg-host" className={labelCls}>Host</label>
              <input id="cfg-host" value={config.server_host ?? ''} onChange={e => updateField('server_host', e.target.value)} placeholder="0.0.0.0" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label htmlFor="cfg-port" className={labelCls}>Port</label>
              <input id="cfg-port" type="number" value={config.server_port ?? 17890} onChange={e => updateField('server_port', Number(e.target.value))} className={inputCls} />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <span className={groupCls}>Timeouts</span>
          <div className="grid grid-cols-2 gap-3">
            <div className={fieldCls}>
              <label htmlFor="cfg-backend-timeout" className={labelCls}>Timeout backend (s)</label>
              <input id="cfg-backend-timeout" type="number" value={config.backend_timeout ?? 300} min={10} onChange={e => updateField('backend_timeout', Number(e.target.value))} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label htmlFor="cfg-health-timeout" className={labelCls}>Timeout health (s)</label>
              <input id="cfg-health-timeout" type="number" value={config.health_check_timeout ?? 2} min={0.5} max={30} step={0.5} onChange={e => updateField('health_check_timeout', Number(e.target.value))} className={inputCls} />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className={groupCls}>Maintenance</span>
          <div className={fieldCls}>
            <label htmlFor="cfg-log-retention" className={labelCls}>Rétention logs texte (jours)</label>
            <input id="cfg-log-retention" type="number" value={config.log_retention_days ?? 0} min={0} onChange={e => updateField('log_retention_days', Number(e.target.value))} className={inputCls} />
            <p className="text-[10px] text-muted-foreground/60 m-0">0 = pas de nettoyage. Ne concerne que les rotations <code>mercury.log.*</code> ; les <code>usage_*.jsonl</code> (stats dashboard) sont toujours conservés.</p>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
