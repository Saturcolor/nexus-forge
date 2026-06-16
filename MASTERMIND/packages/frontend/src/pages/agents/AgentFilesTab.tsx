import { useState } from 'react';
import { FileText, Star, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import type { WorkspaceFile, AgentFull } from './types';
import { formatMtime } from './types';
import { normalizeMdBasename } from './fileNameUtils';

export interface AgentFilesTabProps {
  files: WorkspaceFile[];
  filesError: string | null;
  selectedFile: string | null;
  fileContent: string;
  saving: boolean;
  savingStars: boolean;
  configDraft: Partial<AgentFull>;
  setSelectedFile: (name: string | null) => void;
  setFileContent: (content: string) => void;
  handleSaveFile: () => void;
  toggleWorkspaceStar: (fileName: string) => Promise<void>;
  onCreateFile: (basename: string) => Promise<void>;
}

export function AgentFilesTab({
  files, filesError, selectedFile, fileContent, saving, savingStars,
  configDraft, setSelectedFile, setFileContent, handleSaveFile, toggleWorkspaceStar, onCreateFile,
}: AgentFilesTabProps) {
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
    if (files.some(f => f.name === norm.name)) {
      setCreateError('Un fichier avec ce nom existe déjà.');
      return;
    }
    setCreatingBusy(true);
    try {
      await onCreateFile(norm.name);
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
        <div className="px-3 py-2 border-b border-border/50 flex items-center justify-between gap-2">
          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">Fichiers</span>
          <button
            type="button"
            title="Nouveau fichier .md"
            disabled={!!filesError || creatingBusy}
            onClick={() => { setCreatingOpen(o => !o); setCreateError(null); }}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-40 transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {creatingOpen && !filesError && (
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
          {filesError && (
            <p className="px-2 py-2 text-xs text-destructive">{filesError}</p>
          )}
          {!filesError && files.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground/50">Aucun fichier .md</p>
          )}
          {files.map(file => {
            const isSelected = selectedFile === file.name;
            const isStarred = (configDraft.promptInjection?.workspaceStarredFiles ?? []).includes(file.name);
            return (
              <div
                key={file.name}
                className={clsx(
                  'group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors cursor-pointer',
                  isSelected ? 'bg-secondary/80' : 'hover:bg-secondary/40',
                )}
                onClick={() => setSelectedFile(file.name)}
              >
                <FileText size={11} className={isSelected ? 'text-primary shrink-0' : 'text-muted-foreground/40 shrink-0'} />
                <div className="flex-1 min-w-0">
                  <p className={clsx('text-[12px] truncate', isSelected ? 'text-foreground font-medium' : 'text-foreground/70')}>{file.name}</p>
                  {file.mtime && (
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">{formatMtime(file.mtime)}</p>
                  )}
                </div>
                <button
                  onClick={e => { e.stopPropagation(); void toggleWorkspaceStar(file.name); }}
                  disabled={savingStars}
                  title="Injecter dans le prompt"
                  className={clsx(
                    'shrink-0 transition-colors disabled:opacity-40',
                    isStarred ? 'text-yellow-400' : 'text-muted-foreground/20 group-hover:text-muted-foreground/50 hover:!text-yellow-400',
                  )}
                >
                  <Star size={11} fill={isStarred ? 'currentColor' : 'none'} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
              <span className="text-[12px] font-mono text-muted-foreground">{selectedFile}</span>
              <button
                onClick={handleSaveFile}
                disabled={saving}
                className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <textarea
              value={fileContent}
              onChange={e => setFileContent(e.target.value)}
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
