import { useState, useEffect, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Settings, Server, FolderOpen, Sliders, Wrench,
  Zap, Search, FileText, Database, Layers, Palette,
  RotateCw, Eye, EyeOff, CheckCircle2, Clock, Brain,
} from 'lucide-react';
import { api } from '../lib/api';
import type { ProviderOption } from './agents/types';
import { useTheme } from '../contexts/ThemeContext';
import { themes, themeNames, type ThemeName } from '../lib/themes';
import { ModelPickerPopup } from '../components/ModelPickerPopup';
import { PushSettingsCard } from '../components/PushSettingsCard';

type ConsolidationStatus = 'idle' | 'running' | 'done' | 'error';

interface ConsolidationDraft {
  chatEnabled: boolean;
  chatCronHour: number;
  chatModel: string;
  chatValidateSummaries: boolean;
  chatMinSummaryChars: number;
  memoryEnabled: boolean;
  memoryCronSchedule: 'weekly' | 'daily';
  memoryCronHour: number;
  memoryMergeModel: string;
  scoringRecencyWeight: number;
  scoringFrequencyWeight: number;
  scoringAgeWeight: number;
  scoringRecencyHalfLifeDays: number;
  scoringMaxAgeDays: number;
  clusteringMergeThreshold: number;
  clusteringMaxPairsPerRun: number;
  clusteringMaxClusterSize: number;
  archivalScoreThreshold: number;
  archivalMinAgeDays: number;
  delayBetweenMergesMs: number;
}

interface ToolDefaults {
  bashTimeoutMs?: number;
  webFetchMaxChars?: number;
  maxToolTurns?: number;
  maxReasoningCalls?: number;
  maxReasoningInputChars?: number;
  maxIdenticalToolCalls?: number;
  autoAbortOnLoopGuard?: boolean;
}

interface AutoWarmupDraft {
  enabled: boolean;
  promptCacheTtl: number;
  globalWarmupIdleMinutes: number;
  fileDebounceSeconds: number;
  recentActivityHours: number;
}

interface Config {
  server: { host: string; port: number; apiKey: string };
  paths: { agentsDir: string; sharedMemoryDir: string; compactArchivesDir?: string; skillsDir?: string; userImagesDir?: string; subagentReportsDir?: string };
  defaults: {
    model: string;
    temperature: number;
    maxContextTokens: number;
    promptCacheTtl?: number;
    toolDefaults?: ToolDefaults;
    autoWarmup?: {
      enabled?: boolean;
      globalWarmupIdleMinutes?: number;
      fileDebounceSeconds?: number;
      recentActivityHours?: number;
    };
    autoUnloadOnSwitch?: boolean;
    cacheOptimized?: boolean;
    /** @deprecated YAML-only override, hidden from UI. */
    stripThinkBlocks?: boolean;
  };
  database: { host: string; port: number; database: string; password: string };
  telegram: { enabled: boolean; botToken: string };
  search?: { braveApiKey?: string };
  logging?: {
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    file?: string;
    maxFileSizeMb: number;
    maxFiles: number;
  };
  openingHours?: {
    enabled?: boolean;
    closedStart?: number;
    closedEnd?: number;
    overrideOpen?: boolean;
  };
  consolidation?: {
    chat?: { enabled?: boolean; cronHour?: number; model?: string; validateSummaries?: boolean; minSummaryChars?: number };
    memory?: { enabled?: boolean; cronSchedule?: string; cronHour?: number; mergeModel?: string; scoring?: Record<string, number>; clustering?: Record<string, number>; archival?: Record<string, number>; delayBetweenMergesMs?: number };
  };
  /** @deprecated */
  memoryConsolidation?: { enabled?: boolean; cronSchedule?: string; cronHour?: number; mergeModel?: string; scoring?: Record<string, number>; clustering?: Record<string, number>; archival?: Record<string, number>; delayBetweenMergesMs?: number };
  subagentDefaults?: { reportInjectionMaxChars?: number };
}

type Tab = 'general' | 'config' | 'systeme';

/* ── Small reusable components ── */

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
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

/* ── Section header helper ── */

function SectionHeader({
  icon: Icon,
  iconBg,
  iconColor,
  title,
  onEdit,
  isEditing,
  isSaving,
  onSave,
  onCancel,
}: {
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  title: string;
  onEdit?: () => void;
  isEditing: boolean;
  isSaving: boolean;
  onSave?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={clsx('w-6 h-6 rounded-lg flex items-center justify-center', iconBg)}>
          <Icon size={12} className={iconColor} />
        </div>
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
      </div>
      {isEditing ? (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Annuler
          </button>
          {onSave && (
            <button
              onClick={onSave}
              disabled={isSaving}
              className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors font-medium"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      ) : onEdit ? (
        <button
          onClick={onEdit}
          title="Éditer"
          className="p-1.5 text-muted-foreground/40 hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
        >
          <Settings size={13} />
        </button>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const { theme, setTheme } = useTheme();

  const [tab, setTab] = useState<Tab>('general');

  const [chatConsolidStatus, setChatConsolidStatus] = useState<ConsolidationStatus>('idle');
  const [chatConsolidResult, setChatConsolidResult] = useState<{ agents: string[]; date: string } | null>(null);
  const [chatConsolidError, setChatConsolidError] = useState<string | null>(null);
  const [memConsolidStatus, setMemConsolidStatus] = useState<ConsolidationStatus>('idle');
  const [memConsolidResult, setMemConsolidResult] = useState<string | null>(null);
  const [dConsolidation, setDConsolidation] = useState<ConsolidationDraft>({
    chatEnabled: true, chatCronHour: 0, chatModel: '', chatValidateSummaries: true, chatMinSummaryChars: 40,
    memoryEnabled: true, memoryCronSchedule: 'weekly', memoryCronHour: 3, memoryMergeModel: '',
    scoringRecencyWeight: 0.5, scoringFrequencyWeight: 0.35, scoringAgeWeight: 0.15,
    scoringRecencyHalfLifeDays: 30, scoringMaxAgeDays: 365,
    clusteringMergeThreshold: 0.75, clusteringMaxPairsPerRun: 200, clusteringMaxClusterSize: 5,
    archivalScoreThreshold: 0.1, archivalMinAgeDays: 60, delayBetweenMergesMs: 1000,
  });
  const [showAdvancedConsolid, setShowAdvancedConsolid] = useState(false);

  // Opening hours draft
  const [dOpeningHours, setDOpeningHours] = useState({ enabled: false, closedStart: 2, closedEnd: 4, overrideOpen: false });

  // Model picker (shared component, 2 targets)
  const [modelPickerProviders, setModelPickerProviders] = useState<ProviderOption[]>([]);
  const [pickerTarget, setPickerTarget] = useState<'chatModel' | 'memoryMergeModel' | null>(null);
  const chatModelBtnRef = useRef<HTMLButtonElement>(null);
  const memoryModelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api.get<ProviderOption[]>('/api/providers').then(setModelPickerProviders).catch(() => {});
  }, []);

  const handleChatConsolidate = async () => {
    setChatConsolidStatus('running');
    setChatConsolidResult(null);
    setChatConsolidError(null);
    try {
      const r = await api.post<{ ok: boolean; agents: string[]; date: string }>('/api/consolidation/run');
      setChatConsolidResult(r);
      setChatConsolidStatus('done');
    } catch (e) {
      setChatConsolidError(e instanceof Error ? e.message : 'Erreur inconnue');
      setChatConsolidStatus('error');
    }
  };

  const handleMemConsolidate = async () => {
    setMemConsolidStatus('running');
    setMemConsolidResult(null);
    try {
      await api.post('/api/memory-consolidation/run');
      setMemConsolidResult('OK');
      setMemConsolidStatus('done');
    } catch (e) {
      setMemConsolidResult(e instanceof Error ? e.message : 'Erreur');
      setMemConsolidStatus('error');
    }
  };

  // per-section edit state
  const [editingSection, setEditingSection] = useState<string | null>(null);

  // draft values
  const [dServer, setDServer] = useState({ host: '', port: 3000, apiKey: '' });
  const [dPaths, setDPaths] = useState({
    agentsDir: '',
    sharedMemoryDir: '',
    compactArchivesDir: '',
    skillsDir: '',
    userImagesDir: '',
    subagentReportsDir: '',
    reportInjectionMaxChars: 12000,
  });
  const [dDefaults, setDDefaults] = useState({ model: '', temperature: 0.7, maxContextTokens: 100000 });
  const [dToolDefaults, setDToolDefaults] = useState<ToolDefaults>({ bashTimeoutMs: 30000, webFetchMaxChars: 20000, maxToolTurns: 10 });
  const [dSearch, setDSearch] = useState({ braveApiKey: '' });
  const [dLogging, setDLogging] = useState({
    level: 'INFO' as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    file: '',
    maxFileSizeMb: 50,
    maxFiles: 5,
  });
  const [dAutoWarmup, setDAutoWarmup] = useState<AutoWarmupDraft>({
    enabled: true,
    promptCacheTtl: 30,
    globalWarmupIdleMinutes: 25,
    fileDebounceSeconds: 3,
    recentActivityHours: 24,
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await api.get<Config>('/api/config');
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, []);

  const startEdit = (section: string) => {
    if (!config) return;
    if (section === 'server') setDServer({ ...config.server });
    if (section === 'paths') {
      setDPaths({
        agentsDir: config.paths.agentsDir,
        sharedMemoryDir: config.paths.sharedMemoryDir,
        compactArchivesDir: config.paths.compactArchivesDir ?? '',
        skillsDir: config.paths.skillsDir ?? '',
        userImagesDir: config.paths.userImagesDir ?? '',
        subagentReportsDir: config.paths.subagentReportsDir ?? '',
        reportInjectionMaxChars: config.subagentDefaults?.reportInjectionMaxChars ?? 12000,
      });
    }
    if (section === 'defaults') setDDefaults({ ...config.defaults });
    if (section === 'toolDefaults') setDToolDefaults({ bashTimeoutMs: 30000, webFetchMaxChars: 20000, maxToolTurns: 10, maxReasoningCalls: 3, maxReasoningInputChars: 8000, maxIdenticalToolCalls: 5, autoAbortOnLoopGuard: true, ...config.defaults.toolDefaults });
    if (section === 'search') setDSearch({ braveApiKey: '' }); // never pre-fill the key
    if (section === 'logging') {
      setDLogging({
        level: config.logging?.level ?? 'INFO',
        file: config.logging?.file ?? '',
        maxFileSizeMb: config.logging?.maxFileSizeMb ?? 50,
        maxFiles: config.logging?.maxFiles ?? 5,
      });
    }
    if (section === 'autoWarmup') {
      setDAutoWarmup({
        enabled: config.defaults.autoWarmup?.enabled !== false,
        promptCacheTtl: config.defaults.promptCacheTtl ?? 30,
        globalWarmupIdleMinutes: config.defaults.autoWarmup?.globalWarmupIdleMinutes ?? 25,
        fileDebounceSeconds: config.defaults.autoWarmup?.fileDebounceSeconds ?? 3,
        recentActivityHours: config.defaults.autoWarmup?.recentActivityHours ?? 24,
      });
    }
    if (section === 'openingHours') {
      const oh = config.openingHours ?? {};
      setDOpeningHours({
        enabled: oh.enabled === true,
        closedStart: oh.closedStart ?? 2,
        closedEnd: oh.closedEnd ?? 4,
        overrideOpen: oh.overrideOpen === true,
      });
    }
    if (section === 'consolidation') {
      const c = config.consolidation ?? {};
      const chat = c.chat ?? {};
      const mem = c.memory ?? config.memoryConsolidation ?? {};
      setDConsolidation({
        chatEnabled: chat.enabled !== false,
        chatCronHour: chat.cronHour ?? 0,
        chatModel: chat.model ?? '',
        chatValidateSummaries: chat.validateSummaries !== false,
        chatMinSummaryChars: chat.minSummaryChars ?? 40,
        memoryEnabled: mem.enabled !== false,
        memoryCronSchedule: (mem.cronSchedule as 'weekly' | 'daily') ?? 'weekly',
        memoryCronHour: mem.cronHour ?? 3,
        memoryMergeModel: mem.mergeModel ?? '',
        scoringRecencyWeight: mem.scoring?.recencyWeight ?? 0.5,
        scoringFrequencyWeight: mem.scoring?.frequencyWeight ?? 0.35,
        scoringAgeWeight: mem.scoring?.ageWeight ?? 0.15,
        scoringRecencyHalfLifeDays: mem.scoring?.recencyHalfLifeDays ?? 30,
        scoringMaxAgeDays: mem.scoring?.maxAgeDays ?? 365,
        clusteringMergeThreshold: mem.clustering?.mergeThreshold ?? 0.75,
        clusteringMaxPairsPerRun: mem.clustering?.maxPairsPerRun ?? 200,
        clusteringMaxClusterSize: mem.clustering?.maxClusterSize ?? 5,
        archivalScoreThreshold: mem.archival?.scoreThreshold ?? 0.1,
        archivalMinAgeDays: mem.archival?.minAgeDaysBeforeArchive ?? 60,
        delayBetweenMergesMs: mem.delayBetweenMergesMs ?? 1000,
      });
    }
    setEditingSection(section);
  };

  const cancelEdit = () => setEditingSection(null);

  const saveSection = async (section: string, data: object) => {
    setSaving(section);
    try {
      await api.put('/api/config', { [section]: data });
      await load();
      setEditingSection(null);
    } catch (e) {
      alert('Erreur : ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(null);
    }
  };

  const savePaths = async () => {
    const { reportInjectionMaxChars, ...pathsOnly } = dPaths;
    setSaving('paths');
    try {
      await api.put('/api/config', { paths: pathsOnly, subagentDefaults: { reportInjectionMaxChars } });
      await load();
      setEditingSection(null);
    } catch (e) {
      alert('Erreur : ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(null);
    }
  };

  const saveConsolidation = async () => {
    const d = dConsolidation;
    await saveSection('consolidation', {
      chat: { enabled: d.chatEnabled, cronHour: d.chatCronHour, model: d.chatModel.trim() || undefined, validateSummaries: d.chatValidateSummaries, minSummaryChars: d.chatMinSummaryChars },
      memory: {
        enabled: d.memoryEnabled, cronSchedule: d.memoryCronSchedule, cronHour: d.memoryCronHour,
        mergeModel: d.memoryMergeModel.trim() || undefined,
        scoring: { recencyWeight: d.scoringRecencyWeight, frequencyWeight: d.scoringFrequencyWeight, ageWeight: d.scoringAgeWeight, recencyHalfLifeDays: d.scoringRecencyHalfLifeDays, maxAgeDays: d.scoringMaxAgeDays },
        clustering: { mergeThreshold: d.clusteringMergeThreshold, maxPairsPerRun: d.clusteringMaxPairsPerRun, maxClusterSize: d.clusteringMaxClusterSize },
        archival: { scoreThreshold: d.archivalScoreThreshold, minAgeDaysBeforeArchive: d.archivalMinAgeDays },
        delayBetweenMergesMs: d.delayBetweenMergesMs,
      },
    });
  };

  const saveOpeningHours = async () => {
    await saveSection('openingHours', dOpeningHours);
  };

  // Reboot the backend service. Backend exits the Node process with code 0;
  // systemd (Restart=always in mastermind.service) restarts it within ~5–10s.
  // The WS layer auto-reconnects every 2s and re-subscribes — so the user sees
  // a brief blackout then everything resumes. In dev (no supervisor) the
  // process just dies; relaunch via `npm start` manually.
  const handleReboot = useCallback(async () => {
    if (rebooting) return;
    if (!window.confirm(
      'Redémarrer Mastermind ?\n\n'
      + '• Tous les agents en cours d\'inférence seront coupés\n'
      + '• Le KV cache des modèles sera perdu (warmup à refaire)\n'
      + '• Indispo ~5–10s pendant le restart systemd\n\n'
      + 'Continuer ?',
    )) return;

    setRebooting(true);
    try {
      await api.post('/api/system/reboot');
      // The backend response comes back ~250ms before process.exit(0).
      // We don't auto-reload — the WS reconnect will signal recovery and the
      // user can refresh the data manually. Leave the rebooting state on for
      // ~12s so the spinner is visible across the actual blackout window.
      setTimeout(() => setRebooting(false), 12_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reboot a échoué');
      setRebooting(false);
    }
  }, [rebooting]);

  const reloadInFlight = useRef(false);
  const handleReload = useCallback(async () => {
    if (reloadInFlight.current) return;
    reloadInFlight.current = true;
    setReloading(true);
    try {
      await api.post('/api/config/reload', { force: false }).catch(() => {});
      await load();
    } finally {
      reloadInFlight.current = false;
      setReloading(false);
    }
  }, [load]);

  // Auto-refresh every 30s, only when not editing.
  useEffect(() => {
    if (loading) return;
    if (editingSection) return;

    const id = setInterval(() => {
      void handleReload();
    }, 30_000);

    return () => clearInterval(id);
  }, [loading, editingSection, handleReload]);

  if (loading) return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      Chargement…
    </div>
  );

  if (error) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3">
      <p className="text-sm text-destructive">Erreur : {error}</p>
      <button onClick={load} className="px-3 py-1.5 text-xs bg-secondary text-muted-foreground rounded-lg hover:bg-muted transition-colors">
        Réessayer
      </button>
    </div>
  );

  if (!config) return null;

  const isEditing = (s: string) => editingSection === s;
  const isSaving = (s: string) => saving === s;

  const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'general', label: 'Général',  icon: Sliders  },
    { id: 'config',  label: 'Config',   icon: Server   },
    { id: 'systeme', label: 'Système',  icon: FileText },
  ];

  const inputCls = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring';
  const inputMonoCls = inputCls + ' font-mono';

  return (
    <div className="flex-1 flex flex-col min-h-0">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/30 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-muted/60 flex items-center justify-center">
            <Settings size={15} className="text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-[15px] font-bold text-foreground">Settings</h1>
            <p className="text-[11px] text-muted-foreground/50">Configuration du serveur Mastermind</p>
          </div>
        </div>
        <button
          onClick={handleReload}
          disabled={reloading || !!editingSection}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground bg-secondary hover:bg-secondary/80 rounded-lg transition-colors disabled:opacity-50"
        >
          <RotateCw size={12} className={reloading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 px-6 border-b border-border bg-card/20 shrink-0">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
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

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-3 max-w-2xl mx-auto w-full">

          {/* ═══════════ TAB: GÉNÉRAL ═══════════ */}
          {tab === 'general' && (
            <>
              {/* ── APPARENCE ── */}
              <div className="bg-card rounded-xl border border-border/50 p-4 space-y-4">
                <SectionHeader
                  icon={Palette} iconBg="bg-violet-500/10" iconColor="text-violet-400/70"
                  title="Apparence"
                  isEditing={false} isSaving={false} onCancel={cancelEdit}
                />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-foreground/80">Thème</p>
                    <p className="text-[11px] text-muted-foreground/40">Apparence globale de l'interface</p>
                  </div>
                  <select
                    value={theme}
                    onChange={e => setTheme(e.target.value as ThemeName)}
                    className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-ring"
                  >
                    {themeNames.map(t => (
                      <option key={t} value={t}>{themes[t].label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ── DEFAULTS ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <SectionHeader
                    icon={Sliders} iconBg="bg-indigo-500/10" iconColor="text-indigo-400/70"
                    title="Defaults"
                    onEdit={() => startEdit('defaults')}
                    isEditing={isEditing('defaults')} isSaving={isSaving('defaults')}
                    onSave={() => saveSection('defaults', dDefaults)}
                    onCancel={cancelEdit}
                  />
                </div>

                {isEditing('defaults') ? (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3 bg-card/50">
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Default Model</label>
                      <input value={dDefaults.model} onChange={e => setDDefaults(p => ({ ...p, model: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)}
                        placeholder="anthropic/claude-sonnet-4" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Temperature</label>
                        <input type="number" step="0.1" min="0" max="2" value={dDefaults.temperature}
                          onChange={e => setDDefaults(p => ({ ...p, temperature: Number(e.target.value) }))}
                          className={clsx('mt-1', inputCls)} />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Max Context Tokens</label>
                        <input type="number" value={dDefaults.maxContextTokens}
                          onChange={e => setDDefaults(p => ({ ...p, maxContextTokens: Number(e.target.value) }))}
                          className={clsx('mt-1', inputCls)} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 grid grid-cols-3 gap-3">
                    <div className="col-span-3">
                      <span className="text-[11px] text-muted-foreground/50">Default Model</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.defaults.model}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Temperature</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.defaults.temperature}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-[11px] text-muted-foreground/50">Max Context Tokens</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.defaults.maxContextTokens?.toLocaleString()}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── OUTILS ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4">
                  <SectionHeader
                    icon={Wrench} iconBg="bg-muted/60" iconColor="text-muted-foreground/60"
                    title="Outils"
                    onEdit={() => startEdit('toolDefaults')}
                    isEditing={isEditing('toolDefaults')} isSaving={isSaving('toolDefaults')}
                    onSave={() => saveSection('defaults', { ...config!.defaults, toolDefaults: dToolDefaults })}
                    onCancel={cancelEdit}
                  />
                </div>

                {isEditing('toolDefaults') ? (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 grid grid-cols-2 gap-3 bg-card/50">
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Bash timeout (ms)</label>
                      <input type="number" value={dToolDefaults.bashTimeoutMs ?? 30000}
                        onChange={e => setDToolDefaults(p => ({ ...p, bashTimeoutMs: Number(e.target.value) }))}
                        className={clsx('mt-1', inputCls)} />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Web fetch max (chars)</label>
                      <input type="number" value={dToolDefaults.webFetchMaxChars ?? 20000}
                        onChange={e => setDToolDefaults(p => ({ ...p, webFetchMaxChars: Number(e.target.value) }))}
                        className={clsx('mt-1', inputCls)} />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Max tool turns</label>
                      <input type="number" min="1" max="50" value={dToolDefaults.maxToolTurns ?? 10}
                        onChange={e => setDToolDefaults(p => ({ ...p, maxToolTurns: Number(e.target.value) }))}
                        className={clsx('mt-1', inputCls)} />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Max identical tool calls</label>
                      <input type="number" min="0" max="50" value={dToolDefaults.maxIdenticalToolCalls ?? 5}
                        onChange={e => setDToolDefaults(p => ({ ...p, maxIdenticalToolCalls: Number(e.target.value) }))}
                        className={clsx('mt-1', inputCls)} />
                      <p className="mt-1 text-[10px] text-muted-foreground/50">Loop guard : nb max d'appels consécutifs identiques (même name + args) avant soft-refuse. 0 = désactivé.</p>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Auto-abort on loop</label>
                      <label className="mt-1 flex items-center gap-2 text-[13px] text-foreground">
                        <input type="checkbox"
                          checked={dToolDefaults.autoAbortOnLoopGuard ?? true}
                          onChange={e => setDToolDefaults(p => ({ ...p, autoAbortOnLoopGuard: e.target.checked }))} />
                        <span>{(dToolDefaults.autoAbortOnLoopGuard ?? true) ? 'enabled' : 'disabled'}</span>
                      </label>
                      <p className="mt-1 text-[10px] text-muted-foreground/50">Si le loop guard fire 2× d'affilée sur la même signature (modèle ignore le warning), abort le run. Coupe l'herbe sous le pied du modèle stuck.</p>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Max reasoning calls</label>
                      <input type="number" min="0" max="20" value={dToolDefaults.maxReasoningCalls ?? 3}
                        onChange={e => setDToolDefaults(p => ({ ...p, maxReasoningCalls: Number(e.target.value) }))}
                        className={clsx('mt-1', inputCls)} />
                    </div>
                    <div className="col-span-2">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Max reasoning input chars</label>
                      <input type="number" min="1000" max="100000" step="1000" value={dToolDefaults.maxReasoningInputChars ?? 8000}
                        onChange={e => setDToolDefaults(p => ({ ...p, maxReasoningInputChars: Number(e.target.value) }))}
                        className={clsx('mt-1', inputCls)} />
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 grid grid-cols-2 gap-3">
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Bash timeout</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.defaults.toolDefaults?.bashTimeoutMs ?? 30000} ms</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Web fetch max</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.defaults.toolDefaults?.webFetchMaxChars ?? 20000} chars</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Max tool turns</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.defaults.toolDefaults?.maxToolTurns ?? 10}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Max identical tool calls</span>
                      <p className="mt-1 text-[13px] text-foreground">
                        {(config.defaults.toolDefaults?.maxIdenticalToolCalls ?? 5) === 0
                          ? 'disabled'
                          : config.defaults.toolDefaults?.maxIdenticalToolCalls ?? 5}
                      </p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Auto-abort on loop</span>
                      <p className="mt-1 text-[13px] text-foreground">
                        {(config.defaults.toolDefaults?.autoAbortOnLoopGuard ?? true) ? 'enabled' : 'disabled'}
                      </p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Max reasoning calls</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.defaults.toolDefaults?.maxReasoningCalls ?? 3}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-[11px] text-muted-foreground/50">Max reasoning input chars</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.defaults.toolDefaults?.maxReasoningInputChars ?? 8000}</p>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ═══════════ TAB: CONFIG ═══════════ */}
          {tab === 'config' && (
            <>
              {/* ── SERVER ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4">
                  <SectionHeader
                    icon={Server} iconBg="bg-sky-500/10" iconColor="text-sky-400/70"
                    title="Server"
                    onEdit={() => startEdit('server')}
                    isEditing={isEditing('server')} isSaving={isSaving('server')}
                    onSave={() => saveSection('server', dServer)}
                    onCancel={cancelEdit}
                  />
                </div>

                {isEditing('server') ? (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3 bg-card/50">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Host</label>
                        <input value={dServer.host} onChange={e => setDServer(p => ({ ...p, host: e.target.value }))}
                          className={clsx('mt-1', inputCls)} />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Port</label>
                        <input type="number" value={dServer.port} onChange={e => setDServer(p => ({ ...p, port: Number(e.target.value) }))}
                          className={clsx('mt-1', inputCls)} />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">API Key</label>
                      <input value={dServer.apiKey} onChange={e => setDServer(p => ({ ...p, apiKey: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)} />
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 grid grid-cols-2 gap-3">
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Host</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.server.host}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Port</span>
                      <p className="mt-1 text-[13px] text-foreground">{config.server.port}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-[11px] text-muted-foreground/50">API Key</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.server.apiKey}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── PATHS ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4">
                  <SectionHeader
                    icon={FolderOpen} iconBg="bg-orange-500/10" iconColor="text-orange-400/70"
                    title="Paths"
                    onEdit={() => startEdit('paths')}
                    isEditing={isEditing('paths')} isSaving={isSaving('paths')}
                    onSave={savePaths}
                    onCancel={cancelEdit}
                  />
                </div>

                {isEditing('paths') ? (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3 bg-card/50">
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Agents Directory</label>
                      <input value={dPaths.agentsDir} onChange={e => setDPaths(p => ({ ...p, agentsDir: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)} />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Shared Memory Directory</label>
                      <input value={dPaths.sharedMemoryDir} onChange={e => setDPaths(p => ({ ...p, sharedMemoryDir: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)} />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Compact Archives Directory (optionnel)</label>
                      <input value={dPaths.compactArchivesDir} onChange={e => setDPaths(p => ({ ...p, compactArchivesDir: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)}
                        placeholder="ex: ./archives/compact" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Skills Directory (optionnel)</label>
                      <input value={dPaths.skillsDir} onChange={e => setDPaths(p => ({ ...p, skillsDir: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)}
                        placeholder="ex: ~/.cursor/skills-cursor" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">User Images Directory (optionnel)</label>
                      <input value={dPaths.userImagesDir} onChange={e => setDPaths(p => ({ ...p, userImagesDir: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)}
                        placeholder="vide → <sharedMemoryDir>/user-images/" />
                      <p className="text-[11px] text-muted-foreground/50 mt-1">
                        Où Mastermind dump les images uploadées dans le chat pour que les agents puissent les passer en path à des outils (édition d'image via media-gen, OCR, etc.). Si vide, défaut sous shared-memory.
                      </p>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Rapports sub-agents (optionnel)</label>
                      <input value={dPaths.subagentReportsDir} onChange={e => setDPaths(p => ({ ...p, subagentReportsDir: e.target.value }))}
                        className={clsx('mt-1', inputMonoCls)}
                        placeholder="ex: /home/…/shared-memory/rapport ou ./rapports-subagents" />
                      <p className="text-[11px] text-muted-foreground/50 mt-1">
                        Chaque rapport Markdown (submit_subagent_report) est écrit sous <code className="bg-secondary px-1 rounded text-[10px]">&lt;chemin&gt;/&lt;id_preset&gt;/&lt;jobId&gt;.md</code>. Vide = pas d&apos;écriture disque (PostgreSQL inchangé).
                      </p>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Cap réinjection rapport sub-agent (chars)</label>
                      <input type="number" min={500} max={200000} value={dPaths.reportInjectionMaxChars} onChange={e => setDPaths(p => ({ ...p, reportInjectionMaxChars: Math.max(500, Math.min(200000, Number(e.target.value) || 12000)) }))}
                        className={clsx('mt-1', inputMonoCls)} />
                      <p className="text-[11px] text-muted-foreground/50 mt-1">
                        Taille max du rapport <strong>réinjecté</strong> dans le re-run du parent (le rapport complet reste en DB, cap 200k). Évite qu&apos;un gros rapport déclenche un auto-compact coûteux. Défaut : 12000.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3">
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Agents Directory</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.paths.agentsDir}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Shared Memory</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.paths.sharedMemoryDir}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Compact Archives</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.paths.compactArchivesDir || 'workspace/archives (par défaut)'}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Skills</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.paths.skillsDir || '— (non configuré)'}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">User Images</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.paths.userImagesDir || `${config.paths.sharedMemoryDir}/user-images (par défaut)`}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Rapports sub-agents</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.paths.subagentReportsDir || '— (disque désactivé, DB uniquement)'}</p>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground/50">Cap réinjection rapport sub-agent</span>
                      <p className="mt-1 text-[13px] text-foreground font-mono">{config.subagentDefaults?.reportInjectionMaxChars ?? 12000} chars</p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── SEARCH ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4">
                  <SectionHeader
                    icon={Search} iconBg="bg-theme-green/10" iconColor="text-theme-green/70"
                    title="Search"
                    onEdit={() => startEdit('search')}
                    isEditing={isEditing('search')} isSaving={isSaving('search')}
                    onSave={() => saveSection('search', dSearch)}
                    onCancel={cancelEdit}
                  />
                </div>
                <div className="border-t border-border/50 px-4 pb-4 pt-1">
                  <p className="text-[11px] text-muted-foreground/50 mb-3">
                    Brave Web Search — active le tool <code className="bg-secondary px-1 rounded text-[10px]">web_search</code> pour tous les agents
                  </p>

                  {isEditing('search') ? (
                    <div className="bg-card/50 space-y-2">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Brave Search API Key</label>
                      <PasswordInput
                        value={dSearch.braveApiKey}
                        onChange={v => setDSearch({ braveApiKey: v })}
                        placeholder="BSAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      />
                      <p className="text-[11px] text-muted-foreground/50">
                        Obtenir une clé sur{' '}
                        <a href="https://brave.com/search/api/" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          brave.com/search/api
                        </a>{' '}
                        · Plan gratuit : 2 000 req/mois
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      {config.search?.braveApiKey ? (
                        <>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-theme-green/10 text-theme-green text-[10px] font-medium">
                            <CheckCircle2 size={10} />
                            Configuré
                          </span>
                          <span className="text-[13px] text-foreground font-mono">{config.search.braveApiKey}</span>
                        </>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/50">Aucune clé configurée — tool web_search désactivé</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ═══════════ TAB: SYSTÈME ═══════════ */}
          {tab === 'systeme' && (
            <>
              {/* ── NOTIFICATIONS MOBILE (PUSH / APNs) ── */}
              <PushSettingsCard />

              {/* ── CACHE & AUTO-WARMUP ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4">
                  <SectionHeader
                    icon={Zap} iconBg="bg-yellow-500/10" iconColor="text-yellow-400/70"
                    title="Cache & Auto-warmup"
                    onEdit={() => startEdit('autoWarmup')}
                    isEditing={isEditing('autoWarmup')} isSaving={isSaving('autoWarmup')}
                    onSave={() => saveSection('defaults', {
                      ...config!.defaults,
                      promptCacheTtl: dAutoWarmup.promptCacheTtl,
                      autoWarmup: {
                        enabled: dAutoWarmup.enabled,
                        globalWarmupIdleMinutes: dAutoWarmup.globalWarmupIdleMinutes,
                        fileDebounceSeconds: dAutoWarmup.fileDebounceSeconds,
                        recentActivityHours: dAutoWarmup.recentActivityHours,
                      },
                    })}
                    onCancel={cancelEdit}
                  />
                </div>
                <div className="border-t border-border/50 px-4 pb-4 pt-1">
                  <p className="text-[11px] text-muted-foreground/50 mb-3">
                    Maintient le cache prompt chaud automatiquement — élimine le prompt processing entre les messages
                  </p>

                  {isEditing('autoWarmup') ? (
                    <div className="space-y-3 bg-card/50">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-foreground/80">Auto-warmup activé</p>
                          <p className="text-[11px] text-muted-foreground/40">Déclenche le warmup automatiquement</p>
                        </div>
                        <Toggle
                          value={dAutoWarmup.enabled}
                          onChange={() => setDAutoWarmup(p => ({ ...p, enabled: !p.enabled }))}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">TTL cache (min)</label>
                          <input type="number" min="1" max="1440" value={dAutoWarmup.promptCacheTtl}
                            onChange={e => setDAutoWarmup(p => ({ ...p, promptCacheTtl: Math.max(1, Number(e.target.value)) }))}
                            className={clsx('mt-1', inputCls)} />
                          <p className="mt-0.5 text-[11px] text-muted-foreground/40">Durée avant expiration du cache</p>
                        </div>
                        <div>
                          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Inactivité avant warmup (min)</label>
                          <input type="number" min="1" max="120" value={dAutoWarmup.globalWarmupIdleMinutes}
                            onChange={e => setDAutoWarmup(p => ({ ...p, globalWarmupIdleMinutes: Math.max(1, Number(e.target.value)) }))}
                            className={clsx('mt-1', inputCls)} />
                          <p className="mt-0.5 text-[11px] text-muted-foreground/40">Durée d'inactivité globale avant déclenchement</p>
                        </div>
                        <div>
                          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Debounce fichier (s)</label>
                          <input type="number" min="1" max="30" value={dAutoWarmup.fileDebounceSeconds}
                            onChange={e => setDAutoWarmup(p => ({ ...p, fileDebounceSeconds: Math.max(1, Number(e.target.value)) }))}
                            className={clsx('mt-1', inputCls)} />
                          <p className="mt-0.5 text-[11px] text-muted-foreground/40">Délai après modif d&apos;un fichier starred</p>
                        </div>
                        <div>
                          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Fenêtre activité (h)</label>
                          <input type="number" min="1" max="168" value={dAutoWarmup.recentActivityHours}
                            onChange={e => setDAutoWarmup(p => ({ ...p, recentActivityHours: Math.max(1, Number(e.target.value)) }))}
                            className={clsx('mt-1', inputCls)} />
                          <p className="mt-0.5 text-[11px] text-muted-foreground/40">Sessions actives dans cette fenêtre sont warmées</p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <span className={clsx(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium',
                          config.defaults.autoWarmup?.enabled !== false
                            ? 'bg-theme-green/10 text-theme-green'
                            : 'bg-muted text-muted-foreground',
                        )}>
                          <span className={clsx(
                            'w-1.5 h-1.5 rounded-full',
                            config.defaults.autoWarmup?.enabled !== false ? 'bg-theme-green animate-pulse' : 'bg-muted-foreground/40',
                          )} />
                          {config.defaults.autoWarmup?.enabled !== false ? 'Activé' : 'Désactivé'}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-3">
                        <div>
                          <span className="text-[11px] text-muted-foreground/50">TTL cache</span>
                          <p className="mt-1 text-[13px] text-foreground">{config.defaults.promptCacheTtl ?? 30} min</p>
                        </div>
                        <div>
                          <span className="text-[11px] text-muted-foreground/50">Inactivité warmup</span>
                          <p className="mt-1 text-[13px] text-foreground">{config.defaults.autoWarmup?.globalWarmupIdleMinutes ?? 25} min</p>
                        </div>
                        <div>
                          <span className="text-[11px] text-muted-foreground/50">Debounce fichier</span>
                          <p className="mt-1 text-[13px] text-foreground">{config.defaults.autoWarmup?.fileDebounceSeconds ?? 3} s</p>
                        </div>
                        <div>
                          <span className="text-[11px] text-muted-foreground/50">Fenêtre activité</span>
                          <p className="mt-1 text-[13px] text-foreground">{config.defaults.autoWarmup?.recentActivityHours ?? 24} h</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── AUTO-UNLOAD ON SWITCH ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center shrink-0">
                      <RotateCw size={15} className="text-theme-orange/70" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">Auto-unload au switch de modèle</h3>
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                        Décharge le modèle précédent à chaque changement (UI chat, Telegram, edit agent). À désactiver
                        quand plusieurs agents partagent le même modèle — le switch devient instantané car aucun
                        reload n'est nécessaire. Togglable aussi depuis la barre du chat.
                      </p>
                    </div>
                  </div>
                  <Toggle
                    value={config.defaults.autoUnloadOnSwitch !== false}
                    onChange={() => {
                      const next = !(config.defaults.autoUnloadOnSwitch !== false);
                      void (async () => {
                        try {
                          await api.put('/api/config', { defaults: { autoUnloadOnSwitch: next } });
                          await load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'Erreur de sauvegarde');
                        }
                      })();
                    }}
                  />
                </div>
              </div>

              {/* ── PROMPT MODE: cache-optimized vs full-context ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                      <Brain size={15} className="text-purple-400/70" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">Mode prompt : <span className="text-purple-400/90">cache-optimized</span> / full context</h3>
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                        ON (défaut, <span className="text-purple-400/80">cache-optimized</span>) : retire du prompt rebuilt les messages dupliqués par <code className="text-[10px] px-1 py-0.5 rounded bg-muted/40">send_to_user</code> (le contenu est déjà dans <code className="text-[10px]">tool_calls.arguments</code> — la LLM ne perd rien). Garde les <code className="text-[10px]">&lt;think&gt;</code>. Le prompt rebuilt match au max le KV slot streamé → prefix-cache hit max (sim_best ~0.99).
                        <br className="my-1" />
                        OFF (full context) : laisse le duplicate dans l'historique pour que la LLM "voie" chaque message envoyé comme un tour assistant standalone. Coût : ~440 tokens/call de mismatch en queue de prompt + redondance.
                        <br className="my-1" />
                        Recommandé ON sur LLM local lent (full attention, single slot). OFF sur cloud rapide ou si tu veux un audit complet côté LLM. Sans effet sur l'affichage UI / Telegram (les messages restent visibles).
                      </p>
                    </div>
                  </div>
                  <Toggle
                    value={config.defaults.cacheOptimized !== false}
                    onChange={() => {
                      const next = !(config.defaults.cacheOptimized !== false);
                      void (async () => {
                        try {
                          await api.put('/api/config', { defaults: { cacheOptimized: next } });
                          await load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'Erreur de sauvegarde');
                        }
                      })();
                    }}
                  />
                </div>
              </div>

              {/* ── LOGGING ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4">
                  <SectionHeader
                    icon={FileText} iconBg="bg-muted/60" iconColor="text-muted-foreground/60"
                    title="Logging"
                    onEdit={() => startEdit('logging')}
                    isEditing={isEditing('logging')} isSaving={isSaving('logging')}
                    onSave={() => saveSection('logging', {
                      level: dLogging.level,
                      file: dLogging.file.trim(),
                      maxFileSizeMb: dLogging.maxFileSizeMb,
                      maxFiles: dLogging.maxFiles,
                    })}
                    onCancel={cancelEdit}
                  />
                </div>
                <div className="border-t border-border/50 px-4 pb-4 pt-1">
                  <p className="text-[11px] text-muted-foreground/50 mb-3">
                    Niveau minimal écrit dans le fichier, rotation par taille. Un redémarrage peut être nécessaire si vous changez le chemin du fichier alors que le serveur tourne.
                  </p>

                  {isEditing('logging') ? (
                    <div className="space-y-3 bg-card/50">
                      <div>
                        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Niveau (écriture fichier)</label>
                        <select
                          value={dLogging.level}
                          onChange={e => setDLogging(p => ({ ...p, level: e.target.value as typeof dLogging.level }))}
                          className={clsx('mt-1', inputCls)}
                        >
                          <option value="DEBUG">DEBUG</option>
                          <option value="INFO">INFO</option>
                          <option value="WARN">WARN</option>
                          <option value="ERROR">ERROR</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Chemin fichier (vide = défaut ../logs/mastermind.log)</label>
                        <input
                          value={dLogging.file}
                          onChange={e => setDLogging(p => ({ ...p, file: e.target.value }))}
                          className={clsx('mt-1', inputMonoCls)}
                          placeholder="ex: ./logs/app.log"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Rotation max (Mo)</label>
                          <input type="number" min={1} max={4096} value={dLogging.maxFileSizeMb}
                            onChange={e => setDLogging(p => ({ ...p, maxFileSizeMb: Math.max(1, Number(e.target.value)) }))}
                            className={clsx('mt-1', inputCls)} />
                        </div>
                        <div>
                          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Fichiers conservés</label>
                          <input type="number" min={2} max={100} value={dLogging.maxFiles}
                            onChange={e => setDLogging(p => ({ ...p, maxFiles: Math.max(2, Math.min(100, Number(e.target.value))) }))}
                            className={clsx('mt-1', inputCls)} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-[11px] text-muted-foreground/50">Niveau</span>
                        <p className="mt-1 text-[13px] text-foreground">{config.logging?.level ?? 'INFO'}</p>
                      </div>
                      <div>
                        <span className="text-[11px] text-muted-foreground/50">Fichiers conservés</span>
                        <p className="mt-1 text-[13px] text-foreground">{config.logging?.maxFiles ?? 5}</p>
                      </div>
                      <div className="col-span-2">
                        <span className="text-[11px] text-muted-foreground/50">Chemin</span>
                        <p className="mt-1 text-[13px] text-foreground font-mono break-all">
                          {config.logging?.file?.trim() ? config.logging.file : '(défaut: ../logs/mastermind.log)'}
                        </p>
                      </div>
                      <div>
                        <span className="text-[11px] text-muted-foreground/50">Rotation (Mo)</span>
                        <p className="mt-1 text-[13px] text-foreground">{config.logging?.maxFileSizeMb ?? 50}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── OPENING HOURS ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4 space-y-3">
                  <SectionHeader
                    icon={Clock} iconBg="bg-sky-500/10" iconColor="text-sky-400/70"
                    title="Heures d'ouverture"
                    onEdit={() => startEdit('openingHours')}
                    isEditing={isEditing('openingHours')} isSaving={isSaving('openingHours')}
                    onSave={() => void saveOpeningHours()} onCancel={cancelEdit}
                  />

                  {isEditing('openingHours') ? (
                    <div className="space-y-3">
                      <p className="text-[11px] text-muted-foreground/50">
                        Bloque les inferences pendant la plage horaire definie. L'override permet de forcer l'ouverture manuellement.
                      </p>
                      <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                        <input type="checkbox" checked={dOpeningHours.enabled} onChange={e => setDOpeningHours(d => ({ ...d, enabled: e.target.checked }))} className="rounded" />
                        Activer les heures d'ouverture
                      </label>
                      {dOpeningHours.enabled && (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[11px] text-muted-foreground block mb-1">Fermeture a (heure)</label>
                              <input type="number" min={0} max={23} value={dOpeningHours.closedStart} onChange={e => setDOpeningHours(d => ({ ...d, closedStart: Number(e.target.value) }))} className={inputCls + ' font-mono'} />
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground block mb-1">Reouverture a (heure)</label>
                              <input type="number" min={0} max={23} value={dOpeningHours.closedEnd} onChange={e => setDOpeningHours(d => ({ ...d, closedEnd: Number(e.target.value) }))} className={inputCls + ' font-mono'} />
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                            <input type="checkbox" checked={dOpeningHours.overrideOpen} onChange={e => setDOpeningHours(d => ({ ...d, overrideOpen: e.target.checked }))} className="rounded" />
                            Override : forcer ouvert maintenant
                          </label>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {config.openingHours?.enabled ? (
                        <>
                          <div className="grid grid-cols-3 gap-3 text-xs">
                            <div><span className="text-muted-foreground">Ferme :</span> <span className="text-foreground font-mono">{config.openingHours.closedStart ?? 2}h — {config.openingHours.closedEnd ?? 4}h</span></div>
                            <div><span className="text-muted-foreground">Status :</span> <span className={(() => {
                              const oh = config.openingHours;
                              if (oh?.overrideOpen) return 'text-theme-orange';
                              const h = new Date().getHours();
                              const closed = (oh?.closedStart ?? 0) <= (oh?.closedEnd ?? 0)
                                ? h >= (oh?.closedStart ?? 0) && h < (oh?.closedEnd ?? 0)
                                : h >= (oh?.closedStart ?? 0) || h < (oh?.closedEnd ?? 0);
                              return closed ? 'text-destructive' : 'text-theme-green';
                            })()}>{(() => {
                              const oh = config.openingHours;
                              if (oh?.overrideOpen) return 'ouvert (override)';
                              const h = new Date().getHours();
                              const closed = (oh?.closedStart ?? 0) <= (oh?.closedEnd ?? 0)
                                ? h >= (oh?.closedStart ?? 0) && h < (oh?.closedEnd ?? 0)
                                : h >= (oh?.closedStart ?? 0) || h < (oh?.closedEnd ?? 0);
                              return closed ? 'ferme' : 'ouvert';
                            })()}</span></div>
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">Override :</span>
                              <Toggle
                                value={config.openingHours.overrideOpen === true}
                                onChange={() => {
                                  const next = !config.openingHours?.overrideOpen;
                                  void (async () => {
                                    try {
                                      await api.put('/api/config', { openingHours: { overrideOpen: next } });
                                      await load();
                                    } catch (e) {
                                      setError(e instanceof Error ? e.message : 'Erreur');
                                    }
                                  })();
                                }}
                              />
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground/50">Desactive — inferences autorisees 24/7</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ── CONSOLIDATION ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4 space-y-3">
                  <SectionHeader
                    icon={Layers} iconBg="bg-purple-500/10" iconColor="text-purple-400/70"
                    title="Consolidation"
                    onEdit={() => startEdit('consolidation')}
                    isEditing={isEditing('consolidation')} isSaving={isSaving('consolidation')}
                    onSave={() => void saveConsolidation()} onCancel={cancelEdit}
                  />

                  {isEditing('consolidation') ? (
                    <div className="space-y-5">
                      {/* ── Chat consolidation ── */}
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-foreground">Consolidation quotidienne (chat)</p>
                        <p className="text-[11px] text-muted-foreground/50">
                          Resume les sessions du jour pour chaque agent → <code className="bg-secondary px-1 rounded text-[10px]">sharedMemory/daily/consolidated/</code>
                        </p>
                        <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                          <input type="checkbox" checked={dConsolidation.chatEnabled} onChange={e => setDConsolidation(d => ({ ...d, chatEnabled: e.target.checked }))} className="rounded" />
                          Activee
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">Heure du cron (0-23)</label>
                            <input type="number" min={0} max={23} value={dConsolidation.chatCronHour} onChange={e => setDConsolidation(d => ({ ...d, chatCronHour: Number(e.target.value) }))} className={inputCls + ' font-mono'} />
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">Modele LLM (vide = modele de l'agent)</label>
                            <div className="flex items-center gap-2">
                              <input value={dConsolidation.chatModel} onChange={e => setDConsolidation(d => ({ ...d, chatModel: e.target.value }))} placeholder="ex: qwen/qwen3-8b" className={inputCls + ' font-mono flex-1'} />
                              {modelPickerProviders.length > 0 && (
                                <button
                                  ref={chatModelBtnRef}
                                  onClick={() => setPickerTarget(t => t === 'chatModel' ? null : 'chatModel')}
                                  className="px-2 py-1 text-xs text-muted-foreground bg-secondary border border-border rounded hover:border-ring hover:text-primary whitespace-nowrap"
                                  title="Parcourir les modèles disponibles"
                                >
                                  Parcourir
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                          <input type="checkbox" checked={dConsolidation.chatValidateSummaries} onChange={e => setDConsolidation(d => ({ ...d, chatValidateSummaries: e.target.checked }))} className="rounded" />
                          Valider le résumé avant écriture (anti prompt-injection)
                        </label>
                        <div className="max-w-[14rem]">
                          <label className="text-[11px] text-muted-foreground block mb-1">Longueur min. du résumé (chars)</label>
                          <input type="number" min={0} max={10000} value={dConsolidation.chatMinSummaryChars} onChange={e => setDConsolidation(d => ({ ...d, chatMinSummaryChars: Number(e.target.value) }))} className={inputCls + ' font-mono'} disabled={!dConsolidation.chatValidateSummaries} />
                          <p className="text-[11px] text-muted-foreground/50 mt-1">En dessous (ou refus LLM) → le résumé n'est pas écrit (donc pas injecté dans le system prompt de tous les agents).</p>
                        </div>
                      </div>

                      <div className="border-t border-border" />

                      {/* ── Memory consolidation ── */}
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-foreground">Consolidation memoire</p>
                        <p className="text-[11px] text-muted-foreground/50">Scoring, clustering, merge LLM et archivage des memoires vectorielles.</p>
                        <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                          <input type="checkbox" checked={dConsolidation.memoryEnabled} onChange={e => setDConsolidation(d => ({ ...d, memoryEnabled: e.target.checked }))} className="rounded" />
                          Activee
                        </label>
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">Frequence</label>
                            <select value={dConsolidation.memoryCronSchedule} onChange={e => setDConsolidation(d => ({ ...d, memoryCronSchedule: e.target.value as 'weekly' | 'daily' }))} className={inputCls}>
                              <option value="weekly">Hebdomadaire</option>
                              <option value="daily">Quotidien</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">Heure du cron (0-23)</label>
                            <input type="number" min={0} max={23} value={dConsolidation.memoryCronHour} onChange={e => setDConsolidation(d => ({ ...d, memoryCronHour: Number(e.target.value) }))} className={inputCls + ' font-mono'} />
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground block mb-1">Modele de merge (vide = defaults.model)</label>
                            <div className="flex items-center gap-2">
                              <input value={dConsolidation.memoryMergeModel} onChange={e => setDConsolidation(d => ({ ...d, memoryMergeModel: e.target.value }))} placeholder="ex: qwen/qwen3-8b" className={inputCls + ' font-mono flex-1'} />
                              {modelPickerProviders.length > 0 && (
                                <button
                                  ref={memoryModelBtnRef}
                                  onClick={() => setPickerTarget(t => t === 'memoryMergeModel' ? null : 'memoryMergeModel')}
                                  className="px-2 py-1 text-xs text-muted-foreground bg-secondary border border-border rounded hover:border-ring hover:text-primary whitespace-nowrap"
                                  title="Parcourir les modèles disponibles"
                                >
                                  Parcourir
                                </button>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Advanced toggle */}
                        <button type="button" onClick={() => setShowAdvancedConsolid(v => !v)} className="text-[11px] text-primary hover:underline">
                          {showAdvancedConsolid ? 'Masquer' : 'Afficher'} les parametres avances
                        </button>

                        {showAdvancedConsolid && (
                          <div className="space-y-3 bg-secondary/30 rounded-lg p-3">
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Scoring</p>
                            <div className="grid grid-cols-3 gap-2">
                              {[
                                { label: 'Recency weight', key: 'scoringRecencyWeight' as const, step: 0.05 },
                                { label: 'Frequency weight', key: 'scoringFrequencyWeight' as const, step: 0.05 },
                                { label: 'Age weight', key: 'scoringAgeWeight' as const, step: 0.05 },
                              ].map(f => (
                                <div key={f.key}>
                                  <label className="text-[10px] text-muted-foreground block mb-0.5">{f.label}</label>
                                  <input type="number" min={0} max={1} step={f.step} value={dConsolidation[f.key]} onChange={e => setDConsolidation(d => ({ ...d, [f.key]: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                                </div>
                              ))}
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Half-life (jours)</label>
                                <input type="number" min={1} value={dConsolidation.scoringRecencyHalfLifeDays} onChange={e => setDConsolidation(d => ({ ...d, scoringRecencyHalfLifeDays: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Max age (jours)</label>
                                <input type="number" min={1} value={dConsolidation.scoringMaxAgeDays} onChange={e => setDConsolidation(d => ({ ...d, scoringMaxAgeDays: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                            </div>

                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-2">Clustering</p>
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Seuil merge</label>
                                <input type="number" min={0.5} max={0.99} step={0.05} value={dConsolidation.clusteringMergeThreshold} onChange={e => setDConsolidation(d => ({ ...d, clusteringMergeThreshold: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Max paires/run</label>
                                <input type="number" min={10} max={1000} value={dConsolidation.clusteringMaxPairsPerRun} onChange={e => setDConsolidation(d => ({ ...d, clusteringMaxPairsPerRun: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Max cluster size</label>
                                <input type="number" min={2} max={20} value={dConsolidation.clusteringMaxClusterSize} onChange={e => setDConsolidation(d => ({ ...d, clusteringMaxClusterSize: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                            </div>

                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-2">Archivage</p>
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Score seuil</label>
                                <input type="number" min={0} max={0.5} step={0.05} value={dConsolidation.archivalScoreThreshold} onChange={e => setDConsolidation(d => ({ ...d, archivalScoreThreshold: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Age min (jours)</label>
                                <input type="number" min={1} value={dConsolidation.archivalMinAgeDays} onChange={e => setDConsolidation(d => ({ ...d, archivalMinAgeDays: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-0.5">Delay merges (ms)</label>
                                <input type="number" min={0} step={500} value={dConsolidation.delayBetweenMergesMs} onChange={e => setDConsolidation(d => ({ ...d, delayBetweenMergesMs: Number(e.target.value) }))} className={inputCls + ' font-mono text-[11px]'} />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Read-only view */}
                      <div>
                        <p className="text-[11px] text-muted-foreground/50 mb-2">Consolidation quotidienne (chat)</p>
                        <div className="grid grid-cols-3 gap-3 text-xs">
                          <div><span className="text-muted-foreground">Active :</span> <span className={config.consolidation?.chat?.enabled !== false ? 'text-theme-green' : 'text-destructive'}>{config.consolidation?.chat?.enabled !== false ? 'oui' : 'non'}</span></div>
                          <div><span className="text-muted-foreground">Heure :</span> <span className="text-foreground font-mono">{config.consolidation?.chat?.cronHour ?? 0}h</span></div>
                          <div><span className="text-muted-foreground">Modele :</span> <span className="text-foreground font-mono">{config.consolidation?.chat?.model || '(agent)'}</span></div>
                          <div><span className="text-muted-foreground">Validation :</span> <span className={config.consolidation?.chat?.validateSummaries !== false ? 'text-theme-green' : 'text-destructive'}>{config.consolidation?.chat?.validateSummaries !== false ? `oui (≥${config.consolidation?.chat?.minSummaryChars ?? 40})` : 'non'}</span></div>
                        </div>
                        <div className="flex items-center gap-3 mt-2">
                          <button onClick={() => void handleChatConsolidate()} disabled={chatConsolidStatus === 'running'} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors font-medium">
                            {chatConsolidStatus === 'running' ? 'En cours...' : 'Lancer'}
                          </button>
                          {chatConsolidStatus === 'done' && chatConsolidResult && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-theme-green"><CheckCircle2 size={11} /> {chatConsolidResult.agents.length} agent(s) — {chatConsolidResult.date}</span>
                          )}
                          {chatConsolidStatus === 'error' && <span className="text-[11px] text-destructive">Erreur : {chatConsolidError}</span>}
                        </div>
                      </div>

                      <div className="border-t border-border" />

                      <div>
                        <p className="text-[11px] text-muted-foreground/50 mb-2">Consolidation memoire</p>
                        <div className="grid grid-cols-3 gap-3 text-xs">
                          <div><span className="text-muted-foreground">Active :</span> <span className={(config.consolidation?.memory ?? config.memoryConsolidation)?.enabled !== false ? 'text-theme-green' : 'text-destructive'}>{(config.consolidation?.memory ?? config.memoryConsolidation)?.enabled !== false ? 'oui' : 'non'}</span></div>
                          <div><span className="text-muted-foreground">Frequence :</span> <span className="text-foreground">{(config.consolidation?.memory ?? config.memoryConsolidation)?.cronSchedule ?? 'weekly'} a {(config.consolidation?.memory ?? config.memoryConsolidation)?.cronHour ?? 3}h</span></div>
                          <div><span className="text-muted-foreground">Modele :</span> <span className="text-foreground font-mono">{(config.consolidation?.memory ?? config.memoryConsolidation)?.mergeModel || '(defaut)'}</span></div>
                        </div>
                        <div className="flex items-center gap-3 mt-2">
                          <button onClick={() => void handleMemConsolidate()} disabled={memConsolidStatus === 'running'} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors font-medium">
                            {memConsolidStatus === 'running' ? 'En cours...' : 'Lancer'}
                          </button>
                          {memConsolidStatus === 'done' && memConsolidResult === 'OK' && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-theme-green"><CheckCircle2 size={11} /> Terminee</span>
                          )}
                          {memConsolidStatus === 'error' && <span className="text-[11px] text-destructive">Erreur : {memConsolidResult}</span>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── DATABASE (read-only) ── */}
              <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg bg-muted/60 flex items-center justify-center">
                      <Database size={12} className="text-muted-foreground/60" />
                    </div>
                    <h2 className="text-[13px] font-semibold text-foreground">Database</h2>
                  </div>
                  <span className="text-[11px] text-muted-foreground/40">via .env / mastermind.yml</span>
                </div>
                <div className="border-t border-border/50 px-4 pb-4 pt-3 grid grid-cols-3 gap-3">
                  <div>
                    <span className="text-[11px] text-muted-foreground/50">Host</span>
                    <p className="mt-1 text-[13px] text-foreground font-mono">{config.database.host}:{config.database.port}</p>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground/50">Database</span>
                    <p className="mt-1 text-[13px] text-foreground">{config.database.database}</p>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground/50">Password</span>
                    <p className="mt-1 text-[13px] text-muted-foreground/40">***</p>
                  </div>
                </div>
              </div>

              {/* ── SERVICE / REBOOT ── */}
              <div className="bg-card rounded-xl border border-red-500/30 overflow-hidden">
                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-red-500/15 flex items-center justify-center">
                      <RotateCw size={13} className={clsx('text-red-400/80', rebooting && 'animate-spin')} />
                    </div>
                    <h2 className="text-[13px] font-semibold text-foreground">Service</h2>
                  </div>
                </div>
                <div className="border-t border-border/50 px-4 pb-4 pt-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground">Redémarrer Mastermind</h3>
                    <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                      Coupe les agents en cours, perd le KV cache, indispo ~5–10s.
                      Suppose <code className="text-[10px] px-1 py-0.5 rounded bg-muted/40">Restart=always</code> dans le systemd unit
                      (sinon le service ne remontera pas tout seul).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleReboot()}
                    disabled={rebooting}
                    className={clsx(
                      'shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                      rebooting
                        ? 'bg-red-500/10 text-red-300/60 border-red-500/20 cursor-not-allowed'
                        : 'bg-red-500/15 text-red-300 hover:bg-red-500/25 border-red-500/30 hover:border-red-500/50',
                    )}
                  >
                    <RotateCw size={12} className={rebooting ? 'animate-spin' : ''} />
                    {rebooting ? 'Reboot en cours…' : 'Reboot service'}
                  </button>
                </div>
              </div>
            </>
          )}

        </div>
      </div>

      <ModelPickerPopup
        isOpen={pickerTarget !== null}
        anchorEl={pickerTarget === 'chatModel' ? chatModelBtnRef.current : pickerTarget === 'memoryMergeModel' ? memoryModelBtnRef.current : null}
        providers={modelPickerProviders}
        currentModelId={pickerTarget === 'chatModel' ? dConsolidation.chatModel : pickerTarget === 'memoryMergeModel' ? dConsolidation.memoryMergeModel : undefined}
        onClose={() => setPickerTarget(null)}
        onSelect={(modelId) => {
          if (pickerTarget) setDConsolidation(d => ({ ...d, [pickerTarget]: modelId }));
          setPickerTarget(null);
        }}
      />
    </div>
  );
}
