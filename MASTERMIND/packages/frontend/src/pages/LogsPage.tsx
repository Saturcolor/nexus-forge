import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { RefreshCw, Pause, Play, Search, ChevronDown, FileText, Settings, ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

/**
 * Liste horizontale scrollable avec boutons ◀ ▶ qui apparaissent dynamiquement
 * quand il y a overflow. Conserve le mask-image fade comme indice visuel.
 * Sur mobile (touch), les boutons restent utiles mais le swipe natif marche aussi.
 */
function ScrollablePresets({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Re-check après le rendu initial des enfants (transitions de filtre, etc).
    const t = setTimeout(update, 50);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); clearTimeout(t); };
  }, [update]);

  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * 140, behavior: 'smooth' });

  const hasOverflow = canLeft || canRight;

  // Mask dynamique : on fade côté droit s'il reste à scroller, côté gauche
  // si on a déjà scrollé. Quand pas d'overflow ou aux deux extrémités, le fade
  // approprié disparaît — pas de bruit visuel quand inutile.
  const maskImage = (() => {
    if (canLeft && canRight) return 'linear-gradient(to right, transparent, black 1.5rem, black calc(100% - 1.5rem), transparent)';
    if (canLeft) return 'linear-gradient(to right, transparent, black 1.5rem)';
    if (canRight) return 'linear-gradient(to right, black calc(100% - 1.5rem), transparent)';
    return 'none';
  })();

  return (
    <div className="flex items-center gap-1 min-w-0">
      {hasOverflow && (
        <button
          type="button"
          onClick={() => scroll(-1)}
          disabled={!canLeft}
          className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors"
          aria-label="Scroll left"
        >
          <ChevronLeft size={12} />
        </button>
      )}
      <div
        ref={ref}
        className="flex gap-1 overflow-x-auto no-scrollbar"
        style={{ maskImage, WebkitMaskImage: maskImage }}
      >
        {children}
      </div>
      {hasOverflow && (
        <button
          type="button"
          onClick={() => scroll(1)}
          disabled={!canRight}
          className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors"
          aria-label="Scroll right"
        >
          <ChevronRight size={12} />
        </button>
      )}
    </div>
  );
}

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  ts: string;
  level: LogLevel;
  tag: string;
  msg: string;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: 'text-muted-foreground',
  INFO:  'text-foreground/80',
  WARN:  'text-theme-orange',
  ERROR: 'text-theme-red',
};

const LEVEL_BADGE: Record<LogLevel, string> = {
  DEBUG: 'bg-muted text-muted-foreground',
  INFO:  'bg-primary/15 text-primary',
  WARN:  'bg-theme-orange/15 text-theme-orange',
  ERROR: 'bg-theme-red/15 text-theme-red',
};

const LEVELS: Array<LogLevel | 'ALL'> = ['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const TAILS = [100, 500, 1000, 2000];
const TAG_PRESETS = ['memory-store', 'memory-consolidation', 'agent', 'consolidation', 'http', 'ws', 'provider', 'config'] as const;

export default function LogsPage() {
  const [entries, setEntries]         = useState<LogEntry[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoScroll, setAutoScroll]   = useState(true);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'ALL'>('ALL');
  const [search, setSearch]           = useState('');
  const [tagFilter, setTagFilter]     = useState('');
  const [excludeFilter, setExcludeFilter] = useState('');
  const [tail, setTail]               = useState(500);
  const [logConfigHint, setLogConfigHint] = useState<string | null>(null);
  const [logWriteLevel, setLogWriteLevel] = useState<LogLevel | null>(null);
  const [debugToggleSaving, setDebugToggleSaving] = useState(false);
  const levelBeforeDebugRef = useRef<LogLevel>('INFO');
  const bottomRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshLogConfigHint = useCallback(() => {
    return api
      .get<{ logging?: { level: string; file?: string; maxFileSizeMb?: number; maxFiles?: number } }>('/api/config')
      .then(c => {
        if (!c.logging) { setLogConfigHint(null); setLogWriteLevel(null); return; }
        const { level, file, maxFileSizeMb, maxFiles } = c.logging;
        const lv = level as LogLevel;
        setLogWriteLevel(lv);
        if (lv !== 'DEBUG') levelBeforeDebugRef.current = lv;
        setLogConfigHint(`${level} · ${maxFileSizeMb ?? 50} Mo × ${maxFiles ?? 5}${file?.trim() ? ` · ${file}` : ''}`);
      })
      .catch(() => { setLogConfigHint(null); setLogWriteLevel(null); });
  }, []);

  useEffect(() => { void refreshLogConfigHint(); }, [refreshLogConfigHint]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('tail', String(tail));
    if (levelFilter !== 'ALL') params.set('level', levelFilter);
    if (search.trim()) params.set('search', search.trim());
    if (tagFilter.trim()) params.set('tag', tagFilter.trim());
    if (excludeFilter.trim()) params.set('exclude', excludeFilter.trim());
    try {
      const data = await api.get<LogEntry[]>(`/api/logs?${params}`);
      setEntries(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tail, levelFilter, search, tagFilter, excludeFilter]);

  const handleDebugFileToggle = useCallback(async (wantDebug: boolean) => {
    if (debugToggleSaving || logWriteLevel === null) return;
    setDebugToggleSaving(true);
    setError(null);
    try {
      if (wantDebug) {
        if (logWriteLevel !== 'DEBUG') levelBeforeDebugRef.current = logWriteLevel;
        await api.put('/api/config', { logging: { level: 'DEBUG' } });
        setLogWriteLevel('DEBUG');
      } else {
        const restore = levelBeforeDebugRef.current;
        await api.put('/api/config', { logging: { level: restore } });
        setLogWriteLevel(restore);
      }
      await refreshLogConfigHint();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDebugToggleSaving(false);
    }
  }, [debugToggleSaving, logWriteLevel, load, refreshLogConfigHint]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) { intervalRef.current && clearInterval(intervalRef.current); return; }
    intervalRef.current = setInterval(load, 2000);
    return () => { intervalRef.current && clearInterval(intervalRef.current); };
  }, [autoRefresh, load]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, autoScroll]);

  const fmt = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };

  return (
    <div className="flex flex-col h-full bg-background text-card-foreground">
      {/* Header — `min-w-0 truncate` pour que le hint de config (path complet)
          coupe proprement sous narrow plutôt que d'élargir le header. */}
      <div className="px-3 sm:px-6 py-4 border-b border-border bg-card shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <FileText size={20} /> Logs
            </h1>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              <span className="hidden sm:inline">Journal temps reel du serveur Mastermind</span>
              <span className="sm:hidden">Live server logs</span>
              {logConfigHint && <> — <span className="font-mono">{logConfigHint}</span></>}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {autoRefresh && (
              <span className="text-[10px] text-theme-green font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-theme-green animate-pulse" />
                <span className="hidden sm:inline">Live</span>
              </span>
            )}
            <Link to="/settings" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              <Settings size={12} />
              <span className="hidden sm:inline">Reglages</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="border-b border-border bg-card/50 shrink-0">
        <div className="px-3 sm:px-6 py-3 space-y-2.5">
          {/* Row 1: search + controls */}
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative flex-1 min-w-0">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Rechercher dans les messages..."
                className="w-full pl-8 pr-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:border-ring"
              />
            </div>

            {/* Tail — label compact sur narrow ("500 l.") pour libérer la place
                pour la search. Format complet "X lignes" dès sm+. */}
            <div className="relative shrink-0">
              <select
                value={tail}
                onChange={e => setTail(Number(e.target.value))}
                className="appearance-none pl-3 pr-7 py-2 text-xs bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:border-ring tabular-nums"
                title="Nombre de lignes affichées"
              >
                {TAILS.map(t => <option key={t} value={t}>{t} lignes</option>)}
              </select>
              <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            </div>

            {/* Auto-scroll — label texte caché sous sm, on garde la checkbox seule */}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none shrink-0" title="Suivre le bas du flux automatiquement">
              <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="rounded" />
              <span className="hidden sm:inline">Scroll</span>
            </label>

            {/* Auto-refresh */}
            <button
              onClick={() => setAutoRefresh(v => !v)}
              title={autoRefresh ? 'Pause' : 'Resume'}
              className={clsx(
                'p-2 rounded-lg transition-colors shrink-0',
                autoRefresh ? 'text-theme-green bg-theme-green/10' : 'text-muted-foreground hover:bg-secondary',
              )}
            >
              {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
            </button>

            {/* Manual refresh */}
            <button onClick={load} title="Refresh" className="p-2 rounded-lg text-muted-foreground hover:bg-secondary transition-colors shrink-0">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* Row 2: level filter + tag filter + debug toggle. flex-wrap pour
              que les sous-blocs cassent proprement sous sm. Pas de spacer
              flex-1 (interfère avec wrap) — debug toggle pousse à droite via
              ml-auto sur sm+ uniquement. Séparateurs visuels masqués sous sm. */}
          <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
            {/* Level pills */}
            <div className="flex gap-1">
              {LEVELS.map(l => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLevelFilter(l)}
                  className={clsx(
                    'px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold transition-colors',
                    levelFilter === l
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground hover:bg-muted',
                  )}
                >
                  {l}
                </button>
              ))}
            </div>

            <div className="hidden sm:block w-px h-5 bg-border" />

            {/* Tag filter — input + presets sur la même flex line, scroll-x si overflow */}
            <div className="flex items-center gap-1.5 min-w-0">
              <input
                value={tagFilter}
                onChange={e => setTagFilter(e.target.value)}
                placeholder="Tag..."
                className="w-24 sm:w-28 px-2 py-1 text-[11px] bg-secondary border border-border rounded-lg text-foreground font-mono placeholder-muted-foreground focus:outline-none focus:border-ring shrink-0"
              />
              <ScrollablePresets>
                {TAG_PRESETS.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTagFilter(tagFilter === t ? '' : t)}
                    className={clsx(
                      'shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-mono transition-colors',
                      tagFilter === t
                        ? 'bg-primary/20 text-primary'
                        : 'bg-secondary text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t}
                  </button>
                ))}
              </ScrollablePresets>
            </div>

            <div className="hidden sm:block w-px h-5 bg-border" />

            {/* Exclude filter */}
            <div className="flex items-center gap-1.5 min-w-0">
              <input
                value={excludeFilter}
                onChange={e => setExcludeFilter(e.target.value)}
                placeholder="Exclure tags..."
                title="Tags a exclure, separes par virgule (ex: http,ws)"
                className="w-28 sm:w-32 px-2 py-1 text-[11px] bg-secondary border border-destructive/30 rounded-lg text-foreground font-mono placeholder-muted-foreground/40 focus:outline-none focus:border-destructive/50 shrink-0"
              />
              <ScrollablePresets>
                {(['http', 'ws'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      const current = excludeFilter.split(',').map(s => s.trim()).filter(Boolean);
                      const next = current.includes(t) ? current.filter(s => s !== t) : [...current, t];
                      setExcludeFilter(next.join(','));
                    }}
                    className={clsx(
                      'shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-mono transition-colors',
                      excludeFilter.split(',').map(s => s.trim()).includes(t)
                        ? 'bg-destructive/20 text-destructive'
                        : 'bg-secondary text-muted-foreground hover:bg-muted',
                    )}
                  >
                    -{t}
                  </button>
                ))}
              </ScrollablePresets>
            </div>

            {/* Debug file toggle — `sm:ml-auto` colle à droite sur desktop ;
                sous sm, suit naturellement après les filtres avec flex-wrap. */}
            <label
              className={clsx(
                'flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-lg border text-[11px] cursor-pointer select-none transition-colors sm:ml-auto',
                logWriteLevel === 'DEBUG'
                  ? 'border-theme-orange/50 bg-theme-orange/10 text-theme-orange'
                  : 'border-border bg-secondary text-muted-foreground hover:bg-muted',
                (debugToggleSaving || logWriteLevel === null) && 'opacity-50 cursor-wait',
              )}
              title="Active l'ecriture des lignes DEBUG sur disque (effet immediat)"
            >
              <input
                type="checkbox"
                className="rounded"
                checked={logWriteLevel === 'DEBUG'}
                disabled={debugToggleSaving || logWriteLevel === null}
                onChange={e => void handleDebugFileToggle(e.target.checked)}
              />
              <span className="font-medium">{debugToggleSaving ? '...' : 'DEBUG → fichier'}</span>
            </label>
          </div>
        </div>
      </div>

      {/* Log area */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-5 p-2">
        {error && (
          <div className="text-theme-red p-3 bg-theme-red/10 rounded-xl mb-2 text-xs">Erreur : {error}</div>
        )}
        {!loading && entries.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
            <FileText size={36} className="text-muted-foreground/15" />
            <p className="text-sm text-muted-foreground/40">Aucune entree de log</p>
            <p className="text-[10px] text-muted-foreground/30 max-w-xs">
              {search || tagFilter || excludeFilter || levelFilter !== 'ALL'
                ? 'Aucune ligne ne correspond aux filtres actifs.'
                : 'Les logs apparaîtront ici en temps réel quand le serveur en émettra.'}
            </p>
          </div>
        )}
        {entries.map((e, i) => (
          // Layout adaptatif : sur sm+ une seule ligne avec colonnes alignées
          // (timestamp / level / tag / msg). Sous sm, msg passe en basis-full pour
          // tomber sur une 2e ligne — sinon le message est squizzé à <100px.
          <div key={i} className={clsx('flex flex-wrap items-baseline gap-x-2 px-2 py-1 sm:py-px rounded hover:bg-secondary/50', LEVEL_COLORS[e.level])}>
            <span className="text-muted-foreground/60 shrink-0 sm:w-24 tabular-nums">{fmt(e.ts)}</span>
            <span className={clsx('shrink-0 sm:w-12 text-center rounded-md px-1 text-[10px] font-bold', LEVEL_BADGE[e.level])}>
              {e.level}
            </span>
            <span className="shrink-0 sm:w-32 text-primary/50 truncate max-w-[40%] sm:max-w-none" title={e.tag}>[{e.tag}]</span>
            <span className="break-all whitespace-pre-wrap min-w-0 basis-full sm:basis-0 sm:flex-1">{e.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Status bar — flex-wrap pour que les badges de filtres actifs cassent
          proprement au lieu de déborder hors de l'écran sur narrow. */}
      <div className="px-3 sm:px-6 py-1.5 border-t border-border bg-card flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground shrink-0">
        <span className="tabular-nums">{entries.length} entree{entries.length !== 1 ? 's' : ''}</span>
        {tagFilter.trim() && (
          <span className="text-primary font-mono">tag = {tagFilter.trim()}</span>
        )}
        {levelFilter !== 'ALL' && (
          <span className="font-mono">level = {levelFilter}</span>
        )}
        {excludeFilter.trim() && (
          <span className="text-destructive font-mono">exclu = {excludeFilter.trim()}</span>
        )}
      </div>
    </div>
  );
}
