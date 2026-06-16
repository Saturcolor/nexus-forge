import { useCallback, useEffect, useState } from 'react'
import { clsx } from 'clsx'
import {
  LayoutDashboard,
  Brain,
  Boxes,
  CalendarClock,
  Gauge,
  Wallet,
  Cloud,
  Route,
  Users,
  ScrollText,
  BarChart3,
  Menu,
  X,
  ArrowLeftRight,
  Settings as SettingsIcon,
} from 'lucide-react'
import { useVersion } from '../api/queries'
import useIsMobile from '../hooks/useIsMobile'
import { UsersPage } from './pages/UsersPage'
import { CloudPage } from './pages/CloudPage'
import { RoutingPage } from './pages/RoutingPage'
import { LogsPage } from './pages/LogsPage'
import { StatsPage } from './pages/StatsPage'
import { OpenBillPage } from './pages/OpenBillPage'
import { BrainPage } from './pages/BrainPage'
import { BenchmarkPage } from './pages/BenchmarkPage'
import { ModelsPage } from './pages/ModelsPage'
import { SchedulerPage } from './pages/SchedulerPage'
import { DashboardPage } from './dashboard/DashboardPage'
import { SettingsPage } from './pages/SettingsPage'
import { ThemeProvider } from './contexts/ThemeContext'

type Section =
  | 'dashboard' | 'brain' | 'models' | 'scheduler' | 'benchmark'
  | 'openbill' | 'cloud' | 'routing' | 'users'
  | 'logs' | 'stats' | 'settings'

type NavItem = {
  id: Section
  label: string
  icon: typeof LayoutDashboard
  /** When true, V2 reuses the V1 panel component until a V2 version is built. */
  legacy?: boolean
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard',  icon: LayoutDashboard },
  { id: 'brain',     label: 'Brain',      icon: Brain },
  { id: 'cloud',     label: 'Cloud',      icon: Cloud },
  { id: 'models',    label: 'Models',     icon: Boxes },
  { id: 'scheduler', label: 'Scheduler',  icon: CalendarClock },
  { id: 'benchmark', label: 'Benchmark',  icon: Gauge },
  { id: 'openbill',  label: 'OpenBill',   icon: Wallet },
  // 'config' panel is now merged inside Settings (V2). The legacy nav entry
  // has been dropped — same data is reachable via the Settings page.
  { id: 'routing',   label: 'Routage',    icon: Route },
  { id: 'users',     label: 'Users',      icon: Users },
  { id: 'logs',      label: 'Logs',       icon: ScrollText },
  { id: 'stats',     label: 'Stats',      icon: BarChart3 },
  { id: 'settings',  label: 'Settings',   icon: SettingsIcon },
]

const SECTION_STORAGE_KEY = 'mercury_v2_section'

type AppV2Props = {
  onSwitchToV1: () => void
}

export default function AppV2(props: AppV2Props) {
  return (
    <ThemeProvider>
      <AppV2Inner {...props} />
    </ThemeProvider>
  )
}

function AppV2Inner({ onSwitchToV1 }: AppV2Props) {
  const isMobile = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<Section>(() => {
    try {
      const stored = localStorage.getItem(SECTION_STORAGE_KEY)
      if (stored && NAV.find(n => n.id === stored)) return stored as Section
    } catch { /* ignore */ }
    return 'dashboard'
  })

  useEffect(() => {
    try { localStorage.setItem(SECTION_STORAGE_KEY, activeSection) } catch { /* ignore */ }
  }, [activeSection])

  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false)
  }, [isMobile])

  const { data: version } = useVersion()
  const current = NAV.find(n => n.id === activeSection) ?? NAV[0]

  const handleNavClick = useCallback((id: Section) => {
    setActiveSection(id)
    if (isMobile) setMobileMenuOpen(false)
  }, [isMobile])

  // Deep-link helper : navigue vers Routing en forçant l'onglet ciblé. Le
  // RoutingPage lit `mercury_v2_routing_tab` au montage, donc l'écrire ici
  // avant la nav suffit (la page est démontée tant qu'inactive).
  const handleOpenRouting = useCallback((tab?: 'resolution' | 'audio') => {
    if (tab) {
      try { localStorage.setItem('mercury_v2_routing_tab', tab) } catch { /* ignore */ }
    }
    handleNavClick('routing')
  }, [handleNavClick])

  const handleOpenBrain = useCallback(() => {
    handleNavClick('brain')
  }, [handleNavClick])

  const navContent = (
    <>
      <div className="flex items-center justify-center mb-2 shrink-0">
        <span className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary font-bold text-lg tracking-tight">
          M
        </span>
      </div>
      {NAV.map(({ id, label, icon: Icon, legacy }) => {
        const isActive = activeSection === id
        return (
          <button
            key={id}
            type="button"
            title={legacy ? `${label} · V1 legacy` : label}
            aria-label={legacy ? `${label} (V1 legacy)` : label}
            onClick={() => handleNavClick(id)}
            className={clsx(
              'relative flex items-center rounded-lg transition-colors group',
              isMobile ? 'px-3 py-2.5 gap-3 w-full' : 'w-10 h-10 justify-center',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
            )}
          >
            <Icon size={18} strokeWidth={1.75} />
            {isMobile && <span className="text-sm font-medium">{label}</span>}
            {legacy && (
              <span
                className={clsx(
                  'absolute text-[8px] font-bold leading-none px-1 py-0.5 rounded',
                  'bg-theme-amber/15 text-theme-amber border border-theme-amber/30',
                  isMobile ? 'static ml-auto' : 'top-1 right-1',
                )}
                title="Affiche le panneau V1 (en attente de refonte)"
              >
                V1
              </span>
            )}
          </button>
        )
      })}
    </>
  )

  return (
    <div className="mercury-v2 flex flex-col h-screen bg-background text-foreground font-sans">
      {/* Mobile header */}
      {isMobile && (
        <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-3 py-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(o => !o)}
            className="p-2 -ml-1 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Menu"
          >
            {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="min-w-0 flex-1 text-center">
            <span className="text-sm font-semibold text-foreground truncate">{current.label}</span>
          </div>
          <button
            type="button"
            onClick={onSwitchToV1}
            className="p-2 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="Basculer vers l'interface V1"
            aria-label="Switch to V1"
          >
            <ArrowLeftRight size={18} />
          </button>
        </header>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop sidebar */}
        {!isMobile && (
          <nav className="w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-1.5 shrink-0">
            {navContent}
          </nav>
        )}

        {/* Mobile sidebar overlay */}
        {isMobile && mobileMenuOpen && (
          <>
            <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setMobileMenuOpen(false)} />
            <nav className="fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col py-4 px-3 gap-1 overflow-y-auto animate-[slide-in-left_200ms_ease-out]">
              {navContent}
            </nav>
          </>
        )}

        {/* Main column */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {!isMobile && (
            <header className="shrink-0 flex items-center justify-between gap-4 px-6 py-3.5 border-b border-border bg-card/40 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <current.icon size={18} className="text-primary shrink-0" strokeWidth={2} />
                  <h1 className="text-base font-semibold text-foreground tracking-tight">
                    {current.label}
                  </h1>
                  {current.legacy && (
                    <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-theme-amber/10 text-theme-amber border border-theme-amber/30">
                      V1 legacy
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">Mercury · NEXUS broker</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {version?.version && (
                  <span className="px-2 py-1 bg-secondary text-muted-foreground text-[11px] font-mono rounded border border-border/60">
                    v{version.version}
                  </span>
                )}
                <button
                  type="button"
                  onClick={onSwitchToV1}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/60 bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary text-[11px] font-medium transition-colors"
                  title="Basculer vers l'interface V1"
                >
                  <ArrowLeftRight size={13} />
                  V1
                </button>
              </div>
            </header>
          )}

          <main
            className="flex-1 overflow-auto bg-background"
            style={{ animation: 'mercury-fade-in 180ms ease-out' }}
            key={activeSection}
          >
            <div className={clsx(
              'mx-auto px-4 md:px-6 py-5 md:py-6',
              activeSection === 'dashboard' ? 'max-w-[1500px]' : 'max-w-6xl',
              current.legacy && 'mercury-v1-panel',
            )}>
              {activeSection === 'dashboard' && (
                <DashboardPage
                  onOpenRouting={handleOpenRouting}
                  onOpenBrain={handleOpenBrain}
                />
              )}
              {activeSection === 'brain' && <BrainPage />}
              {activeSection === 'models' && <ModelsPage />}
              {activeSection === 'scheduler' && <SchedulerPage />}
              {activeSection === 'benchmark' && <BenchmarkPage />}
              {activeSection === 'openbill' && <OpenBillPage />}
              {activeSection === 'cloud' && <CloudPage />}
              {activeSection === 'routing' && <RoutingPage />}
              {activeSection === 'users' && <UsersPage />}
              {activeSection === 'logs' && <LogsPage />}
              {activeSection === 'stats' && <StatsPage />}
              {activeSection === 'settings' && <SettingsPage />}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}

