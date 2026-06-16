/**
 * Prompt Builder — read-only inspection du system prompt envoyé à un agent.
 *
 * Fetch : GET /api/agents/:id/prompt-render?variant=web|telegram
 *   → { prompt, chars, estimatedTokens, sections: [{ key, content, chars, estimatedTokens }] }
 *
 * UI :
 *   - Top bar : agent picker + variant toggle (web/telegram) + total stats + refresh
 *   - Left  : sections list (groupées par catégorie, badges chars/tokens)
 *   - Right : viewer monospace de la section sélectionnée (avec copy)
 *
 * V2 (TODO) : edit YAML promptInjection, edit fichiers .md, diff preview.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { RotateCw, Copy, Check, FileCode2, Globe, Send as SendIcon, AlertCircle, Zap, Settings as SettingsIcon, X, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import { useAgents } from '../../hooks/useAgents';
import { clientLogger } from '../../lib/clientLogger';

type Variant = 'web' | 'telegram';

interface PromptSection {
  key: string;
  chars: number;
  estimatedTokens: number;
  content: string;
}

interface ToolEntry {
  name: string;
  kind: 'builtin' | 'skill';
  description: string;
  schema: string;
  chars: number;
  estimatedTokens: number;
}

interface ToolsMeta {
  count: number;
  chars: number;
  estimatedTokens: number;
  lazySkillsActive: boolean;
  bypassUnified: boolean;
  skillCount: { full: number; emitted: number };
}

interface OverrideStatus {
  active: boolean;
  value?: boolean;
  configValue?: boolean;
}

interface EffectiveConfig {
  kind: 'agent' | 'subagent';
  lazySkills: boolean;
  bypassUnifiedCache: boolean;
  memoryStoreEnabled: boolean;
  starredSkills: string[];
  sharedStarredFiles: string[];
  disabledTools: string[];
  allowOnly: string[];
  skillCallMode: 'stub' | 'wildcard';
  overrides: {
    lazySkills: OverrideStatus;
    bypassUnifiedCache: OverrideStatus;
    skillCallMode: { active: boolean; value?: 'stub' | 'wildcard'; configValue: 'stub' | 'wildcard' };
  };
}

interface PromptRender {
  agentId: string;
  variant: Variant;
  prompt: string;
  chars: number;
  estimatedTokens: number;
  sections: PromptSection[];
  tools?: ToolEntry[];
  toolsMeta?: ToolsMeta;
  lazySkillSummary?: string | null;
  lazySkillSummaryMeta?: { chars: number; estimatedTokens: number } | null;
  effectiveConfig?: EffectiveConfig;
}

type TriState = 'config' | 'on' | 'off';
type SkillCallModePreview = 'stub' | 'wildcard';

/**
 * Group sections by category for readable sidebar — orders preserved within
 * each group; groups themselves follow the prompt assembly order.
 */
interface SectionGroup {
  id: string;
  label: string;
  emoji: string;
  description: string;
  sections: PromptSection[];
}

function classifySection(key: string): { groupId: string; subLabel?: string } {
  if (key === 'subagent-harness') return { groupId: 'platform' };
  if (key === 'platform') return { groupId: 'platform' };
  if (key === 'environment') return { groupId: 'environment' };
  if (key === 'memory-stub') return { groupId: 'memory' };
  if (key === 'daily-recent') return { groupId: 'daily' };
  if (key.startsWith('shared-starred:')) return { groupId: 'shared-starred', subLabel: key.slice('shared-starred:'.length) };
  if (key === 'agent-identity') return { groupId: 'identity' };
  if (key === 'codebase-search-hint') return { groupId: 'codebase-search' };
  if (key.startsWith('workspace:')) return { groupId: 'workspace', subLabel: key.slice('workspace:'.length) };
  // Tools & skills are injected as virtual sections (key `tool:<name>` / `skill:<name>`)
  // alongside the real prompt sections so the sidebar/viewer flow stays uniform.
  if (key.startsWith('tool:')) return { groupId: 'tools-builtin', subLabel: key.slice('tool:'.length) };
  if (key.startsWith('skill:')) return { groupId: 'tools-skill', subLabel: key.slice('skill:'.length) };
  if (key === 'lazy-skill-summary') return { groupId: 'lazy-summary' };
  return { groupId: 'other' };
}

const GROUP_META: Record<string, { label: string; emoji: string; description: string; order: number }> = {
  platform:        { label: 'Platform Context',  emoji: '🌐', description: 'Harness Mastermind ou sub-agent harness',          order: 1 },
  environment:     { label: 'Environment',       emoji: '📁', description: 'Paths absolus + tool call rules',                  order: 2 },
  memory:          { label: 'Memory',            emoji: '🧠', description: 'Reminder PostgreSQL memory store',                 order: 3 },
  daily:           { label: 'Daily Context',     emoji: '📰', description: 'Résumés daily récents (partagés)',                 order: 4 },
  'shared-starred':{ label: 'Shared Starred',    emoji: '⭐', description: 'Fichiers starred (ordonnés par signature)',        order: 5 },
  identity:        { label: 'Identity',          emoji: '🎭', description: 'IDENTITY.md parsé (Name/Role/Vibe)',               order: 6 },
  'codebase-search':{ label: 'Codebase Search',  emoji: '🔍', description: 'Hint pratique si index configuré',                 order: 7 },
  workspace:       { label: 'Workspace Files',   emoji: '📄', description: 'SOUL.md / MEMORY.md / autres .md du workspace',    order: 8 },
  'lazy-summary':  { label: 'Lazy Skills Summary', emoji: '📝', description: 'Bloc appended au system prompt (= messages[0]) quand lazySkills actif', order: 8.5 },
  'tools-builtin': { label: 'Tools (builtin)',   emoji: '🛠️', description: 'Outils natifs filtrés par modules + allowOnly/disabled', order: 9 },
  'tools-skill':   { label: 'Skills',            emoji: '✨', description: 'Actions de skills (stubs si lazySkills)',          order: 10 },
  other:           { label: 'Other',             emoji: '❔', description: 'Sections non classifiées',                          order: 99 },
};

function groupSections(sections: PromptSection[]): SectionGroup[] {
  const map = new Map<string, PromptSection[]>();
  for (const s of sections) {
    const { groupId } = classifySection(s.key);
    const arr = map.get(groupId) ?? [];
    arr.push(s);
    map.set(groupId, arr);
  }
  return [...map.entries()]
    .map(([id, secs]) => ({
      id,
      label: GROUP_META[id]?.label ?? id,
      emoji: GROUP_META[id]?.emoji ?? '·',
      description: GROUP_META[id]?.description ?? '',
      sections: secs,
    }))
    .sort((a, b) => (GROUP_META[a.id]?.order ?? 99) - (GROUP_META[b.id]?.order ?? 99));
}

/**
 * Merge tools + lazy summary into a unified section list so the sidebar groups them
 * naturally. Tools live in a separate API field (they're a parallel payload, not in
 * the system prompt string), but for UI purposes we render them as virtual sections
 * with `tool:<name>` / `skill:<name>` keys. The viewer shows their JSON schema.
 *
 * Lazy skill summary (when active) is a third virtual section — it's actually appended
 * to `messages[0].content` in run.ts, which IS the system message (role: 'system').
 * So in practice the summary becomes the tail of the system prompt at request time.
 * Visually we slot it as a separate group so the operator sees that this fragment is
 * conditional and isolated from the byte-stable buildSystemPrompt sections above it.
 */
function mergeVirtualSections(
  sections: PromptSection[],
  tools: ToolEntry[] | undefined,
  lazySummary: string | null | undefined,
  lazySummaryMeta: { chars: number; estimatedTokens: number } | null | undefined,
): PromptSection[] {
  const out: PromptSection[] = [...sections];
  if (lazySummary && lazySummaryMeta) {
    out.push({
      key: 'lazy-skill-summary',
      chars: lazySummaryMeta.chars,
      estimatedTokens: lazySummaryMeta.estimatedTokens,
      content: lazySummary,
    });
  }
  if (tools?.length) {
    for (const t of tools) {
      out.push({
        key: `${t.kind === 'skill' ? 'skill' : 'tool'}:${t.name}`,
        chars: t.chars,
        estimatedTokens: t.estimatedTokens,
        content: t.schema,
      });
    }
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}

export default function PromptBuilder() {
  const { agents, loading: agentsLoading } = useAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => {
    return localStorage.getItem('mm-advanced-agent') || null;
  });
  const [variant, setVariant] = useState<Variant>(() => {
    return (localStorage.getItem('mm-advanced-variant') as Variant) || 'web';
  });
  const [render, setRender] = useState<PromptRender | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lazyOverride, setLazyOverride] = useState<TriState>('config');
  const [skillCallMode, setSkillCallMode] = useState<SkillCallModePreview>(() => {
    return (localStorage.getItem('mm-advanced-skill-call-mode') as SkillCallModePreview) || 'stub';
  });
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [filter, setFilter] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    // Default : Tools (builtin) and Skills collapsed (they're the biggest, often 100+ items).
    try {
      const stored = localStorage.getItem('mm-advanced-collapsed-groups');
      if (stored) return new Set(JSON.parse(stored));
    } catch { /* ignore */ }
    return new Set(['tools-builtin', 'tools-skill']);
  });
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      try { localStorage.setItem('mm-advanced-collapsed-groups', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Default agent on first load (when list arrives and we haven't persisted a choice).
  useEffect(() => {
    if (!selectedAgentId && agents.length > 0) {
      const first = agents.find(a => a.kind !== 'subagent') ?? agents[0];
      setSelectedAgentId(first.identity.id);
    }
  }, [agents, selectedAgentId]);

  // Persist choice.
  useEffect(() => {
    if (selectedAgentId) localStorage.setItem('mm-advanced-agent', selectedAgentId);
  }, [selectedAgentId]);
  useEffect(() => {
    localStorage.setItem('mm-advanced-variant', variant);
  }, [variant]);
  useEffect(() => {
    localStorage.setItem('mm-advanced-skill-call-mode', skillCallMode);
  }, [skillCallMode]);

  // Fetch render.
  const fetchRender = useCallback(async () => {
    if (!selectedAgentId) return;
    setLoading(true);
    setError(null);
    const startedAt = Date.now();
    clientLogger.info('prompt-builder', 'fetch start', { agentId: selectedAgentId, variant, lazyOverride, skillCallMode });
    try {
      const qs = new URLSearchParams({ variant });
      if (lazyOverride !== 'config') qs.set('lazySkills', lazyOverride);
      if (skillCallMode !== 'stub') qs.set('skillCallMode', skillCallMode);
      const data = await api.get<PromptRender>(`/api/agents/${selectedAgentId}/prompt-render?${qs.toString()}`);
      setRender(data);
      // Default selection : first section of first group on fresh render.
      // Include tools in the "valid keys" set so a tool can stay selected across refreshes.
      const allKeys = new Set<string>(data.sections.map(s => s.key));
      data.tools?.forEach(t => allKeys.add(`${t.kind === 'skill' ? 'skill' : 'tool'}:${t.name}`));
      const firstSection = data.sections[0];
      setSelectedKey(prev => (prev && allKeys.has(prev)) ? prev : (firstSection?.key ?? null));
      clientLogger.info('prompt-builder', 'fetch done', {
        agentId: selectedAgentId,
        variant,
        sections: data.sections.length,
        tools: data.tools?.length ?? 0,
        chars: data.chars,
        toolsChars: data.toolsMeta?.chars ?? 0,
        lazySkills: data.toolsMeta?.lazySkillsActive ?? false,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      clientLogger.warn('prompt-builder', 'fetch failed', { agentId: selectedAgentId, variant, error: msg, ms: Date.now() - startedAt });
      setError(msg);
      setRender(null);
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId, variant, lazyOverride, skillCallMode]);

  useEffect(() => {
    fetchRender();
  }, [fetchRender]);

  // Merge tools + lazy summary as virtual sections so the sidebar groups them naturally.
  const allSections = useMemo(
    () => render
      ? mergeVirtualSections(render.sections, render.tools, render.lazySkillSummary, render.lazySkillSummaryMeta)
      : [],
    [render],
  );

  // "Tout (LLM context)" view = system prompt + lazy summary (if active) + tools schemas,
  // concaténés avec des séparateurs clairs pour visualiser ce que le LLM voit en prefix.
  // Ordre : system → lazy summary → tools (= ordre cache prefix Anthropic).
  const fullLlmContext = useMemo(() => {
    if (!render) return '';
    const parts: string[] = [
      `# ═══════════════════════════════════════════════════════════════════════════════
# SYSTEM PROMPT (${formatBytes(render.chars)} · ~${render.estimatedTokens.toLocaleString()} tokens)
# ═══════════════════════════════════════════════════════════════════════════════

${render.prompt}`,
    ];
    if (render.lazySkillSummary && render.lazySkillSummaryMeta) {
      parts.push(`# ═══════════════════════════════════════════════════════════════════════════════
# LAZY SKILL SUMMARY (appended to the system message at request time)
# ${formatBytes(render.lazySkillSummaryMeta.chars)} · ~${render.lazySkillSummaryMeta.estimatedTokens.toLocaleString()} tokens
# ═══════════════════════════════════════════════════════════════════════════════

${render.lazySkillSummary}`);
    }
    if (render.tools?.length && render.toolsMeta) {
      const toolsBlock = render.tools.map(t => `// ${t.kind === 'skill' ? 'SKILL' : 'BUILTIN'} — ${t.name}\n${t.schema}`).join('\n\n');
      parts.push(`# ═══════════════════════════════════════════════════════════════════════════════
# TOOLS (payload[\"tools\"] — ${render.tools.length} entries, ${formatBytes(render.toolsMeta.chars)} · ~${render.toolsMeta.estimatedTokens.toLocaleString()} tokens)
# ═══════════════════════════════════════════════════════════════════════════════

${toolsBlock}`);
    }
    return parts.join('\n\n');
  }, [render]);
  const groups = useMemo(() => {
    const all = groupSections(allSections);
    if (!filter.trim()) return all;
    const q = filter.trim().toLowerCase();
    // Filter sections within each group by key or subLabel match. Drop empty groups.
    return all
      .map(g => ({
        ...g,
        sections: g.sections.filter(s => {
          const { subLabel } = classifySection(s.key);
          const label = subLabel ?? s.key;
          return label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q);
        }),
      }))
      .filter(g => g.sections.length > 0);
  }, [allSections, filter]);
  const selectedSection = useMemo(() => {
    if (!selectedKey) return null;
    return allSections.find(s => s.key === selectedKey) ?? null;
  }, [allSections, selectedKey]);

  const handleCopy = useCallback(async () => {
    const text = showFull ? fullLlmContext : selectedSection?.content;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      clientLogger.warn('prompt-builder', 'copy failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, [showFull, fullLlmContext, selectedSection]);

  const sortedAgents = useMemo(() => {
    return [...agents]
      .filter(a => a.enabled !== false)
      .sort((a, b) => {
        // Standard agents first, then sub-agents.
        const sa = a.kind === 'subagent' ? 1 : 0;
        const sb = b.kind === 'subagent' ? 1 : 0;
        if (sa !== sb) return sa - sb;
        return a.identity.name.localeCompare(b.identity.name);
      });
  }, [agents]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border bg-card/20 shrink-0 flex-wrap">
        {/* Agent picker */}
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-muted-foreground uppercase tracking-wide">Agent</label>
          <select
            value={selectedAgentId ?? ''}
            onChange={(e) => setSelectedAgentId(e.target.value || null)}
            disabled={agentsLoading || sortedAgents.length === 0}
            className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-ring min-w-[180px]"
          >
            {sortedAgents.length === 0 && <option value="">— aucun agent —</option>}
            {sortedAgents.map(a => (
              <option key={a.identity.id} value={a.identity.id}>
                {a.identity.emoji} {a.identity.name} {a.kind === 'subagent' ? '(sub)' : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Variant toggle */}
        <div className="flex items-center gap-1 bg-secondary border border-border rounded-lg p-0.5">
          <button
            onClick={() => setVariant('web')}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
              variant === 'web' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            title="isMainSession=true"
          >
            <Globe size={11} /> Web
          </button>
          <button
            onClick={() => setVariant('telegram')}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
              variant === 'telegram' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            title="isMainSession=false"
          >
            <SendIcon size={11} /> Telegram
          </button>
        </div>

        {/* Lazy skills override (3-way) */}
        <div className="flex items-center gap-1 bg-secondary border border-border rounded-lg p-0.5" title="Preview lazy skill mode (override éphémère — n'écrit rien en DB)">
          <span className="text-[10px] text-muted-foreground/70 px-1.5 flex items-center gap-1">
            <Zap size={10} /> lazy
          </span>
          {(['config', 'on', 'off'] as TriState[]).map(state => (
            <button
              key={state}
              onClick={() => setLazyOverride(state)}
              className={clsx(
                'px-2 py-1 text-[11px] font-medium rounded-md transition-colors',
                lazyOverride === state
                  ? (state === 'config' ? 'bg-secondary/80 text-foreground border border-border' : 'bg-amber-500/20 text-amber-300 border border-amber-500/40')
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {state}
            </button>
          ))}
        </div>

        {/* Skill call mode preview (stub / wildcard) — only meaningful when lazy is active */}
        <div className="flex items-center gap-1 bg-secondary border border-border rounded-lg p-0.5" title="Preview skill dispatch mode — wildcard = single call_skill_action tool au lieu de N stubs (V2 ajoutera la persistance YAML)">
          <span className="text-[10px] text-muted-foreground/70 px-1.5">skill</span>
          {(['stub', 'wildcard'] as SkillCallModePreview[]).map(mode => (
            <button
              key={mode}
              onClick={() => setSkillCallMode(mode)}
              className={clsx(
                'px-2 py-1 text-[11px] font-medium rounded-md transition-colors',
                skillCallMode === mode
                  ? (mode === 'stub' ? 'bg-secondary/80 text-foreground border border-border' : 'bg-purple-500/20 text-purple-300 border border-purple-500/40')
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* Refresh */}
        <button
          onClick={fetchRender}
          disabled={loading || !selectedAgentId}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground bg-secondary hover:bg-secondary/80 rounded-lg transition-colors disabled:opacity-50"
        >
          <RotateCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>

        {/* Effective config panel toggle */}
        <button
          onClick={() => setShowConfigPanel(s => !s)}
          disabled={!render?.effectiveConfig}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-50',
            showConfigPanel
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground bg-secondary hover:bg-secondary/80',
          )}
        >
          <SettingsIcon size={11} />
          Effective config
        </button>

        {/* Stats globaux */}
        <div className="flex-1" />
        {render && (() => {
          const builtinCount = render.tools?.filter(t => t.kind === 'builtin').length ?? 0;
          const skillCount = render.tools?.filter(t => t.kind === 'skill').length ?? 0;
          const lazyChars = render.lazySkillSummaryMeta?.chars ?? 0;
          const lazyTokens = render.lazySkillSummaryMeta?.estimatedTokens ?? 0;
          const totalChars = render.chars + (render.toolsMeta?.chars ?? 0) + lazyChars;
          const totalTokens = render.estimatedTokens + (render.toolsMeta?.estimatedTokens ?? 0) + lazyTokens;
          const breakdownTitle = [
            `system: ${formatBytes(render.chars)} (~${render.estimatedTokens.toLocaleString()} tok)`,
            render.toolsMeta ? `tools: ${formatBytes(render.toolsMeta.chars)} (~${render.toolsMeta.estimatedTokens.toLocaleString()} tok)` : null,
            lazyChars ? `lazy summary: ${formatBytes(lazyChars)} (~${lazyTokens.toLocaleString()} tok)` : null,
            `total: ${formatBytes(totalChars)} (~${totalTokens.toLocaleString()} tok)`,
          ].filter(Boolean).join(' · ');
          return (
            <div className="flex items-center gap-4 text-xs">
              <div className="text-muted-foreground" title="Sections du system prompt (string concaténée)">
                <span className="text-foreground font-mono">{render.sections.length}</span> sec
              </div>
              {render.toolsMeta && (() => {
                const wildcardActive = render.effectiveConfig?.skillCallMode === 'wildcard';
                return (
                  <div className="text-muted-foreground" title={`${builtinCount} builtin + ${skillCount} skill${render.toolsMeta.lazySkillsActive ? (wildcardActive ? ' (wildcard: 0 stubs)' : ' (stubs lazy)') : ' (full defs)'} · skills emitted ${render.toolsMeta.skillCount.emitted}/${render.toolsMeta.skillCount.full}${render.toolsMeta.bypassUnified ? ' · bypassUnified' : ''}`}>
                    <span className="text-foreground font-mono">{builtinCount}</span>+<span className="text-foreground font-mono">{skillCount}</span> tools
                    {render.toolsMeta.lazySkillsActive && <span className="ml-1 text-amber-400/80 text-[10px]">lazy</span>}
                    {wildcardActive && <span className="ml-1 text-purple-300 text-[10px]">wildcard</span>}
                  </div>
                );
              })()}
              <div className="text-muted-foreground" title={breakdownTitle}>
                <span className="text-foreground font-mono">{formatBytes(totalChars)}</span>
                <span className="text-muted-foreground/60 text-[10px] ml-1">
                  ({formatBytes(render.chars)}
                  {render.toolsMeta ? ` +${formatBytes(render.toolsMeta.chars)}` : ''}
                  {lazyChars ? ` +${formatBytes(lazyChars)}` : ''})
                </span>
              </div>
              <div className="text-muted-foreground" title={breakdownTitle}>
                ~<span className="text-foreground font-mono">{totalTokens.toLocaleString()}</span> tok
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── Effective config panel (slide-down) ── */}
      {showConfigPanel && render?.effectiveConfig && (
        <EffectiveConfigPanel
          config={render.effectiveConfig}
          lazyOverride={lazyOverride}
          onClose={() => setShowConfigPanel(false)}
        />
      )}

      {/* ── Body ── */}
      {error ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle size={16} />
            <span className="text-sm">Erreur : {error}</span>
          </div>
        </div>
      ) : !render && loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Chargement du prompt…
        </div>
      ) : !render ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Sélectionne un agent pour afficher son prompt.
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* ── Sidebar sections ── */}
          <aside className="w-72 shrink-0 border-r border-border bg-card/10 flex flex-col min-h-0">
            {/* Sticky header : "Tout" + filter + collapse-all */}
            <div className="shrink-0 border-b border-border/50 bg-card/30">
              <button
                onClick={() => { setShowFull(true); setSelectedKey(null); }}
                className={clsx(
                  'w-full text-left px-4 py-2.5 transition-colors',
                  showFull ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
                )}
              >
                <div className="flex items-center gap-2">
                  <FileCode2 size={13} />
                  <span className="text-xs font-semibold">Tout (LLM context)</span>
                </div>
                <div className="text-[10px] text-muted-foreground/60 mt-0.5" title="System prompt + lazy summary + tools schemas concaténés">
                  {(() => {
                    const lazyChars = render.lazySkillSummaryMeta?.chars ?? 0;
                    const lazyTok = render.lazySkillSummaryMeta?.estimatedTokens ?? 0;
                    const totalC = render.chars + (render.toolsMeta?.chars ?? 0) + lazyChars;
                    const totalT = render.estimatedTokens + (render.toolsMeta?.estimatedTokens ?? 0) + lazyTok;
                    return `${formatBytes(totalC)} · ~${totalT.toLocaleString()} tokens`;
                  })()}
                </div>
              </button>

              {/* Filter input */}
              <div className="px-2 pb-2 pt-1 flex items-center gap-1.5">
                <div className="relative flex-1">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none" />
                  <input
                    type="text"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Filtrer sections…"
                    className="w-full pl-7 pr-7 py-1.5 text-[11px] bg-secondary/60 border border-border rounded-md text-foreground focus:outline-none focus:border-ring placeholder:text-muted-foreground/40"
                  />
                  {filter && (
                    <button
                      onClick={() => setFilter('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
                <button
                  onClick={() => {
                    // Collapse all if anything expanded, else expand all
                    const allIds = groups.map(g => g.id);
                    const allCollapsed = allIds.every(id => collapsedGroups.has(id));
                    setCollapsedGroups(allCollapsed ? new Set() : new Set(allIds));
                    try { localStorage.setItem('mm-advanced-collapsed-groups', JSON.stringify(allCollapsed ? [] : allIds)); } catch { /* ignore */ }
                  }}
                  className="text-[10px] px-2 py-1.5 bg-secondary/60 border border-border rounded-md text-muted-foreground hover:text-foreground transition-colors"
                  title="Tout replier / déplier"
                >
                  {groups.every(g => collapsedGroups.has(g.id)) ? '＋' : '－'}
                </button>
              </div>
            </div>

            {/* Scrollable group list */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {groups.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground/60">
                  Aucune section ne matche "{filter}"
                </div>
              ) : groups.map(group => {
                const collapsed = collapsedGroups.has(group.id);
                const groupChars = group.sections.reduce((acc, s) => acc + s.chars, 0);
                const groupTokens = group.sections.reduce((acc, s) => acc + s.estimatedTokens, 0);
                return (
                  <div key={group.id} className="py-1">
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className="w-full px-4 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground transition-colors group"
                      title={`${formatBytes(groupChars)} · ~${groupTokens.toLocaleString()} tok · clic pour ${collapsed ? 'déplier' : 'replier'}`}
                    >
                      {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                      <span>{group.emoji}</span>
                      <span className="font-semibold">{group.label}</span>
                      <span className="text-muted-foreground/40">({group.sections.length})</span>
                      <span className="ml-auto text-muted-foreground/40 normal-case tracking-normal text-[9px]">
                        {formatBytes(groupChars)} · ~{groupTokens >= 1000 ? `${(groupTokens / 1000).toFixed(1)}k` : groupTokens} tok
                      </span>
                    </button>
                    {!collapsed && group.sections.map(s => {
                      const { subLabel } = classifySection(s.key);
                      const isActive = !showFull && selectedKey === s.key;
                      return (
                        <button
                          key={s.key}
                          onClick={() => { setSelectedKey(s.key); setShowFull(false); }}
                          className={clsx(
                            'w-full text-left px-4 py-1.5 transition-colors group',
                            isActive
                              ? 'bg-primary/10 border-l-2 border-primary'
                              : 'border-l-2 border-transparent hover:bg-secondary/40',
                          )}
                        >
                          <div className={clsx('text-xs font-mono truncate', isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>
                            {subLabel ?? s.key}
                          </div>
                          <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                            {formatBytes(s.chars)} · ~{s.estimatedTokens.toLocaleString()} tok
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* ── Viewer ── */}
          <section className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-card/20 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {showFull ? (
                  <>
                    <FileCode2 size={13} className="text-muted-foreground shrink-0" />
                    <span className="text-xs font-semibold text-foreground">Tout (LLM context)</span>
                    <span className="text-[10px] text-muted-foreground/60 truncate">
                      — system + {render.lazySkillSummary ? 'lazy summary + ' : ''}{render.tools?.length ?? 0} tools
                    </span>
                  </>
                ) : selectedSection ? (
                  <>
                    <span className="text-xs font-mono text-muted-foreground truncate">{selectedSection.key}</span>
                    <span className="text-[10px] text-muted-foreground/60 shrink-0">
                      · {formatBytes(selectedSection.chars)} · ~{selectedSection.estimatedTokens.toLocaleString()} tokens
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">Aucune section sélectionnée</span>
                )}
              </div>
              <button
                onClick={handleCopy}
                disabled={showFull ? !fullLlmContext : !selectedSection}
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground bg-secondary hover:bg-secondary/80 rounded-md transition-colors disabled:opacity-50"
              >
                {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                {copied ? 'Copié' : 'Copier'}
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              <pre className="text-[12px] leading-relaxed font-mono text-foreground/90 px-5 py-4 whitespace-pre-wrap break-words">
                {showFull
                  ? fullLlmContext
                  : selectedSection?.content ?? ''}
              </pre>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * Read-only panel showing what's *actually* applied to the agent for this render,
 * with explicit "from config" vs "overridden" badges so the operator can see the
 * difference between what's persisted in YAML and what they're previewing.
 */
function EffectiveConfigPanel({
  config,
  lazyOverride,
  onClose,
}: {
  config: EffectiveConfig;
  lazyOverride: TriState;
  onClose: () => void;
}) {
  const renderBoolFlag = (
    label: string,
    value: boolean,
    override: OverrideStatus,
    hint?: string,
  ) => (
    <div className="flex items-center gap-2 py-1">
      <span className={clsx(
        'inline-block w-2 h-2 rounded-full shrink-0',
        value ? 'bg-emerald-400' : 'bg-muted-foreground/40',
      )} />
      <span className="text-xs font-mono text-foreground/90">{label}</span>
      <span className={clsx('text-[10px] font-mono px-1 rounded', value ? 'bg-emerald-400/10 text-emerald-300' : 'bg-muted/40 text-muted-foreground')}>
        {value ? 'on' : 'off'}
      </span>
      {override.active ? (
        <span className="text-[10px] px-1.5 py-px rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
          preview override (config: {override.configValue ? 'on' : 'off'})
        </span>
      ) : (
        <span className="text-[10px] px-1.5 py-px rounded bg-muted/30 text-muted-foreground/70">from config</span>
      )}
      {hint && <span className="text-[10px] text-muted-foreground/50 ml-1 truncate">— {hint}</span>}
    </div>
  );

  const renderList = (label: string, items: string[], hint: string) => (
    <div className="py-1">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-mono text-foreground/90">{label}</span>
        <span className="text-[10px] font-mono px-1 rounded bg-muted/40 text-muted-foreground">
          {items.length}
        </span>
        <span className="text-[10px] text-muted-foreground/50">— {hint}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[10px] text-muted-foreground/40 pl-3 italic">(empty)</div>
      ) : (
        <div className="flex flex-wrap gap-1 pl-3">
          {items.map(it => (
            <span key={it} className="text-[10px] font-mono px-1.5 py-px rounded bg-secondary/60 text-foreground/80 border border-border/30">
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="border-b border-border bg-card/30 px-6 py-3 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground/80 font-semibold">
          Effective config (read-only)
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-0.5"
          title="Close"
        >
          <X size={12} />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
        {/* Flags */}
        <div>
          {renderBoolFlag('lazySkills', config.lazySkills, config.overrides.lazySkills, lazyOverride === 'config' ? undefined : `toolbar = ${lazyOverride}`)}
          {renderBoolFlag('bypassUnifiedCache', config.bypassUnifiedCache, config.overrides.bypassUnifiedCache, 'YAML: agent.bypassUnifiedCache')}
          {renderBoolFlag('memoryStoreEnabled', config.memoryStoreEnabled, { active: false }, 'global config')}
          <div className="flex items-center gap-2 py-1">
            <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-blue-400/70" />
            <span className="text-xs font-mono text-foreground/90">kind</span>
            <span className="text-[10px] font-mono px-1 rounded bg-blue-400/10 text-blue-300">{config.kind}</span>
            <span className="text-[10px] text-muted-foreground/50">— affects platform vs sub-agent harness</span>
          </div>
          {/* skillCallMode — read-only ici. Édition via Agent Settings (AgentConfigTab). */}
          <div className="flex items-center gap-2 py-1">
            <span className={clsx(
              'inline-block w-2 h-2 rounded-full shrink-0',
              config.skillCallMode === 'wildcard' ? 'bg-purple-400' : 'bg-muted-foreground/40',
            )} />
            <span className="text-xs font-mono text-foreground/90">skillCallMode</span>
            <span className={clsx(
              'text-[10px] font-mono px-1 rounded',
              config.skillCallMode === 'wildcard' ? 'bg-purple-400/10 text-purple-300' : 'bg-muted/40 text-muted-foreground',
            )}>
              {config.skillCallMode}
            </span>
            {config.overrides.skillCallMode.active ? (
              <span className="text-[10px] px-1.5 py-px rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                preview override (YAML: {config.overrides.skillCallMode.configValue})
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-px rounded bg-muted/30 text-muted-foreground/70">from YAML</span>
            )}
            <span className="text-[10px] text-muted-foreground/50 ml-1">— éditer dans Agent Settings · stub: N skill stubs · wildcard: 1 call_skill_action</span>
          </div>
        </div>
        {/* Lists */}
        <div>
          {renderList('starredSkills', config.starredSkills, 'matters quand bypassUnified=on')}
          {renderList('sharedStarredFiles', config.sharedStarredFiles, 'fichiers shared (ordre = signature)')}
          {renderList('disabledTools', config.disabledTools, 'strip si bypassUnified=on, gate exec sinon')}
          {config.kind === 'subagent' && renderList('allowOnly', config.allowOnly, 'restriction sub-agent (toujours active)')}
        </div>
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground/60 italic">
        💡 Les overrides du toolbar ne sont pas persistés — ils servent juste à prévisualiser. La config YAML reste intacte. Édition complète en V2.
      </div>
    </div>
  );
}
