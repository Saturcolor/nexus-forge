import { useState, useCallback, useEffect, useRef } from 'react'
import * as api from './api/admin'
import { useVersion } from './api/queries'
import useIsMobile from './hooks/useIsMobile'
import AppV2 from './v2/AppV2'
import OverviewPanel from './components/OverviewPanel'
import UsersPanel from './components/UsersPanel'
import ConfigPanel from './components/ConfigPanel'
import CloudPanel from './components/CloudPanel'
import ModelRoutingPanel from './components/ModelRoutingPanel'
import LogsPanel from './components/LogsPanel'
import StatsPanel from './components/StatsPanel'
import CreditsPanel from './components/CreditsPanel'
import BrainPanel from './components/BrainPanel'
import BenchmarkPanel from './components/BenchmarkPanel'
import ModelsPanel from './components/ModelsPanel'
import SchedulerPanel from './components/SchedulerPanel'
type Section = 'dashboard' | 'openbill' | 'config' | 'cloud' | 'routing' | 'users' | 'logs' | 'stats' | 'brain' | 'models' | 'scheduler' | 'benchmark'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'brain', label: 'Brain' },
  { id: 'models', label: 'Models' },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'benchmark', label: 'Benchmark' },
  { id: 'openbill', label: 'OpenBill' },
  { id: 'config', label: 'Configuration' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'routing', label: 'Routage modèles' },
  { id: 'users', label: 'Utilisateurs' },
  { id: 'logs', label: 'Logs' },
  { id: 'stats', label: 'Statistiques' },
]

const SIDEBAR_STORAGE_KEY = 'mercury_sidebar_open'
const UI_VERSION_STORAGE_KEY = 'mercury_ui_version' // 'v1' | 'v2' — default 'v2'

function readUiVersion(): 'v1' | 'v2' {
  try {
    const stored = localStorage.getItem(UI_VERSION_STORAGE_KEY)
    if (stored === 'v1' || stored === 'v2') return stored
  } catch { /* ignore */ }
  return 'v2'
}

function writeUiVersion(v: 'v1' | 'v2') {
  try { localStorage.setItem(UI_VERSION_STORAGE_KEY, v) } catch { /* ignore */ }
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    api.setAdminToken(token.trim())
    try {
      await api.getVersion()
      onLogin()
    } catch {
      api.setAdminToken('')
      setError('Token invalide ou serveur inaccessible')
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 font-sans text-neutral-100">
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-8 shadow-2xl">
        <h1 className="text-2xl font-bold mb-2">Mercury Dashboard</h1>
        <p className="text-neutral-400 text-sm mb-6">Un token admin est requis pour accéder au dashboard.</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-token" className="text-sm font-medium text-neutral-300">Token admin</label>
            <input
              id="admin-token"
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Saisissez le token admin"
              autoFocus
              className="px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>
          {error && <p className="text-red-500 text-sm font-medium">{error}</p>}
          <button type="submit" className="mt-2 w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-md font-medium transition-colors">
            Se connecter
          </button>
        </form>
      </div>
    </div>
  )
}

export default function App() {
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null)

  useEffect(() => {
    // Auto-login from ?token= query param (for iframe embedding via NEXUS-HUB)
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get('token')
    if (urlToken) {
      api.setAdminToken(urlToken)
      // Clean the URL to avoid leaking the token
      params.delete('token')
      const clean = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (clean ? '?' + clean : ''))
    }

    api.getVersion()
      .then(() => setNeedsAuth(false))
      .catch((e) => {
        if (e instanceof Error && e.message.includes('401')) {
          setNeedsAuth(true)
        } else if (e instanceof Error && (e.message.includes('Token admin') || e.message.includes('Unauthorized'))) {
          setNeedsAuth(true)
        } else {
          setNeedsAuth(false)
        }
      })
  }, [])

  if (needsAuth === null) return <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-400 font-sans"><p>Chargement…</p></div>
  if (needsAuth) return <LoginScreen onLogin={() => setNeedsAuth(false)} />

  return <Shell />
}

/**
 * Top-level UI version switcher.
 * V2 (Mastermind-styled rebuild) is the default; V1 is preserved verbatim and
 * reachable via the toggle in either shell. Choice is persisted to localStorage.
 */
function Shell() {
  const [uiVersion, setUiVersion] = useState<'v1' | 'v2'>(() => readUiVersion())
  const switchTo = useCallback((v: 'v1' | 'v2') => {
    writeUiVersion(v)
    setUiVersion(v)
  }, [])
  if (uiVersion === 'v2') return <AppV2 onSwitchToV1={() => switchTo('v1')} />
  return <Dashboard onSwitchToV2={() => switchTo('v2')} />
}

function Dashboard({ onSwitchToV2 }: { onSwitchToV2: () => void }) {
  const [activeSection, setActiveSection] = useState<Section>('dashboard')
  const isMobile = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY)
      return stored !== 'false'
    } catch {
      return true
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen))
    } catch { /* ignore */ }
  }, [sidebarOpen])

  const sidebarLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSidebarEnter = useCallback(() => {
    if (isMobile) return
    if (sidebarLeaveTimer.current) {
      clearTimeout(sidebarLeaveTimer.current)
      sidebarLeaveTimer.current = null
    }
    setSidebarOpen(true)
  }, [isMobile])
  const handleSidebarLeave = useCallback(() => {
    if (isMobile) return
    sidebarLeaveTimer.current = setTimeout(() => setSidebarOpen(false), 220)
  }, [isMobile])
  useEffect(() => () => {
    if (sidebarLeaveTimer.current) clearTimeout(sidebarLeaveTimer.current)
  }, [])

  // Close mobile menu on resize to desktop
  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false)
  }, [isMobile])

  const { data: version } = useVersion()

  const handleSectionClick = (id: Section) => {
    setActiveSection(id)
    if (isMobile) setMobileMenuOpen(false)
  }

  const sidebarContent = (
    <>
      <div className="p-4 border-b border-neutral-800 flex items-center justify-center min-h-[64px]">
        <h1 className="font-bold text-lg text-white tracking-tight">Mercury</h1>
      </div>
      <nav className="flex-1 py-4 flex flex-col gap-1 px-2 overflow-y-auto">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`flex items-center rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
              activeSection === id
                ? 'bg-blue-600/10 text-blue-400'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
            }`}
            onClick={() => handleSectionClick(id)}
          >
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  )

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100 font-sans">
      {/* Desktop sidebar */}
      {!isMobile && (
        <aside
          className={`bg-neutral-900 border-r border-neutral-800 flex flex-col transition-all duration-300 ${sidebarOpen ? 'w-64' : 'w-16 items-center'}`}
          onMouseEnter={handleSidebarEnter}
          onMouseLeave={handleSidebarLeave}
        >
          <div className="p-4 border-b border-neutral-800 flex items-center justify-center min-h-[64px]">
            {sidebarOpen ? (
              <h1 className="font-bold text-lg text-white tracking-tight">Mercury</h1>
            ) : (
              <span className="font-bold text-xl text-blue-500">O</span>
            )}
          </div>
          <nav className="flex-1 py-4 flex flex-col gap-1 px-2 overflow-y-auto">
            {SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  activeSection === id
                    ? 'bg-blue-600/10 text-blue-400'
                    : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                } ${!sidebarOpen ? 'justify-center' : ''}`}
                onClick={() => setActiveSection(id)}
                title={!sidebarOpen ? label : undefined}
              >
                {sidebarOpen && <span>{label}</span>}
                {!sidebarOpen && <span>{label.charAt(0)}</span>}
              </button>
            ))}
          </nav>
        </aside>
      )}

      {/* Mobile sidebar overlay */}
      {isMobile && mobileMenuOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setMobileMenuOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-neutral-900 border-r border-neutral-800 flex flex-col animate-[slide-in-left_200ms_ease-out]">
            {sidebarContent}
          </aside>
        </>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="px-3 md:px-6 py-3 md:py-4 border-b border-neutral-800 bg-neutral-900/50 flex justify-between items-center gap-3">
          <div className="flex items-center gap-3">
            {isMobile && (
              <button
                type="button"
                onClick={() => setMobileMenuOpen(o => !o)}
                className="p-2 -ml-1 rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14"/></svg>
              </button>
            )}
            <div>
              <h1 className="text-lg md:text-xl font-semibold text-white">
                {SECTIONS.find(s => s.id === activeSection)?.label}
              </h1>
              <p className="text-xs text-neutral-500 mt-0.5">Mercury</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onSwitchToV2}
              className="px-2.5 py-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/15 text-xs font-semibold transition-colors"
              title="Passer à la nouvelle interface V2"
            >
              ✨ V2
            </button>
            {version?.version && (
              <span className="px-2 py-1 bg-neutral-800 text-neutral-300 text-xs rounded border border-neutral-700">
                v{version.version}
              </span>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-auto p-3 md:p-6 bg-neutral-950">
          <div className={`mx-auto space-y-6 ${activeSection === 'dashboard' ? 'w-full max-w-[1400px]' : 'max-w-6xl'}`}>
            {activeSection === 'dashboard' && <OverviewPanel />}
            {activeSection === 'brain' && <BrainPanel />}
            {activeSection === 'models' && <ModelsPanel />}
            {activeSection === 'scheduler' && <SchedulerPanel />}
            {activeSection === 'benchmark' && <BenchmarkPanel />}
            {activeSection === 'openbill' && <CreditsPanel />}
            {activeSection === 'config' && <ConfigPanel />}
            {activeSection === 'cloud' && <CloudPanel />}
            {activeSection === 'routing' && <ModelRoutingPanel />}
            {activeSection === 'users' && <UsersPanel />}
            {activeSection === 'logs' && <LogsPanel />}
            {activeSection === 'stats' && <StatsPanel />}
          </div>
        </main>
      </div>
    </div>
  )
}
