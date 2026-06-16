import { inputClass, labelClass, fieldClass, sectionClass, legendClass, type SectionProps } from './shared'
import Checkbox from './Checkbox'
import OrderableList from './OrderableList'

const DEFAULT_FALLBACK_ORDER = ['openrouter', 'anthropic']
const CLOUD_LABELS: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic' }

export default function QueueRoutingSection({ config, updateField, markDirty }: SectionProps) {
  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">File d'attente & Routage</h3>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>File d'attente</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={fieldClass}>
            <label htmlFor="cfg-queue-size" className={labelClass}>Taille max</label>
            <input id="cfg-queue-size" type="number" value={config.queue_max_size ?? 100} className={inputClass} onChange={e => updateField('queue_max_size', Number(e.target.value))} />
          </div>
          <div className={fieldClass}>
            <label htmlFor="cfg-queue-timeout" className={labelClass}>Timeout file (s)</label>
            <input id="cfg-queue-timeout" type="number" value={config.queue_timeout_seconds ?? ''} min={0} className={inputClass} onChange={e => updateField('queue_timeout_seconds', e.target.value === '' ? undefined : Number(e.target.value))} placeholder="Aucun" title="Timeout des requetes en attente dans la file (secondes). Vide = pas de timeout." />
          </div>
        </div>

        <Checkbox
          id="cfg-priority-threshold"
          checked={config.priority_threshold_enabled === true}
          onChange={e => updateField('priority_threshold_enabled', e.target.checked)}
          label="Priority threshold (grace period)"
          tooltip="Apres traitement d'un user prioritaire, attend un delai avant de servir un user moins prioritaire. Permet aux users haute priorite d'enchainer leurs requetes en serie sans etre interrompus."
        />
        {config.priority_threshold_enabled && (
          <div className={fieldClass}>
            <label htmlFor="cfg-priority-threshold-seconds" className={labelClass}>Delai grace period (s)</label>
            <input
              id="cfg-priority-threshold-seconds"
              type="number"
              value={config.priority_threshold_seconds ?? 30}
              min={5}
              max={120}
              step={5}
              className={inputClass}
              onChange={e => updateField('priority_threshold_seconds', Number(e.target.value))}
            />
            <p className="text-xs text-neutral-500">Temps d'attente apres la derniere requete d'un user prioritaire avant de traiter les requetes de priorite inferieure.</p>
          </div>
        )}
      </fieldset>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>Routage auto</legend>
        <Checkbox
          id="cfg-auto-priority-enabled"
          checked={config.auto_priority_enabled !== false}
          onChange={e => updateField('auto_priority_enabled', e.target.checked)}
          label="Priorite stricte (auto_priority_enabled)"
          tooltip="Active : le modele auto est choisi selon provider_priority et model_priority. Desactive : prefere les modeles deja charges en memoire."
        />
      </fieldset>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-3">
        <legend className={legendClass}>Ordre fallback cloud</legend>
        <p className="text-xs text-neutral-500 m-0">Ordre de preference des providers cloud pour le fallback (premier = utilise en priorite).</p>
        <OrderableList
          items={config.fallback_providers_order ?? DEFAULT_FALLBACK_ORDER}
          onChange={items => { markDirty(); updateField('fallback_providers_order', items) }}
          labels={CLOUD_LABELS}
        />
      </fieldset>
    </section>
  )
}
