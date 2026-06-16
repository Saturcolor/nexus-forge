import { useState } from 'react';
import { FileText, Folder, Star, ChevronRight, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import type { SharedEntry, AgentFull } from './types';
import { formatMtime } from './types';
import { normalizeMdBasename } from './fileNameUtils';

export interface AgentSharedTabProps {
  sharedPath: string;
  setSharedPath: (path: string) => void;
  sharedEntries: SharedEntry[];
  sharedSelectedFile: string | null;
  sharedFileContent: string;
  sharedSaving: boolean;
  sharedLoading: boolean;
  sharedBreadcrumbs: string[];
  savingStars: boolean;
  configDraft: Partial<AgentFull>;
  handleSharedSelectEntry: (entry: SharedEntry) => void;
  handleSharedSave: () => void;
  setSharedFileContent: (content: string) => void;
  toggleSharedStar: (filePath: string) => Promise<void>;
  onCreateFile: (relativeMdPath: string) => Promise<void>;
}

export function AgentSharedTab({
  sharedPath, setSharedPath, sharedEntries, sharedSelectedFile, sharedFileContent,
  sharedSaving, sharedLoading, sharedBreadcrumbs, savingStars, configDraft,
  handleSharedSelectEntry, handleSharedSave, setSharedFileContent, toggleSharedStar, onCreateFile,
}: AgentSharedTabProps) {
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newNameDraft, setNewNameDraft] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const submitCreate = async () => {
    setCreateError(null);
    const norm = normalizeMdBasename(newNameDraft);
    if (!norm.ok) {
      setCreateError(norm.message);
      return;
    }
    const relative = sharedPath ? `${sharedPath}/${norm.name}` : norm.name;
    if (sharedEntries.some(e => !e.isDir && e.name === norm.name)) {
      setCreateError('Un fichier avec ce nom existe déjà dans ce dossier.');
      return;
    }
    setCreatingBusy(true);
    try {
      await onCreateFile(relative);
      setNewNameDraft('');
      setCreatingOpen(false);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Création impossible.');
    } finally {
      setCreatingBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col sm:flex-row min-h-0">
      {/* File list */}
      <div className="w-full sm:w-52 bg-card/50 border-r border-border flex flex-col shrink-0">
        {/* Breadcrumb */}
        <div className="px-3 py-2 border-b border-border/50 flex items-center gap-1 flex-wrap min-h-[33px]">
          <button
            onClick={() => setSharedPath('')}
            className="text-[10px] font-mono text-primary hover:underline shrink-0"
          >
            shared
          </button>
          {sharedBreadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={9} className="text-muted-foreground/30" />
              <button
                onClick={() => setSharedPath(sharedBreadcrumbs.slice(0, i + 1).join('/'))}
                className="text-[10px] font-mono text-primary hover:underline"
              >
                {crumb}
              </button>
            </span>
          ))}
          <button
            type="button"
            title="Nouveau fichier .md ici"
            disabled={sharedLoading || creatingBusy}
            onClick={() => { setCreatingOpen(o => !o); setCreateError(null); }}
            className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-40 transition-colors shrink-0"
          >
            <Plus size={14} />
          </button>
        </div>
        {creatingOpen && (
          <div className="px-2 py-2 border-b border-border/50 flex flex-col gap-1.5">
            <input
              value={newNameDraft}
              onChange={e => setNewNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submitCreate(); }}
              placeholder="nom.md"
              disabled={creatingBusy}
              className="w-full px-2 py-1 text-[11px] font-mono rounded border border-border bg-background text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {createError && <p className="text-[10px] text-destructive">{createError}</p>}
            <div className="flex gap-1 justify-end">
              <button
                type="button"
                disabled={creatingBusy}
                onClick={() => { setCreatingOpen(false); setCreateError(null); }}
                className="px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={creatingBusy}
                onClick={() => void submitCreate()}
                className="px-2 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground rounded disabled:opacity-50"
              >
                {creatingBusy ? '…' : 'Créer'}
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5">
          {sharedLoading && (
            <p className="px-2 py-3 text-xs text-muted-foreground/50">Chargement…</p>
          )}
          {!sharedLoading && sharedEntries.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground/50">Aucun fichier .md</p>
          )}
          {!sharedLoading && sharedEntries.map(entry => {
            const filePath = sharedPath ? `${sharedPath}/${entry.name}` : entry.name;
            const isSelected = sharedSelectedFile === filePath;
            const isStarred = !entry.isDir && (configDraft.promptInjection?.sharedStarredFiles ?? []).includes(filePath);
            return (
              <div
                key={entry.name}
                className={clsx(
                  'group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors cursor-pointer',
                  isSelected ? 'bg-secondary/80' : 'hover:bg-secondary/40',
                )}
                onClick={() => handleSharedSelectEntry(entry)}
              >
                {entry.isDir
                  ? <Folder size={11} className="text-muted-foreground/50 shrink-0" />
                  : <FileText size={11} className={isSelected ? 'text-primary shrink-0' : 'text-muted-foreground/40 shrink-0'} />
                }
                <div className="flex-1 min-w-0">
                  <p className={clsx('text-[12px] truncate', isSelected ? 'text-foreground font-medium' : 'text-foreground/70')}>{entry.name}</p>
                  {!entry.isDir && entry.mtime && (
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">{formatMtime(entry.mtime)}</p>
                  )}
                </div>
                {!entry.isDir && (
                  <button
                    onClick={e => { e.stopPropagation(); void toggleSharedStar(filePath); }}
                    disabled={savingStars}
                    title="Injecter dans le prompt"
                    className={clsx(
                      'shrink-0 transition-colors disabled:opacity-40',
                      isStarred ? 'text-yellow-400' : 'text-muted-foreground/20 group-hover:text-muted-foreground/50 hover:!text-yellow-400',
                    )}
                  >
                    <Star size={11} fill={isStarred ? 'currentColor' : 'none'} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {sharedSelectedFile ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
              <span className="text-[12px] font-mono text-muted-foreground">{sharedSelectedFile}</span>
              <button
                onClick={handleSharedSave}
                disabled={sharedSaving}
                className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {sharedSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <textarea
              value={sharedFileContent}
              onChange={e => setSharedFileContent(e.target.value)}
              className="flex-1 bg-background text-foreground p-4 font-mono text-sm resize-none focus:outline-none"
              spellCheck={false}
            />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <FileText size={28} className="text-muted-foreground/15" />
            <p className="text-sm text-muted-foreground/40">Sélectionne un fichier</p>
          </div>
        )}
      </div>
    </div>
  );
}
