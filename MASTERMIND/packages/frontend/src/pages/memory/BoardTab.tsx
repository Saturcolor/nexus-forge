import { useState, useEffect, useCallback } from 'react';
import { Trash2, RefreshCw, Clipboard, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import type { BoardNote } from '@mastermind/shared';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  if (diff <= 0) return 'expiree';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}min`;
  return `${Math.round(diff / 3600_000)}h`;
}

export function BoardTab() {
  const [notes, setNotes] = useState<BoardNote[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<BoardNote[]>('/api/board');
      setNotes(data);
    } catch (err) {
      console.error('Failed to fetch board notes:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Auto-refresh every 30s to match the purge tick
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const deleteNote = async (id: string) => {
    try {
      await api.delete(`/api/board/${id}`);
      setNotes(prev => prev.filter(n => n.id !== id));
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  };

  const purgeAll = async () => {
    try {
      await api.post('/api/board/purge');
      refresh();
    } catch (err) {
      console.error('Failed to purge:', err);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Chargement...</div>;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Clipboard size={14} /> Board ephemere
          </h2>
          <p className="text-[11px] text-muted-foreground/50 mt-0.5">
            Notes partagees entre tous les agents, injectees dans chaque prompt. TTL auto-purge.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw size={11} /> Rafraichir
          </button>
          {notes.length > 0 && (
            <button
              onClick={purgeAll}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-destructive/70 hover:text-destructive transition-colors"
            >
              <Trash2 size={11} /> Purger tout
            </button>
          )}
        </div>
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
          <Clipboard size={32} className="text-muted-foreground/15" />
          <p className="text-sm text-muted-foreground/40">Board vide</p>
          <p className="text-[11px] text-muted-foreground/30">
            Les agents ecrivent ici via board_write, les notes s'auto-purgent apres leur TTL
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {notes.map(note => (
            <div
              key={note.id}
              className="bg-card border border-border/50 rounded-xl px-4 py-3 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-semibold text-primary">{note.agentId}</span>
                  <span className="text-[10px] text-muted-foreground/40">{formatTime(note.createdAt)}</span>
                  <span className="text-[10px] text-muted-foreground/40 flex items-center gap-0.5">
                    <Clock size={9} /> expire dans {formatExpiry(note.expiresAt)}
                  </span>
                  <span className="text-[9px] text-muted-foreground/30 font-mono">{note.id}</span>
                </div>
                <p className="text-[13px] text-foreground/80 whitespace-pre-wrap break-words">
                  {note.content}
                </p>
              </div>
              <button
                onClick={() => deleteNote(note.id)}
                className="p-1.5 text-muted-foreground/40 hover:text-destructive transition-colors shrink-0"
                title="Supprimer cette note"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
