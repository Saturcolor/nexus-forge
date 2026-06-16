import { inputClass, labelClass, fieldClass, sectionClass, legendClass, type SectionProps } from './shared'

export default function NetworkSection({ config, updateField }: SectionProps) {
  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Reseau & Serveur</h3>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>Ecoute</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={fieldClass}>
            <label htmlFor="cfg-host" className={labelClass}>Host</label>
            <input id="cfg-host" value={config.server_host ?? ''} onChange={e => updateField('server_host', e.target.value)} placeholder="0.0.0.0" className={inputClass} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="cfg-port" className={labelClass}>Port</label>
            <input id="cfg-port" type="number" value={config.server_port ?? 17890} className={inputClass} onChange={e => updateField('server_port', Number(e.target.value))} />
          </div>
        </div>
      </fieldset>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>Timeouts & sante</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={fieldClass}>
            <label htmlFor="cfg-backend-timeout" className={labelClass}>Timeout backend (s)</label>
            <input id="cfg-backend-timeout" type="number" value={config.backend_timeout ?? 300} min={10} className={inputClass} onChange={e => updateField('backend_timeout', Number(e.target.value))} />
            <p className="text-xs text-neutral-500">Temps max pour une requete vers un backend.</p>
          </div>
          <div className={fieldClass}>
            <label htmlFor="cfg-health-timeout" className={labelClass}>Timeout health check (s)</label>
            <input id="cfg-health-timeout" type="number" value={config.health_check_timeout ?? 2} min={0.5} max={30} step={0.5} className={inputClass} onChange={e => updateField('health_check_timeout', Number(e.target.value))} />
            <p className="text-xs text-neutral-500">Delai max pour verifier si un backend est joignable.</p>
          </div>
        </div>
      </fieldset>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>Maintenance</legend>
        <div className={fieldClass}>
          <label htmlFor="cfg-log-retention" className={labelClass}>Retention des logs texte (jours)</label>
          <input id="cfg-log-retention" type="number" value={config.log_retention_days ?? 0} min={0} className={inputClass} onChange={e => updateField('log_retention_days', Number(e.target.value))} />
          <p className="text-xs text-neutral-500">0 = pas de nettoyage. Concerne uniquement les rotations mercury.log.* ; les usage_*.jsonl (stats dashboard) sont toujours conserves.</p>
        </div>
      </fieldset>
    </section>
  )
}
