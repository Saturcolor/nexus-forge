import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  Swords, Plus, X, SkipForward, Square, DoorClosed, Users, Loader,
  CheckCircle2, AlertTriangle, Clock, ArrowLeft, FileText, PanelLeftOpen, PanelLeftClose,
} from 'lucide-react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import useIsMobile from '../hooks/useIsMobile';
import type {
  WarRoom,
  WarRoomDetail,
  WarRoomMessage,
  CreateRoomInput,
  WsServerMessage,
} from '@mastermind/shared';

interface AgentInfo { id: string; name: string }

// ── Utility ──────────────────────────────────────────────────
function formatDate(iso?: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('fr-FR');
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Deterministic color per agent id, used for bubbles and name tags. */
const AGENT_COLORS = [
  'text-theme-orange', 'text-theme-green', 'text-theme-blue',
  'text-theme-purple', 'text-theme-pink', 'text-theme-yellow',
];
function colorForAgent(agentId: string): string {
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

// ── Status badge ─────────────────────────────────────────────
function StatusBadge({ status }: { status: WarRoom['status'] }) {
  if (status === 'open') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-theme-green/10 text-theme-green text-[10px] font-medium">
      <CheckCircle2 size={10} /> Ouverte
    </span>
  );
  if (status === 'closed') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-medium">
      <DoorClosed size={10} /> Fermee
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-[10px] font-medium">
      <AlertTriangle size={10} /> Crashed
    </span>
  );
}

// ── Creation modal ───────────────────────────────────────────
function CreateRoomModal({ agents, onCreated, onCancel }: {
  agents: AgentInfo[];
  onCreated: (room: WarRoomDetail) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [userName, setUserName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [maxMessages, setMaxMessages] = useState(200);
  const [maxToolsPerTurn, setMaxToolsPerTurn] = useState(5);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const submit = async () => {
    setError('');
    if (!name.trim()) { setError('Nom requis'); return; }
    if (selected.length === 0) { setError('Selectionne au moins un agent'); return; }
    setSaving(true);
    try {
      const input: CreateRoomInput = {
        name: name.trim(),
        memberAgentIds: selected,
        maxMessages,
        maxToolsPerTurn,
        ...(userName.trim() && { userName: userName.trim() }),
      };
      const detail = await api.post<WarRoomDetail>('/api/war-rooms', input);
      onCreated(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border w-full h-full sm:h-auto sm:max-w-lg sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Swords size={16} className="text-primary" />
            <h2 className="text-[14px] font-semibold text-foreground">Nouvelle War Room</h2>
          </div>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Nom</label>
            <input
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Debat sur l'architecture v2"
              autoFocus
            />
          </div>

          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Ton nom</label>
            <input
              className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
              value={userName}
              onChange={e => setUserName(e.target.value)}
              placeholder="User"
            />
          </div>

          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Participants</label>
            <p className="text-[10px] text-muted-foreground/40 mt-0.5">
              Ordre de parole = ordre de selection (round-robin apres toi)
            </p>
            <div className="mt-2 space-y-1 max-h-48 overflow-y-auto border border-border rounded-lg p-2">
              {agents.map(a => {
                const idx = selected.indexOf(a.id);
                const isSelected = idx >= 0;
                return (
                  <button
                    key={a.id}
                    onClick={() => toggle(a.id)}
                    className={clsx(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors',
                      isSelected ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-secondary/50',
                    )}
                  >
                    <div className={clsx(
                      'w-4 h-4 rounded border flex items-center justify-center text-[9px] font-bold',
                      isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30',
                    )}>
                      {isSelected ? idx + 1 : ''}
                    </div>
                    <span className={colorForAgent(a.id)}>{a.name}</span>
                    <span className="text-[10px] text-muted-foreground/40 ml-auto">{a.id}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Max messages</label>
              <input
                type="number"
                min={10}
                max={2000}
                className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
                value={maxMessages}
                onChange={e => setMaxMessages(Math.max(10, Math.min(2000, parseInt(e.target.value) || 200)))}
              />
            </div>
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Max tools / tour</label>
              <input
                type="number"
                min={0}
                max={20}
                className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
                value={maxToolsPerTurn}
                onChange={e => setMaxToolsPerTurn(Math.max(0, Math.min(20, parseInt(e.target.value) || 5)))}
              />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border bg-card/50">
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
            {saving ? 'Creation...' : 'Ouvrir la war room'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Room list view (default landing) ─────────────────────────
function RoomsList({ rooms, onOpen, onCreate }: {
  rooms: WarRoom[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const open = rooms.filter(r => r.status === 'open');
  const closed = rooms.filter(r => r.status !== 'open');

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 sm:px-6 py-4 border-b border-border bg-card shrink-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Swords size={20} /> War Room
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Brainstorm multi-agents dans une session isolee. Round-robin, pass individuel, compact + archive a la fermeture.
            </p>
          </div>
          <button
            onClick={onCreate}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
          >
            <Plus size={14} /> Nouvelle war room
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-6">
        {open.length > 0 && (
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">Ouvertes</h2>
            <div className="space-y-2">
              {open.map(r => (
                <button
                  key={r.id}
                  onClick={() => onOpen(r.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-primary/30 rounded-xl hover:border-primary/60 transition-colors text-left"
                >
                  <Swords size={16} className="text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-foreground truncate">{r.name}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <p className="text-[11px] text-muted-foreground/50 mt-0.5">
                      Creee le {formatDate(r.createdAt)} · cap {r.maxMessages} msgs · {r.maxToolsPerTurn} tools/tour
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {closed.length > 0 && (
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">Archivees</h2>
            <div className="space-y-2">
              {closed.map(r => (
                <button
                  key={r.id}
                  onClick={() => onOpen(r.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-border/40 rounded-xl hover:border-border transition-colors text-left"
                >
                  <FileText size={14} className="text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground/80 truncate">{r.name}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <p className="text-[11px] text-muted-foreground/40 mt-0.5">
                      Fermee le {formatDate(r.closedAt)} {r.archivePath ? `· archive: ${r.archivePath.split(/[\\/]/).pop()}` : ''}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {rooms.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <Swords size={40} className="text-muted-foreground/15" />
            <p className="text-sm text-muted-foreground/40">Aucune war room</p>
            <button
              onClick={onCreate}
              className="text-xs text-primary hover:text-primary/80 transition-colors"
            >
              + Creer la premiere
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Active room view ─────────────────────────────────────────
function RoomView({ roomId, onExit }: { roomId: string; onExit: () => void }) {
  const isMobile = useIsMobile();
  const [membersOpen, setMembersOpen] = useState(false);
  const [detail, setDetail] = useState<WarRoomDetail | null>(null);
  const [messages, setMessages] = useState<WarRoomMessage[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [input, setInput] = useState('');
  const [posting, setPosting] = useState(false);
  const [autoPass, setAutoPass] = useState(false);
  const [closing, setClosing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([
        api.get<WarRoomDetail>(`/api/war-rooms/${roomId}`),
        api.get<WarRoomMessage[]>(`/api/war-rooms/${roomId}/messages?limit=500`),
      ]);
      setDetail(d);
      setMessages(m);
    } catch (err) {
      console.error('Failed to fetch room:', err);
    }
  }, [roomId]);

  useEffect(() => {
    refresh();
    api.get<Record<string, { identity: { id: string; name: string } }>>('/api/agents')
      .then(data => {
        const map: Record<string, AgentInfo> = {};
        for (const a of Object.values(data)) {
          map[a.identity.id] = { id: a.identity.id, name: a.identity.name };
        }
        setAgents(map);
      })
      .catch(() => {});
  }, [refresh]);

  // Track which agent is actively thinking (from WS events, not inferred from currentSpeaker)
  const [wsThinkingAgent, setWsThinkingAgent] = useState<string | null>(null);

  // WS subscription
  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsServerMessage) => {
      if ('roomId' in msg && msg.roomId !== roomId) return;
      if (msg.type === 'war-room.message') {
        setMessages(prev => {
          if (prev.some(m => m.id === msg.message.id)) return prev;
          return [...prev, msg.message];
        });
        setDetail(prev => prev ? { ...prev, messageCount: prev.messageCount + 1 } : prev);
      } else if (msg.type === 'war-room.turn') {
        setDetail(prev => prev ? { ...prev, turnIndex: msg.turnIndex, currentSpeaker: msg.speaker } : prev);
        // Reset thinking state on turn change
        setWsThinkingAgent(null);
      } else if (msg.type === 'war-room.agent.thinking') {
        setWsThinkingAgent(msg.agentId);
      } else if (msg.type === 'war-room.agent.done') {
        setWsThinkingAgent(null);
      } else if (msg.type === 'war-room.closed' || msg.type === 'war-room.status') {
        setWsThinkingAgent(null);
        refresh();
      }
    });
    return unsub;
  }, [roomId, refresh]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Auto-pass: when turn returns to the user AND auto-pass is on, skip automatically
  useEffect(() => {
    if (!autoPass || !detail || detail.status !== 'open') return;
    if (detail.currentSpeaker !== 'user') return;
    // Fire skip after a tiny delay so the WS event ordering stabilises
    const t = setTimeout(() => {
      api.post(`/api/war-rooms/${roomId}/skip`).catch(err => console.warn('auto-skip failed', err));
    }, 150);
    return () => clearTimeout(t);
  }, [autoPass, detail, roomId]);

  const send = async () => {
    if (!input.trim() || posting || !detail) return;
    setPosting(true);
    try {
      await api.post(`/api/war-rooms/${roomId}/post`, { content: input.trim() });
      setInput('');
      // User submitting = implicit exit from auto-pass mode
      if (autoPass) setAutoPass(false);
    } catch (err) {
      console.error('post failed:', err);
    } finally {
      setPosting(false);
    }
  };

  const skipMyTurn = async () => {
    try {
      await api.post(`/api/war-rooms/${roomId}/skip`);
    } catch (err) {
      console.error('skip failed:', err);
    }
  };

  const close = async () => {
    if (!confirm('Fermer la war room ? Cela genere un resume, archive la conversation et supprime les sessions des agents.')) return;
    setClosing(true);
    try {
      await api.post(`/api/war-rooms/${roomId}/close`);
      await refresh();
    } catch (err) {
      console.error('close failed:', err);
    } finally {
      setClosing(false);
    }
  };

  const abort = async () => {
    try {
      await api.post(`/api/war-rooms/${roomId}/abort`);
    } catch (err) {
      console.error('abort failed:', err);
    }
  };

  const sortedMembers = useMemo(() => {
    if (!detail) return [];
    return [...detail.members].sort((a, b) => a.orderIndex - b.orderIndex);
  }, [detail]);

  if (!detail) {
    return <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Chargement...</div>;
  }

  const isOpen = detail.status === 'open';
  const isUserTurn = detail.currentSpeaker === 'user';
  // Prefer WS-based thinking state (precise), fall back to inferred from currentSpeaker
  const thinkingAgentId = wsThinkingAgent ?? (isOpen && !isUserTurn ? detail.currentSpeaker : null);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 sm:px-6 py-3 border-b border-border bg-card shrink-0 flex flex-wrap items-center gap-2 sm:gap-3">
        <button onClick={onExit} className="text-muted-foreground hover:text-foreground" title="Retour a la liste">
          <ArrowLeft size={16} />
        </button>
        {isMobile && (
          <button
            onClick={() => setMembersOpen(o => !o)}
            className="text-muted-foreground hover:text-foreground p-1"
            title="Membres"
          >
            {membersOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        )}
        <Swords size={16} className="text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[14px] font-semibold text-foreground truncate">{detail.name}</h1>
            <StatusBadge status={detail.status} />
            <span className={clsx(
              'text-[11px] font-mono hidden sm:inline',
              detail.messageCount >= detail.maxMessages * 0.95 ? 'text-destructive font-semibold' :
              detail.messageCount >= detail.maxMessages * 0.80 ? 'text-theme-orange' :
              'text-muted-foreground/50',
            )}>
              {detail.messageCount}/{detail.maxMessages}
            </span>
          </div>
        </div>
        {isOpen && (
          <div className="flex items-center gap-1">
            <button
              onClick={abort}
              className="flex items-center gap-1 px-2 sm:px-3 py-1.5 text-xs font-medium rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
              title="Arreter le tour en cours"
            >
              <Square size={12} /> <span className="hidden sm:inline">Stop</span>
            </button>
            <button
              onClick={close}
              disabled={closing}
              className="flex items-center gap-1 px-2 sm:px-3 py-1.5 text-xs font-medium rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
            >
              <DoorClosed size={12} /> <span className="hidden sm:inline">{closing ? 'Fermeture...' : 'Fermer'}</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 flex min-h-0 relative">
        {/* Members sidebar -- overlay on mobile */}
        {isMobile && membersOpen && (
          <div className="fixed inset-0 z-30 bg-black/40" onClick={() => setMembersOpen(false)} />
        )}
        {(!isMobile || membersOpen) && (
        <div className={clsx(
          'border-r border-border bg-card/50 shrink-0 overflow-y-auto',
          isMobile
            ? 'fixed inset-y-0 left-0 z-40 w-64 bg-card animate-[slide-in-left_200ms_ease-out]'
            : 'w-56',
        )}>
          <div className="p-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 flex items-center gap-1">
              <Users size={11} /> Tour de parole
            </h3>
            <div className="space-y-1">
              {/* User slot */}
              <div className={clsx(
                'flex items-center gap-2 px-2 py-1.5 rounded text-sm',
                isUserTurn && isOpen ? 'bg-primary/15 text-foreground' : 'text-muted-foreground',
              )}>
                <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[9px] font-bold text-primary">
                  G
                </div>
                <span className="flex-1 truncate">You</span>
                {isUserTurn && isOpen && <span className="text-[9px] text-primary">tour</span>}
              </div>
              {sortedMembers.map(m => {
                const name = agents[m.agentId]?.name ?? m.agentId;
                const isActive = detail.currentSpeaker === m.agentId && isOpen;
                const isThinking = thinkingAgentId === m.agentId;
                return (
                  <div key={m.agentId} className={clsx(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-sm',
                    isActive ? 'bg-primary/15 text-foreground' : 'text-muted-foreground',
                  )}>
                    <div className={clsx(
                      'w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold',
                      isActive ? 'bg-primary/30' : 'bg-muted',
                      colorForAgent(m.agentId),
                    )}>
                      {m.orderIndex}
                    </div>
                    <span className={clsx('flex-1 truncate', colorForAgent(m.agentId))}>{name}</span>
                    {isThinking && <Loader size={10} className="animate-spin text-primary shrink-0" />}
                  </div>
                );
              })}
            </div>
          </div>

          {detail.status !== 'open' && detail.archivePath && (
            <div className="p-3 border-t border-border">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 flex items-center gap-1">
                <FileText size={11} /> Archive
              </h3>
              <p className="text-[10px] text-muted-foreground/50 break-all font-mono">
                {detail.archivePath}
              </p>
            </div>
          )}
        </div>
        )}

        {/* Messages + composer */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-center text-muted-foreground/40">
                <Swords size={32} className="opacity-30" />
                <p className="text-sm">La war room t'attend — lance la discussion</p>
              </div>
            )}
            {messages.map(msg => <MessageBubble key={msg.id} msg={msg} agents={agents} />)}
            {thinkingAgentId && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground/60 px-3">
                <Loader size={11} className="animate-spin" />
                <span className={colorForAgent(thinkingAgentId)}>{agents[thinkingAgentId]?.name ?? thinkingAgentId}</span>
                <span>reflechit...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {isOpen && (
            <div className="border-t border-border bg-card/50 px-3 sm:px-4 py-3 shrink-0">
              <div className="flex gap-2 items-end">
                <textarea
                  className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground min-h-[40px] max-h-32 resize-y focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && isUserTurn) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    autoPass
                      ? '(Auto-pass ON — les agents parlent entre eux. Tape pour interrompre)'
                      : isUserTurn
                        ? 'Ton message... (Entree pour envoyer, Shift+Entree pour retour ligne)'
                        : `En attente de ${detail.currentSpeaker}...`
                  }
                  disabled={!isUserTurn && !autoPass}
                />
                <div className="flex flex-col gap-1">
                  <button
                    onClick={send}
                    disabled={!input.trim() || posting || !isUserTurn}
                    className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {posting ? '...' : 'Envoyer'}
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={skipMyTurn}
                  disabled={!isUserTurn}
                  className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                >
                  <SkipForward size={11} /> Passer mon tour
                </button>
                <button
                  onClick={() => setAutoPass(!autoPass)}
                  className={clsx(
                    'flex items-center gap-1 px-3 py-1.5 text-[11px] rounded transition-colors',
                    autoPass
                      ? 'bg-theme-orange/15 text-theme-orange hover:bg-theme-orange/25'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Clock size={11} /> {autoPass ? 'Auto-pass ON' : 'Auto-pass OFF'}
                </button>
                {!isUserTurn && !autoPass && (
                  <span className="text-[10px] text-muted-foreground/50 ml-auto">
                    Attends le retour de ton tour, ou active auto-pass
                  </span>
                )}
              </div>
            </div>
          )}

          {detail.status === 'closed' && detail.summary && (
            <div className="border-t border-border bg-card/30 px-3 sm:px-6 py-4 shrink-0 max-h-64 overflow-y-auto">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 flex items-center gap-1">
                <FileText size={11} /> Resume genere
              </h3>
              <pre className="whitespace-pre-wrap text-[11px] text-foreground/70 font-sans">{detail.summary}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Message bubble ───────────────────────────────────────────
function MessageBubble({ msg, agents }: { msg: WarRoomMessage; agents: Record<string, AgentInfo> }) {
  if (msg.authorKind === 'system') {
    return (
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground/50 italic text-center">
        {msg.content} · {formatTime(msg.createdAt)}
      </div>
    );
  }
  if (msg.passed) {
    const name = msg.authorAgentId ? (agents[msg.authorAgentId]?.name ?? msg.authorAgentId) : '?';
    return (
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/40 italic px-3">
        <span className={colorForAgent(msg.authorAgentId ?? '')}>{name}</span>
        <span>passe son tour · {formatTime(msg.createdAt)}</span>
      </div>
    );
  }
  const isUser = msg.authorKind === 'user';
  const authorName = isUser ? 'You' : (agents[msg.authorAgentId ?? '']?.name ?? msg.authorAgentId ?? '?');
  const colorClass = isUser ? 'text-primary' : colorForAgent(msg.authorAgentId ?? '');
  return (
    <div className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={clsx('max-w-[75%]', isUser ? 'text-right' : 'text-left')}>
        <div className="flex items-center gap-2 mb-0.5 px-1">
          <span className={clsx('text-[10px] font-semibold', colorClass)}>{authorName}</span>
          <span className="text-[9px] text-muted-foreground/40">{formatTime(msg.createdAt)}</span>
        </div>
        <div className={clsx(
          'px-3 py-2 rounded-xl text-[13px] text-foreground/90 whitespace-pre-wrap break-words',
          isUser ? 'bg-primary/10 border border-primary/20' : 'bg-secondary border border-border/40',
        )}>
          {msg.content}
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────
export default function WarRoomPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<WarRoom[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchRooms = useCallback(async () => {
    try {
      const data = await api.get<WarRoom[]>('/api/war-rooms');
      setRooms(data);
    } catch (err) {
      console.error('Failed to fetch rooms:', err);
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
    fetchRooms();
    fetchAgents();
  }, [fetchRooms, fetchAgents]);

  useEffect(() => {
    const unsub = wsClient.subscribe((msg: WsServerMessage) => {
      if (msg.type === 'war-room.rooms.updated' || msg.type === 'war-room.closed') {
        fetchRooms();
      }
    });
    return unsub;
  }, [fetchRooms]);

  if (loading) {
    return <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Chargement...</div>;
  }

  if (id) {
    return <RoomView roomId={id} onExit={() => navigate('/war-room')} />;
  }

  return (
    <>
      <RoomsList
        rooms={rooms}
        onOpen={(roomId) => navigate(`/war-room/${roomId}`)}
        onCreate={() => setShowCreate(true)}
      />
      {showCreate && (
        <CreateRoomModal
          agents={agents}
          onCreated={(detail) => {
            setShowCreate(false);
            fetchRooms();
            navigate(`/war-room/${detail.id}`);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </>
  );
}
