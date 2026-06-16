import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Database } from 'lucide-react';
import { clsx } from 'clsx';

import type { MemoryTab, MastermindConfigResponse, CsForm, IndexEntry, CodebaseSearchStatusResponse, CodebaseSearchStatsResponse, CodebaseSearchSearchResponse, MercuryChainSnapshot, EmbeddingChainEntry, SessionSearchHit, AgentSummary } from './memory/types';
import { configToForm, emptyForm, newEntryId } from './memory/types';
import type { ProviderConfig } from '@mastermind/shared';

import { MemorySearchTab } from './memory/MemorySearchTab';
import { MemoryConfigTab } from './memory/MemoryConfigTab';
import { MemoryStoreTab } from './memory/MemoryStoreTab';
import { BoardTab } from './memory/BoardTab';
import { SessionSearchTab } from './memory/SessionSearchTab';

const TABS: { id: MemoryTab; label: string }[] = [
  { id: 'search', label: 'Recherche' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'config', label: 'Configuration' },
  { id: 'store', label: 'Memoire vectorielle' },
  { id: 'board', label: 'Board' },
];

export default function MemoryPage() {
  const [activeTab, setActiveTab] = useState<MemoryTab>('search');

  // ── Codebase search state (shared between search + config tabs) ──────
  const [status, setStatus] = useState<CodebaseSearchStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stats, setStats] = useState<CodebaseSearchStatsResponse | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<string>('default');
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<'vector' | 'hybrid'>('vector');
  const [limit, setLimit] = useState(10);
  const [filePattern, setFilePattern] = useState('');
  const [extensions, setExtensions] = useState('');
  const [searchResult, setSearchResult] = useState<CodebaseSearchSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingStats, setLoadingStats] = useState(false);
  const [searching, setSearching] = useState(false);

  // ── Session (conversation history) full-text search state ────────────
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [convQuery, setConvQuery] = useState('');
  const [convAgentId, setConvAgentId] = useState('');
  const [convLimit, setConvLimit] = useState(20);
  const [convResults, setConvResults] = useState<SessionSearchHit[] | null>(null);
  const [convSearching, setConvSearching] = useState(false);
  const [convError, setConvError] = useState<string | null>(null);
  const convNonceRef = useRef(0); // last-issued-wins : ignore les réponses d'une recherche périmée

  const [csForm, setCsForm] = useState<CsForm>(emptyForm);
  const [appConfig, setAppConfig] = useState<MastermindConfigResponse | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configOk, setConfigOk] = useState<string | null>(null);
  const [embedBusy, setEmbedBusy] = useState<Record<string, boolean>>({});
  const [embedAllBusy, setEmbedAllBusy] = useState(false);
  const [mercuryChain, setMercuryChain] = useState<MercuryChainSnapshot | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data loading ─────────────────────────────────────────────────────

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setLoadingStatus(true);
    setStatusError(null);
    try {
      const s = await api.get<CodebaseSearchStatusResponse>('/api/codebase-search/status');
      setStatus(s);
    } catch (e: unknown) {
      setStatusError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      if (!silent) setLoadingStatus(false);
    }
  }, []);

  const loadAppConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const cfg = await api.get<MastermindConfigResponse>('/api/config');
      setCsForm(configToForm(cfg));
      setAppConfig(cfg);
    } catch (e: unknown) {
      setConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    if (!status?.enabled) return;
    // Avoid the initial-render race: selectedIndex defaults to 'default', and the
    // auto-fix effect below switches it to keys[0] when the backend has no
    // defaultDbPath. But that effect runs after this one, so the first loadStats()
    // call would hit /stats?index=default → 400 (and pollute the logs). Skip when
    // the index won't resolve; we'll be called back once selectedIndex is corrected.
    if (selectedIndex === 'default' && !status.resolvedDefaultDbPath) return;
    setLoadingStats(true);
    setStatsError(null);
    try {
      const st = await api.get<CodebaseSearchStatsResponse>(`/api/codebase-search/stats?index=${encodeURIComponent(selectedIndex)}`);
      setStats(st);
    } catch (e: unknown) {
      setStatsError(e instanceof Error ? e.message : String(e));
      setStats(null);
    } finally {
      setLoadingStats(false);
    }
  }, [status?.enabled, status?.resolvedDefaultDbPath, selectedIndex]);

  const loadMercuryChain = useCallback(async () => {
    try {
      const providers = await api.get<ProviderConfig[]>('/api/providers');
      const mercury = providers.find(p => p.embeddingFallbackEnabled);
      if (!mercury) {
        setMercuryChain(null);
        return;
      }
      const chainResp = await api.get<{ data?: EmbeddingChainEntry[]; error?: string }>(
        `/api/providers/${encodeURIComponent(mercury.id)}/embedding-chain`,
      );
      setMercuryChain({
        providerId: mercury.id,
        entries: chainResp.data ?? [],
        error: chainResp.error,
        expectedDim: appConfig?.memoryStore?.embeddingDimensions ?? 4096,
      });
    } catch (e) {
      setMercuryChain(prev => prev ? { ...prev, error: e instanceof Error ? e.message : String(e) } : null);
    }
  }, [appConfig?.memoryStore?.embeddingDimensions]);

  useEffect(() => { void loadStatus(); void loadAppConfig(); }, [loadStatus, loadAppConfig]);
  useEffect(() => {
    void (async () => {
      try { setAgents(await api.get<AgentSummary[]>('/api/agents?kind=all')); } catch { /* non-fatal — agent filter reste "Tous" */ }
    })();
  }, []);
  useEffect(() => { void loadMercuryChain(); }, [loadMercuryChain]);

  useEffect(() => {
    if (!status?.enabled) return;
    const keys = Object.keys(status.resolvedIndices);
    if (keys.length > 0 && !status.resolvedDefaultDbPath) {
      setSelectedIndex(prev => (prev === 'default' ? keys[0]! : prev));
    }
  }, [status]);

  useEffect(() => { if (status?.enabled) void loadStats(); }, [status?.enabled, loadStats]);

  const indexOptions = (): string[] => {
    if (!status?.enabled) return [];
    const keys = Object.keys(status.resolvedIndices);
    if (status.resolvedDefaultDbPath) return [...new Set(['default', ...keys])];
    return keys.length > 0 ? keys : ['default'];
  };

  // ── Search handler ──────────────────────────────────────────────────

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const r = await api.post<CodebaseSearchSearchResponse>('/api/codebase-search/search', {
        query: query.trim(), index: selectedIndex, limit, type: searchType,
        ...(filePattern.trim() ? { file_pattern: filePattern.trim() } : {}),
        ...(extensions.trim() ? { extensions: extensions.split(',').map(e => e.trim()).filter(Boolean) } : {}),
      });
      setSearchResult(r);
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const handleSessionSearch = async () => {
    const q = convQuery.trim();
    if (!q || convSearching) return;
    const nonce = ++convNonceRef.current;
    setConvSearching(true);
    setConvError(null);
    setConvResults(null);
    try {
      const qs = new URLSearchParams({ q, limit: String(convLimit) });
      if (convAgentId) qs.set('agentId', convAgentId);
      const hits = await api.get<SessionSearchHit[]>(`/api/sessions/search?${qs.toString()}`);
      if (nonce === convNonceRef.current) setConvResults(hits); // ignore une réponse périmée
    } catch (e: unknown) {
      if (nonce === convNonceRef.current) setConvError(e instanceof Error ? e.message : String(e));
    } finally {
      if (nonce === convNonceRef.current) setConvSearching(false);
    }
  };

  // ── Config form handlers ────────────────────────────────────────────

  const updateEntry = (id: string, field: keyof Omit<IndexEntry, 'id'>, value: string) => {
    setCsForm(f => ({ ...f, indexEntries: f.indexEntries.map(e => e.id === id ? { ...e, [field]: value } : e) }));
  };
  const addEntry = () => { setCsForm(f => ({ ...f, indexEntries: [...f.indexEntries, { id: newEntryId(), key: '', sourcePath: '', dbPath: '' }] })); };
  const removeEntry = (id: string) => { setCsForm(f => ({ ...f, indexEntries: f.indexEntries.filter(e => e.id !== id) })); };

  const handleSaveCodebaseSearch = async () => {
    setConfigError(null);
    setConfigOk(null);
    const entries = csForm.indexEntries.filter(e => e.key.trim());
    const keys = entries.map(e => e.key.trim());
    const dupKey = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dupKey) { setConfigError(`Cle dupliquee : ${dupKey}`); return; }

    const indices: Record<string, string> = {};
    const embedSources: Record<string, string> = {};
    let defaultDbPath: string | undefined;
    for (const e of entries) {
      const k = e.key.trim();
      if (k === 'default') { if (e.dbPath.trim()) defaultDbPath = e.dbPath.trim(); }
      else { if (e.dbPath.trim()) indices[k] = e.dbPath.trim(); }
      if (e.sourcePath.trim()) embedSources[k] = e.sourcePath.trim();
    }
    const hour = Math.min(23, Math.max(0, Math.floor(Number(csForm.embedCronHourUtc)) || 0));
    const codebaseSearch: Record<string, unknown> = {
      enabled: csForm.enabled, configPath: csForm.configPath.trim() || undefined,
      defaultDbPath: defaultDbPath ?? '', indices, embedSources, allowUiIndex: csForm.allowUiIndex,
      embedCronEnabled: csForm.embedCronEnabled, embedCronHourUtc: hour, embedCronMode: csForm.embedCronMode,
      embedCronCloudOnly: csForm.embedCronCloudOnly,
      embeddingForceCloud: csForm.embeddingForceCloud,
    };

    setConfigSaving(true);
    try {
      await api.put('/api/config', { codebaseSearch });
      setConfigOk('Configuration enregistree.');
      await loadAppConfig();
      await loadStatus();
    } catch (e: unknown) {
      setConfigError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfigSaving(false);
    }
  };

  // ── Embed polling ───────────────────────────────────────────────────

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => { void loadStatus(true); }, 1500);
  }, [loadStatus]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => {
    const runs = status?.lastEmbedRuns ?? {};
    const anyRunning = Object.values(runs).some(r => r.status === 'running');
    if (!anyRunning) {
      stopPolling();
      setEmbedBusy(prev => { const next = { ...prev }; for (const k of Object.keys(next)) next[k] = false; return next; });
      setEmbedAllBusy(false);
    }
  }, [status?.lastEmbedRuns, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleRunEmbed = async (indexKey?: string, mode: 'full' | 'incremental' = 'full') => {
    if (indexKey) setEmbedBusy(prev => ({ ...prev, [indexKey]: true }));
    else setEmbedAllBusy(true);
    startPolling();
    try {
      // Backend returns immediately ({ ok: true, started: true }) — the embed runs in the
      // background. The polling above watches lastEmbedRuns and clears busy/stops polling
      // when no run is 'running' anymore (see useEffect above).
      await api.post('/api/codebase-search/embed', { ...(indexKey ? { index: indexKey } : {}), mode });
      await loadStatus();
    } catch {
      // POST itself failed (network error, 4xx/5xx) — clear busy now since no run was
      // started server-side. On success we let the polling-driven useEffect clear busy
      // when the embed actually finishes.
      if (indexKey) setEmbedBusy(prev => ({ ...prev, [indexKey]: false }));
      else setEmbedAllBusy(false);
    }
  };

  // ── Status dot ──────────────────────────────────────────────────────

  const statusEnabled = activeTab === 'store'
    ? appConfig?.memoryStore?.enabled
    : activeTab === 'conversations'
    ? true // FTS toujours dispo (aucune config requise)
    : status?.enabled;

  return (
    <div className="flex flex-col h-full bg-background text-card-foreground">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-card shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Database size={20} /> Memoire
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              {activeTab === 'store'
                ? <>Memoire vectorielle des agents (PostgreSQL + pgvector) — outils <code className="bg-secondary px-1 rounded-md">memory_write</code> / <code className="bg-secondary px-1 rounded-md">memory_search</code>.</>
                : activeTab === 'conversations'
                ? <>Recherche plein-texte dans l'historique des conversations (outil agent <code className="bg-secondary px-1 rounded-md">session_search</code>).</>
                : <>Recherche semantique dans la base de code et configuration des embeddings (outil agent <code className="bg-secondary px-1 rounded-md">codebase_search</code>).</>}
            </p>
          </div>
          {statusEnabled != null && (
            <span className={clsx('w-2.5 h-2.5 rounded-full shrink-0 mt-1.5', statusEnabled ? 'bg-theme-green' : 'bg-muted-foreground')} title={statusEnabled ? 'Active' : 'Desactive'} />
          )}
        </div>

        {/* Tab bar — scrollable horizontalement sur narrow (sinon "Memoire
            vectorielle" wrap et les onglets suivants sont clippés). */}
        <div className="mt-3 -mb-4 overflow-x-auto no-scrollbar">
          <div className="flex min-w-max">
          {TABS.map(t => (
            <button
              key={t.id} type="button" onClick={() => setActiveTab(t.id)}
              className={clsx(
                'whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                activeTab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >{t.label}</button>
          ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'search' && (
        <MemorySearchTab
          status={status} loadingStatus={loadingStatus}
          indexOptions={indexOptions()} selectedIndex={selectedIndex} setSelectedIndex={setSelectedIndex}
          query={query} setQuery={setQuery}
          searchType={searchType} setSearchType={setSearchType}
          limit={limit} setLimit={setLimit}
          filePattern={filePattern} setFilePattern={setFilePattern}
          extensions={extensions} setExtensions={setExtensions}
          searching={searching} searchResult={searchResult} searchError={searchError}
          onSearch={() => void handleSearch()} onSwitchToConfig={() => setActiveTab('config')}
        />
      )}

      {activeTab === 'conversations' && (
        <SessionSearchTab
          query={convQuery} setQuery={setConvQuery}
          agentId={convAgentId} setAgentId={setConvAgentId}
          agents={agents}
          limit={convLimit} setLimit={setConvLimit}
          searching={convSearching} results={convResults} error={convError}
          onSearch={() => void handleSessionSearch()}
        />
      )}

      {activeTab === 'config' && (
        <MemoryConfigTab
          status={status} loadingStatus={loadingStatus} statusError={statusError}
          stats={stats} statsError={statsError} loadingStats={loadingStats}
          csForm={csForm} setCsForm={setCsForm}
          configLoading={configLoading} configSaving={configSaving} configError={configError} configOk={configOk}
          selectedIndex={selectedIndex} setSelectedIndex={setSelectedIndex} indexOptions={indexOptions()}
          embedBusy={embedBusy} embedAllBusy={embedAllBusy}
          onRefreshStatus={() => void loadStatus()} onRefreshStats={() => void loadStats()}
          onRefreshConfig={() => { void loadAppConfig(); void loadMercuryChain(); }}
          onSave={() => void handleSaveCodebaseSearch()}
          onRunEmbed={(k, m) => void handleRunEmbed(k, m)}
          updateEntry={updateEntry} addEntry={addEntry} removeEntry={removeEntry}
          mercuryChain={mercuryChain}
          onToggleForceCloud={async (value) => {
            await api.put('/api/config', { codebaseSearch: { embeddingForceCloud: value } });
            await loadAppConfig();
          }}
        />
      )}

      {activeTab === 'store' && (
        <MemoryStoreTab appConfig={appConfig} />
      )}

      {activeTab === 'board' && (
        <BoardTab />
      )}
    </div>
  );
}
