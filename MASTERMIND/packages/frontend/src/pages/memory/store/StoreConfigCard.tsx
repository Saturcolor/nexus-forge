import { useEffect, useRef, useState } from 'react';
import { Settings, Save, CheckCircle2, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../../lib/api';
import { cardCls, inputCls, btnPrimary } from '../types';

interface Props {
  initialDimensions: number;
  initialDedup: boolean;
  initialDedupThreshold: number;
  initialBypassSignificance: boolean;
  initialAutoEnabled: boolean;
  initialTopK: number;
  initialThreshold: number;
  initialMaxChars: number;
  initialIncludeShared: boolean;
  msConfigEnabled: boolean;
}

export function StoreConfigCard({
  initialDimensions, initialDedup, initialDedupThreshold, initialBypassSignificance,
  initialAutoEnabled,
  initialTopK, initialThreshold, initialMaxChars, initialIncludeShared,
  msConfigEnabled,
}: Props) {
  const [dimensions, setDimensions] = useState(initialDimensions);
  const [dedup, setDedup] = useState(initialDedup);
  const [dedupThreshold, setDedupThreshold] = useState(initialDedupThreshold);
  const [bypassSignificance, setBypassSignificance] = useState(initialBypassSignificance);
  const [autoEnabled, setAutoEnabled] = useState(initialAutoEnabled);
  const [topK, setTopK] = useState(initialTopK);
  const [threshold, setThreshold] = useState(initialThreshold);
  const [maxChars, setMaxChars] = useState(initialMaxChars);
  const [includeShared, setIncludeShared] = useState(initialIncludeShared);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.put('/api/config', {
        memoryStore: {
          embeddingDimensions: dimensions,
          enableDeduplication: dedup,
          deduplicationThreshold: dedupThreshold,
          bypassSignificanceFilter: bypassSignificance,
          autoInjection: { enabled: autoEnabled, topK, threshold, maxCharsPerChunk: maxChars, includeShared },
        },
      });
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        savedTimerRef.current = null;
        setSaved(false);
      }, 2500);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Settings size={16} /> Configuration
        </h2>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-theme-green flex items-center gap-1"><CheckCircle2 size={12} /> Enregistre</span>}
          <button type="button" disabled={saving} onClick={() => void save()} className={btnPrimary}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? 'Enregistrement...' : 'Enregistrer'}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-theme-red mb-3">{error}</p>}

      <div className="space-y-5">
        {/* Embeddings */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Embeddings</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Dimensions des vecteurs</label>
              <input type="number" value={dimensions} onChange={e => setDimensions(Number(e.target.value))} min={64} max={8192} step={64} className={clsx(inputCls, 'font-mono')} />
              <p className="text-xs text-muted-foreground/60 mt-0.5">ex: 1024 (nomic-embed), 4096 (qwen3-embedding-8b)</p>
            </div>
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={dedup} onChange={e => setDedup(e.target.checked)} className="rounded" />
                <div>
                  <span className="text-foreground">Deduplication</span>
                  <p className="text-muted-foreground/60 mt-0.5">Ignore les entrees trop similaires</p>
                </div>
              </label>
            </div>
          </div>
          {dedup && (
            <div className="mt-3">
              <label className="text-xs text-muted-foreground block mb-1">Seuil de deduplication</label>
              <div className="flex items-center gap-3">
                <input type="range" value={dedupThreshold} onChange={e => setDedupThreshold(Number(e.target.value))} min={0.7} max={0.99} step={0.01} className="flex-1" />
                <span className="text-xs font-mono text-foreground w-10 text-right">{dedupThreshold}</span>
              </div>
              <p className="text-xs text-muted-foreground/60 mt-0.5">Plus bas = plus agressif (0.85 recommande, 0.92 par defaut)</p>
            </div>
          )}
        </div>

        {/* Filtre de significance */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Filtre d'ecriture</p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={bypassSignificance} onChange={e => setBypassSignificance(e.target.checked)} className="rounded" />
            <div>
              <span className="text-foreground">Bypass filtre de significance</span>
              <p className="text-muted-foreground/60 mt-0.5">Accepte tout sauf les messages triviaux (salut, merci, ok...). La consolidation nettoie ensuite.</p>
            </div>
          </label>
        </div>

        {/* Auto-injection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-foreground">Injection automatique de memoire</p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={autoEnabled} onChange={e => setAutoEnabled(e.target.checked)} className="rounded" />
              Activee
            </label>
          </div>
          <div className={clsx('grid grid-cols-2 sm:grid-cols-4 gap-3', !autoEnabled && 'opacity-40 pointer-events-none')}>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">topK</label>
              <input type="number" value={topK} onChange={e => setTopK(Number(e.target.value))} min={1} max={20} className={clsx(inputCls, 'font-mono')} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">threshold</label>
              <input type="number" value={threshold} onChange={e => setThreshold(Number(e.target.value))} min={0.1} max={0.99} step={0.01} className={clsx(inputCls, 'font-mono')} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">maxCharsPerChunk</label>
              <input type="number" value={maxChars} onChange={e => setMaxChars(Number(e.target.value))} min={100} max={4000} step={100} className={clsx(inputCls, 'font-mono')} />
            </div>
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={includeShared} onChange={e => setIncludeShared(e.target.checked)} className="rounded" />
                Inclure shared
              </label>
            </div>
          </div>
        </div>

        {/* YAML preview */}
        <div>
          <p className="text-xs text-muted-foreground mb-1">Apercu YAML genere</p>
          <pre className="bg-secondary rounded-lg p-3 text-xs font-mono text-muted-foreground leading-relaxed overflow-x-auto">{[
            'memoryStore:',
            `  enabled: ${msConfigEnabled}`,
            `  embeddingDimensions: ${dimensions}`,
            dedup ? '  enableDeduplication: true' : null,
            dedup ? `  deduplicationThreshold: ${dedupThreshold}` : null,
            bypassSignificance ? '  bypassSignificanceFilter: true' : null,
            '  autoInjection:',
            `    enabled: ${autoEnabled}`,
            `    topK: ${topK}`,
            `    threshold: ${threshold}`,
            `    maxCharsPerChunk: ${maxChars}`,
            `    includeShared: ${includeShared}`,
          ].filter(Boolean).join('\n')}</pre>
        </div>
      </div>
    </div>
  );
}
