import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';

export interface Agent {
  identity: {
    id: string;
    name: string;
    emoji: string;
    creature: string;
    vibe: string;
  };
  workspacePath: string;
  model: string;
  maxContextTokens?: number;
  state: string;
  enabled?: boolean;
  telegram?: { enabled: boolean };
  /** Reasoning effort (single source of truth — agent-level). */
  thinkBudget?: 'off' | 'low' | 'medium' | 'high';
  /** Agent type — `'subagent'` for cloud one-shot presets, `'agent'` (default) otherwise. */
  kind?: 'agent' | 'subagent';
  loraScales?: number[];
  /** Mode session unifiée cross-plateforme : web/mobile/Telegram → 1 session `{agent}-unified`. */
  unifiedSession?: boolean;
}

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAgents = useCallback(async () => {
    try {
      // kind=all returns both main agents AND sub-agents — callers filter as needed
      // (Gallery hides subagents; AgentDetailPage needs them so /agents/:id works for both).
      const data = await api.get<Agent[]>('/api/agents?kind=all');
      setAgents(data);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();

    // Listen for state + config changes
    const unsub = wsClient.subscribe((msg) => {
      if (msg.type === 'agent.state') {
        setAgents(prev =>
          prev.map(a =>
            a.identity.id === msg.agentId ? { ...a, state: msg.state } : a
          ),
        );
      } else if (msg.type === 'agent.config') {
        setAgents(prev =>
          prev.map(a =>
            a.identity.id === msg.agentId ? { ...a, ...msg.patch } : a
          ),
        );
      }
    });

    return unsub;
  }, [fetchAgents]);

  return { agents, loading, refetch: fetchAgents };
}
