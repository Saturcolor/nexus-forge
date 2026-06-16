import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Star, Zap, Pencil, X, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import type { SkillEntry, AgentFull } from './types';

export interface SkillActionToolEntry {
  toolName: string;
  actionName: string;
  skillDir: string;
  skillName: string;
  skillEmoji?: string;
}

export interface AgentSkillsTabProps {
  agentDetail: AgentFull;
  skills: SkillEntry[];
  skillsLoading: boolean;
  skillActionTools: SkillActionToolEntry[];
  configDraft: Partial<AgentFull>;
  saveConfigPatch: (patch: Partial<AgentFull>) => Promise<void>;
}

interface SkillSection {
  skillDir: string;
  displayName: string;
  emoji?: string;
  description?: string;
  actions: Array<{ toolName: string; actionName: string }>;
}

export function AgentSkillsTab({
  agentDetail,
  skills,
  skillsLoading,
  skillActionTools,
  configDraft,
  saveConfigPatch,
}: AgentSkillsTabProps) {
  const isSubAgent = (configDraft.kind ?? agentDetail.kind) === 'subagent';
  const tools = configDraft.tools ?? {};
  const promptInjection = configDraft.promptInjection ?? agentDetail.promptInjection ?? {};

  // Race-safe refs — voir commentaire dans AgentConfigTab pour le rationale.
  const toolsRef = useRef<NonNullable<AgentFull['tools']>>(tools);
  useEffect(() => { toolsRef.current = tools; }, [tools]);
  const promptInjectionRef = useRef<NonNullable<AgentFull['promptInjection']>>(promptInjection);
  useEffect(() => { promptInjectionRef.current = promptInjection; }, [promptInjection]);

  const allowOnlyList = tools.allowOnly ?? [];
  const allowOnlySet = useMemo(() => new Set(allowOnlyList), [allowOnlyList]);
  const starredSet = useMemo(() => new Set(promptInjection.starredSkills ?? []), [promptInjection.starredSkills]);

  const skillSections: SkillSection[] = useMemo(() => {
    const byDir = new Map<string, SkillSection>();
    for (const sk of skills) {
      byDir.set(sk.dir, {
        skillDir: sk.dir,
        displayName: sk.name || sk.dir,
        emoji: sk.emoji,
        description: sk.description,
        actions: [],
      });
    }
    for (const a of skillActionTools) {
      let entry = byDir.get(a.skillDir);
      if (!entry) {
        entry = { skillDir: a.skillDir, displayName: a.skillName || a.skillDir, emoji: a.skillEmoji, actions: [] };
        byDir.set(a.skillDir, entry);
      } else if (!entry.emoji && a.skillEmoji) {
        entry.emoji = a.skillEmoji;
      }
      entry.actions.push({ toolName: a.toolName, actionName: a.actionName });
    }
    return [...byDir.values()].sort((a, b) => a.skillDir.localeCompare(b.skillDir));
  }, [skills, skillActionTools]);

  const totalSkillActions = useMemo(
    () => skillSections.reduce((n, s) => n + s.actions.length, 0),
    [skillSections],
  );
  const selectedSkillActions = useMemo(
    () => skillSections.reduce((n, s) => n + s.actions.filter(a => allowOnlySet.has(a.toolName)).length, 0),
    [skillSections, allowOnlySet],
  );

  // Sub-agent : si allowOnly contient des skill_*, le starred-gate est shunté côté backend.
  // Déclaré ici pour que `effectiveAllowedActions` puisse en tenir compte.
  const allowOnlyHasSkillTool = isSubAgent && allowOnlyList.some(t => t.startsWith('skill_'));

  // Compte des actions RÉELLEMENT autorisées (= ce que l'agent peut exécuter).
  // Distinct de `selectedSkillActions` : une skill étoilée sans aucune action cochée
  // donne accès à TOUTES ses actions (rétro-compat starredSkills), pas zéro.
  const effectiveAllowedActions = useMemo(() => {
    return skillSections.reduce((acc, s) => {
      const dirActionsCount = s.actions.filter(a => allowOnlySet.has(a.toolName)).length;
      if (allowOnlyHasSkillTool) {
        // Sub-agent + allowOnly strict : seules les actions cochées passent (étoile shuntée).
        return acc + dirActionsCount;
      }
      if (!starredSet.has(s.skillDir)) return acc; // pas étoilée → bloqué
      if (dirActionsCount > 0) return acc + dirActionsCount; // subset choisi
      return acc + s.actions.length; // étoilée + 0 cochée → toutes OK
    }, 0);
  }, [skillSections, allowOnlySet, starredSet, allowOnlyHasSkillTool]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (dir: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  const saveTools = (patch: Partial<NonNullable<AgentFull['tools']>>) => {
    const merged = { ...toolsRef.current, ...patch };
    toolsRef.current = merged;
    return saveConfigPatch({ tools: merged });
  };

  const toggleAllowOnly = (toolName: string) => {
    const cur = toolsRef.current.allowOnly ?? [];
    const next = cur.includes(toolName) ? cur.filter(t => t !== toolName) : [...cur, toolName];
    return saveTools({ allowOnly: next });
  };

  const toggleSkillStar = (skillDir: string) => {
    const cur = promptInjectionRef.current.starredSkills ?? [];
    const next = cur.includes(skillDir)
      ? cur.filter(x => x !== skillDir)
      : [...cur, skillDir].sort((a, b) => a.localeCompare(b));
    const merged = {
      sharedStarredFiles: promptInjectionRef.current.sharedStarredFiles ?? [],
      workspaceStarredFiles: promptInjectionRef.current.workspaceStarredFiles ?? [],
      starredSkills: next,
    };
    promptInjectionRef.current = merged;
    return saveConfigPatch({ promptInjection: merged });
  };

  // Modal SKILL.md
  const [editingSkillDir, setEditingSkillDir] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState('');
  const [skillContentLoading, setSkillContentLoading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);

  const openSkillEditor = async (skillDir: string) => {
    setEditingSkillDir(skillDir);
    setSkillContent('');
    setSkillContentLoading(true);
    try {
      const res = await api.get<{ name: string; content: string }>(`/api/skills/${skillDir}`);
      setSkillContent(res.content);
    } catch {
      setSkillContent('');
    } finally {
      setSkillContentLoading(false);
    }
  };
  const closeSkillEditor = () => {
    setEditingSkillDir(null);
    setSkillContent('');
  };
  const saveSkillContent = async () => {
    if (!editingSkillDir) return;
    setSkillSaving(true);
    try {
      await api.put(`/api/skills/${editingSkillDir}`, { content: skillContent });
    } finally {
      setSkillSaving(false);
    }
  };

  const resetAllowOnly = () => {
    // Sub-agent: preserve core-tool allowOnly entries configured in Config tab.
    // Here we only reset skill_* entries from the Skills tab.
    const cur = toolsRef.current.allowOnly ?? [];
    const kept = cur.filter(t => !t.startsWith('skill_'));
    return saveTools({ allowOnly: kept });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 w-full max-w-5xl mx-auto">
      <div className="mb-4 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground flex items-center gap-2">
            <Zap size={14} className="text-primary" />
            Skills
          </h2>
          <p className="text-[11px] text-muted-foreground/70 mt-1 max-w-2xl">
            <Star size={10} className="inline-block mb-0.5 mr-0.5 text-yellow-400" fill="currentColor" />{' '}
            = skill autorisée à l'exécution.
            Coche des actions précises pour restreindre cette skill à un sous-ensemble (laisser tout décoché = toutes
            les actions de la skill étoilée sont OK).
            {isSubAgent && (
              <span className="block mt-1 text-muted-foreground/60">
                Les outils core (bash, read_file, …) restent dans la card Outils du Config tab.
              </span>
            )}
          </p>
        </div>
        <div
          className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground/70 shrink-0"
          title={`${effectiveAllowedActions} actions exécutables sur ${totalSkillActions} chargées (${starredSet.size} skills favorites, ${selectedSkillActions} actions cochées)`}
        >
          <span>
            <span className="text-foreground font-semibold">{starredSet.size}</span> favoris
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <span className="text-foreground font-semibold">{effectiveAllowedActions}</span>
            <span className="text-muted-foreground/50">/{totalSkillActions}</span> exécutables
          </span>
          {allowOnlyList.some(t => t.startsWith('skill_')) && (
            <button
              type="button"
              onClick={() => void resetAllowOnly()}
              className="ml-2 px-2 py-1 rounded border border-border bg-secondary hover:border-ring text-foreground"
              title="Vider la liste blanche d'actions (les skills étoilées redeviennent ouvertes à toutes leurs actions)"
            >
              Réinitialiser
            </button>
          )}
        </div>
      </div>

      {allowOnlyHasSkillTool && (
        <p className="text-[11px] text-amber-400/90 italic mb-3 flex items-start gap-1.5 px-2 py-1.5 rounded border border-amber-500/20 bg-amber-500/5">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>
            Sub-agent : <code className="font-mono bg-secondary/60 px-1 rounded">allowOnly</code> contient des actions
            {' '}<code className="font-mono bg-secondary/60 px-1 rounded">skill_*</code> — les étoiles favoris sont
            ignorées à l'exécution tant que la liste blanche est active.
          </span>
        </p>
      )}

      {skillsLoading ? (
        <p className="text-xs text-muted-foreground/60 italic">Chargement…</p>
      ) : skillSections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground/40">
          <Zap size={28} />
          <p className="text-sm">Aucune skill chargée.</p>
        </div>
      ) : (
        <div className="border border-border/50 rounded-md divide-y divide-border/40 overflow-hidden">
          {skillSections.map(section => {
            const isExpanded = expanded.has(section.skillDir);
            const isStarred = starredSet.has(section.skillDir);
            const selectedCount = section.actions.filter(a => allowOnlySet.has(a.toolName)).length;
            const hasActions = section.actions.length > 0;
            const dimmed = isStarred && allowOnlyHasSkillTool;
            return (
              <div key={section.skillDir}>
                <div
                  className={clsx(
                    'flex items-center gap-2 px-3 py-2 hover:bg-secondary/30 transition-colors',
                    hasActions && 'cursor-pointer',
                  )}
                  onClick={() => { if (hasActions) toggleExpanded(section.skillDir); }}
                >
                  {hasActions ? (
                    <ChevronRight
                      size={12}
                      className={clsx(
                        'shrink-0 text-muted-foreground/70 transition-transform',
                        isExpanded && 'rotate-90',
                      )}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="w-3 shrink-0" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void toggleSkillStar(section.skillDir); }}
                    title={isStarred ? `Retirer ${section.displayName} des favoris` : `Ajouter ${section.displayName} aux favoris`}
                    className={clsx(
                      'shrink-0 transition-colors',
                      isStarred ? 'text-yellow-400' : 'text-muted-foreground/30 hover:text-yellow-400',
                      dimmed && 'opacity-50',
                    )}
                    aria-pressed={isStarred}
                    aria-label={`Favori ${section.displayName}`}
                  >
                    <Star size={13} fill={isStarred ? 'currentColor' : 'none'} />
                  </button>
                  <span className="text-[12px] flex-1 min-w-0 flex items-center gap-1.5">
                    {section.emoji && <span className="text-[14px] leading-none shrink-0">{section.emoji}</span>}
                    <span className="font-mono text-foreground truncate" title={section.skillDir}>
                      {section.displayName}
                    </span>
                    {section.description && (
                      <span className="text-[10px] text-muted-foreground/60 truncate hidden md:inline ml-2">
                        — {section.description}
                      </span>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-[10px] font-mono text-muted-foreground/60 mr-1"
                    title={
                      !hasActions
                        ? 'Skill sans action exécutable (doc-only)'
                        : allowOnlyHasSkillTool
                          ? `${selectedCount} actions cochées sur ${section.actions.length} (allowOnly strict, étoile ignorée)`
                          : !isStarred
                            ? 'Skill non étoilée — aucune action autorisée'
                            : selectedCount === 0
                              ? `${section.actions.length} actions toutes autorisées (skill étoilée, aucun subset)`
                              : `${selectedCount}/${section.actions.length} actions autorisées (subset)`
                    }
                  >
                    {!hasActions ? (
                      <span className="italic">doc</span>
                    ) : allowOnlyHasSkillTool ? (
                      <>
                        <span className={selectedCount > 0 ? 'text-foreground font-semibold' : ''}>{selectedCount}</span>
                        <span className="text-muted-foreground/50">/{section.actions.length}</span>
                      </>
                    ) : !isStarred ? (
                      <span className="italic text-muted-foreground/40">off</span>
                    ) : selectedCount === 0 ? (
                      <span className="text-foreground/80">tout · {section.actions.length}</span>
                    ) : (
                      <>
                        <span className="text-amber-400 font-semibold">{selectedCount}</span>
                        <span className="text-muted-foreground/50">/{section.actions.length}</span>
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void openSkillEditor(section.skillDir); }}
                    title="Éditer SKILL.md"
                    className="shrink-0 text-muted-foreground/40 hover:text-foreground transition-colors p-1 rounded hover:bg-secondary/60"
                  >
                    <Pencil size={11} />
                  </button>
                </div>
                {hasActions && isExpanded && (
                  <div className="bg-secondary/20 px-3 py-2 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-3 gap-y-1">
                    {section.actions.map(action => (
                      <label
                        key={action.toolName}
                        className="flex items-center gap-2 cursor-pointer text-[11px] text-foreground hover:bg-secondary/40 px-1 py-0.5 rounded"
                      >
                        <input
                          type="checkbox"
                          checked={allowOnlySet.has(action.toolName)}
                          onChange={() => void toggleAllowOnly(action.toolName)}
                          className="cursor-pointer shrink-0"
                        />
                        <span className="font-mono shrink-0 text-foreground/90 truncate" title={action.toolName}>
                          {action.actionName}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingSkillDir && (
        <SkillEditorModal
          skillDir={editingSkillDir}
          content={skillContent}
          loading={skillContentLoading}
          saving={skillSaving}
          onChange={setSkillContent}
          onSave={saveSkillContent}
          onClose={closeSkillEditor}
        />
      )}
    </div>
  );
}

interface SkillEditorModalProps {
  skillDir: string;
  content: string;
  loading: boolean;
  saving: boolean;
  onChange: (s: string) => void;
  onSave: () => Promise<void> | void;
  onClose: () => void;
}

function SkillEditorModal({ skillDir, content, loading, saving, onChange, onSave, onClose }: SkillEditorModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
          <span className="text-[12px] font-mono text-muted-foreground">
            <span className="text-foreground">{skillDir}</span>/SKILL.md
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void onSave()}
              disabled={saving || loading}
              className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onClose}
              className="text-muted-foreground/60 hover:text-foreground p-1 rounded hover:bg-secondary/60 transition-colors"
              title="Fermer (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground/60">Chargement…</div>
        ) : (
          <textarea
            value={content}
            onChange={e => onChange(e.target.value)}
            className="flex-1 bg-background text-foreground p-4 font-mono text-sm resize-none focus:outline-none"
            spellCheck={false}
            autoFocus
          />
        )}
      </div>
    </div>
  );
}
