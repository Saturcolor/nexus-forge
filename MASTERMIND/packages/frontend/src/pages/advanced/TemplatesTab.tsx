/**
 * Templates editor — Advanced tab dans Mastermind.
 *
 * Permet d'éditer le contenu des sections "fixes" du prompt système qui étaient
 * jusque-là hardcoded en TypeScript : platform, environment, lazy-skills-summary,
 * memory-stub, subagent-harness.
 *
 * Architecture :
 *  - GET /api/prompt-templates           → liste avec metadata
 *  - GET /api/prompt-templates/:key      → contenu (override ou default) + variables
 *  - GET /api/prompt-templates/:key/default → contenu hardcoded (pour diff)
 *  - PUT /api/prompt-templates/:key      → persiste override (valide required vars)
 *  - DELETE /api/prompt-templates/:key   → supprime override, retombe au default
 *
 * Save → backend invalidate prompt cache → prochain message agent pickup direct.
 * Pas de restart backend nécessaire.
 */
import { useEffect, useMemo, useState, useCallback, useRef, forwardRef } from 'react';
import type { ForwardedRef } from 'react';
import { Save, RotateCcw, Copy, Check, AlertCircle, FileCode2, ChevronRight, Eye, EyeOff, X } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import { clientLogger } from '../../lib/clientLogger';

interface VariableSpec {
  name: string;
  required: boolean;
  description: string;
  example?: string;
}

interface TemplateInfo {
  key: string;
  source: 'override' | 'default';
  content: string;
  chars: number;
  estimatedTokens: number;
  variables: VariableSpec[];
  usedVariables: string[];
  missingRequired: string[];
}

interface DefaultResponse {
  key: string;
  content: string;
  chars: number;
  estimatedTokens: number;
}

const TEMPLATE_LABELS: Record<string, { emoji: string; label: string; description: string }> = {
  'platform':                      { emoji: '🌐', label: 'Platform Context',         description: 'Contexte global Mastermind + fleet roster + send_to_user + sandbox + war rooms + skills overview' },
  'subagent-harness':              { emoji: '🛰️', label: 'Sub-agent Harness',        description: 'Texte sub-agent (one-shot cloud worker) avec preset identity + delivery contract' },
  'environment':                   { emoji: '📁', label: 'Environment',              description: 'Paths absolus + tool call rules + cross-tool workflows + mandatory triggers + error handling' },
  'memory-stub':                   { emoji: '🧠', label: 'Memory Stub',              description: 'Reminder PostgreSQL memory_search/memory_write (1 ligne, conditionnel si memoryStore actif)' },
  'lazy-skills-summary.stub':      { emoji: '📝', label: 'Lazy Summary (stub)',      description: 'Instructions lazy mode + liste skills, mode stub (appel skill_* direct après inspect_skill)' },
  'lazy-skills-summary.wildcard':  { emoji: '🎯', label: 'Lazy Summary (wildcard)',  description: 'Instructions lazy mode + liste skills, mode wildcard (appel via call_skill_action)' },
};

export default function TemplatesTab() {
  const [list, setList] = useState<TemplateInfo[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => localStorage.getItem('mm-templates-selected'));
  const [current, setCurrent] = useState<TemplateInfo | null>(null);
  const [defaultContent, setDefaultContent] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // Persist selection
  useEffect(() => {
    if (selectedKey) localStorage.setItem('mm-templates-selected', selectedKey);
  }, [selectedKey]);

  // Load list
  const loadList = useCallback(async () => {
    const startedAt = Date.now();
    clientLogger.info('templates', 'list fetch start');
    try {
      const data = await api.get<TemplateInfo[]>('/api/prompt-templates');
      setList(data);
      clientLogger.info('templates', 'list fetch done', { count: data.length, ms: Date.now() - startedAt });
      // Auto-select first if nothing selected or selection invalid.
      if (!selectedKey || !data.some(t => t.key === selectedKey)) {
        const first = data[0]?.key ?? null;
        setSelectedKey(first);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      clientLogger.warn('templates', 'list fetch failed', { error: msg, ms: Date.now() - startedAt });
      setError(msg);
    }
  }, [selectedKey]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Load current template + default (for diff)
  const loadTemplate = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const [info, def] = await Promise.all([
        api.get<TemplateInfo>(`/api/prompt-templates/${key}`),
        api.get<DefaultResponse>(`/api/prompt-templates/${key}/default`),
      ]);
      setCurrent(info);
      setDefaultContent(def.content);
      setDraftContent(info.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedKey) loadTemplate(selectedKey);
  }, [selectedKey, loadTemplate]);

  // Detect variables in current draft
  const draftAnalysis = useMemo(() => {
    if (!current) return { used: new Set<string>(), missingRequired: [] as string[] };
    const re = /\{\{([\w.]+)\}\}/g;
    const used = new Set<string>();
    let m;
    while ((m = re.exec(draftContent)) !== null) used.add(m[1]);
    const required = current.variables.filter(v => v.required).map(v => v.name);
    const missingRequired = required.filter(name => !used.has(name));
    return { used, missingRequired };
  }, [draftContent, current]);

  const isDirty = current ? draftContent !== current.content : false;
  const canSave = isDirty && draftAnalysis.missingRequired.length === 0 && !saving;

  const handleSave = useCallback(async () => {
    if (!selectedKey || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.put<TemplateInfo>(`/api/prompt-templates/${selectedKey}`, { content: draftContent });
      setCurrent(updated);
      setDraftContent(updated.content);
      // Refresh list to update source badges (default → override)
      loadList();
      clientLogger.info('templates', 'save ok', { key: selectedKey, chars: updated.chars });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      clientLogger.warn('templates', 'save failed', { key: selectedKey, error: msg });
    } finally {
      setSaving(false);
    }
  }, [selectedKey, canSave, draftContent, loadList]);

  const handleRevert = useCallback(async () => {
    if (!selectedKey || !current || current.source !== 'override') return;
    if (!confirm(`Supprimer l'override de "${selectedKey}" et revenir au défaut hardcoded ?`)) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.delete<TemplateInfo>(`/api/prompt-templates/${selectedKey}`);
      setCurrent(updated);
      setDraftContent(updated.content);
      loadList();
      clientLogger.info('templates', 'revert ok', { key: selectedKey });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      clientLogger.warn('templates', 'revert failed', { key: selectedKey, error: msg });
    } finally {
      setSaving(false);
    }
  }, [selectedKey, current, loadList]);

  const handleResetDraft = useCallback(() => {
    if (current) setDraftContent(current.content);
  }, [current]);

  const handleLoadDefaultAsBase = useCallback(() => {
    if (defaultContent !== null) setDraftContent(defaultContent);
  }, [defaultContent]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draftContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      clientLogger.warn('templates', 'copy failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, [draftContent]);

  const insertVariableAtCursor = useCallback((varName: string) => {
    const el = editorRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const insert = `{{${varName}}}`;
    const next = draftContent.slice(0, start) + insert + draftContent.slice(end);
    setDraftContent(next);
    // Restore cursor position after the inserted variable
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + insert.length;
    });
  }, [draftContent]);

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar: list of templates ── */}
      <aside className="w-64 shrink-0 border-r border-border bg-card/10 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-border/50 shrink-0">
          <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">Templates</h2>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            {list.length} sections éditables
          </p>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {list.map(item => {
            const meta = TEMPLATE_LABELS[item.key] ?? { emoji: '·', label: item.key, description: '' };
            const isActive = selectedKey === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setSelectedKey(item.key)}
                className={clsx(
                  'w-full text-left px-4 py-2.5 transition-colors border-l-2',
                  isActive ? 'bg-primary/10 border-primary' : 'border-transparent hover:bg-secondary/40',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0">{meta.emoji}</span>
                  <span className={clsx('text-xs font-semibold truncate', isActive ? 'text-foreground' : 'text-muted-foreground')}>
                    {meta.label}
                  </span>
                  {item.source === 'override' ? (
                    <span className="ml-auto text-[9px] px-1 py-px rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">edit</span>
                  ) : (
                    <span className="ml-auto text-[9px] text-muted-foreground/40">default</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                  {formatBytes(item.chars)} · ~{item.estimatedTokens.toLocaleString()} tok
                </div>
                {item.missingRequired.length > 0 && (
                  <div className="text-[10px] text-destructive mt-0.5 flex items-center gap-1">
                    <AlertCircle size={10} /> {item.missingRequired.length} var manquante(s)
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Main pane: editor + variables panel ── */}
      <section className="flex-1 min-w-0 min-h-0 flex flex-col">
        {error && (
          <div className="shrink-0 px-4 py-2 bg-destructive/10 border-b border-destructive/30 text-xs text-destructive flex items-center gap-2">
            <AlertCircle size={12} />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-destructive hover:text-destructive/80">
              <X size={12} />
            </button>
          </div>
        )}
        {!selectedKey ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Sélectionne un template à gauche.
          </div>
        ) : loading || !current ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Chargement…
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="shrink-0 px-5 py-3 border-b border-border bg-card/20 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span>{TEMPLATE_LABELS[selectedKey]?.emoji ?? '·'}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{TEMPLATE_LABELS[selectedKey]?.label ?? selectedKey}</span>
                    <span className="text-[10px] font-mono text-muted-foreground/60">{selectedKey}</span>
                    {current.source === 'override' ? (
                      <span className="text-[10px] px-1.5 py-px rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">override actif</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-px rounded bg-muted/40 text-muted-foreground">default</span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground/60 mt-0.5 truncate max-w-[600px]">
                    {TEMPLATE_LABELS[selectedKey]?.description}
                  </div>
                </div>
              </div>
              <div className="flex-1" />
              {/* Actions */}
              <button
                onClick={() => setShowDiff(s => !s)}
                disabled={!defaultContent}
                className={clsx(
                  'flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors',
                  showDiff ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:text-foreground',
                )}
                title="Toggle diff vs default"
              >
                {showDiff ? <EyeOff size={11} /> : <Eye size={11} />}
                Diff
              </button>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-secondary/60 text-muted-foreground hover:text-foreground rounded transition-colors"
              >
                {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                {copied ? 'Copié' : 'Copier'}
              </button>
              <button
                onClick={handleResetDraft}
                disabled={!isDirty}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-secondary/60 text-muted-foreground hover:text-foreground rounded transition-colors disabled:opacity-40"
                title="Annuler les modifications non sauvegardées"
              >
                <RotateCcw size={11} />
                Reset draft
              </button>
              <button
                onClick={handleLoadDefaultAsBase}
                disabled={defaultContent === null || draftContent === defaultContent}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-secondary/60 text-muted-foreground hover:text-foreground rounded transition-colors disabled:opacity-40"
                title="Recharger le défaut comme base d'édition (override en mémoire seulement, pas encore sauvé)"
              >
                <FileCode2 size={11} />
                Load default
              </button>
              <button
                onClick={handleRevert}
                disabled={current.source !== 'override' || saving}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-secondary/60 text-muted-foreground hover:text-destructive rounded transition-colors disabled:opacity-40"
                title="Supprimer l'override et revenir au défaut hardcoded"
              >
                <X size={11} />
                Revert
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className={clsx(
                  'flex items-center gap-1 px-3 py-1 text-[11px] font-semibold rounded transition-colors',
                  canSave
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
                    : 'bg-muted/30 text-muted-foreground/40 border border-border/30',
                )}
                title={!isDirty ? 'Pas de modification à sauvegarder' : draftAnalysis.missingRequired.length > 0 ? 'Variable(s) requise(s) manquante(s)' : 'Persister dans shared/prompt-templates/'}
              >
                <Save size={11} />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>

            {/* Status line */}
            <div className="shrink-0 px-5 py-1.5 border-b border-border/50 bg-card/10 flex items-center gap-3 text-[10px] flex-wrap">
              <span className="text-muted-foreground">
                {formatBytes(draftContent.length)} · ~{Math.max(1, Math.round(draftContent.length / 4)).toLocaleString()} tok
              </span>
              {isDirty && <span className="text-amber-300">● modifié (non sauvegardé)</span>}
              {draftAnalysis.missingRequired.length > 0 && (
                <span className="text-destructive flex items-center gap-1">
                  <AlertCircle size={10} />
                  Variable(s) requise(s) manquante(s) : {draftAnalysis.missingRequired.map(v => `{{${v}}}`).join(', ')}
                </span>
              )}
              {isDirty && draftAnalysis.missingRequired.length === 0 && (
                <span className="text-emerald-400">✓ Variables requises présentes, save autorisé</span>
              )}
            </div>

            {/* Editor + variables panel */}
            <div className="flex-1 min-h-0 flex overflow-hidden">
              {/* Editor area */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                {showDiff && defaultContent !== null ? (
                  <DiffView left={defaultContent} right={draftContent} />
                ) : (
                  <HighlightedEditor
                    ref={editorRef}
                    value={draftContent}
                    onChange={setDraftContent}
                    declaredVariables={current.variables}
                    placeholder="(template vide — utilise le bouton 'Load default' pour repartir du défaut)"
                  />
                )}
              </div>

              {/* Variables panel */}
              <aside className="w-72 shrink-0 border-l border-border bg-card/10 flex flex-col min-h-0">
                <div className="shrink-0 px-3 py-2 border-b border-border/50">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground/80 font-semibold">
                    Variables disponibles
                  </div>
                  <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                    Click "Insert" pour injecter à la position du curseur
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {current.variables.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-muted-foreground/60 italic">
                      Aucune variable pour ce template (texte statique pur).
                    </div>
                  ) : (
                    current.variables.map(v => {
                      const isUsed = draftAnalysis.used.has(v.name);
                      const isMissing = v.required && !isUsed;
                      return (
                        <div
                          key={v.name}
                          className={clsx(
                            'px-3 py-2 border-b border-border/30',
                            isMissing && 'bg-destructive/5',
                          )}
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={clsx(
                              'text-[11px] font-mono',
                              isUsed ? 'text-foreground' : 'text-muted-foreground',
                            )}>
                              {`{{${v.name}}}`}
                            </span>
                            {v.required && (
                              <span className="text-[9px] px-1 py-px rounded bg-destructive/20 text-destructive border border-destructive/30">required</span>
                            )}
                            {isUsed ? (
                              <span className="ml-auto text-[9px] text-emerald-400">✓ used</span>
                            ) : v.required ? (
                              <span className="ml-auto text-[9px] text-destructive">✗ missing</span>
                            ) : (
                              <span className="ml-auto text-[9px] text-muted-foreground/40">unused</span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground/70 leading-snug">
                            {v.description}
                          </p>
                          {v.example && (
                            <p className="text-[10px] text-muted-foreground/40 italic mt-0.5">
                              ex: {v.example}
                            </p>
                          )}
                          <button
                            onClick={() => insertVariableAtCursor(v.name)}
                            className="text-[10px] mt-1 px-1.5 py-px rounded bg-secondary/60 text-muted-foreground hover:text-foreground border border-border transition-colors flex items-center gap-1"
                          >
                            <ChevronRight size={9} /> Insert at cursor
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </aside>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}

/**
 * Minimal line-level diff view. Lines added/removed are colored; common lines neutral.
 * Not as polished as Monaco diff but enough for the use case (visual comparison).
 */
function DiffView({ left, right }: { left: string; right: string }) {
  const diffLines = useMemo(() => {
    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    // Simple LCS-free diff: compare line-by-line (fast for small templates).
    // For real diff we'd use a library, but for visual comparison this is fine.
    const max = Math.max(leftLines.length, rightLines.length);
    const out: Array<{ kind: 'same' | 'added' | 'removed' | 'changed'; left?: string; right?: string }> = [];
    for (let i = 0; i < max; i++) {
      const l = leftLines[i];
      const r = rightLines[i];
      if (l === undefined) out.push({ kind: 'added', right: r });
      else if (r === undefined) out.push({ kind: 'removed', left: l });
      else if (l === r) out.push({ kind: 'same', left: l, right: r });
      else out.push({ kind: 'changed', left: l, right: r });
    }
    return out;
  }, [left, right]);

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      <div className="flex-1 min-w-0 overflow-auto border-r border-border/30">
        <div className="px-3 py-1 sticky top-0 bg-card/80 backdrop-blur border-b border-border/50 text-[10px] uppercase tracking-wider text-muted-foreground/80">
          default (hardcoded)
        </div>
        <pre className="font-mono text-[11px] leading-relaxed p-3">
          {diffLines.map((d, i) => (
            <div
              key={i}
              className={clsx(
                'whitespace-pre-wrap',
                d.kind === 'removed' && 'bg-red-500/10 text-red-300',
                d.kind === 'changed' && 'bg-amber-500/10 text-amber-300',
              )}
            >
              {d.left ?? ''}
            </div>
          ))}
        </pre>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="px-3 py-1 sticky top-0 bg-card/80 backdrop-blur border-b border-border/50 text-[10px] uppercase tracking-wider text-muted-foreground/80">
          draft (édité)
        </div>
        <pre className="font-mono text-[11px] leading-relaxed p-3">
          {diffLines.map((d, i) => (
            <div
              key={i}
              className={clsx(
                'whitespace-pre-wrap',
                d.kind === 'added' && 'bg-emerald-500/10 text-emerald-300',
                d.kind === 'changed' && 'bg-amber-500/10 text-amber-300',
              )}
            >
              {d.right ?? ''}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

/**
 * Textarea with `{{variable}}` highlighting overlay.
 *
 * Implementation: standard React pattern — a hidden `<pre>` overlay rendered behind a
 * transparent `<textarea>`. The overlay re-renders the text with `<span>` wrappers
 * around each `{{var}}` match. Scroll is mirrored via `onScroll`. The textarea keeps
 * the visible caret (`caret-foreground` from Tailwind palette) so typing UX is intact.
 *
 * Coloring:
 *  - Required variable used in the text → green (good, signal "wired up")
 *  - Optional variable used in the text → amber (visible but not critical)
 *  - Variable used but NOT in the manifest → red (probable typo / unknown var)
 *
 * The set of "declared" variables comes from the template manifest (variables.ts on
 * the backend, propagated via the GET /api/prompt-templates/:key payload). The
 * "required" status is read from the same manifest.
 */
const HighlightedEditor = forwardRef(function HighlightedEditor(
  {
    value,
    onChange,
    declaredVariables,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    declaredVariables: VariableSpec[];
    placeholder?: string;
  },
  ref: ForwardedRef<HTMLTextAreaElement>,
) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  // Allow parent to grab the textarea ref via forwardRef while we keep our own copy for sync.
  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
  }, [ref]);

  // Build a quick lookup of declared variables for color classification.
  const declaredMap = useMemo(() => {
    const m = new Map<string, { required: boolean }>();
    for (const v of declaredVariables) m.set(v.name, { required: v.required });
    return m;
  }, [declaredVariables]);

  // Render the text with `{{var}}` matches wrapped in colored spans.
  // We always emit a trailing newline space so the overlay height matches the textarea
  // when the user's content ends without a final newline (browsers add a phantom line
  // to textarea height in that case).
  const highlighted = useMemo(() => {
    const parts: React.ReactNode[] = [];
    const re = /\{\{[\w.]+\}\}/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = re.exec(value)) !== null) {
      if (match.index > lastIndex) {
        parts.push(value.slice(lastIndex, match.index));
      }
      const name = match[0].slice(2, -2);
      const spec = declaredMap.get(name);
      // unknown var = red (probable typo) ; required + used = emerald ; optional = amber
      const cls = !spec
        ? 'bg-red-500/15 text-red-400 rounded-sm'
        : spec.required
          ? 'bg-emerald-500/15 text-emerald-300 rounded-sm'
          : 'bg-amber-500/15 text-amber-300 rounded-sm';
      parts.push(
        <span key={key++} className={cls}>
          {match[0]}
        </span>,
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) {
      parts.push(value.slice(lastIndex));
    }
    // Phantom trailing newline — keeps overlay scrollHeight in sync with textarea when
    // the user's content doesn't end with \n (textareas reserve room for the next line).
    parts.push('\n');
    return parts;
  }, [value, declaredMap]);

  const syncScroll = useCallback(() => {
    if (innerRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = innerRef.current.scrollTop;
      overlayRef.current.scrollLeft = innerRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      {/*
        Overlay : rendered behind the textarea, with the same typography/padding.
        `pointer-events-none` lets clicks pass through to the textarea below.
        `aria-hidden` because screen readers should read the textarea content, not this clone.
        `whitespace-pre-wrap break-words` must match the textarea exactly so line breaks land identically.
      */}
      <div
        ref={overlayRef}
        aria-hidden="true"
        className="absolute inset-0 overflow-auto pointer-events-none font-mono text-[12px] leading-relaxed p-5 whitespace-pre-wrap break-words text-foreground/90"
      >
        {highlighted}
      </div>
      <textarea
        ref={setRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        placeholder={placeholder}
        // caretColor inline pour garantir un curseur visible malgré color:transparent —
        // référence le même CSS var que `text-foreground` Tailwind.
        style={{ caretColor: 'var(--color-foreground)' }}
        className="relative w-full h-full bg-transparent text-transparent font-mono text-[12px] leading-relaxed p-5 resize-none focus:outline-none whitespace-pre-wrap break-words selection:bg-primary/30 selection:text-foreground"
      />
    </div>
  );
});
