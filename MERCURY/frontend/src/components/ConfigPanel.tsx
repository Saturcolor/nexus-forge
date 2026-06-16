import { useState, useEffect, useRef, useCallback } from 'react'
import type { Config } from '../api/admin'
import { useConfig, useSaveConfigMutation } from '../api/queries'
import Spinner from './Spinner'
import NetworkSection from './config/NetworkSection'
import SecuritySection from './config/SecuritySection'
import LocalProvidersSection from './config/LocalProvidersSection'
import QueueRoutingSection from './config/QueueRoutingSection'
import OptimizationsSection from './config/OptimizationsSection'
import CacheModelsSection from './config/CacheModelsSection'
import ModelMappingSection from './config/ModelMappingSection'

export default function ConfigPanel() {
  const { data: config, error: configErr, isLoading: configLoading, refetch: refreshConfig } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()

  const [configForm, setConfigForm] = useState<Config>({})
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const isDirty = useRef(false)
  const [debugBusy, setDebugBusy] = useState(false)
  const [mappingRefreshKey, setMappingRefreshKey] = useState(0)
  const [requireAuth, setRequireAuth] = useState(false)
  const [adminTokenInput, setAdminTokenInput] = useState('')

  useEffect(() => {
    if (config && !isDirty.current) {
      setConfigForm(config)
      setRequireAuth(config.admin_token_set === true)
      setAdminTokenInput('')
    }
  }, [config])

  const markDirty = useCallback(() => { isDirty.current = true }, [])
  const updateField = useCallback(<K extends keyof Config>(key: K, value: Config[K]) => {
    isDirty.current = true
    setConfigForm(f => ({ ...f, [key]: value }))
  }, [])

  const handleSaveConfig = async () => {
    setSaveStatus(null)
    try {
      const toSend: Config = { ...configForm }
      delete (toSend as Record<string, unknown>).admin_token_set
      delete (toSend as Record<string, unknown>).openrouter_api_key_set
      delete (toSend as Record<string, unknown>).anthropic_credentials_set
      if (!requireAuth) {
        (toSend as Record<string, unknown>).admin_token = ''
      } else if (adminTokenInput.trim()) {
        (toSend as Record<string, unknown>).admin_token = adminTokenInput.trim()
      }
      await saveConfigMutation.mutateAsync(toSend)
      isDirty.current = false
      setAdminTokenInput('')
      setSaveStatus('Enregistre. Redemarrez le serveur si necessaire.')
    } catch (e) {
      setSaveStatus('Erreur : ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  if (configLoading) return <Spinner />

  const sectionProps = { config: configForm, updateField, markDirty }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-xl font-semibold text-white m-0">Configuration</h2>
        {configErr && <p className="text-red-500 text-sm m-0">{configErr instanceof Error ? configErr.message : String(configErr)}</p>}
      </div>

      {/* Row 1: Reseau + Securite */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <NetworkSection {...sectionProps} />
        <SecuritySection
          {...sectionProps}
          adminTokenSet={config?.admin_token_set === true}
          requireAuth={requireAuth}
          setRequireAuth={setRequireAuth}
          adminTokenInput={adminTokenInput}
          setAdminTokenInput={setAdminTokenInput}
        />
      </div>

      {/* Row 2: Providers Locaux + File d'attente & Routage */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <LocalProvidersSection {...sectionProps} />
        <QueueRoutingSection {...sectionProps} />
      </div>

      {/* Row 3: Optimisations & Debug */}
      <OptimizationsSection
        {...sectionProps}
        debugBusy={debugBusy}
        setDebugBusy={setDebugBusy}
        refreshConfig={refreshConfig}
      />

      {/* Row 4: Cache + Mapping */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <CacheModelsSection
          config={configForm}
          updateField={updateField}
          onCacheRefreshed={() => setMappingRefreshKey(k => k + 1)}
        />
        <ModelMappingSection configLoaded={!!config} refreshKey={mappingRefreshKey} />
      </div>

      {/* Row 5: Save */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-white m-0">Enregistrer la configuration</h3>
            <p className="text-sm text-neutral-400 mt-1 m-0">Applique les changements. Redemarrez le serveur pour certains parametres.</p>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            {saveStatus && <span className={`text-sm font-medium ${saveStatus.startsWith('Erreur') ? 'text-red-400' : 'text-emerald-400'}`}>{saveStatus}</span>}
            <button
              type="button"
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-neutral-900"
              onClick={handleSaveConfig}
            >
              Enregistrer
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
