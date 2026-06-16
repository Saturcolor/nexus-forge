import { useState, useCallback, useRef, useEffect } from 'react';
import { Zap, X, ChevronLeft } from 'lucide-react';
import type { SkillActionForUI } from '../hooks/useSkillActions';

interface Props {
  /** Map skillDir → list of actions for that skill (any order). */
  actionsBySkill: Record<string, SkillActionForUI[]>;
  onExecute: (action: SkillActionForUI, params: Record<string, unknown>) => void;
  disabled?: boolean;
  /** Whole bar collapsed to just the Zap icon — owned by parent so we can persist
   *  via the existing ui-prefs API (cross-device, like selectedAgent / agentPanelOpen). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * Skill action bar — one chip per skill, click opens a panel listing all actions
 * for that skill. Selecting an action either executes immediately (no required
 * params) or swaps the panel into a parameter form.
 *
 * Was previously one chip per primary action + a "More" dropdown — too crowded
 * once you have ~6+ skills installed. Grouping by skill shrinks the bar to ~7-8
 * chips regardless of how many actions each skill exposes.
 */
export function SkillActionsBar({ actionsBySkill, onExecute, disabled, collapsed, onToggleCollapsed }: Props) {
  /** Skill currently expanded in the panel — null when bar is closed. */
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  /** Action whose param form is being filled — null when picking from the list. */
  const [expandedAction, setExpandedAction] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close panel on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenSkill(null);
        setExpandedAction(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // When the parent collapses the bar, also dismiss any open panel.
  useEffect(() => {
    if (collapsed) {
      setOpenSkill(null);
      setExpandedAction(null);
    }
  }, [collapsed]);

  const skillKeys = Object.keys(actionsBySkill);
  if (skillKeys.length === 0) return null;

  /** Sort actions inside a skill: primary first, then alpha by visible label. */
  const sortedActions = (skillDir: string): SkillActionForUI[] => {
    const list = [...(actionsBySkill[skillDir] ?? [])];
    return list.sort((a, b) => {
      const ap = a.ui?.primary ? 0 : 1;
      const bp = b.ui?.primary ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (a.ui?.label ?? a.name).localeCompare(b.ui?.label ?? b.name);
    });
  };

  const handleActionClick = useCallback((action: SkillActionForUI) => {
    if (disabled) return;
    const props = action.parameters?.properties ?? {};
    const required = action.parameters?.required ?? [];
    const needsInput = required.some(key => props[key]?.default === undefined);

    if (!needsInput) {
      // No required input → execute right away (with confirm if asked).
      if (action.ui?.confirm && !confirm(`Execute "${action.name}"?`)) return;
      const defaults: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v.default !== undefined) defaults[k] = v.default;
      }
      onExecute(action, defaults);
      setOpenSkill(null);
    } else {
      // Swap to param form, prefilled with declared defaults.
      const defaults: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v.default !== undefined) defaults[k] = v.default;
      }
      setParamValues(defaults);
      setExpandedAction(action.toolName);
    }
  }, [disabled, onExecute]);

  const expandedActionObj = expandedAction
    ? Object.values(actionsBySkill).flat().find(a => a.toolName === expandedAction)
    : null;

  const handleSubmit = useCallback((action: SkillActionForUI) => {
    if (action.ui?.confirm && !confirm(`Execute "${action.name}"?`)) return;
    onExecute(action, paramValues);
    setExpandedAction(null);
    setOpenSkill(null);
    setParamValues({});
  }, [paramValues, onExecute]);

  return (
    <div className="relative" ref={popoverRef}>
      {/* Skill chips row */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto scrollbar-hide">
        {/* Zap toggles the bar collapsed/expanded — parent persists the state. */}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={`flex-shrink-0 p-0.5 rounded transition-colors
            ${collapsed
              ? 'text-muted-foreground/60 hover:text-muted-foreground'
              : 'text-muted-foreground hover:text-foreground'}`}
          title={collapsed ? `Show skill actions (${skillKeys.length})` : 'Hide skill actions'}
          aria-pressed={!collapsed}
        >
          <Zap className="w-3 h-3" />
        </button>

        {!collapsed && skillKeys.map(skillDir => {
          const list = actionsBySkill[skillDir];
          const first = list[0];
          if (!first) return null;
          const isOpen = openSkill === skillDir;
          return (
            <button
              key={skillDir}
              onClick={() => {
                if (isOpen) {
                  setOpenSkill(null);
                  setExpandedAction(null);
                } else {
                  setOpenSkill(skillDir);
                  setExpandedAction(null);
                }
              }}
              disabled={disabled}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors
                ${isOpen
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'
                }
                disabled:opacity-40 disabled:cursor-not-allowed`}
              title={`${first.skillName} — ${list.length} action${list.length > 1 ? 's' : ''}`}
            >
              <span>{first.skillEmoji}</span>
              <span>{first.skillName}</span>
              <span className="text-[9px] opacity-70 ml-0.5">{list.length}</span>
            </button>
          );
        })}
      </div>

      {/* Action picker for the currently open skill — opens UPWARD because the
          bar sits right above the chat input; opening downward would cover it. */}
      {openSkill && !expandedAction && (() => {
        const list = sortedActions(openSkill);
        const first = list[0];
        if (!first) return null;
        return (
          <div className="absolute left-3 right-3 bottom-full z-50 mb-1 bg-card border border-border rounded-lg shadow-lg shadow-black/30 p-2 max-h-72 overflow-y-auto">
            <div className="flex items-center justify-between mb-1.5 px-1">
              <span className="text-xs font-medium text-foreground">
                {first.skillEmoji} {first.skillName}
              </span>
              <button
                onClick={() => setOpenSkill(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close skill panel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-0.5">
              {list.map(action => (
                <button
                  key={action.toolName}
                  onClick={() => handleActionClick(action)}
                  disabled={disabled}
                  className="w-full text-left px-2 py-1 rounded hover:bg-secondary/60
                    disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={action.description}
                >
                  <div className="text-xs text-foreground">
                    {action.ui?.label ?? action.name}
                  </div>
                  {action.description && (
                    <div className="text-[10px] text-muted-foreground line-clamp-2">
                      {action.description}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Param form for an action that needs required inputs (also opens upward) */}
      {expandedAction && expandedActionObj && (
        <div className="absolute left-3 right-3 bottom-full z-50 mb-1 bg-card border border-border rounded-lg shadow-lg shadow-black/30 p-3">
          <div className="flex items-center justify-between mb-2 gap-2">
            <button
              onClick={() => setExpandedAction(null)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[10px]"
              aria-label="Back to action picker"
            >
              <ChevronLeft className="w-3 h-3" />
              <span>Back</span>
            </button>
            <span className="text-sm font-medium truncate">
              {expandedActionObj.skillEmoji} {expandedActionObj.ui?.label ?? expandedActionObj.name}
            </span>
            <button
              onClick={() => { setExpandedAction(null); setOpenSkill(null); }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-2">
            {Object.entries(expandedActionObj.parameters?.properties ?? {}).map(([key, param]) => {
              const isRequired = expandedActionObj.parameters?.required?.includes(key);
              return (
                <div key={key}>
                  <label className="text-xs text-muted-foreground">
                    {key}{isRequired ? ' *' : ''}
                    {param.description && (
                      <span className="ml-1 text-[10px] opacity-60">— {param.description}</span>
                    )}
                  </label>
                  <input
                    type={param.type === 'number' ? 'number' : 'text'}
                    value={String(paramValues[key] ?? '')}
                    onChange={(e) => setParamValues(prev => ({
                      ...prev,
                      [key]: param.type === 'number' ? Number(e.target.value) : e.target.value,
                    }))}
                    placeholder={param.default !== undefined ? String(param.default) : undefined}
                    className="w-full mt-0.5 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              );
            })}
          </div>

          <button
            onClick={() => handleSubmit(expandedActionObj)}
            className="mt-2 w-full px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded hover:brightness-110 transition-all"
          >
            Execute
          </button>
        </div>
      )}
    </div>
  );
}
