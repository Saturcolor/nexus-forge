import { useState, useEffect, useCallback, useRef } from 'react';
import { useAgents } from '../hooks/useAgents';
import { useSessions } from '../hooks/useSessions';
import { useChat, type MessageImage } from '../hooks/useChat';
import { useSessionViewing } from '../hooks/useSessionViewing';
import { useAgentStats } from '../hooks/useAgentStats';
import { wsClient } from '../lib/ws';
import { api } from '../lib/api';
import AgentSelector from '../components/AgentSelector';
import MessageList from '../components/MessageList';
import InputBar, { type AttachedFile } from '../components/InputBar';
import { SkillActionsBar } from '../components/SkillActionsBar';
import ContextGauge from '../components/ContextGauge';
import { useRunTimer } from '../hooks/useRunTimer';
import { useSkillActions } from '../hooks/useSkillActions';
import { Users } from 'lucide-react';
import type { ProviderOption } from './agents/types';
import useIsMobile from '../hooks/useIsMobile';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function SortableSessionTab({
  id,
  label,
  active,
  onClick,
  reorderEnabled,
}: {
  id: string;
  label: string;
  active: boolean;
  onClick: () => void;
  reorderEnabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !reorderEnabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };
  return (
    <button
      ref={setNodeRef}
      style={style}
      onClick={onClick}
      {...attributes}
      {...listeners}
      className={`px-2.5 py-1 text-[11px] font-medium rounded-lg transition-colors shrink-0 ${reorderEnabled ? 'cursor-grab active:cursor-grabbing' : ''} select-none touch-none ${
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
      } ${isDragging ? 'shadow-md' : ''}`}
    >
      {label}
    </button>
  );
}

/** Vision-capable image extensions + their MIME types */
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function getImageMime(name: string): string | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return IMAGE_MIME[ext] ?? null;
}

/** Read a File as a base64 data URL */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ChatPage() {
  const isMobile = useIsMobile();
  const defaultPanelOpen = !window.matchMedia('(max-width: 768px)').matches;

  const [agentPanelOpenState, setAgentPanelOpenState] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('mm-agent-panel-open');
      if (stored !== null) return stored === '1';
    } catch { /* ignore */ }
    return defaultPanelOpen;
  });
  const [selectedAgent, setSelectedAgentState] = useState<string | null>(() => {
    try { return localStorage.getItem('mm-selected-agent'); } catch { return null; }
  });
  // Skill action bar collapsed/expanded — same persistence shape as the others
  // (localStorage for the boot flicker, server ui-prefs for cross-device sync).
  const [skillbarCollapsedState, setSkillbarCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem('mm-skillbar-collapsed') === '1'; }
    catch { return false; }
  });
  const [agentOrder, setAgentOrderState] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('mm-agent-order');
      return raw ? JSON.parse(raw) as string[] : [];
    } catch { return []; }
  });

  // Load persisted UI prefs from server on mount (overrides localStorage defaults)
  const uiPrefsLoaded = useRef(false);
  useEffect(() => {
    if (uiPrefsLoaded.current) return;
    uiPrefsLoaded.current = true;
    api.get<{ selectedAgent?: string; agentPanelOpen?: boolean; skillbarCollapsed?: boolean; agentOrder?: string[] }>('/api/agents/ui-prefs')
      .then(prefs => {
        if (prefs.selectedAgent) setSelectedAgentState(prefs.selectedAgent);
        if (prefs.agentPanelOpen !== undefined) setAgentPanelOpenState(prefs.agentPanelOpen);
        if (prefs.skillbarCollapsed !== undefined) setSkillbarCollapsedState(prefs.skillbarCollapsed);
        if (Array.isArray(prefs.agentOrder)) setAgentOrderState(prefs.agentOrder);
      })
      .catch(() => {});
  }, []);

  const saveUiPrefs = useCallback((patch: Record<string, unknown>) => {
    api.put('/api/agents/ui-prefs', patch).catch(() => {});
  }, []);

  const setAgentPanelOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((v) => {
    setAgentPanelOpenState((prev) => {
      const next = typeof v === 'function' ? (v as (p: boolean) => boolean)(prev) : v;
      try { localStorage.setItem('mm-agent-panel-open', next ? '1' : '0'); } catch { /* ignore */ }
      saveUiPrefs({ agentPanelOpen: next });
      return next;
    });
  }, [saveUiPrefs]);
  const agentPanelOpen = agentPanelOpenState;

  const toggleSkillbarCollapsed = useCallback(() => {
    setSkillbarCollapsedState(prev => {
      const next = !prev;
      try { localStorage.setItem('mm-skillbar-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      saveUiPrefs({ skillbarCollapsed: next });
      return next;
    });
  }, [saveUiPrefs]);
  const { agents: allAgents, loading: agentsLoading } = useAgents();
  const visibleAgents = allAgents.filter(a => a.enabled !== false && a.kind !== 'subagent');
  // Apply persisted order: known-ordered first, then any new agents appended at the end.
  const agents = (() => {
    if (agentOrder.length === 0) return visibleAgents;
    const byId = new Map(visibleAgents.map(a => [a.identity.id, a]));
    const ordered = agentOrder.map(id => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    const orderedIds = new Set(ordered.map(a => a.identity.id));
    const rest = visibleAgents.filter(a => !orderedIds.has(a.identity.id));
    return [...ordered, ...rest];
  })();
  const setSelectedAgent = useCallback((id: string | null) => {
    setSelectedAgentState(id);
    try { if (id) localStorage.setItem('mm-selected-agent', id); } catch { /* ignore */ }
    if (id) saveUiPrefs({ selectedAgent: id });
  }, [saveUiPrefs]);
  const setAgentOrder = useCallback((ids: string[]) => {
    setAgentOrderState(ids);
    try { localStorage.setItem('mm-agent-order', JSON.stringify(ids)); } catch { /* ignore */ }
    saveUiPrefs({ agentOrder: ids });
  }, [saveUiPrefs]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showThink, setShowThink] = useState(true);
  const [showTools, setShowTools] = useState(true);
  // Replier les rows dupliquées send_to_user (📤) quand une réponse finale suit.
  // Persisté localStorage (pas de sync serveur — préférence d'affichage locale).
  const [collapseDelivered, setCollapseDeliveredState] = useState<boolean>(() => {
    try { return localStorage.getItem('mm-collapse-delivered') !== '0'; }
    catch { return true; }
  });
  const toggleCollapseDelivered = useCallback(() => {
    setCollapseDeliveredState(prev => {
      const next = !prev;
      try { localStorage.setItem('mm-collapse-delivered', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [gaugeKey, setGaugeKey] = useState(0);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);

  // Auto-unload-on-switch flag (from /api/config defaults). Default true for BC.
  // Fetched on mount, togglable via the Power/PowerOff button near the model picker.
  const [autoUnloadOnSwitch, setAutoUnloadOnSwitch] = useState(true);
  useEffect(() => {
    api.get<{ defaults?: { autoUnloadOnSwitch?: boolean } }>('/api/config')
      .then(cfg => setAutoUnloadOnSwitch(cfg.defaults?.autoUnloadOnSwitch !== false))
      .catch(() => { /* ignore — stays at default true */ });
  }, []);
  const toggleAutoUnload = useCallback(async () => {
    const next = !autoUnloadOnSwitch;
    setAutoUnloadOnSwitch(next); // optimistic
    try {
      await api.put('/api/config', { defaults: { autoUnloadOnSwitch: next } });
    } catch {
      setAutoUnloadOnSwitch(!next); // rollback
    }
  }, [autoUnloadOnSwitch]);

  // Model picker — list of providers fetched once; the picker popup lives inside ContextGauge
  const [modelPickerProviders, setModelPickerProviders] = useState<ProviderOption[]>([]);

  const { sessions, refetch: refetchSessions } = useSessions(selectedAgent);
  const { messages, streamingContent, isStreaming, streamingError, agentState, toolEvents, sessionOptions, sendMessage, abort, warmCache } = useChat(sessionId, selectedAgent);
  // Présence "regarde l'écran" → presence dedup du push (backend hasSessionViewers).
  useSessionViewing(sessionId);
  const { actionsBySkill, executeAction } = useSkillActions();

  // Auto-select agent: keep persisted choice if still enabled, otherwise fall back to the first one
  useEffect(() => {
    if (agents.length === 0) return;
    if (selectedAgent && agents.some(a => a.identity.id === selectedAgent)) return;
    setSelectedAgent(agents[0].identity.id);
  }, [agents, selectedAgent, setSelectedAgent]);

  // Mode session unifiée de l'agent sélectionné (booléen stable → safe en dep d'effet).
  const selectedAgentUnified = agents.find(a => a.identity.id === selectedAgent)?.unifiedSession ?? false;

  // Auto-select/create session when agent changes — respect persisted tab order
  useEffect(() => {
    if (!selectedAgent) return;
    let cancelled = false;
    // Mode unifié : on pointe DIRECT la session canonique `{agent}-unified` (subscribe + send).
    // Sinon le client écouterait `-web` alors que le serveur émet les deltas sur `-unified`
    // (canonicalisation serveur) → pas de streaming live. Same applies to native mobile clients.
    if (selectedAgentUnified) {
      setSessionId(`${selectedAgent}-unified`);
      return;
    }
    const fallback = `${selectedAgent}-web`;
    // Guard `cancelled` : quand le flag unifié bascule, l'effet re-run et fixe `-unified` ;
    // sans ce guard, le tab-order fetch legacy encore en vol écraserait l'id unifié avec un id
    // de session legacy au moment où il résout → client abonné au mauvais id, streaming perdu.
    api.get<string[]>(`/api/agents/${selectedAgent}/tab-order`)
      .then(order => {
        if (cancelled) return;
        if (Array.isArray(order) && order.length > 0) {
          setSessionId(order[0]);
        } else {
          setSessionId(fallback);
        }
      })
      .catch(() => { if (!cancelled) setSessionId(fallback); });
    return () => { cancelled = true; };
  }, [selectedAgent, selectedAgentUnified]);

  // Connect WebSocket. The socket is an app-wide singleton shared by always-on features
  // (StatusBar, proactive alerts, agent live state, War Room, Scheduler...). connect()
  // ref-counts consumers; on unmount we release() rather than disconnect() so leaving the
  // Chat page does NOT tear down the connection the rest of the app still relies on.
  useEffect(() => {
    wsClient.connect();
    return () => wsClient.release();
  }, []);

  // Clear attached files when switching sessions
  useEffect(() => {
    setAttachedFiles([]);
  }, [sessionId]);

  // Sync showTools/showThink with session options when they change (e.g. via /tools hide)
  useEffect(() => {
    if (sessionOptions.toolsHidden !== undefined) {
      setShowTools(!sessionOptions.toolsHidden);
    }
  }, [sessionOptions.toolsHidden]);

  // Refresh gauge when streaming completes
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      setGaugeKey(k => k + 1);
      setCompacting(false); // ensure reset even if timeout was slow
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Load providers once (for the picker dropdown inside the gauge)
  useEffect(() => {
    api.get<ProviderOption[]>('/api/providers').then(ps => {
      setModelPickerProviders(ps);
    }).catch(() => {});
  }, []);

  const selectChatModel = useCallback(async (modelId: string) => {
    if (!selectedAgent || !sessionId) return;
    // Best-effort unload of the current model before switching — skipped when the user has
    // turned off autoUnloadOnSwitch (typical when a fleet of agents shares the same model).
    // The server also enforces the flag, so this just saves a round-trip.
    if (autoUnloadOnSwitch) {
      try {
        await api.post(`/api/agents/${selectedAgent}/unload`, {});
      } catch { /* ignore */ }
    }
    // Update agent config directly (persistent change, not a session override)
    try {
      await api.put(`/api/agents/${selectedAgent}/config`, { model: modelId });
    } catch { /* ignore */ }
    // Clear any stale session model override so the new agent model takes effect
    if (sessionOptions.modelOverride) {
      sendMessage(selectedAgent, '/model off');
    }
    setTimeout(() => setGaugeKey(k => k + 1), 500);
  }, [selectedAgent, sessionId, sessionOptions.modelOverride, sendMessage, autoUnloadOnSwitch]);

  const handleSend = useCallback(
    (content: string, images?: MessageImage[]) => {
      if (selectedAgent && sessionId) {
        sendMessage(selectedAgent, content, images);
        setAttachedFiles([]); // clear after send
        setTimeout(() => setGaugeKey(k => k + 1), 1500);
      }
    },
    [selectedAgent, sessionId, sendMessage],
  );

  const handleAbort = useCallback(() => {
    if (selectedAgent) abort(selectedAgent);
  }, [selectedAgent, abort]);

  const handleWarmCache = useCallback(() => {
    if (selectedAgent) warmCache(selectedAgent);
  }, [selectedAgent, warmCache]);

  /** Send the /compact directive — the backend handles summarization + reset */
  const handleCompact = useCallback(async () => {
    if (!selectedAgent || !sessionId || isStreaming || compacting) return;
    if (!confirm('Compacter le contexte ? La conversation sera sauvegardée en archive et le contexte sera réinitialisé avec un résumé.')) return;
    setCompacting(true);
    try {
      sendMessage(selectedAgent, '/compact');
      // Gauge will refresh when streaming ends
    } finally {
      // Reset after a short delay to let the message flow
      setTimeout(() => setCompacting(false), 3000);
    }
  }, [selectedAgent, sessionId, isStreaming, compacting, sendMessage]);

  /** Handle new files dropped/selected — images are base64-encoded locally, every other file is uploaded to the server */
  const handleFilesAttached = useCallback(async (files: File[]) => {
    if (!selectedAgent) return;
    setUploadError(null);

    const newAttached: AttachedFile[] = [];

    for (const file of files) {
      const mimeType = getImageMime(file.name);
      if (mimeType) {
        // Vision image — read as base64 data URL directly in the browser (no server upload)
        try {
          const dataUrl = await readFileAsDataUrl(file);
          newAttached.push({
            name: file.name,
            size: file.size,
            isText: false,
            isImage: true,
            mimeType,
            dataUrl,
          });
        } catch (err) {
          setUploadError(`Lecture image échouée : ${file.name}`);
        }
      } else {
        // Always upload non-image files to the server so the agent has a disk path
        // (read_file / bash). Backend extracts inline content for text files ≤500KB.
        try {
          const formData = new FormData();
          formData.append('file', file);
          const result = await api.upload<{
            ok: boolean;
            files: Array<{ originalName: string; savedPath: string; relativePath: string; size: number; isText: boolean; content?: string }>;
          }>(`/api/upload/${selectedAgent}`, formData);

          for (const uploaded of result.files) {
            newAttached.push({
              name: uploaded.originalName,
              size: uploaded.size,
              isText: uploaded.isText,
              content: uploaded.content,
              relativePath: uploaded.relativePath,
              absolutePath: uploaded.savedPath,
            });
          }
        } catch (err) {
          setUploadError(`Upload échoué : ${file.name} — ${err instanceof Error ? err.message : 'erreur réseau'}`);
        }
      }
    }

    setAttachedFiles(prev => [...prev, ...newAttached]);
  }, [selectedAgent]);

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleThinkLevel = useCallback((level: 'off' | 'low' | 'med' | 'high') => {
    if (selectedAgent && sessionId) sendMessage(selectedAgent, `/think ${level}`);
  }, [selectedAgent, sessionId, sendMessage]);

  const currentAgent = agents.find(a => a.identity.id === selectedAgent);
  // Single source of truth: agent-level thinkBudget (set via /think, Telegram menu, or agent config UI).
  const thinkLevel: 'off' | 'low' | 'med' | 'high' = (() => {
    const v = currentAgent?.thinkBudget ?? 'off';
    return v === 'medium' ? 'med' : v;
  })();
  const loraScales = currentAgent?.loraScales;
  const handleSetLoraScales = useCallback((scales: number[] | undefined) => {
    if (!selectedAgent) return;
    // null vide / array vide → backend purge la clé YAML.
    api.put(`/api/agents/${selectedAgent}/config`, { loraScales: scales ?? null }).catch(() => {});
  }, [selectedAgent]);

  const providerStats = useAgentStats(selectedAgent, sessionOptions.modelOverride);
  const { elapsedMs, isRunning } = useRunTimer(agentState);

  // Session tabs: web + mobile + telegram sessions, with drag-to-reorder (order persisted server-side per agent).
  // Mode unifié : un seul onglet « Cross-plateforme » (`{agent}-unified`) — web/mobile/TG y convergent.
  const buildDefaultTabs = useCallback((agentId: string) => {
    if (selectedAgentUnified) {
      return [{ id: `${agentId}-unified`, label: 'Cross-plateforme', source: 'web' as const }];
    }
    return [
      { id: `${agentId}-web`, label: 'Web', source: 'web' as const },
      ...sessions
        .filter(s => s.id.endsWith('-mobile'))
        .map(s => ({ id: s.id, label: 'Mobile', source: 'mobile' as const })),
      ...sessions
        .filter(s => s.id.includes('-tg-'))
        .map(s => ({ id: s.id, label: `TG ${s.id.split('-tg-')[1]}`, source: 'telegram' as const })),
    ];
  }, [sessions, selectedAgentUnified]);

  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [serverTabOrder, setServerTabOrder] = useState<string[] | null>(null);

  // Load persisted tab order from server when agent changes
  useEffect(() => {
    if (!selectedAgent) return;
    let cancelled = false;
    setServerTabOrder(null);
    api.get<string[]>(`/api/agents/${selectedAgent}/tab-order`)
      .then(order => { if (!cancelled) setServerTabOrder(order); })
      .catch(() => { if (!cancelled) setServerTabOrder([]); });
    return () => { cancelled = true; };
  }, [selectedAgent]);

  // Sync tab order when agent, sessions, or server-persisted order change
  useEffect(() => {
    if (!selectedAgent || serverTabOrder === null) return;
    const defaults = buildDefaultTabs(selectedAgent);
    if (serverTabOrder.length > 0) {
      const known = new Set(serverTabOrder);
      const merged = [...serverTabOrder.filter((id: string) => defaults.some(t => t.id === id)), ...defaults.filter(t => !known.has(t.id)).map(t => t.id)];
      setTabOrder(merged);
    } else {
      setTabOrder(defaults.map(t => t.id));
    }
  }, [selectedAgent, sessions, buildDefaultTabs, serverTabOrder]);

  const allSessions = (() => {
    if (!selectedAgent) return [];
    const defaults = buildDefaultTabs(selectedAgent);
    const byId = Object.fromEntries(defaults.map(t => [t.id, t]));
    return tabOrder.map(id => byId[id]).filter(Boolean);
  })();

  const tabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );
  const handleSessionTabDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedAgent) return;
    const oldIndex = tabOrder.indexOf(String(active.id));
    const newIndex = tabOrder.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(tabOrder, oldIndex, newIndex);
    setTabOrder(next);
    setServerTabOrder(next);
    api.put(`/api/agents/${selectedAgent}/tab-order`, next).catch(() => {});
  };

  const handleAgentSelect = useCallback((id: string) => {
    setSelectedAgent(id);
    if (isMobile) setAgentPanelOpen(false);
  }, [isMobile, setSelectedAgent]);

  return (
    <div className="flex h-full">
      {/* Desktop: collapsible column that pushes chat content */}
      {!isMobile && agentPanelOpen && (
        <div className="shrink-0 animate-[slide-in-left_180ms_ease-out]">
          <AgentSelector agents={agents} selected={selectedAgent} onSelect={setSelectedAgent} onReorder={setAgentOrder} />
        </div>
      )}

      {/* Mobile: overlay panel */}
      {isMobile && agentPanelOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setAgentPanelOpen(false)} />
          <div className="fixed inset-y-0 left-0 z-50 w-64 animate-[slide-in-left_200ms_ease-out]">
            <AgentSelector agents={agents} selected={selectedAgent} onSelect={handleAgentSelect} onReorder={setAgentOrder} />
          </div>
        </>
      )}

      <div className="flex-1 min-w-0 flex flex-col bg-background">
        {/* Toolbar */}
        {selectedAgent && (
          <div className="flex flex-wrap items-center gap-1 px-2 md:px-3 border-b border-border bg-card min-h-[44px]">

            {/* Agent panel toggle (desktop + mobile) */}
            <button
              onClick={() => setAgentPanelOpen(o => !o)}
              className={`p-1.5 rounded-lg transition-colors ${
                agentPanelOpen
                  ? 'text-foreground bg-secondary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
              title={agentPanelOpen ? 'Masquer la liste des agents' : 'Afficher la liste des agents'}
            >
              <Users size={16} />
            </button>

            {/* Agent identity */}
            <span className="text-base leading-none mr-1">{currentAgent?.identity.emoji}</span>
            <span className="text-sm font-semibold text-foreground truncate max-w-[120px] md:max-w-none">{currentAgent?.identity.name}</span>

            <div className="h-4 w-px bg-border mx-1 md:mx-2 hidden sm:block" />

            {/* Session tabs (long-press to reorder) */}
            <DndContext sensors={tabSensors} collisionDetection={closestCenter} onDragEnd={handleSessionTabDragEnd}>
              <SortableContext items={allSessions.map(s => s.id)} strategy={horizontalListSortingStrategy}>
                <div className="flex items-center gap-1 overflow-x-auto">
                  {allSessions.map((s) => (
                    <SortableSessionTab
                      key={s.id}
                      id={s.id}
                      label={s.label}
                      active={sessionId === s.id}
                      onClick={() => setSessionId(s.id)}
                      reorderEnabled={allSessions.length > 1}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            <div className="flex-1" />

            {/* Session state badges -- hidden on mobile */}
            {sessionOptions.temperatureOverride !== undefined && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-secondary text-muted-foreground border border-border hidden sm:inline-flex">
                t={sessionOptions.temperatureOverride}
              </span>
            )}
            {sessionOptions.toolsDisabled && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-destructive/10 text-destructive border border-destructive/20 hidden sm:inline-flex">
                tools·off
              </span>
            )}
            {!sessionOptions.toolsDisabled && sessionOptions.toolsHidden && (
              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-secondary text-muted-foreground border border-border hidden sm:inline-flex">
                tools·hidden
              </span>
            )}

            {/* Gauge — now includes run chrono + throughput + model picker popup */}
            <ContextGauge
              sessionId={sessionId}
              refreshKey={gaugeKey}
              providerStats={providerStats}
              elapsedMs={elapsedMs}
              isRunning={isRunning}
              providers={modelPickerProviders}
              onSelectModel={sessionId ? selectChatModel : undefined}
            />

          </div>
        )}

        {/* Messages */}
        <MessageList
          key={sessionId ?? 'empty'}
          messages={messages}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
          streamingError={streamingError}
          toolEvents={toolEvents}
          agentState={agentState}
          agentEmoji={currentAgent?.identity.emoji}
          agentName={currentAgent?.identity.name}
          showThink={showThink}
          showTools={showTools}
          collapseDelivered={collapseDelivered}
        />

        {/* Skill action buttons — one chip per skill, click opens action picker */}
        {Object.keys(actionsBySkill).length > 0 && selectedAgent && sessionId && (
          <SkillActionsBar
            actionsBySkill={actionsBySkill}
            onExecute={(action, params) => {
              if (selectedAgent) executeAction(action, params, sendMessage, selectedAgent);
            }}
            disabled={isStreaming || !selectedAgent}
            collapsed={skillbarCollapsedState}
            onToggleCollapsed={toggleSkillbarCollapsed}
          />
        )}

        {/* Upload error */}
        {uploadError && (
          <div className="px-3 pb-1">
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs font-mono">
              <span>{uploadError}</span>
              <button onClick={() => setUploadError(null)} className="text-destructive/60 hover:text-destructive shrink-0">✕</button>
            </div>
          </div>
        )}

        {/* Input */}
        <InputBar
          onSend={handleSend}
          onAbort={handleAbort}
          isStreaming={isStreaming}
          disabled={!selectedAgent}
          agentState={agentState}
          sessionOptions={sessionOptions}
          onFilesAttached={handleFilesAttached}
          attachedFiles={attachedFiles}
          onRemoveFile={handleRemoveFile}
          onWarmCache={handleWarmCache}
          agentId={selectedAgent}
          thinkLevel={thinkLevel}
          onSetThinkLevel={handleThinkLevel}
          showThink={showThink}
          onToggleShowThink={() => setShowThink(v => !v)}
          showTools={showTools}
          onToggleShowTools={() => setShowTools(v => !v)}
          collapseDelivered={collapseDelivered}
          onToggleCollapseDelivered={toggleCollapseDelivered}
          onCompact={handleCompact}
          compacting={compacting}
          canCompact={!!sessionId && !isStreaming && !compacting}
          autoUnloadOnSwitch={autoUnloadOnSwitch}
          onToggleAutoUnload={() => void toggleAutoUnload()}
          loraScales={loraScales}
          onSetLoraScales={handleSetLoraScales}
        />
      </div>

    </div>
  );
}
