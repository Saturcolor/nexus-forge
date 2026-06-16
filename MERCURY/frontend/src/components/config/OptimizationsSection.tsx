import * as api from '../../api/admin'
import { sectionClass, legendClass, type SectionProps } from './shared'
import Checkbox from './Checkbox'

type OptimizationsSectionProps = SectionProps & {
  debugBusy: boolean
  setDebugBusy: (busy: boolean) => void
  refreshConfig: () => void
}

export default function OptimizationsSection({ config, updateField, debugBusy, setDebugBusy, refreshConfig }: OptimizationsSectionProps) {
  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Optimisations & Debug</h3>
      <p className="text-xs text-neutral-500 m-0">Parametres globaux d'optimisation appliques a tous les backends compatibles.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <fieldset className="border-0 p-0 m-0 flex flex-col gap-3">
          <legend className={legendClass}>Thinking Budget (tokens)</legend>
          <p className="text-[10px] text-neutral-500 m-0 -mt-1">Valeurs par defaut quand Mastermind envoie low / medium / high. Appliquees si le template du modele ne definit pas de budget specifique.</p>
          <div className="flex gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-neutral-400">low</label>
              <input type="number" min="0" className="w-24 px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white" placeholder="1024" value={config.thinking_budget_low ?? ''} onChange={e => updateField('thinking_budget_low', e.target.value ? Number(e.target.value) : undefined as unknown as number)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-neutral-400">medium</label>
              <input type="number" min="0" className="w-24 px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white" placeholder="4096" value={config.thinking_budget_medium ?? ''} onChange={e => updateField('thinking_budget_medium', e.target.value ? Number(e.target.value) : undefined as unknown as number)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-neutral-400">high</label>
              <input type="number" min="-1" className="w-24 px-2 py-1 bg-neutral-950 border border-neutral-700 rounded text-xs text-white" placeholder="-1 (∞)" value={config.thinking_budget_high ?? ''} onChange={e => updateField('thinking_budget_high', e.target.value ? Number(e.target.value) : undefined as unknown as number)} />
            </div>
          </div>
        </fieldset>

        <fieldset className="border-0 p-0 m-0 flex flex-col gap-3">
          <legend className={legendClass}>Debug</legend>
          <Checkbox
            id="cfg-debug"
            checked={config.debug === true}
            disabled={debugBusy}
            label="Logs debug"
            tooltip="Enregistrer les JSON recus, envoyes et transferes dans le journal applicatif."
            onChange={async e => {
              const enabled = e.target.checked
              setDebugBusy(true)
              try {
                await api.setDebug(enabled)
                refreshConfig()
              } catch {
                refreshConfig()
              } finally {
                setDebugBusy(false)
              }
            }}
          />
          <Checkbox
            id="cfg-debug-full-json"
            checked={config.debug_full_json === true}
            onChange={e => updateField('debug_full_json', e.target.checked)}
            label="JSON complets"
            tooltip="Inclure les JSON entiers dans les logs, sans troncature."
          />
        </fieldset>
      </div>
    </section>
  )
}
