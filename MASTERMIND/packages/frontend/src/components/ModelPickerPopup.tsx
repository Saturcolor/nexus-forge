import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { fetchExposedModels, getCachedModels } from '../lib/modelsCache';
import type { LiveModel, ProviderOption } from '../pages/agents/types';

export interface ModelPickerPopupProps {
  isOpen: boolean;
  anchorEl: HTMLElement | null;
  providers: ProviderOption[];
  initialProviderId?: string;
  currentModelId?: string;
  onClose: () => void;
  onSelect: (modelId: string, providerId: string) => void;
}

const POPUP_WIDTH = 360;

export function ModelPickerPopup({
  isOpen, anchorEl, providers, initialProviderId, currentModelId, onClose, onSelect,
}: ModelPickerPopupProps) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<LiveModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadModels = useCallback(async (pid: string) => {
    setProviderId(pid);
    const cached = getCachedModels(pid);
    if (cached) {
      setModels(cached);
      return;
    }
    setLoading(true);
    setModels(null);
    try {
      setModels(await fetchExposedModels(pid));
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const btn = anchorEl;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - POPUP_WIDTH, window.innerWidth - POPUP_WIDTH - 8));
    setAnchor({ left, top: rect.bottom + 6 });
    setSearch('');
    const pid = initialProviderId || providers[0]?.id || '';
    if (pid) void loadModels(pid);
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [isOpen, anchorEl, initialProviderId, providers, loadModels]);

  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorEl?.contains(target) || popupRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onResize = () => onClose();
    const onScroll = (e: Event) => {
      const target = e.target as Node;
      if (popupRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [isOpen, anchorEl, onClose]);

  if (!isOpen || !anchor) return null;

  const filtered = (models ?? []).filter(m => {
    if (!search) return true;
    const q = search.toLowerCase();
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  return createPortal(
    <div
      ref={popupRef}
      className="fixed z-[9999] w-[360px] bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden"
      style={{ left: anchor.left, top: anchor.top, maxHeight: '60vh' }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground shrink-0">Modèle</span>
        {providers.length > 1 && (
          <select
            value={providerId}
            onChange={e => void loadModels(e.target.value)}
            className="ml-auto bg-secondary border border-border rounded px-1.5 py-0.5 text-[10px] font-mono text-foreground focus:outline-none"
          >
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Search size={12} className="text-muted-foreground/60 shrink-0" />
        <input
          ref={searchRef}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={models ? `Rechercher parmi ${models.length} modèles…` : 'Chargement…'}
          className="flex-1 bg-transparent text-[11px] text-foreground focus:outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <p className="px-3 py-3 text-[11px] text-muted-foreground">Chargement…</p>}
        {!loading && filtered.length === 0 && (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">Aucun résultat</p>
        )}
        {filtered.map(m => {
          const isCurrent = m.id === currentModelId;
          return (
            <button
              key={m.id}
              onClick={() => onSelect(m.id, providerId)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left border-b border-border/40 last:border-0 transition-colors ${
                isCurrent ? 'bg-theme-green/5' : 'hover:bg-secondary'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[12px] font-medium truncate ${isCurrent ? 'text-theme-green' : 'text-foreground'}`}>
                    {m.name}
                  </span>
                  {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-theme-green shrink-0" />}
                </div>
                {m.name !== m.id && (
                  <p className="text-[10px] text-muted-foreground/70 font-mono truncate mt-0.5">{m.id}</p>
                )}
              </div>
              {m.contextLength && (
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                  {(m.contextLength / 1000).toFixed(0)}k
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
