import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { applyTheme, themeNames, isLightTheme, type ThemeName } from '../lib/themes'
import * as api from '../../api/admin'

const STORAGE_KEY = 'mercury-ui-theme'
const DEFAULT_THEME: ThemeName = 'midnight'

interface ThemeContextValue {
  theme: ThemeName
  setTheme: (t: ThemeName) => void
  isLight: boolean
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  isLight: false,
})

function isValidTheme(v: unknown): v is ThemeName {
  return typeof v === 'string' && (themeNames as string[]).includes(v)
}

/**
 * Theme provider for Mercury V2.
 *
 * - Boot: read localStorage (`mercury-ui-theme`) and apply immediately.
 * - On mount: fetch `/admin/config`, if `ui_theme` differs, sync to backend value.
 * - On setTheme: update state + localStorage + PATCH `/admin/config` (fire-and-forget).
 *
 * Backend persistence makes the theme follow the user across devices/browsers;
 * localStorage avoids a flash of wrong theme during the initial config fetch.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (isValidTheme(stored)) return stored
    } catch { /* ignore */ }
    return DEFAULT_THEME
  })
  const lastWrittenRef = useRef<ThemeName | null>(null)

  // Apply the active theme on every change.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Initial sync from backend (fire once on mount).
  useEffect(() => {
    let cancelled = false
    api.getConfig()
      .then(cfg => {
        if (cancelled) return
        const remote = cfg?.ui_theme
        if (isValidTheme(remote) && remote !== theme) {
          setThemeState(remote)
          try { localStorage.setItem(STORAGE_KEY, remote) } catch { /* ignore */ }
        }
      })
      .catch(() => { /* backend unreachable — keep localStorage value */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setTheme = useCallback((t: ThemeName) => {
    if (!isValidTheme(t)) return
    setThemeState(t)
    try { localStorage.setItem(STORAGE_KEY, t) } catch { /* ignore */ }
    // Persist to backend, but avoid round-tripping a value we just received.
    if (lastWrittenRef.current === t) return
    lastWrittenRef.current = t
    // Merge with current config to avoid clobbering other fields. saveConfig
    // takes the full config object.
    api.getConfig()
      .then(cfg => api.saveConfig({ ...cfg, ui_theme: t }))
      .catch(() => { /* fire-and-forget */ })
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, isLight: isLightTheme(theme) }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
