import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyTheme, themeNames, type ThemeName } from '../lib/themes';
import { api } from '../lib/api';

const STORAGE_KEY = 'mastermind-theme';
const DEFAULT_THEME: ThemeName = 'midnight';

interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
});

function isValidTheme(v: unknown): v is ThemeName {
  return typeof v === 'string' && themeNames.includes(v as ThemeName);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
    return stored ?? DEFAULT_THEME;
  });

  // On mount, fetch persisted theme from backend config
  useEffect(() => {
    api.get<{ ui?: { theme?: string } }>('/api/config')
      .then((cfg) => {
        const remote = cfg.ui?.theme;
        if (isValidTheme(remote) && remote !== theme) {
          setThemeState(remote);
          localStorage.setItem(STORAGE_KEY, remote);
        }
      })
      .catch(() => {}); // backend unreachable — keep localStorage value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = (t: ThemeName) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
    // Persist to backend config (fire-and-forget)
    api.put('/api/config', { ui: { theme: t } }).catch(() => {});
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
