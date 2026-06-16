import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

export interface SkillActionParam {
  type: string;
  description?: string;
  default?: unknown;
  enum?: string[];
}

export interface SkillActionUI {
  primary?: boolean;
  label?: string;
  confirm?: boolean;
}

export interface SkillActionForUI {
  skillDir: string;
  skillName: string;
  skillEmoji: string;
  actionId: string;
  name: string;
  description: string;
  toolName: string;
  parameters?: {
    type: 'object';
    properties?: Record<string, SkillActionParam>;
    required?: string[];
  };
  ui: SkillActionUI;
}

export function useSkillActions() {
  const [actions, setActions] = useState<SkillActionForUI[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<SkillActionForUI[]>('/api/skills/actions')
      .then(setActions)
      .catch((err) => console.error('[useSkillActions] fetch error:', err))
      .finally(() => setLoading(false));
  }, []);

  const executeAction = useCallback((
    action: SkillActionForUI,
    params: Record<string, unknown>,
    sendMessage: (agentId: string, content: string) => void,
    agentId: string,
  ) => {
    // Send a structured message that the agent will recognize and execute as a tool call
    const paramsStr = JSON.stringify(params);
    const msg = `[skill_action] Use tool \`${action.toolName}\` with parameters: ${paramsStr}`;
    sendMessage(agentId, msg);
  }, []);

  // Group actions by skill for UI organization
  const actionsBySkill = actions.reduce<Record<string, SkillActionForUI[]>>((acc, action) => {
    const key = action.skillDir;
    if (!acc[key]) acc[key] = [];
    acc[key].push(action);
    return acc;
  }, {});

  // Get only primary actions (for the quick bar)
  const primaryActions = actions.filter(a => a.ui?.primary);

  return {
    actions,
    primaryActions,
    actionsBySkill,
    loading,
    executeAction,
  };
}
