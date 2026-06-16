import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { Palette, Check, Sun, Moon, Search, Save, Server, Cpu, Layers, Database } from 'lucide-react'
import { clsx } from 'clsx'
import { useTheme } from '../contexts/ThemeContext'
import { themes, themeNames, isLightTheme, type ThemeName } from '../lib/themes'
import { Card, CardHeader, CardBody } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import type { Config } from '../../api/admin'
import { useConfig, useSaveConfigMutation } from '../../api/queries'
import { NetworkCard } from './config/NetworkCard'
import { SecurityCard } from './config/SecurityCard'
import { LocalProvidersCard } from './config/LocalProvidersCard'
import { QueueCard } from './config/QueueCard'
import { ModelsCard } from './config/ModelsCard'
import { QuantCard } from './config/QuantCard'

type Filter = 'all' | 'dark' | 'light'
type SettingsTab = 'apparence' | 'serveur' | 'providers' | 'queue' | 'modeles' | 'quant'

const TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'apparence', label: 'Apparence', icon: Palette },
  { id: 'serveur',   label: 'Serveur',   icon: Server   },
  { id: 'providers', label: 'Providers', icon: Cpu      },
  { id: 'queue',     label: 'Queue',     icon: Layers   },
  { id: 'modeles',   label: 'Modèles',   icon: Database },
  { id: 'quant',     label: 'Quant',     icon: Cpu      },
]

const TAB_KEY = 'mercury_v2_settings_tab'

function ThemeSwatch({
  themeName,
  active,
  onSelect,
}: {
  themeName: ThemeName
  active: boolean
  onSelect: () => void
}) {
  const t = themes[themeName]
  const c = t.colors
  return (
    <button
      type="button"
      onClick={onSelect}
      title={t.label}
      className={clsx(
        'group relative flex flex-col gap-2 p-3 rounded-xl border text-left transition-all',
        'hover:border-primary/50',
        active
          ? 'border-primary ring-2 ring-primary/30 bg-primary/[0.04]'
          : 'border-border/60 bg-card hover:bg-secondary/30',
      )}
    >
      <div
        className="rounded-lg border h-14 flex items-stretch overflow-hidden"
        style={{ backgroundColor: c['--color-background'], borderColor: c['--color-border'] }}
      >
        <div className="w-2.5 border-r" style={{ backgroundColor: c['--color-card'], borderColor: c['--color-border'] }} />
        <div className="flex-1 p-1.5 flex flex-col gap-1 justify-between">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c['--color-primary'] }} />
            <span className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: c['--color-secondary'] }} />
          </div>
          <div className="flex gap-1">
            <span className="h-1 rounded-full" style={{ backgroundColor: c['--color-primary'], width: '50%' }} />
            <span className="h-1 rounded-full" style={{ backgroundColor: c['--color-green'], width: '20%' }} />
            <span className="h-1 rounded-full" style={{ backgroundColor: c['--color-orange'], width: '15%' }} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-mono leading-none" style={{ color: c['--color-muted-foreground'] }}>●●●</span>
            <span className="px-1 rounded text-[8px] font-bold leading-none py-0.5" style={{ backgroundColor: c['--color-destructive'], color: c['--color-primary-foreground'] }}>ER</span>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[11px] font-medium text-foreground truncate">{t.label}</span>
        <div className="flex items-center gap-1 shrink-0">
          {isLightTheme(themeName) ? (
            <Sun size={11} className="text-theme-amber/70" />
          ) : (
            <Moon size={11} className="text-muted-foreground/60" />
          )}
          {active && <Check size={12} className="text-primary" />}
        </div>
      </div>
    </button>
  )
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SettingsTab>(() => {
    try {
      const s = localStorage.getItem(TAB_KEY)
      if (s && TABS.find(t => t.id === s)) return s as SettingsTab
    } catch { /* ignore */ }
    return 'apparence'
  })

  const handleTabChange = useCallback((id: SettingsTab) => {
    setTab(id)
    try { localStorage.setItem(TAB_KEY, id) } catch { /* ignore */ }
  }, [])

  const { data: config, error: configErr, isLoading: configLoading, refetch: refreshConfig } = useConfig()
  const saveConfigMutation = useSaveConfigMutation()
  const [configForm, setConfigForm] = useState<Config>({})
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const isDirty = useRef(false)
  const [debugBusy, setDebugBusy] = useState(false)
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
      setSaveStatus('ok')
    } catch (e) {
      setSaveStatus('err:' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return themeNames.filter(name => {
      if (filter === 'dark' && isLightTheme(name)) return false
      if (filter === 'light' && !isLightTheme(name)) return false
      if (!q) return true
      return name.toLowerCase().includes(q) || themes[name].label.toLowerCase().includes(q)
    })
  }, [filter, query])

  const sectionProps = { config: configForm, updateField, markDirty }
  const isConfigTab = tab !== 'apparence'

  return (
    <div className="flex flex-col gap-5">
      {/* ── Tab bar ─────────────────────────────────────────────── */}
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

      {/* ── Apparence ───────────────────────────────────────────── */}
      {tab === 'apparence' && (
        <Card>
          <CardHeader
            title="Apparence"
            icon={<Palette size={13} />}
            right={<Badge tone="neutral" mono>{themes[theme].label}</Badge>}
          />
          <CardBody className="!py-4 flex flex-col gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1 p-0.5 rounded-md bg-background border border-border/60">
                {(['all', 'dark', 'light'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={clsx(
                      'px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors',
                      filter === f ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {f === 'all' ? 'Tous' : f === 'dark' ? 'Sombres' : 'Clairs'}
                  </button>
                ))}
              </div>
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
                <input
                  type="search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Rechercher un thème…"
                  className="w-full pl-7 pr-2.5 py-1.5 bg-background border border-border/60 rounded-md text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40"
                />
              </div>
              <span className="ml-auto text-[10px] text-muted-foreground/60 font-mono">
                {filtered.length} / {themeNames.length}
              </span>
            </div>
            {filtered.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/60 py-4 text-center">Aucun thème ne correspond.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
                {filtered.map(name => (
                  <ThemeSwatch key={name} themeName={name} active={name === theme} onSelect={() => setTheme(name)} />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── Onglets config (chargement partagé) ─────────────────── */}
      {isConfigTab && configErr && (
        <p className="text-[11px] text-destructive m-0">{configErr instanceof Error ? configErr.message : String(configErr)}</p>
      )}

      {isConfigTab && configLoading && (
        <div className="flex justify-center py-10"><Spinner size={20} /></div>
      )}

      {isConfigTab && !configLoading && (
        <>
          {tab === 'serveur' && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <NetworkCard {...sectionProps} />
              <SecurityCard
                {...sectionProps}
                adminTokenSet={config?.admin_token_set === true}
                requireAuth={requireAuth}
                setRequireAuth={setRequireAuth}
                adminTokenInput={adminTokenInput}
                setAdminTokenInput={setAdminTokenInput}
              />
            </div>
          )}

          {tab === 'providers' && (
            <LocalProvidersCard {...sectionProps} />
          )}

          {tab === 'queue' && (
            <QueueCard
              {...sectionProps}
              debugBusy={debugBusy}
              setDebugBusy={setDebugBusy}
              refreshConfig={refreshConfig}
            />
          )}

          {tab === 'modeles' && (
            <ModelsCard config={configForm} updateField={updateField} />
          )}

          {tab === 'quant' && (
            <QuantCard {...sectionProps} />
          )}

          {/* Save bar — commune à tous les onglets config */}
          <Card>
            <CardBody className="!py-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[11px] font-medium text-foreground m-0">Enregistrer la configuration</p>
                  <p className="text-[10px] text-muted-foreground/70 m-0">Applique les changements. Redémarrez le serveur pour certains paramètres.</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {saveStatus && (
                    <span className={clsx('text-[11px] font-medium', saveStatus.startsWith('err:') ? 'text-destructive' : 'text-theme-green')}>
                      {saveStatus.startsWith('err:') ? saveStatus.slice(4) : 'Enregistré.'}
                    </span>
                  )}
                  <Button variant="primary" size="sm" onClick={handleSaveConfig}>
                    <Save size={11} />
                    Enregistrer
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}
