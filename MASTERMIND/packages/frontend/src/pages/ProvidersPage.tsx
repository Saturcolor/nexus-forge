import { useState, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Cpu, Globe, Zap, Plus, Settings, Trash2, Eye, EyeOff,
  Activity, BarChart2, Search, X, ChevronRight,
  CheckCircle2, XCircle, Link, Key, Layers, RefreshCw, Eye as EyeIcon,
} from 'lucide-react';
import { api } from '../lib/api';

interface Provider {
  id: string;
  type: 'mercury' | 'openai-compat';
  baseUrl: string;
  apiKey: string;
  statsApiKey?: string;
  modelsUrl?: string;
  statsUrl?: string;
  statsEnabled?: boolean;
  chatStatsmercuryEnabled?: boolean;
  visionFallbackEnabled?: boolean;
  embeddingFallbackEnabled?: boolean;
  models?: Array<{ alias: string; modelId: string }>;
  hiddenModelIds?: string[];
  modelDisplayNames?: Record<string, string>;
}

interface NewProvider {
  id: string;
  type: 'mercury' | 'openai-compat';
  baseUrl: string;
  apiKey: string;
  statsApiKey: string;
  modelsUrl: string;
  statsUrl: string;
  chatStatsmercuryEnabled: boolean;
}

interface NewModel {
  alias: string;
  modelId: string;
}

interface LiveModel {
  id: string;
  name: string;
  contextLength?: number;
}

const DEFAULT_PROVIDER: NewProvider = {
  id: '',
  type: 'openai-compat',
  baseUrl: 'http://localhost:17890/v1',
  apiKey: '',
  statsApiKey: '',
  modelsUrl: 'http://localhost:17890/api/tags',
  statsUrl: '',
  chatStatsmercuryEnabled: true,
};

const DEFAULT_MODEL: NewModel = { alias: '', modelId: '' };

/* ── Small reusable components ── */

function Toggle({ value, onChange, label, sub }: {
  value: boolean;
  onChange: () => void;
  label?: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      {(label || sub) && (
        <div>
          {label && <p className="text-sm text-foreground/80">{label}</p>}
          {sub && <p className="text-[11px] text-muted-foreground/40">{sub}</p>}
        </div>
      )}
      <button
        onClick={onChange}
        className={clsx(
          'relative shrink-0 w-9 h-5 rounded-full transition-colors',
          value ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span className={clsx(
          'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all',
          value ? 'left-[18px]' : 'left-0.5',
        )} />
      </button>
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 pr-9 text-sm font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30"
      />
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
      >
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
}

function TypeBadge({ type }: { type: 'mercury' | 'openai-compat' }) {
  return type === 'mercury'
    ? <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400"><Zap size={9} />mercury</span>
    : <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400"><Globe size={9} />openai-compat</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, placeholder, mono = true }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={clsx(
        'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/30',
        mono && 'font-mono',
      )}
    />
  );
}

/* ── Main page ── */

type ProvTab = 'config' | 'models';

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Provider>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [provTab, setProvTab] = useState<ProvTab>('config');

  // Create provider modal
  const [showCreate, setShowCreate] = useState(false);
  const [newProvider, setNewProvider] = useState<NewProvider>(DEFAULT_PROVIDER);
  const [creating, setCreating] = useState(false);

  // Add model
  const [addingModelFor, setAddingModelFor] = useState<string | null>(null);
  const [newModel, setNewModel] = useState<NewModel>(DEFAULT_MODEL);

  // Stats test
  const [statsTestState, setStatsTestState] = useState<Record<string, string>>({});

  // Live model browser
  const [liveModels, setLiveModels] = useState<LiveModel[] | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveSearch, setLiveSearch] = useState('');
  const [browsingFor, setBrowsingFor] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Exposure — per-provider model lists, auto-loaded
  const [exposureModelsMap, setExposureModelsMap] = useState<Record<string, LiveModel[]>>({});
  const [exposureLoadingMap, setExposureLoadingMap] = useState<Record<string, boolean>>({});
  const [hiddenDrafts, setHiddenDrafts] = useState<Record<string, Set<string>>>({});
  const [displayDrafts, setDisplayDrafts] = useState<Record<string, Record<string, string>>>({});
  const [exposureDirty, setExposureDirty] = useState<Record<string, boolean>>({});

  const load = () => {
    setLoadError(null);
    return api.get<Provider[]>('/api/providers')
      .then(setProviders)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { void load(); }, []);

  const handleToggleStats = async (p: Provider) => {
    await api.put(`/api/providers/${p.id}`, { statsEnabled: !p.statsEnabled });
    await load();
  };

  const handleTestStats = async (p: Provider) => {
    setStatsTestState(s => ({ ...s, [p.id]: 'testing' }));
    try {
      const res = await api.get<{ ok: boolean; version?: string; error?: string }>(`/api/providers/${p.id}/test-stats`);
      setStatsTestState(s => ({ ...s, [p.id]: res.ok ? `ok:${res.version ?? '?'}` : `error:${res.error ?? 'failed'}` }));
    } catch (err) {
      setStatsTestState(s => ({ ...s, [p.id]: `error:${err instanceof Error ? err.message : String(err)}` }));
    }
  };

  const openBrowser = async (providerId: string) => {
    setBrowsingFor(providerId);
    setLiveModels(null);
    setLiveSearch('');
    setLiveLoading(true);
    try {
      const models = await api.get<LiveModel[]>(`/api/providers/${providerId}/available-models`);
      setLiveModels(models);
      setTimeout(() => searchRef.current?.focus(), 50);
    } catch (err) {
      alert(`Impossible de récupérer les modèles : ${err instanceof Error ? err.message : String(err)}`);
      setBrowsingFor(null);
    } finally {
      setLiveLoading(false);
    }
  };

  const closeBrowser = () => { setBrowsingFor(null); setLiveModels(null); setLiveSearch(''); };

  const loadExposure = async (provider: Provider) => {
    setExposureLoadingMap(prev => ({ ...prev, [provider.id]: true }));
    try {
      const models = await api.get<LiveModel[]>(`/api/providers/${provider.id}/available-models`);
      setExposureModelsMap(prev => ({ ...prev, [provider.id]: models }));
      // Initialise drafts from provider config (only if not already dirty / user-edited)
      if (!exposureDirty[provider.id]) {
        setHiddenDrafts(prev => ({ ...prev, [provider.id]: new Set(provider.hiddenModelIds ?? []) }));
        setDisplayDrafts(prev => ({ ...prev, [provider.id]: { ...(provider.modelDisplayNames ?? {}) } }));
      }
    } catch (err) {
      console.error(`Failed to load models for ${provider.id}:`, err);
    } finally {
      setExposureLoadingMap(prev => ({ ...prev, [provider.id]: false }));
    }
  };

  // Auto-load models for all providers when switching to Models tab
  useEffect(() => {
    if (provTab !== 'models' || providers.length === 0) return;
    for (const p of providers) {
      if (!exposureModelsMap[p.id] && !exposureLoadingMap[p.id]) {
        void loadExposure(p);
      }
    }
  }, [provTab, providers]);

  const toggleHiddenModel = (providerId: string, modelId: string) => {
    setHiddenDrafts(prev => {
      const current = prev[providerId] ?? new Set();
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId); else next.add(modelId);
      return { ...prev, [providerId]: next };
    });
    setExposureDirty(prev => ({ ...prev, [providerId]: true }));
  };

  const updateDisplayName = (providerId: string, modelId: string, name: string) => {
    setDisplayDrafts(prev => ({
      ...prev,
      [providerId]: { ...(prev[providerId] ?? {}), [modelId]: name },
    }));
    setExposureDirty(prev => ({ ...prev, [providerId]: true }));
  };

  const saveExposure = async (providerId: string) => {
    await api.put(`/api/providers/${providerId}`, {
      hiddenModelIds: Array.from(hiddenDrafts[providerId] ?? new Set()),
      modelDisplayNames: displayDrafts[providerId] ?? {},
    });
    setExposureDirty(prev => ({ ...prev, [providerId]: false }));
    await load();
  };

  const selectLiveModel = (model: LiveModel) => {
    setNewModel(m => ({ ...m, modelId: model.id }));
    closeBrowser();
  };

  const filteredLive = liveModels?.filter(m =>
    m.name.toLowerCase().includes(liveSearch.toLowerCase()) ||
    m.id.toLowerCase().includes(liveSearch.toLowerCase())
  ) ?? [];

  const handleSave = async (id: string) => {
    setSavingId(id);
    try {
      await api.put(`/api/providers/${id}`, editDraft);
      setEditingId(null);
      await load();
    } finally { setSavingId(null); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Supprimer le provider "${id}" ?`)) return;
    await api.delete(`/api/providers/${id}`);
    await load();
  };

  const handleCreate = async () => {
    if (!newProvider.id || !newProvider.baseUrl) return;
    setCreating(true);
    try {
      await api.post('/api/providers', newProvider);
      setShowCreate(false);
      setNewProvider(DEFAULT_PROVIDER);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally { setCreating(false); }
  };

  const handleAddModel = async (providerId: string) => {
    if (!newModel.alias || !newModel.modelId) return;
    await api.post(`/api/providers/${providerId}/models`, newModel);
    setAddingModelFor(null);
    setNewModel(DEFAULT_MODEL);
    closeBrowser();
    await load();
  };

  const handleDeleteModel = async (providerId: string, alias: string) => {
    await api.delete(`/api/providers/${providerId}/models/${alias}`);
    await load();
  };

  if (loading) return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      Chargement…
    </div>
  );

  if (loadError) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
      <p className="text-destructive font-semibold">Erreur de chargement</p>
      <p className="text-destructive/70 text-xs font-mono">{loadError}</p>
      <button onClick={() => void load()} className="text-sm text-primary hover:text-primary/80">Réessayer</button>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/30 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
            <Cpu size={15} className="text-primary" />
          </div>
          <div>
            <h1 className="text-[15px] font-bold text-foreground">Providers</h1>
            <p className="text-[11px] text-muted-foreground/50">
              {providers.length} provider{providers.length !== 1 ? 's' : ''} configuré{providers.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg transition-colors"
        >
          <Plus size={12} />
          Nouveau provider
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 border-b border-border bg-card/20 shrink-0">
        {([
          { id: 'config' as ProvTab, label: 'Config', icon: Settings },
          { id: 'models' as ProvTab, label: 'Modèles', icon: Layers },
        ] as Array<{ id: ProvTab; label: string; icon: typeof Settings }>).map(t => {
          const Icon = t.icon;
          const active = provTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setProvTab(t.id)}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={12} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {provTab === 'config' && (
          <div className="p-6 space-y-4 max-w-3xl mx-auto w-full">
        {providers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <Cpu size={36} className="text-muted-foreground/15" />
            <p className="text-sm text-muted-foreground/40">Aucun provider configuré</p>
            <button onClick={() => setShowCreate(true)} className="text-xs text-primary hover:text-primary/80">
              + Ajouter un provider
            </button>
          </div>
        )}

        {providers.map(p => (
          <div key={p.id} className="bg-card rounded-xl border border-border/50 overflow-hidden">

            {/* ── Card header ── */}
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                {p.type === 'mercury'
                  ? <Zap size={16} className="text-purple-400" />
                  : <Globe size={16} className="text-sky-400" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-semibold text-foreground">{p.id}</p>
                  <TypeBadge type={p.type} />
                </div>
                <p className="text-[11px] text-muted-foreground/50 font-mono truncate mt-0.5">{p.baseUrl}</p>
              </div>
              {editingId === p.id ? (
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => setEditingId(null)} className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    Annuler
                  </button>
                  <button
                    onClick={() => void handleSave(p.id)}
                    disabled={savingId === p.id}
                    className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                  >
                    {savingId === p.id ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => {
                      setEditingId(p.id);
                      setEditDraft({ baseUrl: p.baseUrl, apiKey: '', statsApiKey: '', modelsUrl: p.modelsUrl ?? '', statsUrl: p.statsUrl ?? '', chatStatsmercuryEnabled: p.chatStatsmercuryEnabled ?? true });
                    }}
                    title="Éditer"
                    className="p-1.5 text-muted-foreground/40 hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
                  >
                    <Settings size={13} />
                  </button>
                  <button
                    onClick={() => void handleDelete(p.id)}
                    title="Supprimer"
                    className="p-1.5 text-destructive/40 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>

            {/* ── Edit form ── */}
            {editingId === p.id && (
              <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3 bg-card/50">
                <Field label="Base URL">
                  <TextInput value={editDraft.baseUrl ?? ''} onChange={v => setEditDraft(d => ({ ...d, baseUrl: v }))} />
                </Field>
                <Field label="Models URL (optionnel)">
                  <TextInput value={editDraft.modelsUrl ?? ''} onChange={v => setEditDraft(d => ({ ...d, modelsUrl: v }))} placeholder="ex: http://localhost:17890/api/tags" />
                </Field>
                <Field label="Stats URL (optionnel)">
                  <TextInput value={editDraft.statsUrl ?? ''} onChange={v => setEditDraft(d => ({ ...d, statsUrl: v }))} placeholder="ex: http://192.168.1.x:17890" />
                </Field>
                <Field label="API Key (vide = pas de changement)">
                  <PasswordInput value={editDraft.apiKey ?? ''} onChange={v => setEditDraft(d => ({ ...d, apiKey: v }))} placeholder="sk-…" />
                </Field>
                <Field label="Stats API Key (optionnel)">
                  <PasswordInput value={editDraft.statsApiKey ?? ''} onChange={v => setEditDraft(d => ({ ...d, statsApiKey: v }))} placeholder="Token admin — vide = utilise API Key" />
                </Field>
              </div>
            )}

            {/* ── Read-only info ── */}
            {editingId !== p.id && (
              <div className="border-t border-border/40 px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-2">
                <InfoRow icon={<Link size={10} />} label="Models URL" value={p.modelsUrl || 'défaut'} mono />
                <InfoRow icon={<Key size={10} />} label="API Key" value={p.apiKey ? '••••••••' : 'aucune'} />
                {p.statsUrl && (
                  <InfoRow icon={<Activity size={10} />} label="Stats URL" value={p.statsUrl} mono />
                )}
                {p.statsApiKey && (
                  <InfoRow icon={<Key size={10} />} label="Stats API Key" value="••••••••" />
                )}
              </div>
            )}

            {/* ── Stats controls ── */}
            {editingId !== p.id && p.statsUrl && (
              <div className="border-t border-border/40 px-4 py-3">
                <div className="flex items-center gap-1.5 mb-2.5">
                  <BarChart2 size={11} className="text-muted-foreground/40" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/40">Stats live</span>
                  <span className="text-[11px] font-mono text-muted-foreground/30 ml-1">{p.statsUrl}</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Test button + result */}
                  <button
                    onClick={() => void handleTestStats(p)}
                    disabled={statsTestState[p.id] === 'testing'}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-secondary text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary/80 disabled:opacity-50 transition-colors"
                  >
                    <RefreshCw size={10} className={statsTestState[p.id] === 'testing' ? 'animate-spin' : ''} />
                    Test
                  </button>
                  {statsTestState[p.id] && statsTestState[p.id] !== 'testing' && (
                    <span className={clsx(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono',
                      statsTestState[p.id].startsWith('ok')
                        ? 'bg-theme-green/10 text-theme-green'
                        : 'bg-destructive/10 text-destructive',
                    )}>
                      {statsTestState[p.id].startsWith('ok')
                        ? <><CheckCircle2 size={9} />v{statsTestState[p.id].slice(3)}</>
                        : <><XCircle size={9} />{statsTestState[p.id].slice(6)}</>
                      }
                    </span>
                  )}

                  <div className="flex items-center gap-1.5 ml-auto">
                    <StatsToggle
                      value={p.statsEnabled ?? false}
                      onChange={() => void handleToggleStats(p)}
                      label="Stats"
                      activeColor="text-theme-green"
                      activeBg="bg-theme-green/10 hover:bg-theme-green/20"
                    />
                    <StatsToggle
                      value={p.chatStatsmercuryEnabled ?? true}
                      onChange={async () => {
                        await api.put(`/api/providers/${p.id}`, { chatStatsmercuryEnabled: !(p.chatStatsmercuryEnabled ?? true) });
                        await load();
                      }}
                      label="Chat"
                      activeColor="text-primary"
                      activeBg="bg-primary/10 hover:bg-primary/20"
                      title="Affiche les stats dans le chat et /status"
                    />
                    <StatsToggle
                      value={p.visionFallbackEnabled ?? false}
                      onChange={async () => {
                        await api.put(`/api/providers/${p.id}`, { visionFallbackEnabled: !p.visionFallbackEnabled });
                        await load();
                      }}
                      label="Vision"
                      activeColor="text-purple-400"
                      activeBg="bg-purple-500/10 hover:bg-purple-500/20"
                      title="Si le modèle ne supporte pas les images, fallback OpenRouter pour décrire en texte"
                    />
                    <StatsToggle
                      value={p.embeddingFallbackEnabled ?? false}
                      onChange={async () => {
                        await api.put(`/api/providers/${p.id}`, { embeddingFallbackEnabled: !p.embeddingFallbackEnabled });
                        await load();
                      }}
                      label="Embed"
                      activeColor="text-theme-orange"
                      activeBg="bg-theme-orange/10 hover:bg-theme-orange/20"
                      title="Route tous les appels d'embedding (memory-store + codebase-search) vers ce provider — il doit exposer /v1/embeddings (broker Mercury)"
                    />
                  </div>
                </div>
              </div>
            )}

          </div>
        ))}
          </div>
        )}

        {/* ── MODELS TAB ── */}
        {provTab === 'models' && (
          <div className="p-6 space-y-4 max-w-3xl mx-auto w-full">
            {providers.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                <Layers size={36} className="text-muted-foreground/15" />
                <p className="text-sm text-muted-foreground/40">Aucun provider configuré</p>
                <button onClick={() => setShowCreate(true)} className="text-xs text-primary hover:text-primary/80">
                  + Ajouter un provider
                </button>
              </div>
            )}
            {providers.map(p => {
              const models = exposureModelsMap[p.id];
              const isLoading = exposureLoadingMap[p.id] ?? false;
              const hidden = hiddenDrafts[p.id] ?? new Set(p.hiddenModelIds ?? []);
              const display = displayDrafts[p.id] ?? (p.modelDisplayNames ?? {});
              const isDirty = exposureDirty[p.id] ?? false;
              const visibleCount = models ? models.filter(m => !hidden.has(m.id)).length : 0;
              const totalCount = models?.length ?? 0;

              return (
                <div key={p.id} className="bg-card rounded-xl border border-border/50 overflow-hidden">

                  {/* Provider header with model count */}
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40">
                    <div className="w-8 h-8 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                      {p.type === 'mercury'
                        ? <Zap size={14} className="text-purple-400" />
                        : <Globe size={14} className="text-sky-400" />
                      }
                    </div>
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-foreground">{p.id}</p>
                      <TypeBadge type={p.type} />
                      {models && (
                        <span className="text-[10px] font-mono text-muted-foreground/50 ml-1">
                          {visibleCount}/{totalCount} visible{visibleCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => void loadExposure(p)}
                        disabled={isLoading}
                        title="Recharger la liste des modèles"
                        className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-primary disabled:opacity-40 transition-colors"
                      >
                        <RefreshCw size={11} className={isLoading ? 'animate-spin' : ''} />
                      </button>
                      {isDirty && (
                        <button
                          onClick={() => void saveExposure(p.id)}
                          className="px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                        >
                          Sauver
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Model list — always visible */}
                  <div className="px-4 py-3">
                    {isLoading && !models && (
                      <p className="text-xs text-muted-foreground/50 py-2">Chargement des modèles…</p>
                    )}
                    {!isLoading && models && models.length === 0 && (
                      <p className="text-xs text-muted-foreground/50 py-2">Aucun modèle détecté</p>
                    )}
                    {models && models.length > 0 && (
                      <div className="border border-border/50 rounded-xl bg-background overflow-hidden">
                        <div className="divide-y divide-border/30">
                          {models.map(m => {
                            const isHidden = hidden.has(m.id);
                            return (
                              <div key={m.id} className={clsx(
                                'px-3 py-2 hover:bg-secondary/40 transition-colors',
                                isHidden && 'opacity-40',
                              )}>
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs text-foreground truncate">{m.name}</p>
                                    {m.name !== m.id && (
                                      <p className="text-[10px] font-mono text-muted-foreground/40 truncate">{m.id}</p>
                                    )}
                                  </div>
                                  {m.contextLength && (
                                    <span className="text-[10px] text-muted-foreground/40 shrink-0 mr-2">
                                      {(m.contextLength / 1000).toFixed(0)}k
                                    </span>
                                  )}
                                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0 cursor-pointer select-none">
                                    <input
                                      type="checkbox"
                                      checked={isHidden}
                                      onChange={() => toggleHiddenModel(p.id, m.id)}
                                      className="accent-primary"
                                    />
                                    Masqué
                                  </label>
                                </div>
                                <input
                                  value={display[m.id] ?? ''}
                                  onChange={e => updateDisplayName(p.id, m.id, e.target.value)}
                                  placeholder="Nom d'affichage…"
                                  className="mt-1.5 w-full bg-secondary border border-border/40 rounded-lg px-2 py-1 text-[11px] font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/25"
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {!isLoading && !models && (
                      <p className="text-xs text-muted-foreground/30 py-2">
                        Connexion au provider en cours…
                      </p>
                    )}
                  </div>

                  {/* Model aliases */}
                  <div className="px-4 pb-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <ChevronRight size={11} className="text-muted-foreground/40" />
                        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/40">Aliases</span>
                        {(p.models?.length ?? 0) > 0 && (
                          <span className="text-[10px] font-mono text-muted-foreground/30">{p.models!.length}</span>
                        )}
                      </div>
                      <button
                        onClick={() => { setAddingModelFor(addingModelFor === p.id ? null : p.id); setNewModel(DEFAULT_MODEL); }}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-primary transition-colors"
                      >
                        <Plus size={10} />
                        Ajouter
                      </button>
                    </div>

                    {/* Add alias form */}
                    {addingModelFor === p.id && (
                      <div className="border border-border/50 rounded-xl bg-background p-3 mb-2 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Alias</label>
                            <input
                              value={newModel.alias}
                              onChange={e => setNewModel(m => ({ ...m, alias: e.target.value }))}
                              placeholder="ex: claude-opus"
                              className="mt-0.5 w-full bg-secondary border border-border/40 rounded-lg px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/25"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Model ID</label>
                            <div className="mt-0.5 flex gap-1">
                              <input
                                value={newModel.modelId}
                                onChange={e => setNewModel(m => ({ ...m, modelId: e.target.value }))}
                                placeholder="ex: claude-3-opus-20250219"
                                className="flex-1 bg-secondary border border-border/40 rounded-lg px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/25"
                              />
                              {models && models.length > 0 && (
                                <button
                                  onClick={() => void openBrowser(p.id)}
                                  className="px-2 py-1 text-[10px] text-muted-foreground bg-secondary border border-border/40 rounded-lg hover:text-primary hover:border-ring transition-colors shrink-0"
                                >
                                  Parcourir
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setAddingModelFor(null)}
                            className="px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Annuler
                          </button>
                          <button
                            onClick={() => void handleAddModel(p.id)}
                            disabled={!newModel.alias || !newModel.modelId}
                            className="px-2.5 py-1 text-[10px] font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 transition-colors"
                          >
                            Créer alias
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Existing aliases */}
                    {(p.models?.length ?? 0) > 0 ? (
                      <div className="border border-border/50 rounded-xl bg-background overflow-hidden divide-y divide-border/30">
                        {p.models!.map(m => (
                          <div key={m.alias} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-secondary/40 transition-colors">
                            <div className="min-w-0 flex-1">
                              <span className="text-xs font-mono text-primary">{m.alias}</span>
                              <span className="text-[10px] text-muted-foreground/40 mx-1.5">→</span>
                              <span className="text-[10px] font-mono text-muted-foreground/60">{m.modelId}</span>
                            </div>
                            <button
                              onClick={() => void handleDeleteModel(p.id, m.alias)}
                              className="p-1 text-destructive/30 hover:text-destructive hover:bg-destructive/10 rounded transition-colors shrink-0"
                              title="Supprimer cet alias"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] text-muted-foreground/25">Aucun alias configuré</p>
                    )}
                  </div>

                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Live model browser modal */}
      {browsingFor && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl w-full max-w-lg shadow-2xl border border-border/50 flex flex-col max-h-[70vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
              <p className="text-sm font-semibold text-foreground">Choisir un modèle</p>
              <button onClick={closeBrowser} className="text-muted-foreground/50 hover:text-foreground transition-colors">
                <X size={15} />
              </button>
            </div>
            <div className="px-3 py-2 border-b border-border/30 shrink-0">
              <div className="flex items-center gap-2 bg-secondary rounded-lg px-2.5 py-1.5">
                <Search size={12} className="text-muted-foreground/40 shrink-0" />
                <input
                  ref={searchRef}
                  value={liveSearch}
                  onChange={e => setLiveSearch(e.target.value)}
                  placeholder="Rechercher…"
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-border/20">
              {liveLoading && <p className="px-4 py-6 text-sm text-muted-foreground/50">Chargement des modèles…</p>}
              {!liveLoading && filteredLive.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground/50">Aucun modèle trouvé</p>}
              {filteredLive.map(m => (
                <button
                  key={m.id}
                  onClick={() => selectLiveModel(m)}
                  className="w-full flex items-start gap-3 px-4 py-2.5 hover:bg-secondary/50 text-left transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{m.name}</p>
                    {m.name !== m.id && <p className="text-[11px] font-mono text-muted-foreground/50 truncate">{m.id}</p>}
                  </div>
                  {m.contextLength && (
                    <span className="text-[10px] text-muted-foreground/40 shrink-0 mt-0.5">
                      {(m.contextLength / 1000).toFixed(0)}k ctx
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Create provider modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl w-full max-w-md shadow-2xl border border-border/50 overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
              <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                <Cpu size={15} className="text-primary" />
              </div>
              <h2 className="text-[14px] font-semibold text-foreground">Nouveau provider</h2>
            </div>

            <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
              <Field label="Identifiant">
                <TextInput value={newProvider.id} onChange={v => setNewProvider(p => ({ ...p, id: v }))} placeholder="local" />
              </Field>
              <Field label="Type">
                <select
                  value={newProvider.type}
                  onChange={e => setNewProvider(p => ({ ...p, type: e.target.value as 'mercury' | 'openai-compat' }))}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none"
                >
                  <option value="openai-compat">openai-compat</option>
                  <option value="mercury">mercury</option>
                </select>
              </Field>
              <Field label="Base URL">
                <TextInput value={newProvider.baseUrl} onChange={v => setNewProvider(p => ({ ...p, baseUrl: v }))} />
              </Field>
              <Field label="Models URL (optionnel)">
                <TextInput value={newProvider.modelsUrl} onChange={v => setNewProvider(p => ({ ...p, modelsUrl: v }))} placeholder="http://localhost:17890/api/tags" />
              </Field>
              <Field label="Stats URL (optionnel)">
                <TextInput value={newProvider.statsUrl} onChange={v => setNewProvider(p => ({ ...p, statsUrl: v }))} placeholder="http://192.168.1.x:17890" />
              </Field>
              <Field label="API Key (optionnel)">
                <PasswordInput value={newProvider.apiKey} onChange={v => setNewProvider(p => ({ ...p, apiKey: v }))} placeholder="sk-…" />
              </Field>
              <Field label="Stats API Key (optionnel)">
                <PasswordInput value={newProvider.statsApiKey} onChange={v => setNewProvider(p => ({ ...p, statsApiKey: v }))} placeholder="Token admin — vide = utilise API Key" />
              </Field>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/50 bg-card/50">
              <button
                onClick={() => { setShowCreate(false); setNewProvider(DEFAULT_PROVIDER); }}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !newProvider.id || !newProvider.baseUrl}
                className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {creating ? 'Création…' : 'Créer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Helper sub-components ── */

function InfoRow({ icon, label, value, mono }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="text-muted-foreground/30 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground/40">{label}</p>
        <p className={clsx('text-[12px] text-foreground/70 truncate', mono && 'font-mono')}>{value}</p>
      </div>
    </div>
  );
}

function StatsToggle({ value, onChange, label, activeColor, activeBg, title }: {
  value: boolean;
  onChange: () => void;
  label: string;
  activeColor: string;
  activeBg: string;
  title?: string;
}) {
  return (
    <button
      onClick={onChange}
      title={title}
      className={clsx(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors',
        value
          ? clsx(activeColor, activeBg)
          : 'text-muted-foreground/40 bg-secondary hover:bg-secondary/80 hover:text-muted-foreground',
      )}
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full', value ? 'bg-current' : 'bg-muted-foreground/30')} />
      {label}
    </button>
  );
}
