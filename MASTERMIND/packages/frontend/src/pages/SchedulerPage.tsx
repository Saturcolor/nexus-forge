import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  CalendarClock, Plus, Trash2, Play, RotateCw,
  CheckCircle2, XCircle, Loader, Clock, ChevronDown, ChevronUp,
  ListChecks, History, Radar, Bell, Plug, Pencil, RotateCcw,
  Trash, Undo2,
} from 'lucide-react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { useProactiveAlerts } from '../lib/proactiveAlerts';
import type { ScheduledTask, TaskRun, CreateTaskInput, WsServerMessage, Severity, ProactiveSource, ProactiveAlert } from '@mastermind/shared';

type Tab = 'tasks' | 'proactive' | 'modules' | 'history' | 'trash';

const TABS: { id: Tab; label: string; icon: typeof CalendarClock }[] = [
  { id: 'tasks', label: 'Taches', icon: ListChecks },
  { id: 'proactive', label: 'Proactif', icon: Radar },
  { id: 'modules', label: 'Modules', icon: Plug },
  { id: 'history', label: 'Historique', icon: History },
  { id: 'trash', label: 'Corbeille', icon: Trash },
];

// ── Toggle ────────────────────────────────────────────────────
function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={clsx(
        'relative w-9 h-5 rounded-full transition-colors shrink-0',
        value ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span className={clsx(
        'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all',
        value ? 'left-[18px]' : 'left-0.5',
      )} />
    </button>
  );
}

// ── Sélecteur d'override de canaux de réveil (tâches + sources proactives) ────
// null = pas d'override (la policy `delivery` de l'agent / le legacy s'appliquent).
// [] = chat seul (aucun réveil). Prioritaire sur la policy agent ET sur le channel du LLM.
const DELIVERY_OVERRIDE_OPTIONS: Array<{ key: string; label: string; value: Array<'mobile' | 'telegram'> | null }> = [
  { key: 'inherit', label: 'Policy agent (défaut)', value: null },
  { key: 'mobile', label: 'Mobile uniquement', value: ['mobile'] },
  { key: 'telegram', label: 'Telegram uniquement', value: ['telegram'] },
  { key: 'both', label: 'Mobile + Telegram', value: ['mobile', 'telegram'] },
  { key: 'none', label: 'Chat seul (aucun réveil)', value: [] },
];

function deliveryOverrideKey(value: Array<'mobile' | 'telegram'> | null | undefined): string {
  if (value == null) return 'inherit';
  const hasM = value.includes('mobile');
  const hasT = value.includes('telegram');
  if (hasM && hasT) return 'both';
  if (hasM) return 'mobile';
  if (hasT) return 'telegram';
  return 'none';
}

function DeliveryChannelsSelect({ value, onChange }: {
  value: Array<'mobile' | 'telegram'> | null;
  onChange: (v: Array<'mobile' | 'telegram'> | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-sm text-foreground/80"
        title="Override des canaux de réveil pour CETTE tâche/source. Prioritaire sur la policy de livraison de l'agent ET sur le canal choisi par le modèle dans send_to_user. « Policy agent » = pas d'override."
      >
        Réveil
      </span>
      <select
        className="bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-ring"
        value={deliveryOverrideKey(value)}
        onChange={e => {
          const opt = DELIVERY_OVERRIDE_OPTIONS.find(o => o.key === e.target.value);
          onChange(opt ? opt.value : null);
        }}
      >
        {DELIVERY_OVERRIDE_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </div>
  );
}

// ── Status Badge ──────────────────────────────────────────────
function StatusBadge({ status }: { status?: string }) {
  if (status === 'completed') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-theme-green/10 text-theme-green text-[10px] font-medium">
      <CheckCircle2 size={10} /> OK
    </span>
  );
  if (status === 'failed') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-[10px] font-medium">
      <XCircle size={10} /> Erreur
    </span>
  );
  if (status === 'running') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium">
      <Loader size={10} className="animate-spin" /> En cours
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-medium">
      <Clock size={10} /> En attente
    </span>
  );
}

// ── Schedule display ──────────────────────────────────────────
function formatSchedule(task: ScheduledTask): string {
  if (task.scheduleKind === 'once' && task.scheduledAt) {
    return `Ponctuel: ${new Date(task.scheduledAt).toLocaleString('fr-FR')}`;
  }
  if (task.cronExpression) {
    return `Cron: ${task.cronExpression}`;
  }
  return 'Non planifie';
}

/**
 * Parse une liste cron "1,2,5" en entiers triés/dédupliqués bornés à [0, max].
 * Renvoie null si vide, malformée (virgules en trop, tokens vides, non-entiers,
 * hors bornes). Source : retours bug-hunter sur "0,," / "61 25 * * *" / heures
 * non triées qui s'affichaient comme valides avant durcissement.
 */
function parseCronList(s: string, max: number): number[] | null {
  const tokens = s.split(',');
  if (tokens.length === 0) return null;
  const out: number[] = [];
  for (const tok of tokens) {
    if (tok === '') return null;
    const n = Number(tok);
    if (!Number.isInteger(n) || n < 0 || n > max) return null;
    out.push(n);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/**
 * Humanise une expression cron 5-champs en FR. Renvoie null si pattern non reconnu
 * ou malformé → l'appelant retombe sur le cron brut. Les heures/minutes/jours
 * sont validés (bornes, tri, dedup) via parseCronList.
 */
function humanizeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const pad2 = (n: number) => String(n).padStart(2, '0');

  const DOW_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

  // "*/N * * * *" → toutes les N min
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Toutes les ${min.slice(2)} min`;
  }
  // "M */N * * *" → toutes les N heures
  if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `Toutes les ${hour.slice(2)}h`;
  }

  // À partir d'ici : listes concrètes minutes/heures, dom/mon doivent être '*'.
  if (dom !== '*' || mon !== '*') return null;

  const minutes = parseCronList(min, 59);
  const hours = parseCronList(hour, 23);
  if (!minutes || !hours) return null;

  const times: string[] = [];
  for (const h of hours) for (const m of minutes) times.push(`${pad2(h)}:${pad2(m)}`);
  let timeStr: string;
  if (times.length === 1) timeStr = times[0];
  else if (times.length <= 4) timeStr = times.join(', ');
  else timeStr = `${times[0]}, ${times[1]}, …, ${times[times.length - 1]}`;

  if (dow === '*') return `Tous les jours · ${timeStr}`;
  if (dow === '1-5') return `Lun–Ven · ${timeStr}`;

  // Liste explicite de jours : 7 → 0 (dimanche), puis dedup/tri/canonicalisation.
  const rawDays = parseCronList(dow, 7);
  if (!rawDays) return null;
  const days = Array.from(new Set(rawDays.map(d => d === 7 ? 0 : d))).sort((a, b) => a - b);

  if (days.length === 5 && days.join(',') === '1,2,3,4,5') return `Lun–Ven · ${timeStr}`;
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return `Week-end · ${timeStr}`;

  if (days.length === 0) return null;
  if (days.length === 1) return `Chaque ${DOW_FR[days[0]]} · ${timeStr}`;
  return `${days.map(d => DOW_FR[d]).join(', ')} · ${timeStr}`;
}

/** Renvoie {label, raw} : label = humanisé si possible, raw = à montrer en tooltip. */
function scheduleDisplay(task: ScheduledTask): { label: string; raw: string } {
  if (task.scheduleKind === 'once' && task.scheduledAt) {
    const d = new Date(task.scheduledAt).toLocaleString('fr-FR');
    return { label: `Ponctuel · ${d}`, raw: task.scheduledAt };
  }
  const cron = task.cronExpression?.trim();
  if (cron) {
    const human = humanizeCron(cron);
    return {
      label: human ?? `Cron: ${cron}`,
      raw: cron,
    };
  }
  return { label: 'Non planifie', raw: '' };
}

/**
 * Range les taches dans 3 buckets temporels selon `nextRunAt`. Tache sans nextRunAt
 * (ponctuel passé, ou backend pas encore broadcast) → 'later' pour ne pas la perdre.
 */
function bucketByNextRun(tasks: ScheduledTask[]): { today: ScheduledTask[]; week: ScheduledTask[]; later: ScheduledTask[] } {
  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  const endOfWeek = endOfToday + 7 * 24 * 60 * 60 * 1000;
  const today: ScheduledTask[] = [];
  const week: ScheduledTask[] = [];
  const later: ScheduledTask[] = [];
  for (const t of tasks) {
    if (!t.nextRunAt) { later.push(t); continue; }
    const ts = new Date(t.nextRunAt).getTime();
    if (ts <= endOfToday) today.push(t);
    else if (ts <= endOfWeek) week.push(t);
    else later.push(t);
  }
  const cmp = (a: ScheduledTask, b: ScheduledTask) => {
    // Symétrie d'abord : sinon Array.sort viole l'antisymétrie sur les paires
    // (sans-nextRunAt, sans-nextRunAt) et l'ordre relatif devient instable.
    if (!a.nextRunAt && !b.nextRunAt) return 0;
    if (!a.nextRunAt) return 1;
    if (!b.nextRunAt) return -1;
    return new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime();
  };
  today.sort(cmp); week.sort(cmp); later.sort(cmp);
  return { today, week, later };
}

function AgentChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span>{label}</span>
      <span className={clsx('text-[10px] tabular-nums', active ? 'opacity-80' : 'opacity-50')}>{count}</span>
    </button>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 pt-2 pb-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">{label}</span>
      <span className="text-[10px] text-muted-foreground/40 tabular-nums">{count}</span>
      <div className="flex-1 h-px bg-border/30" />
    </div>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('fr-FR');
}

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Convertit un ISO (avec offset/Z) en valeur pour `<input type="datetime-local">`.
 * datetime-local attend du `YYYY-MM-DDTHH:MM` interprété en heure LOCALE.
 * `toISOString().slice(0,16)` est buggé : il sort de l'UTC, ce qui décale l'affichage
 * de l'offset local (ex: 10:01 Paris affiché 08:01) et corrompt la sauvegarde si on
 * touche au prompt sans toucher à l'heure.
 */
function isoToLocalInputValue(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Agent selector ────────────────────────────────────────────
interface AgentInfo { id: string; name: string }

// ── Create Task Form ──────────────────────────────────────────
function CreateTaskForm({ agents, onCreated, onCancel }: {
  agents: AgentInfo[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'once' | 'cron'>('once');
  const [scheduledAt, setScheduledAt] = useState('');
  const [cronExpr, setCronExpr] = useState('');
  const [deleteAfterRun, setDeleteAfterRun] = useState(false);
  const [autoDeliver, setAutoDeliver] = useState(true);
  const [deliveryChannels, setDeliveryChannels] = useState<Array<'mobile' | 'telegram'> | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    if (!name.trim() || !prompt.trim()) {
      setError('Nom et prompt requis');
      return;
    }
    if (kind === 'once' && !scheduledAt) {
      setError('Date requise pour tache ponctuelle');
      return;
    }
    if (kind === 'cron' && !cronExpr.trim()) {
      setError('Expression cron requise');
      return;
    }
    setSaving(true);
    try {
      const input: CreateTaskInput = {
        name: name.trim(),
        agentId,
        prompt: prompt.trim(),
        scheduleKind: kind,
        ...(kind === 'once' ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        ...(kind === 'cron' ? { cronExpression: cronExpr.trim() } : {}),
        deleteAfterRun,
        autoDeliver,
        deliveryChannels,
      };
      await api.post('/api/scheduler/tasks', input);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
          <Plus size={15} className="text-primary" />
        </div>
        <h3 className="text-[14px] font-semibold text-foreground">Nouvelle tache</h3>
      </div>

      <div className="px-5 py-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Nom</label>
            <input
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Rappel reunion"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Agent</label>
            <select
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none"
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
            >
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Prompt / Instructions</label>
          <textarea
            className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground min-h-[80px] resize-y focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Rappelle-moi de faire X..."
          />
        </div>

        <div className="flex gap-4 items-center">
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Type</label>
          <label className="flex items-center gap-1.5 text-sm text-foreground/80 cursor-pointer">
            <input type="radio" name="kind" checked={kind === 'once'} onChange={() => setKind('once')} />
            Ponctuel
          </label>
          <label className="flex items-center gap-1.5 text-sm text-foreground/80 cursor-pointer">
            <input type="radio" name="kind" checked={kind === 'cron'} onChange={() => setKind('cron')} />
            Recurrent
          </label>
        </div>

        {kind === 'once' && (
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Date & heure</label>
            <input
              type="datetime-local"
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
              value={scheduledAt}
              onChange={e => setScheduledAt(e.target.value)}
            />
          </div>
        )}

        {kind === 'cron' && (
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Expression cron (5 champs)</label>
            <input
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
              value={cronExpr}
              onChange={e => setCronExpr(e.target.value)}
              placeholder="0 9 * * 1-5"
            />
            <p className="text-[10px] text-muted-foreground/40 mt-1">minute heure jour mois jour-semaine (ex: 0 9 * * 1-5 = weekdays 9h)</p>
          </div>
        )}

        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <Toggle value={deleteAfterRun} onChange={() => setDeleteAfterRun(!deleteAfterRun)} />
            <span className="text-sm text-foreground/80">Supprimer apres execution</span>
          </div>
          <div className="flex items-center gap-2">
            <Toggle value={autoDeliver} onChange={() => setAutoDeliver(!autoDeliver)} />
            <span className="text-sm text-foreground/80" title="Filet de secours : si l'agent finit sans send_to_user, son texte final est quand meme pousse vers les canaux push (proactive handler en chat web, ou session Telegram cible). Decoche pour laisser ces runs terminer en silence. N'affecte PAS les tâches scheduled web simples — leur reponse passe par le streaming live et reste visible quoi qu'il arrive.">
              Auto-livrer si pas de send_to_user
            </span>
          </div>
          <DeliveryChannelsSelect value={deliveryChannels} onChange={setDeliveryChannels} />
        </div>
        <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
          Le réveil ci-dessus est un <span className="font-medium text-muted-foreground/70">override de canaux</span> pour
          cette tâche, prioritaire sur la <Link to="/telegram" className="text-primary hover:underline">police de livraison</Link> de
          l'agent. « Policy agent » = pas d'override (la policy s'applique telle quelle).
        </p>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/50 bg-card/50">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Annuler
        </button>
        <button
          onClick={submit}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Creation...' : 'Creer'}
        </button>
      </div>
    </div>
  );
}

// ── Tasks Tab ─────────────────────────────────────────────────
function TasksTab() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.get<ScheduledTask[]>('/api/scheduler/tasks');
      setTasks(data);
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.get<Record<string, { identity: { id: string; name: string } }>>('/api/agents');
      setAgents(Object.values(data).map(a => ({ id: a.identity.id, name: a.identity.name })));
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    fetchAgents();
  }, [fetchTasks, fetchAgents]);

  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsServerMessage) => {
      if (msg.type === 'tasks.updated' || msg.type === 'task.completed' || msg.type === 'task.failed' || msg.type === 'task.started') {
        fetchTasks();
      }
    });
    return unsub;
  }, [fetchTasks]);

  const toggleTask = async (id: string, enabled: boolean) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, enabled } : t));
    try {
      await api.post(`/api/scheduler/tasks/${id}/toggle`, { enabled });
    } catch (err) {
      console.error('Failed to toggle task:', err);
      fetchTasks();
    }
  };

  const deleteTask = async (id: string) => {
    await api.delete(`/api/scheduler/tasks/${id}`);
    // Defensive refresh: WS broadcast may not arrive (or may race with the response).
    // Without this the row stays visible until the user reloads — see Corbeille for restore.
    await fetchTasks();
  };

  const runNow = async (id: string) => {
    await api.post(`/api/scheduler/tasks/${id}/run`);
  };

  // Compteurs par agent (sur les taches NON filtrées) — sert à alimenter les chips.
  const agentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.agentId] = (counts[t.agentId] ?? 0) + 1;
    return counts;
  }, [tasks]);

  const visibleTasks = useMemo(
    () => agentFilter === 'all' ? tasks : tasks.filter(t => t.agentId === agentFilter),
    [tasks, agentFilter],
  );

  // Si l'agent filtré n'a plus aucune tâche (toutes supprimées, ou WS broadcast),
  // les chips disparaissent (cf. `sortedAgentIds.length > 1`) et l'utilisateur
  // se retrouverait coincé sur un état vide sans issue UI. Reset à 'all'.
  useEffect(() => {
    if (agentFilter !== 'all' && !(agentFilter in agentCounts)) {
      setAgentFilter('all');
    }
  }, [agentCounts, agentFilter]);

  const buckets = useMemo(() => bucketByNextRun(visibleTasks), [visibleTasks]);

  if (loading) {
    return <div className="text-xs text-muted-foreground p-6">Chargement...</div>;
  }

  const sortedAgentIds = Object.keys(agentCounts).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {visibleTasks.length} tache{visibleTasks.length !== 1 ? 's' : ''}
          {agentFilter !== 'all' && tasks.length !== visibleTasks.length && (
            <span className="text-muted-foreground/50"> sur {tasks.length}</span>
          )}
        </p>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus size={14} /> Nouvelle
        </button>
      </div>

      {showForm && (
        <CreateTaskForm
          agents={agents}
          onCreated={() => { setShowForm(false); fetchTasks(); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <CalendarClock size={36} className="text-muted-foreground/15" />
          <p className="text-sm text-muted-foreground/40">Aucune tache planifiee</p>
          <button
            onClick={() => setShowForm(true)}
            className="text-xs text-primary hover:text-primary/80 transition-colors"
          >
            + Creer une tache
          </button>
        </div>
      ) : (
        <>
          {sortedAgentIds.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <AgentChip
                active={agentFilter === 'all'}
                label="Tous"
                count={tasks.length}
                onClick={() => setAgentFilter('all')}
              />
              {sortedAgentIds.map(id => (
                <AgentChip
                  key={id}
                  active={agentFilter === id}
                  label={id}
                  count={agentCounts[id]}
                  onClick={() => setAgentFilter(id)}
                />
              ))}
            </div>
          )}

          {visibleTasks.length === 0 ? (
            <p className="text-xs text-muted-foreground/40 py-8 text-center">Aucune tache pour cet agent</p>
          ) : (
            <div className="space-y-1">
              {buckets.today.length > 0 && (
                <>
                  <SectionHeader label="Aujourd'hui" count={buckets.today.length} />
                  <div className="space-y-2">
                    {buckets.today.map(task => (
                      <TaskRow key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} onRunNow={runNow} onUpdated={fetchTasks} />
                    ))}
                  </div>
                </>
              )}
              {buckets.week.length > 0 && (
                <>
                  <SectionHeader label="Cette semaine" count={buckets.week.length} />
                  <div className="space-y-2">
                    {buckets.week.map(task => (
                      <TaskRow key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} onRunNow={runNow} onUpdated={fetchTasks} />
                    ))}
                  </div>
                </>
              )}
              {buckets.later.length > 0 && (
                <>
                  <SectionHeader label="Plus tard" count={buckets.later.length} />
                  <div className="space-y-2">
                    {buckets.later.map(task => (
                      <TaskRow key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} onRunNow={runNow} onUpdated={fetchTasks} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TaskRow({ task, onToggle, onDelete, onRunNow, onUpdated }: {
  task: ScheduledTask;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(task.name);
  const [prompt, setPrompt] = useState(task.prompt);
  const [cronExpr, setCronExpr] = useState(task.cronExpression ?? '');
  const [scheduledAt, setScheduledAt] = useState(isoToLocalInputValue(task.scheduledAt));
  const [deleteAfterRun, setDeleteAfterRun] = useState(task.deleteAfterRun ?? false);
  const [autoDeliver, setAutoDeliver] = useState(task.autoDeliver ?? true);
  const [deliveryChannels, setDeliveryChannels] = useState<Array<'mobile' | 'telegram'> | null>(task.deliveryChannels ?? null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/scheduler/tasks/${task.id}`, {
        name, prompt,
        cronExpression: cronExpr || undefined,
        ...(task.scheduleKind === 'once' && scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        deleteAfterRun,
        autoDeliver,
        deliveryChannels,
      });
      setEditing(false);
      onUpdated();
    } catch (err) {
      console.error('Failed to update task:', err);
    } finally {
      setSaving(false);
    }
  };

  const sched = scheduleDisplay(task);

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <Toggle value={task.enabled} onChange={() => onToggle(task.id, !task.enabled)} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-foreground truncate">{task.name}</span>
            <span className="text-[10px] text-muted-foreground/50">{task.agentId}</span>
            <StatusBadge status={task.lastRunStatus} />
            {task.createdBy === 'agent' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">agent</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span
              className="text-[11px] text-muted-foreground/60"
              title={sched.raw ? `cron: ${sched.raw}` : undefined}
            >
              {sched.label}
            </span>
            {task.nextRunAt && (
              <span className="text-[11px] text-muted-foreground/40">Prochain: {formatDate(task.nextRunAt)}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => onRunNow(task.id)} title="Executer maintenant" className="p-1.5 text-muted-foreground/40 hover:text-foreground hover:bg-secondary rounded-lg transition-colors">
            <Play size={13} />
          </button>
          <button onClick={() => { setEditing(!editing); setName(task.name); setPrompt(task.prompt); setCronExpr(task.cronExpression ?? ''); setScheduledAt(isoToLocalInputValue(task.scheduledAt)); setDeleteAfterRun(task.deleteAfterRun ?? false); setAutoDeliver(task.autoDeliver ?? true); setDeliveryChannels(task.deliveryChannels ?? null); }} title="Modifier" className="p-1.5 text-muted-foreground/40 hover:text-primary hover:bg-secondary rounded-lg transition-colors">
            <Pencil size={13} />
          </button>
          <button onClick={() => onDelete(task.id)} title="Supprimer" className="p-1.5 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {editing && (
        <div className="border-t border-border/30 px-4 py-3 space-y-3 bg-secondary/20">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Nom</label>
              <input className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring" value={name} onChange={e => setName(e.target.value)} />
            </div>
            {task.scheduleKind === 'cron' ? (
              <div>
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Cron</label>
                <input className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:border-ring" value={cronExpr} onChange={e => setCronExpr(e.target.value)} />
              </div>
            ) : (
              <div>
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Date & heure</label>
                <input type="datetime-local" className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
              </div>
            )}
          </div>
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Prompt</label>
            <textarea className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground min-h-[80px] resize-y focus:outline-none focus:border-ring" value={prompt} onChange={e => setPrompt(e.target.value)} />
          </div>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <Toggle value={deleteAfterRun} onChange={() => setDeleteAfterRun(!deleteAfterRun)} />
              <span className="text-xs text-foreground/80">Supprimer apres exec</span>
            </div>
            <div className="flex items-center gap-2">
              <Toggle value={autoDeliver} onChange={() => setAutoDeliver(!autoDeliver)} />
              <span className="text-xs text-foreground/80" title="Filet de secours : si l'agent finit sans send_to_user, son texte final est quand meme pousse vers les canaux push (proactive handler en chat web, ou session Telegram cible). Decoche pour laisser ces runs terminer en silence. N'affecte PAS les tâches scheduled web simples — leur reponse passe par le streaming live et reste visible quoi qu'il arrive.">
                Auto-livrer
              </span>
            </div>
            <DeliveryChannelsSelect value={deliveryChannels} onChange={setDeliveryChannels} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-muted-foreground">Annuler</button>
            <button onClick={save} disabled={saving} className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg disabled:opacity-50">{saving ? '...' : 'Sauvegarder'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────
function HistoryTab() {
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const data = await api.get<TaskRun[]>('/api/scheduler/runs?limit=50');
      setRuns(data);
    } catch (err) {
      console.error('Failed to fetch runs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsServerMessage) => {
      if (msg.type === 'task.completed' || msg.type === 'task.failed' || msg.type === 'task.started') {
        fetchRuns();
      }
    });
    return unsub;
  }, [fetchRuns]);

  if (loading) {
    return <div className="text-xs text-muted-foreground p-6">Chargement...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{runs.length} execution{runs.length !== 1 ? 's' : ''}</p>
        <button
          onClick={fetchRuns}
          className="p-1.5 text-muted-foreground/40 hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
        >
          <RotateCw size={13} />
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <History size={36} className="text-muted-foreground/15" />
          <p className="text-sm text-muted-foreground/40">Aucune execution</p>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map(run => (
            <div key={run.id} className="bg-card rounded-xl border border-border/50 overflow-hidden">
              <button
                onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left"
              >
                <StatusBadge status={run.status} />
                <span className="text-[13px] font-semibold text-foreground truncate flex-1">
                  {run.taskName ?? run.taskId ?? '(supprimee)'}
                </span>
                {run.kind && run.kind !== 'task' && (
                  <span className={clsx('text-[9px] px-1.5 py-0.5 rounded-full font-medium',
                    run.kind === 'proactive' ? 'bg-primary/10 text-primary' : 'bg-theme-orange/10 text-theme-orange'
                  )}>{run.kind}</span>
                )}
                {run.escalated && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">escalade</span>
                )}
                {!run.taskId && run.taskName && run.kind === 'task' && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">archivee</span>
                )}
                <span className="text-[11px] text-muted-foreground/50">{run.agentId}</span>
                <span className="text-[11px] text-muted-foreground/40 font-mono">{formatDuration(run.durationMs)}</span>
                <span className="text-[11px] text-muted-foreground/40">{formatDate(run.startedAt)}</span>
                {expandedRun === run.id ? <ChevronUp size={13} className="text-muted-foreground/40" /> : <ChevronDown size={13} className="text-muted-foreground/40" />}
              </button>

              {expandedRun === run.id && (
                <div className="border-t border-border/40 px-4 py-3 space-y-3">
                  <div className="flex items-center gap-4 text-[10px] text-muted-foreground/50">
                    <span>Debut: {formatDate(run.startedAt)}</span>
                    {run.completedAt && <span>Fin: {formatDate(run.completedAt)}</span>}
                    {run.durationMs && <span>Duree: {formatDuration(run.durationMs)}</span>}
                    {run.sessionId && <span className="font-mono">Session: {run.sessionId}</span>}
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground/40">Prompt</p>
                    <pre className="mt-1 whitespace-pre-wrap bg-secondary rounded-lg p-3 text-[11px] text-foreground/70">{run.prompt}</pre>
                  </div>
                  {run.result && (
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Resultat</p>
                      <pre className="mt-1 whitespace-pre-wrap bg-secondary rounded-lg p-3 text-[11px] text-foreground/70 max-h-48 overflow-y-auto">{run.result}</pre>
                    </div>
                  )}
                  {run.error && (
                    <div>
                      <p className="text-[10px] text-destructive">Erreur</p>
                      <pre className="mt-1 whitespace-pre-wrap bg-destructive/10 rounded-lg p-3 text-[11px] text-destructive">{run.error}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Proactive Tab ─────────────────────────────────────────────
function CreateProactiveForm({ agents, onCreated, onCancel }: {
  agents: AgentInfo[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [watcherId, setWatcherId] = useState(agents[0]?.id ?? '');
  const [handlerId, setHandlerId] = useState(agents[1]?.id ?? agents[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [cronExpr, setCronExpr] = useState('*/10 * * * *');
  const [severityThreshold, setSeverityThreshold] = useState<Severity>('medium');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    if (!name.trim() || !prompt.trim()) { setError('Nom et prompt requis'); return; }
    if (!watcherId || !handlerId) { setError('Watcher et handler requis'); return; }
    if (watcherId === handlerId) { setError('Le handler doit etre different du watcher'); return; }
    if (!cronExpr.trim()) { setError('Expression cron requise'); return; }
    setSaving(true);
    try {
      const input: CreateTaskInput = {
        name: name.trim(),
        agentId: watcherId,
        prompt: prompt.trim(),
        scheduleKind: 'cron',
        cronExpression: cronExpr.trim(),
        kind: 'proactive',
        escalationAgentId: handlerId,
        severityThreshold,
      };
      await api.post('/api/scheduler/tasks', input);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
          <Radar size={15} className="text-primary" />
        </div>
        <h3 className="text-[14px] font-semibold text-foreground">Nouvelle tache proactive</h3>
      </div>

      <div className="px-5 py-4 space-y-4">
        <div>
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Nom</label>
          <input
            className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Check mails importants"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Watcher (agent leger)</label>
            <select
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none"
              value={watcherId}
              onChange={e => setWatcherId(e.target.value)}
            >
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Handler (agent principal)</label>
            <select
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none"
              value={handlerId}
              onChange={e => setHandlerId(e.target.value)}
            >
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Prompt de surveillance</label>
          <textarea
            className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground min-h-[100px] resize-y focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Liste les mails non lus. Si l'un est urgent (notation facture, rendez-vous, securite), appelle escalate_to_agent avec un resume et severity=medium ou high. Sinon termine ton turn sans escalader."
          />
          <p className="text-[10px] text-muted-foreground/40 mt-1">
            Rappelle au watcher qu'il doit terminer silencieusement s'il n'y a rien a signaler, et n'appeler escalate_to_agent que quand c'est justifie.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Cron</label>
            <input
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-ring"
              value={cronExpr}
              onChange={e => setCronExpr(e.target.value)}
              placeholder="*/10 * * * *"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Seuil severity</label>
            <select
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none"
              value={severityThreshold}
              onChange={e => setSeverityThreshold(e.target.value as Severity)}
            >
              <option value="low">low (tout escalade)</option>
              <option value="medium">medium (defaut)</option>
              <option value="high">high (seulement critique)</option>
            </select>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/50 bg-card/50">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Annuler
        </button>
        <button
          onClick={submit}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Creation...' : 'Creer'}
        </button>
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity?: Severity }) {
  if (!severity) return null;
  const style =
    severity === 'high' ? 'bg-destructive/15 text-destructive' :
    severity === 'medium' ? 'bg-theme-orange/15 text-theme-orange' :
    'bg-primary/15 text-primary';
  return (
    <span className={clsx('text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase', style)}>
      {severity}
    </span>
  );
}

// ── Sources externes (webhook integrations) ──────────────────
function SourceCard({ source: s, agents, onToggle, onDelete, onUpdated }: {
  source: ProactiveSource;
  agents: AgentInfo[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [agentId, setAgentId] = useState(s.agentId);
  const [prompt, setPrompt] = useState(s.prompt);
  const [rate, setRate] = useState(s.rateLimitMinutes);
  const [retention, setRetention] = useState(s.contextRetentionHours);
  const [autoDeliver, setAutoDeliver] = useState(s.autoDeliver ?? true);
  const [deliveryChannels, setDeliveryChannels] = useState<Array<'mobile' | 'telegram'> | null>(s.deliveryChannels ?? null);
  const [saving, setSaving] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [alerts, setAlerts] = useState<ProactiveAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);

  const loadAlerts = async () => {
    if (showAlerts) { setShowAlerts(false); return; }
    setShowAlerts(true);
    setAlertsLoading(true);
    try {
      const data = await api.get<ProactiveAlert[]>(`/api/proactive/alerts?sourceId=${s.id}&limit=20`);
      setAlerts(data);
    } catch { setAlerts([]); }
    finally { setAlertsLoading(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/proactive/sources/${s.id}`, { name, agentId, prompt, rateLimitMinutes: rate, contextRetentionHours: retention, autoDeliver, deliveryChannels });
      setEditing(false);
      onUpdated();
    } catch (err) {
      console.error('Failed to update source:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border/40 overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-3">
        <Toggle value={s.enabled} onChange={() => onToggle(s.id, !s.enabled)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-foreground">{s.name}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium font-mono">{s.id}</span>
            <span className="text-[10px] text-muted-foreground/50">→ {s.agentId}</span>
            <span className="text-[10px] text-muted-foreground/40">cooldown {s.rateLimitMinutes}min</span>
            <span className="text-[10px] text-muted-foreground/40">retention {s.contextRetentionHours === 0 ? 'off' : `${s.contextRetentionHours}h`}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <code className="text-[9px] font-mono text-muted-foreground/30 bg-secondary px-1.5 py-0.5 rounded select-all">
              POST /api/proactive/ingest {`{ "source": "${s.name}", "title": "...", "message": "..." }`}
            </code>
          </div>
          {s.lastAlertAt && (
            <p className="text-[10px] text-muted-foreground/40 mt-0.5">Derniere alerte: {formatDate(s.lastAlertAt)}</p>
          )}
        </div>
        <button
          onClick={async () => { if (confirm(`Reset le contexte de l'agent ${s.agentId} ? Ses messages seront supprimés, le system prompt reste intact.`)) { await api.post(`/api/proactive/sources/${s.id}/flush`); } }}
          className="p-1.5 text-muted-foreground/40 hover:text-theme-orange" title="Reset contexte agent"
        >
          <RotateCcw size={12} />
        </button>
        <button onClick={() => { setEditing(!editing); setName(s.name); setAgentId(s.agentId); setPrompt(s.prompt); setRate(s.rateLimitMinutes); setRetention(s.contextRetentionHours); setAutoDeliver(s.autoDeliver ?? true); setDeliveryChannels(s.deliveryChannels ?? null); }} className="p-1.5 text-muted-foreground/40 hover:text-primary" title="Modifier">
          <Pencil size={12} />
        </button>
        <button onClick={() => onDelete(s.id)} className="p-1.5 text-muted-foreground/40 hover:text-destructive" title="Supprimer">
          <Trash2 size={12} />
        </button>
      </div>
      {editing && (
        <div className="border-t border-border/30 px-4 py-3 space-y-3 bg-secondary/20">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Nom</label>
              <input className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Agent</label>
              <select className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none" value={agentId} onChange={e => setAgentId(e.target.value)}>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Cooldown (min)</label>
              <input type="number" min={0} max={60} className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none" value={rate} onChange={e => setRate(parseInt(e.target.value) ?? 0)} />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Retention (h)</label>
              <input type="number" min={0} max={168} className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none" value={retention} onChange={e => setRetention(parseInt(e.target.value) || 0)} />
              <p className="text-[9px] text-muted-foreground/30 mt-0.5">0 = pas d'auto-flush</p>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Prompt agent</label>
            <textarea className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground min-h-[60px] resize-y focus:outline-none focus:border-ring" value={prompt} onChange={e => setPrompt(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <Toggle value={autoDeliver} onChange={() => setAutoDeliver(!autoDeliver)} />
            <span className="text-xs text-foreground/80" title="Filet de secours : si l'agent finit sans send_to_user sur une alerte, son texte final est quand meme livre. Decoche pour autoriser une fin silencieuse — l'agent peut trier l'alerte sans te pinger.">
              Auto-livrer si pas de send_to_user
            </span>
            <DeliveryChannelsSelect value={deliveryChannels} onChange={setDeliveryChannels} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-muted-foreground">Annuler</button>
            <button onClick={save} disabled={saving} className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg disabled:opacity-50">{saving ? '...' : 'Sauvegarder'}</button>
          </div>
        </div>
      )}

      {/* Alerts toggle */}
      <div className="border-t border-border/30 px-4 py-1.5 flex items-center">
        <button onClick={loadAlerts} className="text-[10px] text-muted-foreground/40 hover:text-primary transition-colors flex items-center gap-1">
          {showAlerts ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          Alertes recentes
          {alerts.length > 0 && showAlerts && <span className="font-mono">({alerts.length})</span>}
        </button>
      </div>

      {showAlerts && (
        <div className="border-t border-border/20 px-4 py-2 space-y-1 bg-secondary/10 max-h-48 overflow-y-auto">
          {alertsLoading && <p className="text-[10px] text-muted-foreground/40">Chargement...</p>}
          {!alertsLoading && alerts.length === 0 && <p className="text-[10px] text-muted-foreground/30">Aucune alerte</p>}
          {alerts.map(a => (
            <div key={a.id} className="flex items-center gap-2 text-[10px] py-0.5">
              <SeverityBadge severity={a.severity} />
              <span className={clsx('px-1 py-0.5 rounded text-[9px] font-mono',
                a.state === 'triggered' ? 'bg-destructive/10 text-destructive' : 'bg-theme-green/10 text-theme-green'
              )}>{a.state}</span>
              <span className="text-foreground/80 truncate flex-1" title={a.message}>{a.title}</span>
              {a.metric && <span className="text-muted-foreground/40 font-mono">{a.metric}={a.value}{a.threshold != null ? ` (>{a.threshold})` : ''}</span>}
              <span className={clsx('text-[9px]', a.dispatched ? 'text-theme-green' : 'text-muted-foreground/30')}>{a.dispatched ? 'dispatche' : 'skip'}</span>
              <span className="text-muted-foreground/30 shrink-0">{formatDate(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SourcesSection({ agents }: { agents: AgentInfo[] }) {
  const [sources, setSources] = useState<ProactiveSource[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAgent, setNewAgent] = useState(agents[0]?.id ?? '');
  const [newPrompt, setNewPrompt] = useState('');
  const [newRate, setNewRate] = useState(5);
  const [newRetention, setNewRetention] = useState(24);
  const [newAutoDeliver, setNewAutoDeliver] = useState(true);

  const fetchSources = useCallback(async () => {
    try {
      const data = await api.get<ProactiveSource[]>('/api/proactive/sources');
      setSources(data);
    } catch (err) {
      console.error('Failed to fetch sources:', err);
    }
  }, []);

  useEffect(() => { fetchSources(); }, [fetchSources]);

  const create = async () => {
    if (!newName.trim() || !newAgent) return;
    try {
      await api.post('/api/proactive/sources', { name: newName.trim(), agentId: newAgent, prompt: newPrompt.trim(), rateLimitMinutes: newRate, contextRetentionHours: newRetention, autoDeliver: newAutoDeliver });
      setShowAdd(false);
      setNewName('');
      fetchSources();
    } catch (err) {
      console.error('Failed to create source:', err);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setSources(prev => prev.map(s => s.id === id ? { ...s, enabled } : s));
    try {
      await api.post(`/api/proactive/sources/${id}/toggle`, { enabled });
    } catch (err) {
      console.error('Failed to toggle source:', err);
      fetchSources();
    }
  };

  const remove = async (id: string) => {
    await api.delete(`/api/proactive/sources/${id}`);
    fetchSources();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug size={14} className="text-muted-foreground" />
          <h3 className="text-[12px] font-semibold text-foreground uppercase tracking-wider">Modules externes</h3>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus size={12} /> Ajouter
        </button>
      </div>

      {showAdd && (
        <div className="bg-card rounded-xl border border-border/50 px-4 py-3 space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Nom</label>
              <input
                className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Nexus Monitor"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Agent assigne</label>
              <select
                className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none"
                value={newAgent}
                onChange={e => setNewAgent(e.target.value)}
              >
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Cooldown (min)</label>
              <input
                type="number" min={0} max={60}
                className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none"
                value={newRate}
                onChange={e => setNewRate(parseInt(e.target.value) ?? 0)}
              />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Retention (h)</label>
              <input
                type="number" min={0} max={168}
                className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none"
                value={newRetention}
                onChange={e => setNewRetention(parseInt(e.target.value) || 0)}
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Prompt agent (instructions)</label>
            <textarea
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground min-h-[60px] resize-y focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
              value={newPrompt}
              onChange={e => setNewPrompt(e.target.value)}
              placeholder="You are monitoring the infrastructure. If the alert is critical, notify the user on Telegram. If it is a warning, note it on the board and wait..."
            />
          </div>
          <div className="flex items-center gap-2">
            <Toggle value={newAutoDeliver} onChange={() => setNewAutoDeliver(!newAutoDeliver)} />
            <span className="text-xs text-foreground/80" title="Filet de secours : si l'agent finit sans send_to_user sur une alerte, son texte final est quand meme livre. Decoche pour autoriser une fin silencieuse — l'agent peut trier l'alerte sans te pinger.">
              Auto-livrer si pas de send_to_user
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-xs text-muted-foreground">Annuler</button>
            <button onClick={create} className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg">Creer</button>
          </div>
        </div>
      )}

      {sources.length === 0 && !showAdd ? (
        <p className="text-[11px] text-muted-foreground/40 px-2">
          Aucun module externe. Ajoute-en un pour recevoir des alertes push (Nexus Monitor, Mailmind, etc.)
        </p>
      ) : (
        <div className="space-y-1.5">
          {sources.map(s => (
            <SourceCard key={s.id} source={s} agents={agents} onToggle={toggle} onDelete={remove} onUpdated={fetchSources} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModulesTab() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Record<string, { identity: { id: string; name: string } }>>('/api/agents')
      .then(data => setAgents(Object.values(data).map(a => ({ id: a.identity.id, name: a.identity.name }))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-xs text-muted-foreground p-6">Chargement...</div>;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs text-muted-foreground">
          Modules externes qui poussent des alertes en temps reel vers Mastermind. Chaque source est associee a un agent qui recoit et traite les alertes.
        </p>
      </div>
      <SourcesSection agents={agents} />
    </div>
  );
}

function ProactiveTaskCard({ task, agents, onToggle, onDelete, onRunNow, onUpdated }: {
  task: ScheduledTask;
  agents: AgentInfo[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(task.name);
  const [prompt, setPrompt] = useState(task.prompt);
  const [cronExpr, setCronExpr] = useState(task.cronExpression ?? '');
  const [watcherId, setWatcherId] = useState(task.agentId);
  const [handlerId, setHandlerId] = useState(task.escalationAgentId ?? '');
  const [threshold, setThreshold] = useState<Severity>(task.severityThreshold ?? 'medium');
  const [saving, setSaving] = useState(false);

  const openEdit = () => {
    setName(task.name); setPrompt(task.prompt); setCronExpr(task.cronExpression ?? '');
    setWatcherId(task.agentId); setHandlerId(task.escalationAgentId ?? '');
    setThreshold(task.severityThreshold ?? 'medium');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/scheduler/tasks/${task.id}`, {
        name, prompt, cronExpression: cronExpr || undefined,
        agentId: watcherId, escalationAgentId: handlerId, severityThreshold: threshold,
      });
      setEditing(false);
      onUpdated();
    } catch (err) {
      console.error('Failed to update proactive task:', err);
    } finally {
      setSaving(false);
    }
  };

  const sched = scheduleDisplay(task);

  return (
    <div className="bg-card rounded-xl border border-primary/30 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <Toggle value={task.enabled} onChange={() => onToggle(task.id, !task.enabled)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-foreground truncate">{task.name}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium uppercase">
              {task.agentId} → {task.escalationAgentId}
            </span>
            <SeverityBadge severity={task.severityThreshold} />
            <StatusBadge status={task.lastRunStatus} />
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span
              className="text-[11px] text-muted-foreground/60"
              title={sched.raw ? `cron: ${sched.raw}` : undefined}
            >
              {sched.label}
            </span>
            {task.nextRunAt && (
              <span className="text-[11px] text-muted-foreground/40">Prochain: {formatDate(task.nextRunAt)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onRunNow(task.id)} className="p-1.5 text-muted-foreground hover:text-primary" title="Executer maintenant">
            <Play size={13} />
          </button>
          <button onClick={openEdit} className="p-1.5 text-muted-foreground hover:text-primary" title="Modifier">
            <Pencil size={13} />
          </button>
          <button onClick={() => onDelete(task.id)} className="p-1.5 text-muted-foreground hover:text-destructive" title="Supprimer">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {editing && (
        <div className="border-t border-border/30 px-4 py-3 space-y-3 bg-secondary/20">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Nom</label>
              <input className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Cron</label>
              <input className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:border-ring" value={cronExpr} onChange={e => setCronExpr(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Watcher</label>
              <select className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none" value={watcherId} onChange={e => setWatcherId(e.target.value)}>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Handler</label>
              <select className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none" value={handlerId} onChange={e => setHandlerId(e.target.value)}>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Seuil severity</label>
              <select className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none" value={threshold} onChange={e => setThreshold(e.target.value as Severity)}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Prompt</label>
            <textarea className="w-full mt-1 bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-foreground min-h-[80px] resize-y focus:outline-none focus:border-ring" value={prompt} onChange={e => setPrompt(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-muted-foreground">Annuler</button>
            <button onClick={save} disabled={saving} className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg disabled:opacity-50">{saving ? '...' : 'Sauvegarder'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProactiveTab() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [alerts, setAlerts] = useState<TaskRun[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const { acknowledgeAll } = useProactiveAlerts();

  const fetchAll = useCallback(async () => {
    try {
      const [t, a, runs] = await Promise.all([
        api.get<ScheduledTask[]>('/api/scheduler/tasks?kind=proactive'),
        api.get<Record<string, { identity: { id: string; name: string } }>>('/api/agents'),
        api.get<TaskRun[]>('/api/scheduler/alerts/recent?limit=50'),
      ]);
      setTasks(t);
      setAgents(Object.values(a).map(x => ({ id: x.identity.id, name: x.identity.name })));
      setAlerts(runs);
    } catch (err) {
      console.error('Failed to fetch proactive data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsServerMessage) => {
      if (msg.type === 'tasks.updated' || msg.type === 'proactive.alert' ||
          msg.type === 'task.completed' || msg.type === 'task.failed' || msg.type === 'task.started') {
        fetchAll();
      }
    });
    return unsub;
  }, [fetchAll]);

  // Mark visible alerts as read when the user opens this tab.
  useEffect(() => { acknowledgeAll(); }, [acknowledgeAll]);

  const toggleTask = async (id: string, enabled: boolean) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, enabled } : t));
    try {
      await api.post(`/api/scheduler/tasks/${id}/toggle`, { enabled });
    } catch (err) {
      console.error('Failed to toggle task:', err);
      fetchAll();
    }
  };
  const deleteTask = async (id: string) => {
    await api.delete(`/api/scheduler/tasks/${id}`);
    await fetchAll();
  };
  const runNow = async (id: string) => {
    await api.post(`/api/scheduler/tasks/${id}/run`);
  };

  // Compteurs par agent watcher (sur l'ensemble non filtré). Mémoïsé pour
  // garder la même réf entre rendus et permettre une dep array propre.
  const agentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.agentId] = (counts[t.agentId] ?? 0) + 1;
    return counts;
  }, [tasks]);

  const visibleTasks = useMemo(
    () => agentFilter === 'all' ? tasks : tasks.filter(t => t.agentId === agentFilter),
    [tasks, agentFilter],
  );

  const buckets = useMemo(() => bucketByNextRun(visibleTasks), [visibleTasks]);

  // Si l'agent filtré n'a plus aucune tâche → reset à 'all' pour éviter le piège UI.
  useEffect(() => {
    if (agentFilter !== 'all' && !(agentFilter in agentCounts)) {
      setAgentFilter('all');
    }
  }, [agentCounts, agentFilter]);

  if (loading) return <div className="text-xs text-muted-foreground p-6">Chargement...</div>;

  const sortedAgentIds = Object.keys(agentCounts).sort();

  // Group escalation runs by their parent (watcher run)
  const byParent = new Map<string, TaskRun[]>();
  const topLevel: TaskRun[] = [];
  for (const r of alerts) {
    if (r.parentRunId) {
      const arr = byParent.get(r.parentRunId) ?? [];
      arr.push(r);
      byParent.set(r.parentRunId, arr);
    } else {
      topLevel.push(r);
    }
  }

  return (
    <div className="space-y-5">
      {/* Cron-based watchers */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {visibleTasks.length} watcher{visibleTasks.length !== 1 ? 's' : ''}
          {agentFilter !== 'all' && tasks.length !== visibleTasks.length && (
            <span className="text-muted-foreground/50"> sur {tasks.length}</span>
          )}
        </p>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus size={14} /> Nouveau watcher
        </button>
      </div>

      {showForm && (
        <CreateProactiveForm
          agents={agents}
          onCreated={() => { setShowForm(false); fetchAll(); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
          <Radar size={36} className="text-muted-foreground/15" />
          <p className="text-sm text-muted-foreground/40">Aucun watcher proactif</p>
          <p className="text-[11px] text-muted-foreground/30 max-w-md">
            Un watcher est un agent leger qui tourne sur un cron et decide s'il faut escalader vers un agent plus costaud (handler) pour te notifier.
          </p>
        </div>
      ) : (
        <>
          {sortedAgentIds.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <AgentChip
                active={agentFilter === 'all'}
                label="Tous"
                count={tasks.length}
                onClick={() => setAgentFilter('all')}
              />
              {sortedAgentIds.map(id => (
                <AgentChip
                  key={id}
                  active={agentFilter === id}
                  label={id}
                  count={agentCounts[id]}
                  onClick={() => setAgentFilter(id)}
                />
              ))}
            </div>
          )}

          {visibleTasks.length === 0 ? (
            <p className="text-xs text-muted-foreground/40 py-8 text-center">Aucun watcher pour cet agent</p>
          ) : (
            <div className="space-y-1">
              {buckets.today.length > 0 && (
                <>
                  <SectionHeader label="Aujourd'hui" count={buckets.today.length} />
                  <div className="space-y-2">
                    {buckets.today.map(task => (
                      <ProactiveTaskCard key={task.id} task={task} agents={agents} onToggle={toggleTask} onDelete={deleteTask} onRunNow={runNow} onUpdated={fetchAll} />
                    ))}
                  </div>
                </>
              )}
              {buckets.week.length > 0 && (
                <>
                  <SectionHeader label="Cette semaine" count={buckets.week.length} />
                  <div className="space-y-2">
                    {buckets.week.map(task => (
                      <ProactiveTaskCard key={task.id} task={task} agents={agents} onToggle={toggleTask} onDelete={deleteTask} onRunNow={runNow} onUpdated={fetchAll} />
                    ))}
                  </div>
                </>
              )}
              {buckets.later.length > 0 && (
                <>
                  <SectionHeader label="Plus tard" count={buckets.later.length} />
                  <div className="space-y-2">
                    {buckets.later.map(task => (
                      <ProactiveTaskCard key={task.id} task={task} agents={agents} onToggle={toggleTask} onDelete={deleteTask} onRunNow={runNow} onUpdated={fetchAll} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Alerts audit trail */}
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-3">
          <Bell size={14} className="text-muted-foreground" />
          <h3 className="text-[12px] font-semibold text-foreground uppercase tracking-wider">Historique des alertes</h3>
        </div>
        {topLevel.length === 0 ? (
          <p className="text-xs text-muted-foreground/40 px-2">Aucune alerte recente.</p>
        ) : (
          <div className="space-y-2">
            {topLevel.map(watcher => {
              const children = byParent.get(watcher.id) ?? [];
              const delivered = children.some(c => c.delivered);
              return (
                <div key={watcher.id} className={clsx(
                  'bg-card rounded-xl border overflow-hidden',
                  delivered ? 'border-theme-orange/40' : 'border-border/40',
                )}>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <StatusBadge status={watcher.status} />
                    <span className="text-[11px] text-muted-foreground/60 font-mono">{watcher.agentId}</span>
                    <SeverityBadge severity={watcher.severity} />
                    {watcher.escalated && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">escalade</span>
                    )}
                    {delivered && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-theme-orange/15 text-theme-orange font-medium">delivered</span>
                    )}
                    {watcher.acknowledgedAt ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-theme-green/10 text-theme-green font-medium">
                        ack {formatDate(watcher.acknowledgedAt)}
                      </span>
                    ) : watcher.status === 'completed' && (watcher.escalated || delivered) ? (
                      <button
                        onClick={async (e) => { e.stopPropagation(); await api.post(`/api/scheduler/alerts/${watcher.id}/ack`); fetchAll(); }}
                        className="text-[9px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground hover:bg-theme-green/15 hover:text-theme-green font-medium transition-colors"
                      >
                        ack
                      </button>
                    ) : null}
                    <span className="text-[11px] text-muted-foreground/40 ml-auto">{formatDate(watcher.startedAt)}</span>
                  </div>
                  {children.length > 0 && (
                    <div className="border-t border-border/30 px-4 py-2 space-y-1.5 bg-secondary/20">
                      {children.map(child => (
                        <div key={child.id} className="flex items-center gap-2 text-[11px]">
                          <span className="text-muted-foreground/50">↳</span>
                          <StatusBadge status={child.status} />
                          <span className="text-muted-foreground">{child.agentId}</span>
                          {child.delivered ? (
                            <span className="text-theme-orange">delivered</span>
                          ) : (
                            <span className="text-muted-foreground/40">silent</span>
                          )}
                          <span className="text-muted-foreground/40 ml-auto">{formatDuration(child.durationMs)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export default function SchedulerPage() {
  const [tab, setTab] = useState<Tab>('tasks');
  const { unreadCount } = useProactiveAlerts();

  return (
    <div className="h-full flex flex-col">
      {/* Header — aligned with MemoryPage / ProvidersPage */}
      <div className="px-6 py-4 border-b border-border bg-card shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <CalendarClock size={20} /> Taches planifiees
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Planification et historique des executions automatiques
            </p>
          </div>
        </div>

        {/* Tab bar — scrollable horizontalement sur narrow (même pattern que
            AgentDetailPage). Le wrapper porte overflow-x-auto, la flex interne
            min-w-max garde les onglets à leur largeur naturelle. */}
        <div className="mt-3 -mb-4 overflow-x-auto no-scrollbar">
          <div className="flex min-w-max">
          {TABS.map(t => {
            const Icon = t.icon;
            const showBadge = t.id === 'proactive' && unreadCount > 0;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                  tab === t.id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon size={14} />
                {t.label}
                {showBadge && (
                  <span className="min-w-[16px] h-[16px] px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
            );
          })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'tasks' && <TasksTab />}
        {tab === 'proactive' && <ProactiveTab />}
        {tab === 'modules' && <ModulesTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'trash' && <TrashTab />}
      </div>
    </div>
  );
}

// ── Trash Tab (corbeille) ─────────────────────────────────────
function TrashTab() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchTrash = useCallback(async () => {
    try {
      const data = await api.get<ScheduledTask[]>('/api/scheduler/tasks/trash');
      setTasks(data);
    } catch (err) {
      console.error('Failed to fetch trash:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTrash(); }, [fetchTrash]);

  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsServerMessage) => {
      if (msg.type === 'tasks.updated') fetchTrash();
    });
    return unsub;
  }, [fetchTrash]);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      await api.post(`/api/scheduler/tasks/${id}/restore`);
      await fetchTrash();
    } finally {
      setBusy(null);
    }
  };

  const purge = async (id: string, name: string) => {
    if (!confirm(`Supprimer definitivement "${name}" ? Cette action est irreversible.`)) return;
    setBusy(id);
    try {
      await api.delete(`/api/scheduler/tasks/${id}/purge`);
      await fetchTrash();
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="text-xs text-muted-foreground p-6">Chargement...</div>;

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <Trash size={36} className="text-muted-foreground/15" />
        <p className="text-sm text-muted-foreground/40">Corbeille vide</p>
        <p className="text-[11px] text-muted-foreground/30 max-w-md">
          Les taches supprimees apparaissent ici. Tu peux les restaurer ou les supprimer definitivement.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground mb-2">{tasks.length} tache{tasks.length !== 1 ? 's' : ''} dans la corbeille</p>
      {tasks.map(task => (
        <div key={task.id} className="bg-card rounded-xl border border-border/40 px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground truncate">{task.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-mono">{task.kind}</span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground/60">
              <span>{formatSchedule(task)}</span>
              <span>·</span>
              <span>Supprimee {formatDate(task.deletedAt)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground/50 mt-1 truncate">{task.prompt}</p>
          </div>
          <button
            onClick={() => restore(task.id)}
            disabled={busy === task.id}
            title="Restaurer"
            className="p-1.5 text-muted-foreground/60 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors disabled:opacity-50"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={() => purge(task.id, task.name)}
            disabled={busy === task.id}
            title="Supprimer definitivement"
            className="p-1.5 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors disabled:opacity-50"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
