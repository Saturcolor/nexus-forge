import { BookMarked, X, FolderOpen, Database } from 'lucide-react';
import { clsx } from 'clsx';

export interface CsIndexRow {
  key: string;
  sourcePath: string;
  dbPath: string;
  totalChunks?: number;
}

function formatChunks(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Retourne juste le dernier segment d'un chemin (nom du dossier/fichier) */
function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? p;
}

export function CsIndicesPanel({
  onClose,
  indices,
  totalChunks,
}: {
  onClose: () => void;
  indices: CsIndexRow[];
  totalChunks?: number | null;
}) {
  const totalRows = indices.reduce((s, r) => s + (r.totalChunks ?? 0), 0);
  const displayTotal = totalChunks ?? (totalRows > 0 ? totalRows : null);

  return (
    <div className="absolute bottom-full mb-2 right-0 z-[200] min-w-[240px] w-max max-w-[300px]
      bg-card border border-border rounded-lg shadow-lg shadow-black/30 overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <BookMarked size={9} className="text-muted-foreground/70" />
          Index mémoire
          {displayTotal != null && (
            <span className="text-muted-foreground/50 font-mono normal-case tracking-normal">
              — {formatChunks(displayTotal)} chunks
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Fermer"
        >
          <X size={10} />
        </button>
      </div>

      {/* Index rows */}
      <div className="py-1 max-h-[240px] overflow-y-auto">
        {indices.length === 0 && (
          <div className="px-3 py-3 text-[10px] text-muted-foreground/40 text-center">
            Aucun index configuré
          </div>
        )}
        {indices.map((row) => (
          <div
            key={row.key}
            className="px-3 py-1.5 hover:bg-secondary/30 transition-colors"
          >
            {/* Ligne principale : nom + chunks */}
            <div className="flex items-center justify-between gap-2">
              <span className={clsx(
                'text-[11px] font-medium truncate max-w-[180px]',
                row.key === 'default' ? 'text-muted-foreground/70 italic' : 'text-foreground/85',
              )} title={row.key}>
                {row.key}
              </span>
              {row.totalChunks != null && row.totalChunks > 0 && (
                <span className="text-[10px] font-mono tabular-nums text-muted-foreground/55 shrink-0">
                  {formatChunks(row.totalChunks)}
                </span>
              )}
            </div>

            {/* Ligne secondaire : source */}
            {row.sourcePath && (
              <div className="flex items-center gap-1 mt-0.5">
                <FolderOpen size={8} className="text-muted-foreground/30 shrink-0" />
                <span
                  className="text-[9px] text-muted-foreground/45 font-mono truncate"
                  title={row.sourcePath}
                >
                  {basename(row.sourcePath)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer : chemin DB du dernier index affiché (optionnel, discret) */}
      {indices.length > 0 && (
        <div className="border-t border-border/40 px-3 py-1.5 flex items-center gap-1">
          <Database size={8} className="text-muted-foreground/25 shrink-0" />
          <span className="text-[9px] text-muted-foreground/30 font-mono truncate" title={indices[0]?.dbPath}>
            {basename(indices[0]?.dbPath ?? '')}
          </span>
        </div>
      )}
    </div>
  );
}
