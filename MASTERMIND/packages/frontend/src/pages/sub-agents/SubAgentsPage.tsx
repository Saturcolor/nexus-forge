/**
 * Galerie Sub-agents — même pattern visuel que la section Agents (grille de cartes + création).
 * La fiche détail (workspace, config, skills, cache, runs) vit sous `/sub-agents/:id` (AgentDetailPage).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Bot } from 'lucide-react';
import { useAgents } from '../../hooks/useAgents';
import { api } from '../../lib/api';
import { CreateSubAgentPopup, type CreateSubAgentForm } from './CreateSubAgentPopup';
import type { ProviderOption } from '../agents/types';

export default function SubAgentsPage() {
  const navigate = useNavigate();
  const { agents: allAgents, loading, refetch } = useAgents();
  const subAgents = allAgents.filter(a => a.kind === 'subagent');
  const mainAgentIds = allAgents.filter(a => a.kind !== 'subagent').map(a => a.identity.id);

  const [workspaceDirs, setWorkspaceDirs] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const createBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    Promise.all([
      api.get<string[]>('/api/agents/workspace/scan').catch(() => [] as string[]),
      api.get<ProviderOption[]>('/api/providers').catch(() => [] as ProviderOption[]),
    ]).then(([dirs, provs]) => {
      setWorkspaceDirs(dirs);
      setProviders(provs);
    });
  }, []);

  const handleCreate = async (form: CreateSubAgentForm) => {
    if (!form.id || !form.workspaceDir) return;
    setCreating(true);
    try {
      await api.post('/api/agents', {
        id: form.id,
        workspaceDir: form.workspaceDir,
        model: form.model || undefined,
        kind: 'subagent',
        allowedCallers: form.allowedCallers.length > 0 ? form.allowedCallers : undefined,
      });
      setShowCreate(false);
      await refetch();
      navigate(`/sub-agents/${encodeURIComponent(form.id)}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erreur création');
    } finally {
      setCreating(false);
    }
  };

  const getProviderLabel = (model: string) => {
    if (!model) return 'local';
    const idx = model.indexOf('/');
    return idx > -1 ? model.substring(0, idx) : 'local';
  };

  const getModelAlias = (model: string) => {
    if (!model) return '—';
    return model.split('/').pop() ?? model;
  };

  if (loading) return <div className="p-8 text-muted-foreground">Chargement…</div>;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
        <h1 className="text-base font-semibold text-foreground">
          Sub-agents
          <span className="ml-2 text-[11px] text-muted-foreground/60 font-normal">{subAgents.length}</span>
        </h1>
        <button
          ref={createBtnRef}
          onClick={() => setShowCreate(v => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-primary bg-secondary hover:bg-secondary/70 border border-border rounded-lg transition-colors"
          title="Nouveau sub-agent"
        >
          <Plus size={13} />
          Nouveau sub-agent
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {subAgents.map(agent => {
            const isDisabled = agent.enabled === false;
            const providerLabel = getProviderLabel(agent.model);
            const modelAlias = getModelAlias(agent.model);
            const stateDot =
              agent.state === 'streaming'
                ? 'bg-theme-green animate-pulse'
                : agent.state === 'thinking'
                  ? 'bg-orange-400 animate-pulse'
                  : agent.state === 'warming'
                    ? 'bg-orange-400 animate-pulse'
                    : agent.state === 'error'
                      ? 'bg-destructive'
                      : '';

            return (
              <button
                key={agent.identity.id}
                type="button"
                onClick={() => navigate(`/sub-agents/${encodeURIComponent(agent.identity.id)}`)}
                className={`group text-left bg-card rounded-xl border border-border/60 p-4 hover:border-border hover:bg-secondary/20 transition-all ${
                  isDisabled ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className="relative shrink-0">
                    <div className="w-12 h-12 flex items-center justify-center rounded-2xl bg-secondary text-2xl leading-none">
                      {agent.identity.emoji || '🤖'}
                    </div>
                    {stateDot && (
                      <span
                        className={`absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-card ${stateDot}`}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-semibold text-foreground truncate">{agent.identity.name}</h3>
                      {isDisabled && (
                        <span className="shrink-0 text-[8px] font-bold px-1 py-0.5 rounded bg-destructive/10 text-destructive">
                          off
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] font-mono text-muted-foreground/50 truncate mt-0.5">{agent.identity.id}</p>
                  </div>
                </div>

                {(agent.identity.creature || agent.identity.vibe) && (
                  <p className="text-[11px] text-muted-foreground/70 line-clamp-2 mb-3 italic">
                    {agent.identity.creature && <span>{agent.identity.creature}</span>}
                    {agent.identity.creature && agent.identity.vibe && <span> · </span>}
                    {agent.identity.vibe && <span>{agent.identity.vibe}</span>}
                  </p>
                )}

                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-[10px] font-mono text-violet-400/70 px-1.5 py-0.5 rounded bg-violet-500/5 border border-violet-500/10">
                    {providerLabel}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground/60 truncate" title={agent.model}>
                    {modelAlias}
                  </span>
                </div>
              </button>
            );
          })}

          {subAgents.length === 0 && (
            <div className="col-span-full flex flex-col items-center justify-center gap-3 py-16 text-center max-w-md mx-auto">
              <Bot size={48} className="text-muted-foreground/40" />
              <h2 className="text-lg font-semibold text-foreground">Aucun sub-agent configuré</h2>
              <p className="text-sm text-muted-foreground">
                Presets cloud one-shot que les agents principaux peuvent lancer (recherche, codebase, long-form).
              </p>
              <p className="text-xs text-muted-foreground/70">
                Clique <strong>Nouveau sub-agent</strong> ou ajoute{' '}
                <code className="px-1 py-0.5 bg-secondary rounded">kind: subagent</code> sous{' '}
                <code className="px-1 py-0.5 bg-secondary rounded">agents:</code> dans{' '}
                <code className="px-1 py-0.5 bg-secondary rounded">mastermind.yml</code>.
              </p>
            </div>
          )}
        </div>
      </div>

      <CreateSubAgentPopup
        isOpen={showCreate}
        anchorEl={createBtnRef.current}
        workspaceDirs={workspaceDirs}
        mainAgentIds={mainAgentIds}
        providers={providers}
        creating={creating}
        onClose={() => setShowCreate(false)}
        onSubmit={handleCreate}
      />
    </div>
  );
}
