/**
 * Modal de drill-down pour un run de sub-agent.
 *
 * Mode terminé : affiche le rapport markdown complet (async_jobs.result) + métadonnées.
 * Mode en cours : affiche une timeline live des turns / tool calls / text au fur et à
 * mesure que le sub-agent progresse, alimentée par les events WS subagent.run.*.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { suggestSubagentReportBasename } from '@mastermind/shared';
import { X, Copy, Upload, Loader2, CheckCircle2, XCircle, Wrench, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { wsClient } from '../../lib/ws';

interface JobDetail {
  id: string;
  agentId: string;
  subAgentId: string | null;
  parentSessionId: string | null;
  parentAgentId: string | null;
  taskPrompt: string | null;
  status: string;
  result: string | null;
  error: string | null;
  capsHit: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

type LiveEventType =
  | 'turn'
  | 'tool.start'
  | 'tool.done'
  | 'text'
  | 'lifecycle';

interface LiveEvent {
  type: LiveEventType;
  ts: number;
  // turn
  turn?: number;
  maxTurns?: number;
  // tool
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  durationMs?: number;
  toolError?: string;
  // text
  content?: string;
  finishReason?: string;
  // lifecycle
  lifecycle?: 'queued' | 'started' | 'completed' | 'failed' | 'cancelled';
  lifecycleDetail?: string;
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function summariseInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  try {
    const json = JSON.stringify(input);
    return truncate(json, 160);
  } catch {
    return '';
  }
}

export function SubAgentRunDetail({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportBaseName, setExportBaseName] = useState('');
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [nowTick, setNowTick] = useState(Date.now());
  const eventsEndRef = useRef<HTMLDivElement>(null);

  const suggestedExportBase = useMemo(
    () => (job?.result ? suggestSubagentReportBasename(job.result, jobId) : ''),
    [job?.result, jobId],
  );

  useEffect(() => {
    setExportBaseName(suggestedExportBase);
  }, [jobId, suggestedExportBase]);

  const fetchJob = useCallback(async () => {
    try {
      const j = await api.get<JobDetail>(`/api/async-jobs/${encodeURIComponent(jobId)}`);
      setJob(j);
    } catch (err) {
      console.error('[sub-agent-run-detail] fetch failed:', err);
    }
  }, [jobId]);

  useEffect(() => {
    void fetchJob().finally(() => setLoading(false));
  }, [fetchJob]);

  // Live subscription: filter WS events scoped to this jobId, append to timeline.
  useEffect(() => {
    const unsub = wsClient.subscribe((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; jobId?: string; agentId?: string };
      if (!m.type) return;

      // Sub-agent live progress events — scoped by jobId
      if (m.jobId === jobId) {
        const now = Date.now();
        if (m.type === 'subagent.run.turn') {
          const t = msg as { turn: number; maxTurns: number };
          setEvents(evs => [...evs, { type: 'turn', ts: now, turn: t.turn, maxTurns: t.maxTurns }]);
        } else if (m.type === 'subagent.run.tool.start') {
          const t = msg as { toolName: string; toolCallId: string; input: Record<string, unknown> };
          setEvents(evs => [...evs, { type: 'tool.start', ts: now, toolName: t.toolName, toolCallId: t.toolCallId, input: t.input }]);
        } else if (m.type === 'subagent.run.tool.done') {
          const t = msg as { toolName: string; toolCallId: string; durationMs: number; output: string; error?: string };
          setEvents(evs => [...evs, { type: 'tool.done', ts: now, toolName: t.toolName, toolCallId: t.toolCallId, durationMs: t.durationMs, output: t.output, toolError: t.error }]);
        } else if (m.type === 'subagent.run.text') {
          const t = msg as { turn: number; content: string; finishReason: string };
          setEvents(evs => [...evs, { type: 'text', ts: now, turn: t.turn, content: t.content, finishReason: t.finishReason }]);
        }
      }

      // Async-job lifecycle — refetch the job so status/result/error update
      if (
        (m.type === 'async_job.started' && m.jobId === jobId) ||
        (m.type === 'async_job.completed' && m.jobId === jobId) ||
        (m.type === 'async_job.failed' && m.jobId === jobId) ||
        (m.type === 'async_job.cancelled' && m.jobId === jobId)
      ) {
        const lifecycle =
          m.type === 'async_job.started' ? 'started' :
          m.type === 'async_job.completed' ? 'completed' :
          m.type === 'async_job.failed' ? 'failed' : 'cancelled';
        setEvents(evs => [...evs, { type: 'lifecycle', ts: Date.now(), lifecycle }]);
        void fetchJob();
      }
    });
    return unsub;
  }, [jobId, fetchJob]);

  // Auto-scroll on new events when run is active
  useEffect(() => {
    if (job?.status === 'running' || job?.status === 'queued') {
      eventsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [events.length, job?.status]);

  const isRunning = job?.status === 'running' || job?.status === 'queued';

  // 1Hz tick while the run is active — drives the live elapsed counters and
  // the "waiting on LLM" indicator. Stops once the job is in a terminal state.
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  // Live "elapsed since last event" — surfaces silent waits (DeepInfra slow,
  // upstream pondering, etc.). When >30s without any event, we display a
  // pulsing indicator so the user sees the run is alive but waiting.
  const lastEventTs = events.length > 0 ? events[events.length - 1].ts : null;
  const silentSinceMs = useMemo(() => {
    if (!isRunning || !lastEventTs) return 0;
    return Math.max(0, nowTick - lastEventTs);
  }, [isRunning, lastEventTs, nowTick]);

  // Total wall-clock since job started (using nowTick for live update)
  const liveDurMs = useMemo(() => {
    if (job?.completedAt && job?.startedAt) {
      return new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
    }
    if (isRunning && job?.startedAt) {
      return nowTick - new Date(job.startedAt).getTime();
    }
    return null;
  }, [job?.completedAt, job?.startedAt, isRunning, nowTick]);

  const exportReportToShared = useCallback(async () => {
    if (!job?.result) return;
    setExportBusy(true);
    try {
      const r = await api.post<{ ok: boolean; path: string; baseName: string }>(
        `/api/async-jobs/${encodeURIComponent(jobId)}/export-report-to-shared`,
        { baseName: exportBaseName.trim() || undefined },
      );
      window.alert(`Rapport enregistré sur le serveur (shared memory) :\n${r.path}`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  }, [job?.result, jobId, exportBaseName]);

  // Latest turn marker for header
  const latestTurnEvent = [...events].reverse().find(e => e.type === 'turn');

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-border/50 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              {isRunning && <Loader2 size={14} className="animate-spin text-blue-500" />}
              Sub-agent run · <code className="font-mono text-xs text-muted-foreground">{jobId.slice(0, 12)}</code>
            </h3>
            {job && (
              <div className="text-[11px] text-muted-foreground mt-0.5">
                preset <code className="px-1 bg-secondary rounded">{job.subAgentId ?? '?'}</code>
                {' · '}durée <span className={isRunning ? 'text-blue-500 tabular-nums' : 'tabular-nums'}>{formatDuration(liveDurMs)}</span>
                {' · '}status <span className={job.status === 'done' ? 'text-emerald-500' : job.status === 'error' ? 'text-destructive' : isRunning ? 'text-blue-500' : ''}>{job.status}</span>
                {latestTurnEvent && isRunning && (
                  <span className="ml-1 text-blue-500">· turn {latestTurnEvent.turn}/{latestTurnEvent.maxTurns}</span>
                )}
                {job.capsHit && <span className="ml-1 text-amber-500">(caps_hit: {job.capsHit})</span>}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
            aria-label="Fermer"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && <div className="text-sm text-muted-foreground">Chargement…</div>}
          {!loading && !job && <div className="text-sm text-destructive">Run introuvable.</div>}
          {job && (
            <>
              {/* Prompt initial */}
              <section>
                <div className="flex items-center justify-between mb-1.5">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Prompt initial</h4>
                  {job.taskPrompt && (
                    <button
                      onClick={() => job.taskPrompt && navigator.clipboard.writeText(job.taskPrompt)}
                      className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    >
                      <Copy size={10} /> copier
                    </button>
                  )}
                </div>
                <pre className="bg-secondary/50 border border-border/40 rounded p-3 text-xs whitespace-pre-wrap font-mono text-foreground/90 max-h-40 overflow-y-auto">
                  {job.taskPrompt || '—'}
                </pre>
              </section>

              {/* Métadonnées parent */}
              {(job.parentAgentId || job.parentSessionId) && (
                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Spawn parent</h4>
                  <div className="text-xs text-foreground/90 space-y-0.5">
                    {job.parentAgentId && <div>agent : <code className="px-1 bg-secondary rounded">{job.parentAgentId}</code></div>}
                    {job.parentSessionId && <div>session : <code className="px-1 bg-secondary rounded">{job.parentSessionId}</code></div>}
                  </div>
                </section>
              )}

              {/* Live timeline — visible whenever we have events (during run, or to keep audit
                  trail visible if the modal stays open after completion). */}
              {(events.length > 0 || isRunning) && (
                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                    Timeline live {isRunning && <span className="text-blue-500 normal-case">(en cours…)</span>}
                  </h4>
                  <div className="bg-secondary/30 border border-border/40 rounded p-2 space-y-1.5 max-h-96 overflow-y-auto">
                    {events.length === 0 && isRunning && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground italic">
                        <Loader2 size={11} className="animate-spin text-blue-500" />
                        En attente du premier événement…
                      </div>
                    )}
                    {events.map((e, i) => (
                      <TimelineRow key={i} event={e} />
                    ))}
                    {/* Live silent-wait indicator: surfaces upstream LLM waits >30s.
                        DeepInfra/Moonshot inferences of 5-7min are routine — without
                        this, the timeline looks frozen and the user assumes hang. */}
                    {isRunning && silentSinceMs > 30_000 && (
                      <div className="flex items-center gap-2 text-xs text-blue-500 italic pt-1 border-t border-border/30">
                        <Clock size={11} className="animate-pulse" />
                        <span className="tabular-nums">
                          en attente de la réponse LLM ({Math.round(silentSinceMs / 1000)}s)
                        </span>
                        <span className="text-muted-foreground/60 text-[10px] ml-auto">
                          inférences longues : 5-7min observées sur kimi/reasoning
                        </span>
                      </div>
                    )}
                    <div ref={eventsEndRef} />
                  </div>
                </section>
              )}

              {/* Erreur si applicable */}
              {job.error && (
                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-destructive mb-1.5">Erreur</h4>
                  <pre className="bg-destructive/10 border border-destructive/30 rounded p-3 text-xs whitespace-pre-wrap font-mono text-destructive">
                    {job.error}
                  </pre>
                </section>
              )}

              {/* Rapport (final) */}
              <section>
                <div className="flex items-center justify-between mb-1.5 gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Rapport (markdown)</h4>
                  {job.result && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(job.result!)}
                        className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                      >
                        <Copy size={10} /> copier
                      </button>
                      <button
                        type="button"
                        disabled={exportBusy}
                        onClick={() => void exportReportToShared()}
                        className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        {exportBusy ? <Loader2 size={10} className="animate-spin" /> : <Upload size={10} />}
                        shared memory
                      </button>
                    </div>
                  )}
                </div>
                {job.result && (
                  <div className="mb-2 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label htmlFor="subagent-export-filename" className="text-[10px] font-medium text-muted-foreground">
                        Nom du fichier (sans .md)
                      </label>
                      {suggestedExportBase && (
                        <button
                          type="button"
                          onClick={() => setExportBaseName(suggestedExportBase)}
                          className="text-[10px] text-primary/80 hover:text-primary"
                        >
                          Suggestion depuis le titre
                        </button>
                      )}
                    </div>
                    <input
                      id="subagent-export-filename"
                      value={exportBaseName}
                      onChange={e => setExportBaseName(e.target.value)}
                      disabled={exportBusy}
                      spellCheck={false}
                      className="w-full min-w-0 rounded border border-border/60 bg-background px-2 py-1.5 text-[11px] font-mono text-foreground disabled:opacity-50"
                      placeholder={suggestedExportBase || 'nom-du-fichier'}
                    />
                    <p className="text-[10px] text-muted-foreground/70">
                      Prérempli à partir du premier <code className="rounded bg-secondary px-0.5 text-[9px]"># titre</code> du rapport (sinon identifiant court du job). Vous pouvez l&apos;éditer avant export.
                    </p>
                  </div>
                )}
                {job.result ? (
                  <pre className="bg-secondary/50 border border-border/40 rounded p-3 text-xs whitespace-pre-wrap font-mono text-foreground/90">
                    {job.result}
                  </pre>
                ) : (
                  <div className="text-xs text-muted-foreground italic">
                    {isRunning ? 'En attente du rapport final…' : 'Aucun rapport disponible.'}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ event: e }: { event: LiveEvent }) {
  const time = new Date(e.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ts = <span className="font-mono text-[10px] text-muted-foreground/60 shrink-0 w-16">{time}</span>;

  if (e.type === 'turn') {
    return (
      <div className="flex items-start gap-2 text-xs">
        {ts}
        <span className="text-blue-500 font-medium">turn {e.turn}/{e.maxTurns}</span>
      </div>
    );
  }
  if (e.type === 'tool.start') {
    return (
      <div className="flex items-start gap-2 text-xs">
        {ts}
        <Wrench size={11} className="mt-0.5 text-amber-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-foreground"><span className="font-medium">{e.toolName}</span> starting…</div>
          {e.input && Object.keys(e.input).length > 0 && (
            <div className="text-muted-foreground/70 font-mono text-[10px] truncate">{summariseInput(e.input)}</div>
          )}
        </div>
      </div>
    );
  }
  if (e.type === 'tool.done') {
    return (
      <div className="flex items-start gap-2 text-xs">
        {ts}
        {e.toolError ? (
          <XCircle size={11} className="mt-0.5 text-destructive shrink-0" />
        ) : (
          <CheckCircle2 size={11} className="mt-0.5 text-emerald-500 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-foreground">
            <span className="font-medium">{e.toolName}</span>{' '}
            <span className="text-muted-foreground/70">{formatDuration(e.durationMs)}</span>
          </div>
          {e.toolError ? (
            <div className="text-destructive font-mono text-[10px] truncate">{truncate(e.toolError, 200)}</div>
          ) : e.output ? (
            <div className="text-muted-foreground/70 font-mono text-[10px] truncate">{truncate(e.output, 200)}</div>
          ) : null}
        </div>
      </div>
    );
  }
  if (e.type === 'text') {
    return (
      <div className="flex items-start gap-2 text-xs">
        {ts}
        <span className="text-foreground/60 shrink-0">turn {e.turn} text</span>
        <div className="flex-1 min-w-0 text-foreground/90 italic">
          {truncate(e.content ?? '', 280)}
          {e.finishReason && e.finishReason !== 'tool_calls' && (
            <span className="ml-1 text-muted-foreground/50">· finish={e.finishReason}</span>
          )}
        </div>
      </div>
    );
  }
  if (e.type === 'lifecycle') {
    const colour =
      e.lifecycle === 'completed' ? 'text-emerald-500' :
      e.lifecycle === 'failed' || e.lifecycle === 'cancelled' ? 'text-destructive' :
      'text-blue-500';
    return (
      <div className="flex items-start gap-2 text-xs">
        {ts}
        <span className={`${colour} font-medium`}>job {e.lifecycle}</span>
      </div>
    );
  }
  return null;
}
