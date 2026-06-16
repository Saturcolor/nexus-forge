import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SwitchThumb } from '../../components/ui/SwitchThumb';
import type { CreateForm } from './types';
import { DEFAULT_CREATE } from './types';

export interface CreateAgentPopupProps {
  isOpen: boolean;
  anchorEl: HTMLElement | null;
  workspaceDirs: string[];
  creating: boolean;
  onClose: () => void;
  onSubmit: (form: CreateForm) => Promise<void>;
}

const POPUP_WIDTH = 360;

export function CreateAgentPopup({
  isOpen, anchorEl, workspaceDirs, creating, onClose, onSubmit,
}: CreateAgentPopupProps) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [form, setForm] = useState<CreateForm>(DEFAULT_CREATE);
  const popupRef = useRef<HTMLDivElement>(null);
  const idInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const btn = anchorEl;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_WIDTH - 8));
    setAnchor({ left, top: rect.bottom + 6 });
    setForm(DEFAULT_CREATE);
    setTimeout(() => idInputRef.current?.focus(), 50);
  }, [isOpen, anchorEl]);

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

  const canSubmit = !!form.id && !!form.workspaceDir && !creating;

  return createPortal(
    <div
      ref={popupRef}
      className="fixed z-[9999] w-[360px] bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden"
      style={{ left: anchor.left, top: anchor.top, maxHeight: '80vh' }}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Nouvel agent</h3>
        <button
          onClick={onClose}
          className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          aria-label="Fermer"
        >
          ✕
        </button>
      </div>

      <div className="overflow-y-auto p-4 space-y-3">
        <div>
          <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">ID (slug)</label>
          <input
            ref={idInputRef}
            value={form.id}
            onChange={e => setForm(p => ({ ...p, id: e.target.value.toLowerCase().replace(/\s+/g, '-') }))}
            placeholder="mon-agent"
            className="mt-1 w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
          />
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Workspace directory</label>
          <div className="mt-1 flex gap-2">
            <input
              value={form.workspaceDir}
              onChange={e => setForm(p => ({ ...p, workspaceDir: e.target.value }))}
              placeholder="workspace-mon-agent"
              className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
            />
            {workspaceDirs.length > 0 && (
              <select
                onChange={e => { if (e.target.value) setForm(p => ({ ...p, workspaceDir: e.target.value })); }}
                className="bg-secondary border border-border rounded px-2 text-xs text-card-foreground focus:outline-none"
                value=""
              >
                <option value="">…</option>
                {workspaceDirs.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </div>
          {workspaceDirs.length > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground/60">{workspaceDirs.length} dossier(s) détecté(s) dans agentsDir</p>
          )}
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Modèle (optionnel)</label>
          <input
            value={form.model}
            onChange={e => setForm(p => ({ ...p, model: e.target.value }))}
            placeholder="Défaut du système"
            className="mt-1 w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
          />
        </div>

        <button
          type="button"
          onClick={() => setForm(p => ({ ...p, telegramEnabled: !p.telegramEnabled }))}
          className="w-full flex items-center justify-between gap-3 py-1 hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors text-left"
        >
          <div>
            <span className="text-[12px] text-foreground block">Telegram</span>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">Activer la réception de messages Telegram</p>
          </div>
          <SwitchThumb on={form.telegramEnabled} />
        </button>
      </div>

      <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-border/50 bg-card/50">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded border border-border hover:border-ring transition-colors"
        >
          Annuler
        </button>
        <button
          onClick={() => void onSubmit(form)}
          disabled={!canSubmit}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {creating ? 'Création…' : 'Créer'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
