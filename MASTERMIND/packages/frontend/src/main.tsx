import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import AuthGate from './components/AuthGate';
import App from './App';
import { clientLogger } from './lib/clientLogger';
import './index.css';

if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API) {
  // Dynamic import : fichier exclu du bundle prod par tree-shaking via la garde DEV.
  import('./dev/mockApi').then(m => m.installMockApi());
}

clientLogger.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
