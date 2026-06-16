/**
 * Popup création sub-agent. Pattern emprunté à CreateAgentPopup mais adapté :
 *  - kind=subagent forcé
 *  - pas de toggle Telegram (sub-agents ne discutent pas directement avec l'user)
 *  - liste de allowedCallers (checkboxes des agents principaux disponibles)
 *
 * Création minimale : id + workspaceDir + model + allowedCallers. Les caps
 * récupèrent les défauts globaux (subagentDefaults) ; pour les surcharger →
 * édition après création.
 */

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ModelPickerPopup } from '../../components/ModelPickerPopup';
import type { ProviderOption } from '../agents/types';

export interface CreateSubAgentForm {
  id: string;
  workspaceDir: string;
  model: string;
  allowedCallers: string[]; // [] = tous autorisés
}

export interface CreateSubAgentPopupProps {
  isOpen: boolean;
  anchorEl: HTMLElement | null;
  workspaceDirs: string[];
  mainAgentIds: string[]; // pour la liste de cases à cocher allowedCallers
  providers: ProviderOption[];
  creating: boolean;
  onClose: () => void;
  onSubmit: (form: CreateSubAgentForm) => Promise<void>;
}

const POPUP_WIDTH = 380;
const DEFAULT_FORM: CreateSubAgentForm = {
  id: '',
  workspaceDir: '',
  model: '',
  allowedCallers: [],
};

export function CreateSubAgentPopup({
  isOpen, anchorEl, workspaceDirs, mainAgentIds, providers, creating, onClose, onSubmit,
}: CreateSubAgentPopupProps) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [form, setForm] = useState<CreateSubAgentForm>(DEFAULT_FORM);
  const [pickerOpen, setPickerOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const idInputRef = useRef<HTMLInputElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const btn = anchorEl;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_WIDTH - 8));
    setAnchor({ left, top: rect.bottom + 6 });
    setForm(DEFAULT_FORM);
    setTimeout(() => idInputRef.current?.focus(), 50);
  }, [isOpen, anchorEl]);

  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (e: MouseEvent) => {
      // While the model picker (also a portal popup) is open, swallow outside-clicks here:
      // the picker manages its own dismissal and shouldn't drag this popup down with it.
      if (pickerOpen) return;
      const target = e.target as Node;
      if (anchorEl?.contains(target) || popupRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pickerOpen) onClose();
    };
    const onResize = () => onClose();
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [isOpen, anchorEl, onClose, pickerOpen]);

  if (!isOpen || !anchor) return null;

  const canSubmit = !!form.id && !!form.workspaceDir && !creating;
  const toggleCaller = (id: string) => {
    setForm(p => ({
      ...p,
      allowedCallers: p.allowedCallers.includes(id)
        ? p.allowedCallers.filter(c => c !== id)
        : [...p.allowedCallers, id],
    }));
  };

  return createPortal(
    <>
    <div
      ref={popupRef}
      className="fixed z-[9999] bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden"
      style={{ left: anchor.left, top: anchor.top, width: POPUP_WIDTH, maxHeight: '80vh' }}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Nouveau sub-agent</h3>
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
            placeholder="explorer"
            className="mt-1 w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
          />
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Workspace directory</label>
          <div className="mt-1 flex gap-2">
            <input
              value={form.workspaceDir}
              onChange={e => setForm(p => ({ ...p, workspaceDir: e.target.value }))}
              placeholder="explorer-workspace"
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
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Modèle</label>
          <div className="mt-1 flex gap-2">
            <input
              value={form.model}
              onChange={e => setForm(p => ({ ...p, model: e.target.value }))}
              placeholder="anthropic/claude-haiku-4-5"
              className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
            />
            {providers.length > 0 && (
              <button
                ref={modelBtnRef}
                type="button"
                onClick={() => setPickerOpen(v => !v)}
                className="shrink-0 px-2 py-1 text-xs text-muted-foreground bg-secondary border border-border rounded hover:border-ring hover:text-primary"
                title="Parcourir les modèles disponibles"
              >
                Parcourir
              </button>
            )}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/60">Vide = défaut système. Cliquer <strong>Parcourir</strong> pour piocher dans la liste des modèles exposés par les providers.</p>
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Allowed callers</label>
          <p className="text-[10px] text-muted-foreground/60 mb-1.5">Agents principaux autorisés à spawner ce sub-agent. Si rien coché → tous autorisés.</p>
          {mainAgentIds.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">Aucun agent principal détecté.</div>
          ) : (
            <div className="space-y-1 max-h-32 overflow-y-auto bg-secondary/50 border border-border/40 rounded p-2">
              {mainAgentIds.map(id => (
                <label key={id} className="flex items-center gap-2 cursor-pointer text-xs text-foreground hover:bg-secondary/60 px-1.5 py-1 rounded">
                  <input
                    type="checkbox"
                    checked={form.allowedCallers.includes(id)}
                    onChange={() => toggleCaller(id)}
                    className="cursor-pointer"
                  />
                  <span className="font-mono">{id}</span>
                </label>
              ))}
            </div>
          )}
        </div>
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
    </div>
    <ModelPickerPopup
      isOpen={pickerOpen}
      anchorEl={modelBtnRef.current}
      providers={providers}
      currentModelId={form.model}
      onClose={() => setPickerOpen(false)}
      onSelect={(modelId) => {
        setForm(p => ({ ...p, model: modelId }));
        setPickerOpen(false);
      }}
    />
    </>,
    document.body,
  );
}
