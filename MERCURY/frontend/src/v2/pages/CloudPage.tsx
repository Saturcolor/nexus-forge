import { useState, useEffect, useRef, useCallback } from 'react'
import { clsx } from 'clsx'
import { Activity, Zap, Bot, Volume2, Shield, Save } from 'lucide-react'
import { Card, CardBody } from '../ui/Card'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import type { Config } from '../../api/admin'
import { useConfig, useSaveConfigMutation, useModelMapping } from '../../api/queries'
import { CloudStatsCard }        from './cloud/CloudStatsCard'
import { OpenRouterHealthCard }  from './cloud/OpenRouterHealthCard'
import { OpenRouterCard }   from './cloud/OpenRouterCard'
import { AnthropicCard }    from './cloud/AnthropicCard'
import { AudioCard }        from './cloud/AudioCard'
import { ResilienceCard }   from './cloud/ResilienceCard'

type CloudTab = 'sante' | 'openrouter' | 'anthropic' | 'audio' | 'resilience'

const TABS: { id: CloudTab; label: string; icon: React.ElementType }[] = [
  { id: 'sante',      label: 'Santé',      icon: Activity },
  { id: 'openrouter', label: 'OpenRouter',  icon: Zap      },
  { id: 'anthropic',  label: 'Anthropic',   icon: Bot      },
  { id: 'audio',      label: 'Audio',       icon: Volume2  },
  { id: 'resilience', label: 'Résilience',  icon: Shield   },
]

const TAB_KEY = 'mercury_v2_cloud_tab'

export function CloudPage() {
  const [tab, setTab] = useState<CloudTab>(() => {
    try {
      const s = localStorage.getItem(TAB_KEY)
      if (s && TABS.find(t => t.id === s)) return s as CloudTab
    } catch { /* ignore */ }
    return 'sante'
  })

  const handleTabChange = useCallback((id: CloudTab) => {
    setTab(id)
    try { localStorage.setItem(TAB_KEY, id) } catch { /* ignore */ }
  }, [])

  const { data: config, error: configErr, isLoading: configLoading, refetch: refreshConfig } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()
  const [configForm,  setConfigForm]  = useState<Config>({})
  const [saveStatus,  setSaveStatus]  = useState<string | null>(null)
  const isDirty   = useRef(false)
  // Mapping via hook partagé, fetché seulement une fois la config chargée (cf. comportement V1).
  const { data: modelMapping, refetch: refetchModelMapping } = useModelMapping(!!config)
  const loadModelMapping = useCallback(() => { refetchModelMapping() }, [refetchModelMapping])

  useEffect(() => {
    if (config && !isDirty.current) setConfigForm(config)
  }, [config])

  const markDirty = useCallback(() => { isDirty.current = true }, [])
  const updateField = useCallback(<K extends keyof Config>(key: K, value: Config[K]) => {
    isDirty.current = true
    setConfigForm(f => ({ ...f, [key]: value }))
  }, [])

  const handleSave = async () => {
    setSaveStatus(null)
    try {
      const toSend: Config = { ...configForm }
      delete (toSend as Record<string, unknown>).admin_token_set
      delete (toSend as Record<string, unknown>).openrouter_api_key_set
      delete (toSend as Record<string, unknown>).anthropic_credentials_set
      await saveConfigMutation.mutateAsync(toSend)
      isDirty.current = false
      setSaveStatus('ok')
      loadModelMapping()
    } catch (e) {
      setSaveStatus('err:' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const sectionProps = { config: configForm, updateField, markDirty }
  const isConfigTab  = tab !== 'sante'

  return (
    <div className="flex flex-col gap-5">

      {/* ── Tab bar ─────────────────────────────────────────────────── */}
      <div className="flex items-end border-b border-border/60 -mx-4 md:-mx-6 px-4 md:px-6 overflow-x-auto no-scrollbar">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => handleTabChange(id)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-semibold border-b-2 -mb-px transition-colors shrink-0',
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/60',
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* ── Santé — sections autonomes (pas de save bar) ────────────── */}
      {tab === 'sante' && (
        <div className="flex flex-col gap-4">
          <CloudStatsCard />
          <OpenRouterHealthCard />
        </div>
      )}

      {/* ── Onglets config ──────────────────────────────────────────── */}
      {isConfigTab && configErr && (
        <p className="text-[11px] text-destructive">
          {configErr instanceof Error ? configErr.message : String(configErr)}
        </p>
      )}
      {isConfigTab && configLoading && (
        <div className="flex justify-center py-10"><Spinner size={20} /></div>
      )}

      {isConfigTab && !configLoading && (
        <>
          {tab === 'openrouter' && (
            <OpenRouterCard
              {...sectionProps}
              modelMapping={modelMapping ?? null}
              refreshConfig={refreshConfig}
              loadModelMapping={loadModelMapping}
              setSaveStatus={setSaveStatus}
            />
          )}

          {tab === 'anthropic' && (
            <AnthropicCard
              {...sectionProps}
              modelMapping={modelMapping ?? null}
              refreshConfig={refreshConfig}
              loadModelMapping={loadModelMapping}
              setSaveStatus={setSaveStatus}
            />
          )}

          {tab === 'audio' && (
            <AudioCard
              {...sectionProps}
              refreshConfig={refreshConfig}
              setSaveStatus={setSaveStatus}
            />
          )}

          {tab === 'resilience' && (
            <ResilienceCard config={sectionProps.config} updateField={sectionProps.updateField} />
          )}

          {/* Save bar partagée — tous les onglets config */}
          {(
            <Card>
              <CardBody className="!py-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-medium text-foreground m-0">Enregistrer la configuration</p>
                    <p className="text-[10px] text-muted-foreground/70 m-0">Applique les changements sur le serveur Mercury.</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {saveStatus && (
                      <span className={clsx(
                        'text-[11px] font-medium',
                        saveStatus.startsWith('err:') ? 'text-destructive' : 'text-theme-green',
                      )}>
                        {saveStatus.startsWith('err:') ? saveStatus.slice(4) : 'Enregistré.'}
                      </span>
                    )}
                    <Button variant="primary" size="sm" onClick={handleSave} disabled={saveConfigMutation.isPending}>
                      <Save size={11} />
                      Enregistrer
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
