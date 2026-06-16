import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SectionCardProps {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** If set, card is collapsible. Click on header toggles open/closed. */
  collapsible?: boolean;
  /** Initial open state (ignored if storageKey resolves to a stored value). */
  defaultOpen?: boolean;
  /** If set with `collapsible`, persists the open state in localStorage under this key. */
  storageKey?: string;
}

export function SectionCard({
  title, action, children, className,
  collapsible = false, defaultOpen = true, storageKey,
}: SectionCardProps) {
  const [open, setOpen] = useState<boolean>(() => {
    if (!collapsible) return true;
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored !== null) return stored === '1';
      } catch { /* ignore */ }
    }
    return defaultOpen;
  });

  useEffect(() => {
    if (!collapsible || !storageKey) return;
    try { localStorage.setItem(storageKey, open ? '1' : '0'); } catch { /* ignore */ }
  }, [open, collapsible, storageKey]);

  const header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {collapsible && (
          <ChevronDown
            size={12}
            className={`text-muted-foreground/50 transition-transform ${open ? '' : '-rotate-90'}`}
          />
        )}
        <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
          {title}
        </h3>
      </div>
      {action}
    </div>
  );

  return (
    <div className={`bg-card rounded-xl border border-border/60 p-4 ${open ? 'space-y-3' : ''} ${className ?? ''}`}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full text-left -m-4 mb-0 p-4 rounded-t-xl hover:bg-secondary/20 transition-colors"
        >
          {header}
        </button>
      ) : header}
      {open && children}
    </div>
  );
}
