import { useState, useEffect, useRef, useCallback } from 'react'
import type { Config, ModelMappingResponse } from '../api/admin'
import * as api from '../api/admin'
import { useConfig, useSaveConfigMutation } from '../api/queries'
import Spinner from './Spinner'
import CloudStatsSection from './cloud/CloudStatsSection'
import OpenRouterSection from './cloud/OpenRouterSection'
import OpenRouterHealthSection from './cloud/OpenRouterHealthSection'
import OpenRouterFallbackModelSection from './cloud/OpenRouterFallbackModelSection'
import AnthropicSection from './cloud/AnthropicSection'
import AudioSection from './cloud/AudioSection'
import RealtimeSection from './cloud/RealtimeSection'
import FallbackSettingsSection from './cloud/FallbackSettingsSection'

export default function CloudPanel() {
  const { data: config, error: configErr, isLoading: configLoading, refetch: refreshConfig } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()

  const [configForm, setConfigForm] = useState<Config>({})
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const isDirty = useRef(false)
  const [modelMapping, setModelMapping] = useState<ModelMappingResponse | null>(null)

  const loadModelMapping = useCallback(async () => {
    try { setModelMapping(await api.getModelMapping()) }
    catch { setModelMapping(null) }
  }, [])

  useEffect(() => {
    if (config) loadModelMapping()
  }, [config, loadModelMapping])

  useEffect(() => {
    if (config && !isDirty.current) setConfigForm(config)
  }, [config])

  const markDirty = () => { isDirty.current = true }
  const updateField = <K extends keyof Config>(key: K, value: Config[K]) => {
    markDirty()
    setConfigForm((f) => ({ ...f, [key]: value }))
  }

  const handleSaveConfig = async () => {
    setSaveStatus(null)
    try {
      const toSend: Config = { ...configForm }
      delete (toSend as Record<string, unknown>).admin_token_set
      delete (toSend as Record<string, unknown>).openrouter_api_key_set
      delete (toSend as Record<string, unknown>).anthropic_credentials_set
      await saveConfigMutation.mutateAsync(toSend)
      isDirty.current = false
      setSaveStatus('Enregistre.')
      loadModelMapping()
    } catch (e) {
      setSaveStatus('Erreur : ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  if (configLoading) return <Spinner />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 className="text-xl font-semibold text-white m-0">Cloud</h2>
        {configErr && <p className="text-red-500 text-sm m-0">{configErr instanceof Error ? configErr.message : String(configErr)}</p>}
      </div>

      {/* Stats cloud temps reel */}
      <CloudStatsSection />

      {/* OpenRouter health (live metrics + circuit breaker + reset) */}
      <OpenRouterHealthSection />

      {/* OpenRouter */}
      <OpenRouterSection
        config={configForm}
        updateField={updateField}
        markDirty={markDirty}
        modelMapping={modelMapping}
        refreshConfig={refreshConfig}
        loadModelMapping={loadModelMapping}
        setSaveStatus={setSaveStatus}
      />

      {/* OpenRouter fallback model (config) */}
      <OpenRouterFallbackModelSection
        config={configForm}
        updateField={updateField}
      />

      {/* Anthropic */}
      <AnthropicSection
        config={configForm}
        updateField={updateField}
        markDirty={markDirty}
        modelMapping={modelMapping}
        refreshConfig={refreshConfig}
        loadModelMapping={loadModelMapping}
        setSaveStatus={setSaveStatus}
      />

      {/* Audio (STT / TTS) */}
      <AudioSection
        config={configForm}
        updateField={updateField}
        markDirty={markDirty}
        refreshConfig={refreshConfig}
        setSaveStatus={setSaveStatus}
      />

      {/* OpenAI Realtime API (WS bidir, consomme par NCM Interpreter) */}
      <RealtimeSection
        config={configForm}
        updateField={updateField}
      />

      {/* Fallback & Resilience */}
      <FallbackSettingsSection
        config={configForm}
        updateField={updateField}
        onSave={handleSaveConfig}
        saveStatus={saveStatus}
        saving={saveConfigMutation.isPending}
      />
    </div>
  )
}
