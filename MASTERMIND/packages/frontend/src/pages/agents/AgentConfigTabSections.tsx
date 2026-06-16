import { useMemo, type MutableRefObject } from 'react';
import type { AgentFull, PromptSizeEstimate } from './types';
import { TOOL_CATEGORIES, ALL_TOOLS } from './types';
import { SectionCard } from '../../components/ui/SectionCard';
import { SwitchThumb } from '../../components/ui/SwitchThumb';

/** Ligne switch — copie locale pour ne pas coupler ces sections au reste de l’onglet. */
function ConfigSwitchRow({ label, description, on, onToggle }: {
  label: string;
  description?: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 py-1 hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors text-left"
    >
      <div>
        <span className="text-[12px] text-foreground block">{label}</span>
        {description && <p className="text-[11px] text-muted-foreground/60 mt-0.5">{description}</p>}
      </div>
      <SwitchThumb on={on} />
    </button>
  );
}

function PromptListBlock({ label, items, empty, format }: {
  label: string;
  items: string[] | undefined;
  empty: string;
  format?: (s: string) => string;
}) {
  const arr = items ?? [];
  return (
    <div>
      <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">{label}</label>
      {arr.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {arr.map(p => (
            <span key={p} className="text-[11px] font-mono px-2 py-0.5 rounded bg-secondary text-foreground">
              {format ? format(p) : p}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground/60">{empty}</p>
      )}
    </div>
  );
}

export type MainAgentToolsCardProps = {
  enabledTools: number;
  totalTools: number;
  disabledTools: string[];
  tools: NonNullable<AgentFull['tools']> | Record<string, never>;
  csIndexKeys: string[];
  toggleToolDisabled: (toolName: string) => void;
  saveTools: (patch: Partial<NonNullable<AgentFull['tools']>>) => Promise<void>;
  toggleCsIndex: (key: string) => void;
};

/** Carte Outils — agent principal uniquement (KV cache, tools.disabled, pas d’allowOnly). */
export function MainAgentToolsCard({
  enabledTools,
  totalTools,
  disabledTools,
  tools,
  csIndexKeys,
  toggleToolDisabled,
  saveTools,
  toggleCsIndex,
}: MainAgentToolsCardProps) {
  return (
    <SectionCard
      title="Outils"
      action={
        <span className="text-[10px] text-muted-foreground/60 font-mono">
          <span className="text-foreground font-semibold">{enabledTools}</span>/{totalTools} activés
        </span>
      }
    >
      <p className="text-[11px] text-muted-foreground/70">
        Tous les tools restent visibles au modèle pour garder le bloc{' '}
        <code className="bg-secondary px-1 rounded text-[10px]">tools</code>{' '}
        byte-identique entre agents (partage du KV cache). Les tools désactivés ici sont refusés à l'exécution
        avec un message explicatif adressé au modèle.
      </p>

      <div className="space-y-1">
        {(Object.entries(TOOL_CATEGORIES) as [string, readonly string[]][]).map(([category, list], catIdx) => (
          <div key={category}>
            {catIdx > 0 && <div className="border-t border-border/40 my-2" />}
            <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider mb-1.5">{category}</p>
            {list.map((toolName) => {
              const isEnabled = !disabledTools.includes(toolName);
              return (
                <div key={toolName} className="space-y-2 mb-1.5">
                  <button
                    type="button"
                    onClick={() => void toggleToolDisabled(toolName)}
                    className="w-full flex items-center justify-between py-1 hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors"
                  >
                    <span className="text-[12px] font-mono text-foreground">{toolName}</span>
                    <SwitchThumb on={isEnabled} />
                  </button>

                  {toolName === 'codebase_search' && isEnabled && (
                    <div className="ml-1 pl-3 border-l border-border space-y-2 pb-1">
                      <ConfigSwitchRow
                        label="Note workflow dans le prompt système"
                        description="Injecte une note pédagogique listant les outils codebase_search + codebase_search_read + codebase_search_list, l'index actif et le workflow recommandé (search → read → list)."
                        on={tools.codebaseSearchInPrompt ?? false}
                        onToggle={() => void saveTools({ codebaseSearchInPrompt: !tools.codebaseSearchInPrompt })}
                      />
                      <div>
                        <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider block mb-1.5">Index</label>
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => void saveTools({ codebaseSearchIndices: undefined })}
                            className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors ${
                              !tools.codebaseSearchIndices?.length
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                            }`}
                          >
                            tous
                          </button>
                          {csIndexKeys.map(key => {
                            const selected = tools.codebaseSearchIndices?.includes(key) ?? false;
                            return (
                              <button
                                key={key}
                                type="button"
                                onClick={() => void toggleCsIndex(key)}
                                className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors ${
                                  selected
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                                }`}
                              >
                                {key}
                              </button>
                            );
                          })}
                          {csIndexKeys.length === 0 && (
                            <span className="text-[11px] text-muted-foreground/60 italic">aucun index configuré</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="pt-2 border-t border-border/50">
        <button
          type="button"
          onClick={() => void saveTools({ systemAccess: !tools.systemAccess })}
          className="w-full flex items-start justify-between gap-3 py-1 hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors text-left"
        >
          <div>
            <span className="text-[12px] font-mono text-foreground block">system_access</span>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
              Accès complet au système de fichiers (hors workspace). Contrôle d'exécution uniquement — les descriptions
              des tools de fichiers restent permissives au niveau prompt pour préserver le cache.
            </p>
          </div>
          <SwitchThumb on={tools.systemAccess ?? false} />
        </button>
      </div>
    </SectionCard>
  );
}

export type SubAgentToolsCardProps = {
  tools: NonNullable<AgentFull['tools']> | Record<string, never>;
  /** Race-safe ref maintenu par le parent — lecture optimiste dans les toggles rapides. */
  toolsRef: MutableRefObject<NonNullable<AgentFull['tools']>>;
  csIndexKeys: string[];
  saveTools: (patch: Partial<NonNullable<AgentFull['tools']>>) => Promise<void>;
  toggleCsIndex: (key: string) => void;
};

/** Carte Outils — sub-agent uniquement (allowOnly sur core tools). Les skills + actions vivent dans l'onglet Skills. */
export function SubAgentToolsCard({
  tools,
  toolsRef,
  csIndexKeys,
  saveTools,
  toggleCsIndex,
}: SubAgentToolsCardProps) {
  const subAgentCoreToolSet = useMemo(
    () =>
      new Set<string>(
        ALL_TOOLS.filter(n => n !== 'spawn_subagent' && n !== 'list_subagents'),
      ),
    [],
  );

  const allowOnlyList = tools.allowOnly ?? [];
  // Lit toolsRef.current (latest intent) plutôt que le snapshot de render — sinon
  // 3 clics rapides voient le même `allowOnlyList=[]` et seule la dernière case reste.
  const toggleAllowOnly = (toolName: string) => {
    const cur = toolsRef.current.allowOnly ?? [];
    const next = cur.includes(toolName) ? cur.filter(t => t !== toolName) : [...cur, toolName];
    return saveTools({ allowOnly: next.length > 0 ? next : [] });
  };

  const allowOnlySet = useMemo(() => new Set(allowOnlyList), [allowOnlyList]);

  // Categories rendered as core tool grids — exclude SKILLS (skill_create lives on its own line below).
  const coreCategories = useMemo(
    () =>
      (Object.entries(TOOL_CATEGORIES) as [string, readonly string[]][])
        .map(([cat, list]) => [cat, list.filter(t => subAgentCoreToolSet.has(t) && t !== 'skill_create')] as const)
        .filter(([, list]) => list.length > 0),
    [subAgentCoreToolSet],
  );

  const renderToolCheckbox = (toolName: string) => (
    <label
      key={toolName}
      className="flex items-center gap-2 cursor-pointer text-[12px] font-mono text-foreground hover:bg-secondary/40 px-1 py-1 rounded"
    >
      <input
        type="checkbox"
        checked={allowOnlySet.has(toolName)}
        onChange={() => void toggleAllowOnly(toolName)}
        className="cursor-pointer shrink-0"
      />
      <span className="truncate" title={toolName}>{toolName}</span>
    </label>
  );

  const codebaseSearchActive =
    allowOnlyList.length === 0 || allowOnlySet.has('codebase_search');

  return (
    <SectionCard
      title="Outils"
      action={
        <span className="text-[10px] text-muted-foreground/60 font-mono">
          {allowOnlyList.length > 0 ? (
            <>
              <span className="text-foreground font-semibold">{allowOnlyList.length}</span> sélectionné(s)
            </>
          ) : (
            <span className="text-foreground/80">Pas de liste blanche</span>
          )}
        </span>
      }
    >
      <p className="text-[11px] text-muted-foreground/70">
        Coche pour limiter la surface d’exécution du sub-agent. Liste blanche vide = pas de filtre allowOnly
        (les règles globales — anti-récursion, allowedCallers, opening hours — restent actives).
      </p>

      {/* I.3 — submit_subagent_report toujours implicite (jamais cochable). */}
      <div className="flex items-center gap-2 text-[11px] px-2 py-1.5 rounded bg-primary/10 border border-primary/20">
        <span className="text-primary shrink-0" aria-hidden="true">✓</span>
        <span className="font-mono text-foreground/80">submit_subagent_report</span>
        <span className="text-muted-foreground/70 italic ml-auto">toujours implicite (livraison parent)</span>
      </div>

      {allowOnlyList.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="text-[11px] px-2 py-1 rounded border border-border bg-secondary hover:border-ring text-foreground"
            onClick={() => void saveTools({ allowOnly: [] })}
          >
            Réinitialiser la liste blanche
          </button>
        </div>
      )}

      {/* ── Outils Mastermind (core) — grid auto-fill compact ── */}
      <div className="space-y-3">
        {coreCategories.map(([category, list]) => (
          <div key={category}>
            <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider mb-1.5">
              {category}
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-2 gap-y-0.5">
              {list.map(renderToolCheckbox)}
            </div>
            {category === 'Web & Recherche' && list.includes('codebase_search') && codebaseSearchActive && (
              <div className="mt-2 ml-1 pl-3 border-l border-border space-y-2 pb-1">
                <ConfigSwitchRow
                  label="Note workflow codebase_search dans le prompt système"
                  description="Injecte une note pédagogique listant les outils codebase_search + codebase_search_read + codebase_search_list, l'index actif et le workflow recommandé (search → read → list)."
                  on={tools.codebaseSearchInPrompt ?? false}
                  onToggle={() => void saveTools({ codebaseSearchInPrompt: !tools.codebaseSearchInPrompt })}
                />
                <div>
                  <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider block mb-1.5">
                    Index codebase
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => void saveTools({ codebaseSearchIndices: undefined })}
                      className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors ${
                        !tools.codebaseSearchIndices?.length
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                      }`}
                    >
                      tous
                    </button>
                    {csIndexKeys.map(key => {
                      const selected = tools.codebaseSearchIndices?.includes(key) ?? false;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => void toggleCsIndex(key)}
                          className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors ${
                            selected
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                          }`}
                        >
                          {key}
                        </button>
                      );
                    })}
                    {csIndexKeys.length === 0 && (
                      <span className="text-[11px] text-muted-foreground/60 italic">aucun index configuré</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* skill_create reste un core tool — affiché en ligne propre, séparé de la section Skills disponibles */}
        {subAgentCoreToolSet.has('skill_create') && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider mb-1.5">
              Création de skill
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-2 gap-y-0.5">
              {renderToolCheckbox('skill_create')}
            </div>
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground/60 italic pt-2 border-t border-border/40">
        Les skills + actions individuelles se configurent dans l'onglet{' '}
        <span className="font-semibold text-foreground/80">Skills</span>.
      </p>

      <div className="pt-2 border-t border-border/50">
        <button
          type="button"
          onClick={() => void saveTools({ systemAccess: !tools.systemAccess })}
          className="w-full flex items-start justify-between gap-3 py-1 hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors text-left"
        >
          <div>
            <span className="text-[12px] font-mono text-foreground block">system_access</span>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
              Accès complet au système de fichiers (hors workspace). Contrôle d’exécution uniquement.
            </p>
          </div>
          <SwitchThumb on={tools.systemAccess ?? false} />
        </button>
      </div>
    </SectionCard>
  );
}

export type MainAgentInjectionCardProps = {
  starredFileCount: number;
  configDraft: Partial<AgentFull>;
  promptSize: PromptSizeEstimate | null;
};

/** Bloc « Injectés dans le prompt » — agent principal (2 colonnes fichiers, skills dans onglet Skills). */
export function MainAgentInjectionCard({
  starredFileCount,
  configDraft,
  promptSize,
}: MainAgentInjectionCardProps) {
  return (
    <SectionCard
      title="Injectés dans le prompt"
      action={
        <span className="text-[10px] text-muted-foreground/60">
          {starredFileCount.toLocaleString()} fichier(s)
        </span>
      }
    >
      <p className="text-[11px] text-muted-foreground/70">
        Shared étoilés ordonnés automatiquement par nombre d'agents qui les partagent (multi-tier)
        pour maximiser le préfixe commun du KV cache. Les skills + actions exécutables se configurent
        dans l'onglet <span className="font-semibold text-foreground/90">Skills</span>.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PromptListBlock
          label="Workspace étoilés"
          items={configDraft.promptInjection?.workspaceStarredFiles}
          empty="Aucun fichier workspace étoilé."
        />
        <PromptListBlock
          label="Shared étoilés"
          items={configDraft.promptInjection?.sharedStarredFiles}
          empty="Aucun fichier shared étoilé."
        />
      </div>

      <PromptSizeFooter promptSize={promptSize} />
    </SectionCard>
  );
}

export type SubAgentInjectionCardProps = {
  starredFileCount: number;
  configDraft: Partial<AgentFull>;
  promptSize: PromptSizeEstimate | null;
};

/** Bloc « Injectés dans le prompt » — sub-agent (2 colonnes fichiers uniquement). */
export function SubAgentInjectionCard({ starredFileCount, configDraft, promptSize }: SubAgentInjectionCardProps) {
  return (
    <SectionCard
      title="Injectés dans le prompt"
      action={
        <span className="text-[10px] text-muted-foreground/60">
          {starredFileCount.toLocaleString()} fichier(s)
        </span>
      }
    >
      <p className="text-[11px] text-muted-foreground/70">
        Shared étoilés ordonnés automatiquement par nombre d’agents qui les partagent (multi-tier)
        pour maximiser le préfixe commun du KV cache. Les skills + actions exécutables se configurent dans l’onglet{' '}
        <span className="font-semibold text-foreground/90">Skills</span>.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PromptListBlock
          label="Workspace étoilés"
          items={configDraft.promptInjection?.workspaceStarredFiles}
          empty="Aucun fichier workspace étoilé."
        />
        <PromptListBlock
          label="Shared étoilés"
          items={configDraft.promptInjection?.sharedStarredFiles}
          empty="Aucun fichier shared étoilé."
        />
      </div>

      <PromptSizeFooter promptSize={promptSize} />
    </SectionCard>
  );
}

function PromptSizeFooter({ promptSize }: { promptSize: PromptSizeEstimate | null }) {
  return (
    <div className="pt-2 border-t border-border/50">
      <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Taille estimée du prompt système</label>
      {promptSize ? (
        <div className="mt-1 text-[11px] text-muted-foreground space-y-1">
          <p>
            Web : <span className="font-semibold text-foreground">~{promptSize.web.estimatedTokens.toLocaleString()} tokens</span>
            <span className="text-muted-foreground/60"> ({promptSize.web.chars.toLocaleString()} chars)</span>
          </p>
          <p>
            Telegram : <span className="font-semibold text-foreground">~{promptSize.telegram.estimatedTokens.toLocaleString()} tokens</span>
            <span className="text-muted-foreground/60"> ({promptSize.telegram.chars.toLocaleString()} chars)</span>
          </p>
          {(promptSize.web.sections?.length ?? 0) > 0 && (
            <div className="pt-2">
              <p className="text-[10px] text-muted-foreground/60 mb-1">Détail Web (blocs les plus lourds) :</p>
              <div className="space-y-0.5">
                {[...(promptSize.web.sections ?? [])]
                  .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
                  .slice(0, 8)
                  .map(s => (
                    <p key={`w-${s.key}`} className="font-mono text-[10px]">
                      <span className="text-foreground">{s.key}</span>
                      <span className="text-muted-foreground/60"> : ~{s.estimatedTokens.toLocaleString()} tok ({s.chars.toLocaleString()} chars)</span>
                    </p>
                  ))}
              </div>
            </div>
          )}
          {(promptSize.telegram.sections?.length ?? 0) > 0 && (
            <div className="pt-2">
              <p className="text-[10px] text-muted-foreground/60 mb-1">Détail Telegram (blocs les plus lourds) :</p>
              <div className="space-y-0.5">
                {[...(promptSize.telegram.sections ?? [])]
                  .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
                  .slice(0, 8)
                  .map(s => (
                    <p key={`t-${s.key}`} className="font-mono text-[10px]">
                      <span className="text-foreground">{s.key}</span>
                      <span className="text-muted-foreground/60"> : ~{s.estimatedTokens.toLocaleString()} tok ({s.chars.toLocaleString()} chars)</span>
                    </p>
                  ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground/60">Estimation indisponible.</p>
      )}
    </div>
  );
}
