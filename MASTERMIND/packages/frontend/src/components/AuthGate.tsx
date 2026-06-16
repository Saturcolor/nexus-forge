import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import { getApiKey, setApiKey, verifyApiKey } from '../lib/api';

type Status = 'checking' | 'ok' | 'needs-key';

interface Props {
  children: ReactNode;
}

export default function AuthGate({ children }: Props) {
  const [status, setStatus] = useState<Status>('checking');
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Initial probe on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Dev bypass: in `vite dev`, if VITE_API_KEY is baked in, skip the /api/status probe
      // entirely. Lets us render UI without a running backend (visual checks only —
      // any fetch in the app will still fail). Never engages in production builds.
      if (import.meta.env.DEV && import.meta.env.VITE_API_KEY) {
        console.warn('[AuthGate] dev bypass active — skipping /api/status probe (VITE_API_KEY set)');
        setStatus('ok');
        return;
      }
      // getApiKey() also captures ?token= from URL into localStorage
      const ok = await verifyApiKey();
      if (cancelled) return;
      setStatus(ok ? 'ok' : 'needs-key');
    })();
    return () => { cancelled = true; };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!keyInput.trim()) return;
    setSubmitting(true);
    setError(null);
    setApiKey(keyInput.trim());
    const ok = await verifyApiKey();
    setSubmitting(false);
    if (ok) {
      setStatus('ok');
    } else {
      setError('Invalid API key — server returned 401.');
    }
  }

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Checking authentication…</p>
      </div>
    );
  }

  if (status === 'needs-key') {
    const hasStaleKey = !!getApiKey();
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <form
          onSubmit={onSubmit}
          className="w-full max-w-sm space-y-4 p-6 rounded-2xl border border-border bg-card"
        >
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-foreground">Mastermind</h1>
            <p className="text-sm text-muted-foreground">
              {hasStaleKey
                ? 'The stored API key was rejected. Enter a valid one to continue.'
                : 'Enter your API key to continue.'}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="api-key" className="text-xs font-medium text-muted-foreground">
              API key
            </label>
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              autoFocus
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="mm-…"
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting || !keyInput.trim()}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Verifying…' : 'Unlock'}
          </button>

          <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
            Stored locally in your browser (localStorage). You can also pass the key
            via the <code className="font-mono">?token=</code> URL parameter.
          </p>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
