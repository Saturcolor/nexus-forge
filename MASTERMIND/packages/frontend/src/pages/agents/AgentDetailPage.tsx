import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAgents } from '../../hooks/useAgents';
import { api } from '../../lib/api';
import { wsClient } from '../../lib/ws';
import { RefreshCw, FolderOpen, Settings2, Brain, Zap, Trash2, ArrowLeft, Database, Activity, History } from 'lucide-react';

import type {
  Tab,
  AgentFull,
  SkillEntry,
  WorkspaceFile,
  BotOption,
  ProviderOption,
  SharedEntry,
  PromptSizeEstimate,
} from './types';

import { AgentFilesTab } from './AgentFilesTab';
import { AgentConfigTab } from './AgentConfigTab';
import { AgentSkillsTab, type SkillActionToolEntry } from './AgentSkillsTab';
import { AgentSharedTab } from './AgentSharedTab';
import { AgentPromptCacheTab } from './AgentPromptCacheTab';
import { AgentJobsTab } from './AgentJobsTab';
import { SandboxIndicator } from './SandboxIndicator';
import { SubAgentRunsTab } from '../sub-agents/SubAgentRunsTab';

export default function AgentDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: selectedAgent = '' } = useParams<{ id: string }>();
  const { agents, loading, refetch } = useAgents();
  const isSubAgentSection = location.pathname.startsWith('/sub-agents');
  const detailBasePath = isSubAgentSection ? '/sub-agents' : '/agents';
  const [tab, setTab] = useState<Tab>('config');

  // Files tab
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Config tab
  const [agentDetail, setAgentDetail] = useState<AgentFull | null>(null);
  const [configDraft, setConfigDraft] = useState<Partial<AgentFull>>({});
  const [savingStars, setSavingStars] = useState(false);
  const [promptSize, setPromptSize] = useState<PromptSizeEstimate | null>(null);

  // Workspace scan
  const [workspaceDirs, setWorkspaceDirs] = useState<string[]>([]);

  // Available bots (for botId selector)
  const [availableBots, setAvailableBots] = useState<BotOption[]>([]);

  // Model picker providers
  const [modelPickerProviders, setModelPickerProviders] = useState<ProviderOption[]>([]);

  // Reload identity
  const [reloading, setReloading] = useState(false);

  // Skills tab — favoris + granularité par action (AgentSkillsTab unifié main + sub).
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillActionTools, setSkillActionTools] = useState<SkillActionToolEntry[]>([]);

  // Shared memory tab
  const [sharedPath, setSharedPath] = useState('');
  const [sharedEntries, setSharedEntries] = useState<SharedEntry[]>([]);
  const [sharedSelectedFile, setSharedSelectedFile] = useState<string | null>(null);
  const [sharedFileContent, setSharedFileContent] = useState('');
  const [sharedSaving, setSharedSaving] = useState(false);
  const [sharedLoading, setSharedLoading] = useState(false);

  // Available codebase search index keys
  const [csIndexKeys, setCsIndexKeys] = useState<string[]>([]);

  useEffect(() => {
    api.get<string[]>('/api/agents/workspace/scan').then(setWorkspaceDirs).catch(() => {});
    api.get<BotOption[]>('/api/telegram').then(setAvailableBots).catch(() => {});
    api.get<ProviderOption[]>('/api/providers').then(setModelPickerProviders).catch(() => {});
    api.get<{ resolvedEmbedSources?: Record<string, string>; resolvedIndices?: Record<string, string>; resolvedDefaultDbPath?: string }>('/api/codebase-search/status')
      .then(s => {
        const keys = new Set<string>();
        if (s.resolvedDefaultDbPath) keys.add('default');
        Object.keys(s.resolvedIndices ?? {}).forEach(k => keys.add(k));
        Object.keys(s.resolvedEmbedSources ?? {}).forEach(k => keys.add(k));
        setCsIndexKeys([...keys]);
      })
      .catch(() => {});
  }, []);

  const loadSharedEntries = useCallback((path: string, options?: { resetSelection?: boolean }) => {
    const resetSelection = options?.resetSelection !== false;
    setSharedLoading(true);
    if (resetSelection) {
      setSharedSelectedFile(null);
      setSharedFileContent('');
    }
    api.get<SharedEntry[]>(`/api/memory/shared?path=${encodeURIComponent(path)}`)
      .then(entries => {
        setSharedEntries(entries.filter(e => e.isDir || e.name.endsWith('.md')));
      })
      .catch(() => setSharedEntries([]))
      .finally(() => setSharedLoading(false));
  }, []);

  useEffect(() => {
    if (tab === 'shared') {
      loadSharedEntries(sharedPath);
    }
  }, [tab, sharedPath, loadSharedEntries]);

  const refreshWorkspaceFiles = useCallback(async () => {
    if (!selectedAgent) return;
    const data = await api.get<WorkspaceFile[]>(`/api/agents/${selectedAgent}/files`);
    setFiles(Array.isArray(data) ? data : []);
    setFilesError(null);
  }, [selectedAgent]);

  const handleCreateWorkspaceFile = useCallback(
    async (basename: string) => {
      if (!selectedAgent) return;
      const initial = '# \n';
      await api.put(`/api/agents/${selectedAgent}/files/${encodeURIComponent(basename)}`, { content: initial });
      await refreshWorkspaceFiles();
      setSelectedFile(basename);
      setFileContent(initial);
    },
    [selectedAgent, refreshWorkspaceFiles],
  );

  const handleCreateSharedFile = useCallback(
    async (relativePath: string) => {
      const initial = '# \n';
      const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
      await api.put(`/api/memory/shared/${encoded}`, { content: initial });
      setSharedLoading(true);
      try {
        const entries = await api.get<SharedEntry[]>(`/api/memory/shared?path=${encodeURIComponent(sharedPath)}`);
        setSharedEntries(entries.filter(e => e.isDir || e.name.endsWith('.md')));
      } catch {
        setSharedEntries([]);
      } finally {
        setSharedLoading(false);
      }
      setSharedSelectedFile(relativePath);
      setSharedFileContent(initial);
    },
    [sharedPath],
  );

  useEffect(() => {
    setSkillsLoading(true);
    api.get<SkillEntry[]>('/api/skills')
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setSkillsLoading(false));
    api
      .get<Array<{ toolName: string; name: string; skillDir: string; skillName: string; skillEmoji?: string }>>('/api/skills/actions')
      .then(rows => {
        setSkillActionTools(
          rows.map(r => ({
            toolName: r.toolName,
            actionName: r.name,
            skillDir: r.skillDir,
            skillName: r.skillName,
            skillEmoji: r.skillEmoji,
          })),
        );
      })
      .catch(() => setSkillActionTools([]));
  }, []);

  const loadAgentDetail = useCallback((id: string) => {
    api.get<AgentFull>(`/api/agents/${id}`).then(a => {
      setAgentDetail(a);
      setConfigDraft({
        model: a.model,
        temperature: a.temperature,
        promptCacheTtl: a.promptCacheTtl,
        maxContextTokens: a.maxContextTokens,
        maxCompletionTokens: a.maxCompletionTokens,
        contextMessages: a.contextMessages,
        autoCompactThreshold: a.autoCompactThreshold,
        dailyCompact: a.dailyCompact,
        workspaceDir: a.workspaceDir,
        telegram: a.telegram ?? { enabled: false, chatIds: [] },
        tools: a.tools ?? {},
        promptInjection: a.promptInjection ?? { sharedStarredFiles: [], workspaceStarredFiles: [], starredSkills: [] },
        captureReasoningTraces: a.captureReasoningTraces,
        thinkBudget: a.thinkBudget,
        bypassUnifiedCache: a.bypassUnifiedCache,
        lazySkills: a.lazySkills,
        skillCallMode: a.skillCallMode,
        excludeSharedMemory: a.excludeSharedMemory,
        delivery: a.delivery,
        unifiedSession: a.unifiedSession,
        loraScales: a.loraScales,
      });
    }).catch(() => {
      setAgentDetail(null);
      const sub = typeof window !== 'undefined' && window.location.pathname.startsWith('/sub-agents');
      navigate(sub ? '/sub-agents' : '/agents', { replace: true });
    });
    api.get<PromptSizeEstimate>(`/api/agents/${id}/prompt-size`)
      .then(setPromptSize)
      .catch(() => setPromptSize(null));
  }, [navigate]);

  // Reset detail-scoped state when agent changes via URL
  useEffect(() => {
    if (!selectedAgent) return;
    setSelectedFile(null);
    setFileContent('');
    setAgentDetail(null);
    loadAgentDetail(selectedAgent);
  }, [selectedAgent, loadAgentDetail]);

  // Live sync with other clients (other tabs / devices) that edit the same agent.
  // Backend broadcasts `agent.config` after PUT /api/agents/:id/config — merge the
  // patch into configDraft so the toggles update in real time without manual refresh.
  // Covers ANY AgentConfigPatch field via the `...msg.patch` spread (thinkBudget, model,
  // temperature, enabled, lazySkills, bypassUnifiedCache, skillCallMode, excludeSharedMemory,
  // delivery, unifiedSession, and any future flag added to shared/types/ws.ts).
  useEffect(() => {
    if (!selectedAgent) return;
    const unsub = wsClient.subscribe((msg) => {
      if (msg.type !== 'agent.config') return;
      if (msg.agentId !== selectedAgent) return;
      setConfigDraft(prev => ({ ...prev, ...msg.patch }));
      // Also refresh agentDetail so derived UI (header badges, stats) stays accurate.
      setAgentDetail(prev => prev ? { ...prev, ...msg.patch } : prev);
    });
    return unsub;
  }, [selectedAgent]);

  // Fetch files tab content when tab changes
  useEffect(() => {
    if (!selectedAgent) return;
    if (tab === 'files') {
      setFilesError(null);
      api.get<WorkspaceFile[]>(`/api/agents/${selectedAgent}/files`)
        .then(data => {
          setFiles(Array.isArray(data) ? data : []);
          setFilesError(null);
        })
        .catch((err: unknown) => {
          setFiles([]);
          setFilesError(err instanceof Error ? err.message : 'Impossible de charger les fichiers');
        });
    }
  }, [selectedAgent, tab]);

  useEffect(() => {
    if (selectedAgent && selectedFile) {
      api
        .get<{ content: string }>(`/api/agents/${selectedAgent}/files/${selectedFile}`)
        .then(d => setFileContent(d.content));
    }
  }, [selectedAgent, selectedFile]);

  useEffect(() => {
    if (!selectedAgent) {
      navigate(isSubAgentSection ? '/sub-agents' : '/agents', { replace: true });
    }
  }, [selectedAgent, navigate, isSubAgentSection]);

  /** Id absent de la config (liste WS) → retour galerie de la section courante. */
  useEffect(() => {
    if (loading || !selectedAgent) return;
    if (agents.length > 0 && !agents.some(a => a.identity.id === selectedAgent)) {
      navigate(isSubAgentSection ? '/sub-agents' : '/agents', { replace: true });
    }
  }, [loading, agents, selectedAgent, navigate, isSubAgentSection]);

  /** URL / section incohérente avec le kind (agent principal vs sub-agent). */
  useEffect(() => {
    if (!agentDetail || agentDetail.identity.id !== selectedAgent) return;
    const isPreset = agentDetail.kind === 'subagent';
    if (isSubAgentSection && !isPreset) {
      navigate(`/agents/${encodeURIComponent(selectedAgent)}`, { replace: true });
      return;
    }
    if (!isSubAgentSection && isPreset) {
      navigate(`/sub-agents/${encodeURIComponent(selectedAgent)}`, { replace: true });
    }
  }, [agentDetail, selectedAgent, isSubAgentSection, navigate]);

  useEffect(() => {
    if (tab === 'runs' && agentDetail && agentDetail.identity.id === selectedAgent && agentDetail.kind !== 'subagent') {
      setTab('config');
    }
    // Tâches reste masqué pour les sub-agents (l'équivalent est l'onglet Runs).
    // Skills est désormais visible pour tous (granularité par action partagée main + sub).
    if (
      agentDetail
      && agentDetail.identity.id === selectedAgent
      && agentDetail.kind === 'subagent'
      && tab === 'jobs'
    ) {
      setTab('runs');
    }
  }, [tab, agentDetail, selectedAgent]);

  const saveConfigPatch = useCallback(async (patch: Partial<AgentFull>) => {
    if (!selectedAgent) return;
    setConfigDraft(p => ({ ...p, ...patch }));
    await api.put(`/api/agents/${selectedAgent}/config`, patch);
    await loadAgentDetail(selectedAgent);
  }, [selectedAgent, loadAgentDetail]);

  // Active le mode session unifiée : l'endpoint fusionne + compacte les historiques
  // web/mobile/Telegram puis flip le flag côté serveur — on recharge pour refléter l'état.
  // Update optimiste (comme saveConfigPatch) : le toggle passe ON immédiatement, ce qui évite
  // qu'un 2e clic pendant le merge (LLM ~5-30s) re-déclenche un POST unify. Rollback si échec.
  const unifySessions = useCallback(async () => {
    if (!selectedAgent) return;
    setConfigDraft(p => ({ ...p, unifiedSession: true }));
    try {
      await api.post(`/api/agents/${selectedAgent}/unify-sessions`, {});
      await loadAgentDetail(selectedAgent);
    } catch (err) {
      setConfigDraft(p => ({ ...p, unifiedSession: false }));
      throw err;
    }
  }, [selectedAgent, loadAgentDetail]);

  const savePromptInjection = async (nextPromptInjection: { sharedStarredFiles?: string[]; workspaceStarredFiles?: string[]; starredSkills?: string[] }) => {
    if (!selectedAgent) return;
    setSavingStars(true);
    try {
      await api.put(`/api/agents/${selectedAgent}/config`, { promptInjection: nextPromptInjection });
      await loadAgentDetail(selectedAgent);
    } finally {
      setSavingStars(false);
    }
  };

  const toggleWorkspaceStar = async (fileName: string) => {
    const current = configDraft.promptInjection?.workspaceStarredFiles ?? [];
    const next = current.includes(fileName)
      ? current.filter(x => x !== fileName)
      : [...current, fileName].sort((a, b) => a.localeCompare(b));
    const nextPromptInjection = {
      sharedStarredFiles: configDraft.promptInjection?.sharedStarredFiles ?? [],
      workspaceStarredFiles: next,
      starredSkills: configDraft.promptInjection?.starredSkills ?? [],
    };
    setConfigDraft(p => ({ ...p, promptInjection: nextPromptInjection }));
    await savePromptInjection(nextPromptInjection);
  };

  const toggleSharedStar = async (filePath: string) => {
    const current = configDraft.promptInjection?.sharedStarredFiles ?? [];
    const next = current.includes(filePath)
      ? current.filter(x => x !== filePath)
      : [...current, filePath].sort((a, b) => a.localeCompare(b));
    const nextPromptInjection = {
      sharedStarredFiles: next,
      workspaceStarredFiles: configDraft.promptInjection?.workspaceStarredFiles ?? [],
      starredSkills: configDraft.promptInjection?.starredSkills ?? [],
    };
    setConfigDraft(p => ({ ...p, promptInjection: nextPromptInjection }));
    await savePromptInjection(nextPromptInjection);
  };

  const handleSaveFile = async () => {
    if (!selectedAgent || !selectedFile) return;
    setSaving(true);
    try {
      await api.put(`/api/agents/${selectedAgent}/files/${selectedFile}`, { content: fileContent });
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    if (!selectedAgent) return;
    setReloading(true);
    try {
      await api.post(`/api/agents/${selectedAgent}/reload`, {});
      await refetch();
      if (tab === 'config') loadAgentDetail(selectedAgent);
    } finally {
      setReloading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedAgent) return;
    if (!confirm(`Supprimer l'agent "${selectedAgent}" de la config ? (les fichiers workspace ne sont pas supprimés)`)) return;
    await api.delete(`/api/agents/${selectedAgent}`);
    await refetch();
    navigate(isSubAgentSection ? '/sub-agents' : '/agents');
  };

  const handleToggleEnabled = async () => {
    if (!selectedAgent || !agentDetail) return;
    const next = agentDetail.enabled === false ? true : false;
    await api.put(`/api/agents/${selectedAgent}/config`, { enabled: next });
    await loadAgentDetail(selectedAgent);
    refetch();
  };

  const handleSharedSelectEntry = (entry: SharedEntry) => {
    if (entry.isDir) {
      const newPath = sharedPath ? `${sharedPath}/${entry.name}` : entry.name;
      setSharedPath(newPath);
    } else {
      const filePath = sharedPath ? `${sharedPath}/${entry.name}` : entry.name;
      setSharedSelectedFile(filePath);
      // Encode each path segment (matches handleCreateSharedFile) so names with
      // special chars (#, ?, space, accents…) resolve to the same file the
      // backend wrote — a raw path would target a different/invalid URL.
      const encoded = filePath.split('/').map(encodeURIComponent).join('/');
      api.get<{ path: string; content: string }>(`/api/memory/shared/${encoded}`)
        .then(d => setSharedFileContent(d.content))
        .catch(() => setSharedFileContent(''));
    }
  };

  const handleSharedSave = async () => {
    if (!sharedSelectedFile) return;
    setSharedSaving(true);
    try {
      // Encode each segment (matches handleCreateSharedFile / read) so the save
      // targets the same path the file was created at.
      const encoded = sharedSelectedFile.split('/').map(encodeURIComponent).join('/');
      await api.put(`/api/memory/shared/${encoded}`, { content: sharedFileContent });
    } finally {
      setSharedSaving(false);
    }
  };

  const sharedBreadcrumbs = sharedPath ? sharedPath.split('/') : [];

  const tabItems = useMemo(() => {
    const isSubAgent = agentDetail?.kind === 'subagent';
    const base: Array<{ id: Tab; label: string; icon: typeof Settings2 }> = [
      { id: 'config', label: 'Config', icon: Settings2 },
      { id: 'files', label: 'Workspace', icon: FolderOpen },
      { id: 'shared', label: 'Shared', icon: Brain },
      { id: 'skills', label: 'Skills', icon: Zap },
      { id: 'cache', label: 'Cache', icon: Database },
    ];
    // Tâches tab : kind='shell' (skills async — image/video) + kind='sandbox_run'.
    // Pour les sub-agents, toutes leurs lignes async_jobs sont kind='sub_agent', déjà
    // listées dans l'onglet Runs avec plus de contexte (preset, caps_hit, prompt). On
    // masque Tâches pour éviter le doublon. Les agents principaux gardent l'onglet
    // pour suivre leurs jobs Sora/Veo/etc.
    if (!isSubAgent) {
      base.push({ id: 'jobs', label: 'Tâches', icon: Activity });
    } else {
      base.push({ id: 'runs', label: 'Runs', icon: History });
    }
    return base;
  }, [agentDetail?.kind]);

  const switcherAgents = useMemo(
    () =>
      isSubAgentSection
        ? agents.filter(a => a.kind === 'subagent')
        : agents.filter(a => a.kind !== 'subagent'),
    [agents, isSubAgentSection],
  );

  if (loading) return <div className="p-8 text-muted-foreground">Chargement…</div>;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="border-b border-border bg-card px-3 md:px-5 pt-3 md:pt-4 pb-0 shrink-0">
        {agentDetail ? (
          <>
            <div className="flex items-center justify-between gap-4 mb-3">
              {/* Back + Identity */}
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => navigate(isSubAgentSection ? '/sub-agents' : '/agents')}
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-secondary transition-colors"
                  title={isSubAgentSection ? 'Retour aux sub-agents' : 'Retour aux agents'}
                >
                  <ArrowLeft size={14} />
                </button>
                {(() => {
                  const liveState = agents.find(a => a.identity.id === selectedAgent)?.state ?? '';
                  const dot =
                    liveState === 'streaming' ? 'bg-theme-green animate-pulse' :
                    liveState === 'thinking'  ? 'bg-orange-400 animate-pulse' :
                    liveState === 'warming'   ? 'bg-orange-400 animate-pulse' :
                    liveState === 'sandbox'   ? 'bg-primary animate-pulse' :
                    liveState === 'error'     ? 'bg-destructive' : '';
                  return (
                    <div className="relative shrink-0">
                      <div className="w-12 h-12 flex items-center justify-center rounded-2xl bg-secondary text-2xl leading-none">
                        {agentDetail.identity.emoji || '🤖'}
                      </div>
                      {dot && (
                        <span className={`absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-card ${dot}`} />
                      )}
                    </div>
                  );
                })()}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h1 className="text-[15px] font-bold text-foreground leading-tight truncate">{agentDetail.identity.name}</h1>
                    <SandboxIndicator agentId={selectedAgent} />
                  </div>
                  <p className="text-[11px] font-mono text-muted-foreground/50 mt-0.5">{agentDetail.identity.id}</p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0 mt-0.5">
                <button
                  onClick={handleToggleEnabled}
                  title={agentDetail.enabled === false ? "Activer l'agent" : "Désactiver l'agent"}
                  className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                    agentDetail.enabled === false
                      ? 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20'
                      : 'bg-theme-green/10 text-theme-green border-theme-green/20 hover:bg-theme-green/20'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${agentDetail.enabled === false ? 'bg-destructive' : 'bg-theme-green'}`} />
                  {agentDetail.enabled === false ? 'inactif' : 'actif'}
                </button>
                <button
                  onClick={handleReload}
                  disabled={reloading}
                  title="Recharger l'identité depuis IDENTITY.md"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary disabled:opacity-40 transition-colors"
                >
                  <RefreshCw size={13} className={reloading ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={handleDelete}
                  title="Supprimer l'agent"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Agent switcher pills — même kind que la section (pas de mélange agent / sub-agent). */}
            {switcherAgents.length > 1 && (
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-3">
                {switcherAgents.map(agent => {
                  const isActive = agent.identity.id === selectedAgent;
                  const isDisabled = agent.enabled === false;
                  const stateDot =
                    agent.state === 'streaming' ? 'bg-theme-green animate-pulse' :
                    agent.state === 'thinking'  ? 'bg-orange-400 animate-pulse' :
                    agent.state === 'warming'   ? 'bg-orange-400 animate-pulse' :
                    agent.state === 'error'     ? 'bg-destructive' : '';
                  return (
                    <button
                      key={agent.identity.id}
                      onClick={() => navigate(`${detailBasePath}/${encodeURIComponent(agent.identity.id)}`)}
                      className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-colors text-[11px] ${
                        isActive
                          ? 'bg-primary/10 border-primary/30 text-foreground'
                          : 'bg-secondary/40 border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                      } ${isDisabled ? 'opacity-50' : ''}`}
                      title={agent.identity.id}
                    >
                      <span className="text-[13px] leading-none">{agent.identity.emoji || '🤖'}</span>
                      <span className="font-medium">{agent.identity.name}</span>
                      {stateDot && <span className={`w-1.5 h-1.5 rounded-full ${stateDot}`} />}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="h-16 flex items-center">
            <span className="text-sm text-muted-foreground/40">Chargement…</span>
          </div>
        )}
      </div>

      {/* Tabs — standalone bar below header */}
      {agentDetail && (
        <div className="border-b border-border bg-card px-3 md:px-5 shrink-0 overflow-x-auto">
          <div className="flex gap-0.5 min-w-max">
            {tabItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors ${
                  tab === id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 flex flex-col min-h-0">
        {tab === 'files' && (
          <AgentFilesTab
            files={files}
            filesError={filesError}
            selectedFile={selectedFile}
            fileContent={fileContent}
            saving={saving}
            savingStars={savingStars}
            configDraft={configDraft}
            setSelectedFile={setSelectedFile}
            setFileContent={setFileContent}
            handleSaveFile={handleSaveFile}
            toggleWorkspaceStar={toggleWorkspaceStar}
            onCreateFile={handleCreateWorkspaceFile}
          />
        )}

        {tab === 'config' && agentDetail && (
          <AgentConfigTab
            agentDetail={agentDetail}
            configDraft={configDraft}
            setConfigDraft={setConfigDraft}
            saveConfigPatch={saveConfigPatch}
            unifySessions={unifySessions}
            csIndexKeys={csIndexKeys}
            promptSize={promptSize}
            modelPickerProviders={modelPickerProviders}
            workspaceDirs={workspaceDirs}
            availableBots={availableBots}
            mainAgentIds={agents.filter(a => a.kind !== 'subagent').map(a => a.identity.id)}
          />
        )}

        {tab === 'skills' && agentDetail && (
          <AgentSkillsTab
            agentDetail={agentDetail}
            skills={skills}
            skillsLoading={skillsLoading}
            skillActionTools={skillActionTools}
            configDraft={configDraft}
            saveConfigPatch={saveConfigPatch}
          />
        )}

        {tab === 'shared' && (
          <AgentSharedTab
            sharedPath={sharedPath}
            setSharedPath={setSharedPath}
            sharedEntries={sharedEntries}
            sharedSelectedFile={sharedSelectedFile}
            sharedFileContent={sharedFileContent}
            sharedSaving={sharedSaving}
            sharedLoading={sharedLoading}
            sharedBreadcrumbs={sharedBreadcrumbs}
            savingStars={savingStars}
            configDraft={configDraft}
            handleSharedSelectEntry={handleSharedSelectEntry}
            handleSharedSave={handleSharedSave}
            setSharedFileContent={setSharedFileContent}
            toggleSharedStar={toggleSharedStar}
            onCreateFile={handleCreateSharedFile}
          />
        )}

        {tab === 'cache' && selectedAgent && (
          <AgentPromptCacheTab selectedAgentId={selectedAgent} />
        )}

        {tab === 'jobs' && selectedAgent && (
          <AgentJobsTab selectedAgentId={selectedAgent} />
        )}

        {tab === 'runs' && selectedAgent && agentDetail?.kind === 'subagent' && (
          <SubAgentRunsTab subAgentId={selectedAgent} />
        )}
      </div>
    </div>
  );
}
