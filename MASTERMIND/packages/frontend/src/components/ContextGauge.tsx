import { useState, useEffect, useRef } from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { api } from '../lib/api';
import { fetchExposedModels, getCachedModels } from '../lib/modelsCache';
import type { ProviderStats } from '@mastermind/shared';
import type { ProviderOption } from '../pages/agents/types';
import { ModelPickerPopup } from './ModelPickerPopup';

interface SessionStats {
  sessionId: string;
  agentId: string;
  messageCount: number;
  historyWindow?: number;
  estimatedTokens: number;
  systemPromptTokens?: number;
  maxContextTokens: number;
  effectiveModel: string;
  providerId: string;
}

interface Props {
  sessionId: string | null;
  /** Refresh trigger — increment to force a refetch (e.g. after each message) */
  refreshKey?: number;
  /** Live middleware stats — replaces estimated ctx with real values and adds tok/s */
  providerStats?: ProviderStats | null;
  /** Runtime chrono — elapsed ms for the current/last run */
  elapsedMs?: number;
  /** Whether the agent is actively running (streaming) */
  isRunning?: boolean;
  /** Providers available for the picker dropdown */
  providers?: ProviderOption[];
  /** Fired when the user selects a model from the picker popup */
  onSelectModel?: (modelId: string) => void;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtMax(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}
function formatElapsed(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export default function ContextGauge({
  sessionId, refreshKey, providerStats, elapsedMs = 0, isRunning = false,
  providers = [], onSelectModel,
}: Props) {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [aliasByModel, setAliasByModel] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!sessionId) { setStats(null); return; }
    api.get<SessionStats>(`/api/sessions/${sessionId}/stats`)
      .then(setStats)
      .catch(() => setStats(null));
  }, [sessionId, refreshKey]);

  useEffect(() => {
    const providerId = stats?.providerId;
    if (!providerId) return;
    const cached = getCachedModels(providerId);
    if (cached) {
      const map: Record<string, string> = {};
      for (const m of cached) if (m.name) map[m.id] = m.name;
      setAliasByModel(prev => ({ ...prev, ...map }));
      return;
    }
    fetchExposedModels(providerId)
      .then(models => {
        const map: Record<string, string> = {};
        for (const m of models) if (m.name) map[m.id] = m.name;
        setAliasByModel(prev => ({ ...prev, ...map }));
      })
      .catch(() => { /* ignore — fall back to short id */ });
  }, [stats?.providerId]);

  if (!stats) return null;

  const { estimatedTokens, systemPromptTokens, maxContextTokens, effectiveModel, providerId, messageCount, historyWindow } = stats;
  const displayTokens = providerStats?.promptTokens ?? providerStats?.ctxUsed ?? estimatedTokens;
  const displayMax = providerStats?.ctxMax ?? maxContextTokens;
  const isLive = providerStats != null;
  const pct = Math.min(100, Math.round((displayTokens / displayMax) * 100));

  const color =
    pct >= 85 ? 'bg-destructive' :
    pct >= 60 ? 'bg-yellow-500' :
    'bg-theme-green';
  const textColor =
    pct >= 85 ? 'text-destructive' :
    pct >= 60 ? 'text-yellow-500' :
    'text-theme-green';

  const alias = aliasByModel[effectiveModel];
  const modelLabel = alias ?? (effectiveModel.split('/').pop() ?? effectiveModel);

  const isLoading = providerStats?.isLoading === true;
  const isPromptProcessing = providerStats?.isPromptProcessing === true;
  const promptProgress = providerStats?.promptProcessingProgress;
  const promptTk = providerStats?.promptProcessingTokens;
  const outputTokens = providerStats?.outputTokens;
  const tokPerSec = providerStats?.tokensPerSecond;
  const hasRunData = elapsedMs > 0;

  // cachedTokens est déjà filtré côté backend (omis si 0) — pas besoin de double-check ici.
  // Clamp à 100% pour les rares cas pathologiques où cached > prompt (observé sur certains
  // tiers OpenRouter gratuits qui rapportent mal cached_tokens).
  const cachedTokens = providerStats?.cachedTokens;
  const cacheHitPct = cachedTokens != null && providerStats?.promptTokens
    ? Math.min(100, Math.round((cachedTokens / providerStats.promptTokens) * 100))
    : null;

  const detailLines = [
    isLive
      ? `Context (live): ${displayTokens.toLocaleString()} / ${displayMax.toLocaleString()} tokens (${pct}%)`
      : `Context (est.): ~${estimatedTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens (${pct}%)`,
    isLive ? 'Source: provider (live)' : 'Source: estimation locale',
    systemPromptTokens != null ? `System prompt: ~${systemPromptTokens.toLocaleString()} tokens` : null,
    historyWindow != null ? `Messages: ${messageCount} total, ${historyWindow} in context window` : `Messages: ${messageCount}`,
    tokPerSec != null ? `tok/s: ${tokPerSec.toFixed(1)}` : null,
    providerStats?.promptTokens != null ? `Last prompt: ${providerStats.promptTokens.toLocaleString()} tokens` : null,
    cachedTokens != null ? `Cache hit: ${cachedTokens.toLocaleString()} tokens${cacheHitPct != null ? ` (${cacheHitPct}%)` : ''}` : null,
    outputTokens != null ? `Last output: ${outputTokens.toLocaleString()} tokens` : null,
    hasRunData ? `Elapsed: ${formatElapsed(elapsedMs)}` : null,
    `Model: ${effectiveModel}`,
    alias ? `Alias: ${alias}` : null,
    `Provider: ${providerId}`,
  ].filter(Boolean).join('\n');

  return (
    <div className="flex items-center gap-2" title={detailLines}>
      {/* Run status: dot + elapsed */}
      {hasRunData && (
        <>
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              isRunning ? 'bg-theme-green animate-pulse' : 'bg-muted-foreground/40'
            }`}
          />
          <span className={`text-[10px] font-mono ${isRunning ? 'text-foreground' : 'text-muted-foreground'}`}>
            {formatElapsed(elapsedMs)}
          </span>
        </>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <span className="flex items-center gap-1 text-[10px] font-mono text-yellow-400 animate-pulse">
          <span>⏳</span>
          <span>chargement…</span>
        </span>
      )}

      {/* Prompt processing indicator */}
      {isPromptProcessing && (
        <span className="flex items-center gap-1 text-[10px] font-mono text-blue-400" title={`Traitement du prompt${promptTk != null ? ` — ${promptTk} tokens traités` : ''}`}>
          <span className="opacity-50">prompt</span>
          {promptProgress != null ? (
            <>
              <span className="w-12 h-1 rounded-full bg-blue-900 overflow-hidden inline-block align-middle">
                <span className="h-full bg-blue-400 block rounded-full transition-all" style={{ width: `${promptProgress}%` }} />
              </span>
              <span>{promptProgress}%</span>
            </>
          ) : <span className="animate-pulse">…</span>}
        </span>
      )}

      {/* Context bar + tokens */}
      {!isLoading && !isPromptProcessing && (
        <>
          <div className="w-16 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
          </div>
          <span className={`text-[10px] font-mono ${textColor}`}>
            {fmt(displayTokens)}/{fmtMax(displayMax)}
            {isLive && <span className="ml-0.5 opacity-40">●</span>}
          </span>
        </>
      )}

      {/* Throughput cluster: output + t/s */}
      {!isPromptProcessing && !isLoading && (outputTokens != null || tokPerSec != null) && (
        <span className="flex items-center gap-1.5 font-mono">
          {outputTokens != null && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60">
              <ArrowUp size={10} className="opacity-60" />
              <span>{fmt(outputTokens)}</span>
            </span>
          )}
          {tokPerSec != null && (
            <span className="text-[11px] font-semibold text-foreground">
              <span>{tokPerSec.toFixed(1)}</span>
              <span className="text-muted-foreground/60 font-normal"> t/s</span>
            </span>
          )}
        </span>
      )}

      {/* Model alias — larger, clickable */}
      {onSelectModel ? (
        <button
          ref={modelBtnRef}
          onClick={() => setPickerOpen(v => !v)}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-medium text-foreground hover:bg-secondary transition-colors max-w-[220px] truncate"
          title={`${effectiveModel} · ${providerId}${alias ? ` — alias: ${alias}` : ''} — Changer de modèle`}
        >
          <span className="truncate">{modelLabel}</span>
          <ChevronDown size={11} className="text-muted-foreground/60 shrink-0" />
        </button>
      ) : (
        <span className="text-[12px] font-medium text-foreground max-w-[220px] truncate px-2 py-0.5" title={`${effectiveModel} · ${providerId}`}>
          {modelLabel}
        </span>
      )}

      {onSelectModel && (
        <ModelPickerPopup
          isOpen={pickerOpen}
          anchorEl={modelBtnRef.current}
          providers={providers}
          initialProviderId={providerId}
          currentModelId={effectiveModel}
          onClose={() => setPickerOpen(false)}
          onSelect={(modelId) => {
            setPickerOpen(false);
            onSelectModel(modelId);
          }}
        />
      )}
    </div>
  );
}
