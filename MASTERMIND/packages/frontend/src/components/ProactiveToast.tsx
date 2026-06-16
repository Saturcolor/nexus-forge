import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigate } from 'react-router-dom';
import { useProactiveAlerts, type ProactiveAlertEntry } from '../lib/proactiveAlerts';

interface ToastItem {
  entry: ProactiveAlertEntry;
  shownAt: number;
}

const TOAST_TTL_MS = 8000;

/**
 * Stacked toasts that appear bottom-right when a proactive.alert with state='delivered'
 * arrives. Toasts auto-dismiss after TOAST_TTL_MS. Click the toast to open the Proactive
 * audit tab and ack the alert.
 */
export default function ProactiveToast() {
  const { alerts, acknowledge } = useProactiveAlerts();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const navigate = useNavigate();

  // Watch for new delivered alerts — add a toast for each.
  // Policy delivery.proactiveAlerts='quiet' → flag silent : la carte reste dans le
  // centre de notifications mais on ne toaste pas.
  useEffect(() => {
    const delivered = alerts.filter(a => a.state === 'delivered' && !a.silent);
    setToasts(prev => {
      const existingIds = new Set(prev.map(t => t.entry.runId));
      const fresh = delivered
        .filter(a => !existingIds.has(a.runId))
        .map(entry => ({ entry, shownAt: Date.now() }));
      if (fresh.length === 0) return prev;
      return [...prev, ...fresh].slice(-5); // max 5 on screen
    });
  }, [alerts]);

  // Auto-expire
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setToasts(prev => prev.filter(t => now - t.shownAt < TOAST_TTL_MS));
    }, 1000);
    return () => clearInterval(timer);
  }, [toasts.length]);

  const dismiss = (runId: string) => {
    setToasts(prev => prev.filter(t => t.entry.runId !== runId));
  };

  const openAlert = (entry: ProactiveAlertEntry) => {
    acknowledge(entry.runId);
    dismiss(entry.runId);
    navigate('/scheduler');
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(({ entry }) => (
        <div
          key={entry.runId}
          className={clsx(
            'pointer-events-auto relative w-80 bg-card border shadow-xl rounded-xl overflow-hidden',
            entry.severity === 'high' ? 'border-destructive/60' :
            entry.severity === 'medium' ? 'border-theme-orange/50' :
            'border-primary/40',
          )}
        >
          <button
            type="button"
            onClick={() => openAlert(entry)}
            className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-secondary/30 transition-colors"
          >
            <div className={clsx(
              'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
              entry.severity === 'high' ? 'bg-destructive/15 text-destructive' :
              entry.severity === 'medium' ? 'bg-theme-orange/15 text-theme-orange' :
              'bg-primary/15 text-primary',
            )}>
              <Bell size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold text-foreground truncate">
                {entry.subject ?? `Alerte ${entry.severity}`}
              </p>
              <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                {entry.content ?? entry.summary}
              </p>
              <p className="text-[10px] text-muted-foreground/50 mt-1">
                {entry.handlerAgentId} · {new Date(entry.timestamp).toLocaleTimeString('fr-FR')}
              </p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => dismiss(entry.runId)}
            className="absolute top-2 right-2 p-1 text-muted-foreground/50 hover:text-foreground"
            aria-label="Fermer"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
