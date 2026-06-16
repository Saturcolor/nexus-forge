import { Cpu } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { ConfigCheckbox } from './ConfigCheckbox'
import { inputCls, labelCls, fieldCls, groupCls, type SectionProps } from './shared'

export function QuantCard({ config, updateField }: SectionProps) {
  return (
    <Card>
      <CardHeader title="Quantisation" icon={<Cpu size={13} />} />
      <CardBody className="!py-4 flex flex-col gap-5">

        <div className="flex flex-col gap-3">
          <span className={groupCls}>Activation</span>
          <ConfigCheckbox
            id="cfg-quant-enabled"
            checked={config.quant_enabled === true}
            onChange={e => updateField('quant_enabled', e.target.checked)}
            label="Module quant activé"
            hint="Active le proxy vers brain-daemon /quant/*. Désactivé par défaut."
          />
        </div>

        <div className="flex flex-col gap-3">
          <span className={groupCls}>Brain URL</span>
          <div className={fieldCls}>
            <label htmlFor="cfg-quant-brain-url" className={labelCls}>URL brain-daemon</label>
            <input
              id="cfg-quant-brain-url"
              value={config.quant_brain_url ?? ''}
              onChange={e => updateField('quant_brain_url', e.target.value || undefined)}
              placeholder="http://127.0.0.1:4321"
              className={inputCls}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <span className={groupCls}>Timeouts avancés</span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className={fieldCls}>
              <label htmlFor="cfg-quant-timeout" className={labelCls}>Timeout sync (s)</label>
              <input
                id="cfg-quant-timeout"
                type="number"
                value={config.quant_timeout_sec ?? 60}
                min={5}
                onChange={e => updateField('quant_timeout_sec', Number(e.target.value))}
                className={inputCls}
              />
              <p className="text-[10px] text-muted-foreground/60 m-0">Routes /quant/* synchrones. Défaut 60 s.</p>
            </div>
            <div className={fieldCls}>
              <label htmlFor="cfg-quant-carto-timeout" className={labelCls}>Timeout cartographie (s)</label>
              <input
                id="cfg-quant-carto-timeout"
                type="number"
                value={config.quant_cartography_timeout_sec ?? 600}
                min={30}
                onChange={e => updateField('quant_cartography_timeout_sec', Number(e.target.value))}
                className={inputCls}
              />
              <p className="text-[10px] text-muted-foreground/60 m-0">Routes /quant/cartography + surgical. Défaut 600 s.</p>
            </div>
            <div className={fieldCls}>
              <label htmlFor="cfg-quant-stream-timeout" className={labelCls}>Timeout stream (s)</label>
              <input
                id="cfg-quant-stream-timeout"
                type="number"
                value={config.quant_stream_timeout_sec ?? 3600}
                min={60}
                onChange={e => updateField('quant_stream_timeout_sec', Number(e.target.value))}
                className={inputCls}
              />
              <p className="text-[10px] text-muted-foreground/60 m-0">SSE job stream. Défaut 3600 s.</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className={groupCls}>Whitelist routes (quant_allowed_routes)</span>
          <p className="text-[10px] text-muted-foreground/70 m-0 leading-relaxed">
            Laisser <strong>non configuré</strong> (mode défaut recommandé) : toutes les routes{' '}
            <code>/quant/*</code> sont autorisées. Si défini en YAML comme liste de patterns
            exacts, seules les routes listées passent — le mode défaut est préférable pour la
            majorité des usages (BRAIN-DAEMON gère sa propre sécurité via <code>quant_allowed_routes</code>).
            Éditer directement dans <code>mercury-config.yaml</code> si un filtrage précis est nécessaire.
          </p>
        </div>

      </CardBody>
    </Card>
  )
}
