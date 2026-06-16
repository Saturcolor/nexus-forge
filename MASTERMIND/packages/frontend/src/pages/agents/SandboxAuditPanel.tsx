import { useEffect, useState } from 'react';
import { X, Loader, CheckCircle2, XCircle, Ban, Clock } from 'lucide-react';
import type { ChatMessage } from '../../hooks/useChat';
import type { ToolEvent } from '../../hooks/useChat';
import { api } from '../../lib/api';
import { MarkdownWithCopy, ToolEventBlock } from '../../components/MessageList';

/**
 * Audit panel for a sandbox_run job — replays every message produced during the
 * background run (source='sandbox'), including tool events. Slideout from the right
 * with a single fetch at mount (the run is already complete or cancelled when opened).
 *
 * For kind='shell' jobs, shows the stdout/stderr stored in `job.result` instead.
 */

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
type JobKind = 'shell' | 'sandbox_run';

interface AsyncJobSummary {
  id: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  kind: JobKind;
  status: JobStatus;
  result: string | null;
  error: string | null;
  caption: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface AuditResponse {
  job: AsyncJobSummary;
  messages: ChatMessage[];
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
}

function StatusPill({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { cls: string; icon: typeof CheckCircle2; label: string }> = {
    queued: { cls: 'bg-secondary text-muted-foreground', icon: Clock, label: 'Queued' },
    running: { cls: 'bg-primary/15 text-primary', icon: Loader, label: 'Running' },
    done: { cls: 'bg-theme-green/15 text-theme-green', icon: CheckCircle2, label: 'Done' },
    error: { cls: 'bg-destructive/15 text-destructive', icon: XCircle, label: 'Error' },
    cancelled: { cls: 'bg-muted-foreground/15 text-muted-foreground', icon: Ban, label: 'Cancelled' },
  };
  const { cls, icon: Icon, label } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      <Icon size={10} className={status === 'running' ? 'animate-spin' : ''} />
      {label}
    </span>
  );
}

export function SandboxAuditPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<AuditResponse>(`/api/async-jobs/${jobId}/audit`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [jobId]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end pointer-events-none">
      {/* Dim backdrop — clickable to close */}
      <div className="absolute inset-0 bg-black/40 pointer-events-auto" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-3xl h-full bg-card border-l border-border shadow-2xl flex flex-col pointer-events-auto">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
              Audit de tâche
            </p>
            <p className="text-sm font-mono text-foreground">{jobId.slice(0, 12)}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="Fermer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && <p className="text-xs text-muted-foreground">Chargement…</p>}
          {error && <p className="text-xs text-destructive">Erreur: {error}</p>}
          {data && <AuditBody data={data} />}
        </div>
      </div>
    </div>
  );
}

function AuditBody({ data }: { data: AuditResponse }) {
  const { job, messages } = data;
  const duration = formatDuration(job.startedAt, job.completedAt);
  const taskPrompt = job.kind === 'sandbox_run' && typeof job.args['task'] === 'string'
    ? (job.args['task'] as string)
    : null;

  return (
    <>
      {/* Job header card */}
      <div className="bg-secondary/30 rounded-lg border border-border/60 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <StatusPill status={job.status} />
          <span className="font-mono text-xs text-foreground">
            {job.toolName.replace(/^skill_/, '')}
          </span>
          <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
            {duration}
          </span>
        </div>
        {taskPrompt && (
          <div className="pt-2 border-t border-border/40">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Task prompt
            </p>
            <p className="text-xs text-foreground whitespace-pre-wrap">{taskPrompt}</p>
          </div>
        )}
        {job.error && (
          <div className="pt-2 border-t border-border/40">
            <p className="text-[10px] text-destructive uppercase tracking-wider mb-1">Erreur</p>
            <p className="text-xs text-destructive font-mono whitespace-pre-wrap">{job.error}</p>
          </div>
        )}
      </div>

      {/* Messages timeline */}
      {job.kind === 'sandbox_run' && (
        <div className="space-y-3">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
            Timeline ({messages.length} messages)
          </p>
          {messages.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              {job.status === 'cancelled'
                ? 'Aucun message — tâche annulée avant de produire des messages.'
                : 'Aucun message enregistré pour cette tâche.'}
            </p>
          ) : (
            messages.map((msg) => <MessageRow key={msg.id} msg={msg} />)
          )}
        </div>
      )}

      {/* Shell job: show result as plain output */}
      {job.kind === 'shell' && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
            Output
          </p>
          {job.result ? (
            <pre className="text-xs font-mono bg-secondary/30 p-3 rounded border border-border/60 whitespace-pre-wrap overflow-x-auto">
              {job.result}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground italic">Pas de sortie capturée.</p>
          )}
        </div>
      )}
    </>
  );
}

function MessageRow({ msg }: { msg: ChatMessage }) {
  const role = msg.role;
  const time = new Date(msg.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const toolEvents = (msg.metadata?.['toolEvents'] ?? msg.toolEvents ?? []) as ToolEvent[];

  const roleBadge =
    role === 'assistant' ? (
      <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-theme-green/20 text-theme-green">
        AGENT
      </span>
    ) : role === 'tool' ? (
      <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-primary/20 text-primary">
        TOOL
      </span>
    ) : role === 'user' ? (
      <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-muted-foreground/20 text-muted-foreground">
        INPUT
      </span>
    ) : (
      <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-secondary text-muted-foreground">
        {role.toUpperCase()}
      </span>
    );

  return (
    <div className="border-l-2 border-border/60 pl-3 space-y-1.5">
      <div className="flex items-center gap-2">
        {roleBadge}
        <span className="text-[10px] text-muted-foreground tabular-nums ml-auto">{time}</span>
      </div>
      {Array.isArray(toolEvents) && toolEvents.length > 0 && (
        <div className="space-y-1">
          {toolEvents.map((ev) => (
            <ToolEventBlock key={ev.toolCallId} ev={ev} />
          ))}
        </div>
      )}
      {msg.content && (
        <div className="text-sm text-foreground">
          {role === 'assistant' ? (
            <MarkdownWithCopy
              content={msg.content}
              className="[&_code]:bg-secondary [&_code]:text-primary [&_code]:px-1 [&_code]:rounded [&_pre]:bg-secondary [&_pre]:p-2 [&_pre]:rounded [&_a]:text-primary text-foreground text-sm break-words"
            />
          ) : (
            <pre className="text-xs font-mono whitespace-pre-wrap bg-secondary/20 p-2 rounded">
              {msg.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
