import { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentFull, AgentDeliveryPolicy, ProviderOption, BotOption, PromptSizeEstimate } from './types';
import { TOOL_CATEGORIES } from './types';
import {
  MainAgentToolsCard,
  SubAgentToolsCard,
  MainAgentInjectionCard,
  SubAgentInjectionCard,
} from './AgentConfigTabSections';
import { ModelPickerPopup } from '../../components/ModelPickerPopup';
import { SwitchThumb } from '../../components/ui/SwitchThumb';
import { SectionCard } from '../../components/ui/SectionCard';
import { DeliveryPolicyEditor } from '../../components/DeliveryPolicyEditor';
import { EditableField } from './EditableField';

export interface AgentConfigTabProps {
  agentDetail: AgentFull;
  configDraft: Partial<AgentFull>;
  setConfigDraft: React.Dispatch<React.SetStateAction<Partial<AgentFull>>>;
  saveConfigPatch: (patch: Partial<AgentFull>) => Promise<void>;
  /** Active le mode session unifiée : merge + compaction des historiques puis flip du flag (côté serveur). */
  unifySessions: () => Promise<void>;
  csIndexKeys: string[];
  promptSize: PromptSizeEstimate | null;
  modelPickerProviders: ProviderOption[];
  workspaceDirs: string[];
  availableBots: BotOption[];
  /** IDs des agents principaux disponibles — utilisés pour la liste allowedCallers d'un sub-agent. */
  mainAgentIds?: string[];
}

export function AgentConfigTab({
  agentDetail,
  configDraft,
  saveConfigPatch,
  unifySessions,
  csIndexKeys,
  promptSize,
  modelPickerProviders,
  workspaceDirs,
  availableBots,
  mainAgentIds = [],
}: AgentConfigTabProps) {
  const isSubAgent = (configDraft.kind ?? agentDetail.kind) === 'subagent';
  const [pickerOpen, setPickerOpen] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  const tg = configDraft.telegram ?? { enabled: false, chatIds: [] };
  const dc = configDraft.dailyCompact ?? { enabled: false };
  const tools = configDraft.tools ?? {};
  const disabledTools = tools.disabled ?? [];
  const totalTools = Object.values(TOOL_CATEGORIES).reduce((acc, arr) => acc + arr.length, 0);
  const enabledTools = totalTools - disabledTools.length;

  // Toggle session unifiée : ON déclenche le merge+compaction via l'endpoint dédié (avec
  // confirmation — c'est une migration one-shot des historiques) ; OFF se contente de
  // re-basculer le flag en legacy (la session unifiée reste consultable).
  const handleUnifiedToggle = async () => {
    if (configDraft.unifiedSession) {
      await saveConfigPatch({ unifiedSession: false });
      return;
    }
    const ok = window.confirm(
      'Activer la session unifiée (cross-plateforme) ?\n\n' +
      'Les historiques web, mobile et Telegram (DM) de cet agent vont être fusionnés et ' +
      'compactés en UNE session « Cross-plateforme ». Tous les canaux convergeront ensuite ' +
      'vers cette session unique (un seul KV chaud, qui te suit d\'un device à l\'autre). ' +
      'Les anciennes sessions restent consultables.',
    );
    if (!ok) return;
    await unifySessions();
  };

  // Race-safe refs for rapid toggle clicks. Without this, clicking N toggles before
  // saveConfigPatch's awaited PUT + loadAgentDetail re-render finishes makes each new
  // handler closure see the *stale* state from the LAST render — so each PUT overwrites
  // the previous one's intent. Symptom: user toggles 5 things ON, only the last lands.
  // We update these refs optimistically at every toggle so subsequent clicks chain off
  // the latest in-flight state, not the last committed state.
  const toolsRef = useRef<NonNullable<AgentFull['tools']>>(tools);
  useEffect(() => {
    toolsRef.current = tools;
  }, [tools]);

  const initialAllowedCallers = configDraft.allowedCallers ?? agentDetail.allowedCallers ?? [];
  const allowedCallersRef = useRef<string[]>(initialAllowedCallers);
  useEffect(() => {
    allowedCallersRef.current = configDraft.allowedCallers ?? agentDetail.allowedCallers ?? [];
  }, [configDraft.allowedCallers, agentDetail.allowedCallers]);

  const initialCaps = configDraft.caps ?? agentDetail.caps ?? {};
  const capsRef = useRef<NonNullable<AgentFull['caps']>>(initialCaps);
  useEffect(() => {
    capsRef.current = configDraft.caps ?? agentDetail.caps ?? {};
  }, [configDraft.caps, agentDetail.caps]);

  // Race-safe ref pour les toggles rapides des sous-champs dailyCompact (skipWarmup, plages shuffle).
  // Même logique que toolsRef : on lit la dernière intention et on envoie l'objet absolu fusionné
  // (sûr en StrictMode — pas de setState fonctionnel non-idempotent, cf. piège connu).
  const dcRef = useRef<NonNullable<AgentFull['dailyCompact']>>(dc);
  useEffect(() => {
    dcRef.current = configDraft.dailyCompact ?? { enabled: false };
  }, [configDraft.dailyCompact]);

  // Politique de livraison (v3) — même pattern race-safe que dcRef. Le DeliveryPolicyEditor
  // renvoie TOUJOURS la policy complète (ou null pour repasser en legacy) ; on persiste tel quel.
  // Le delRef est mis à jour optimistiquement pour que des toggles rapides enchaînés lisent la
  // dernière intention et pas l'état du dernier render (cf. piège StrictMode connu).
  const delivery = configDraft.delivery ?? null;
  const delRef = useRef<AgentDeliveryPolicy | null>(delivery);
  useEffect(() => {
    delRef.current = configDraft.delivery ?? null;
  }, [configDraft.delivery]);
  const onDeliveryChange = (next: AgentDeliveryPolicy | null) => {
    delRef.current = next;
    return saveConfigPatch({ delivery: next });
  };

  const saveTelegram = (patch: Partial<NonNullable<AgentFull['telegram']>>) =>
    saveConfigPatch({ telegram: { ...tg, ...patch } });

  // Le backend reconstruit dailyCompact à chaque PUT → on doit toujours renvoyer l'objet
  // COMPLET (enabled/time/skipWarmup/loraShuffle), sinon un champ omis serait perdu.
  const patchDailyCompact = (patch: Partial<NonNullable<AgentFull['dailyCompact']>>) => {
    const merged = { ...dcRef.current, ...patch };
    dcRef.current = merged;
    return saveConfigPatch({ dailyCompact: merged });
  };

  const saveTools = (patch: Partial<NonNullable<AgentFull['tools']>>) => {
    // Build the merged tools off the latest known intent (ref), not the stale render value.
    // Update the ref BEFORE awaiting so an immediate next click sees this intent.
    const merged = { ...toolsRef.current, ...patch };
    toolsRef.current = merged;
    return saveConfigPatch({ tools: merged });
  };

  const toggleToolDisabled = (toolName: string) => {
    const curDisabled = toolsRef.current.disabled ?? [];
    const next = curDisabled.includes(toolName)
      ? curDisabled.filter(t => t !== toolName)
      : [...curDisabled, toolName];
    return saveTools({ disabled: next });
  };

  const toggleCsIndex = (key: string) => {
    const cur = toolsRef.current.codebaseSearchIndices ?? [];
    const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key];
    return saveTools({ codebaseSearchIndices: next.length ? next : undefined });
  };

  const toolsCard = isSubAgent ? (
    <SubAgentToolsCard
      tools={tools}
      toolsRef={toolsRef}
      csIndexKeys={csIndexKeys}
      saveTools={saveTools}
      toggleCsIndex={toggleCsIndex}
    />
  ) : (
    <MainAgentToolsCard
      enabledTools={enabledTools}
      totalTools={totalTools}
      disabledTools={disabledTools}
      tools={tools}
      csIndexKeys={csIndexKeys}
      toggleToolDisabled={toggleToolDisabled}
      saveTools={saveTools}
      toggleCsIndex={toggleCsIndex}
    />
  );

  const modelCard = (
    <SectionCard title="Modèle">
      <div>
        <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Model</label>
        <div className="mt-1 flex items-center gap-2 min-w-0">
          <div className="flex-1 min-w-0" title={configDraft.model}>
            <EditableField
              value={configDraft.model}
              onSave={(v) => saveConfigPatch({ model: (v as string) ?? '' })}
              placeholder="anthropic/claude-sonnet-4"
              className="block text-sm font-mono text-foreground truncate"
              inputClassName="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
            />
          </div>
          {modelPickerProviders.length > 0 && (
            <button
              ref={modelBtnRef}
              onClick={() => setPickerOpen(v => !v)}
              className="shrink-0 px-2 py-1 text-xs text-muted-foreground bg-secondary border border-border rounded hover:border-ring hover:text-primary"
              title="Parcourir les modèles disponibles"
            >
              Parcourir
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldRow label="Temperature">
          <EditableField
            value={configDraft.temperature}
            onSave={(v) => saveConfigPatch({ temperature: v as number | undefined })}
            type="number"
            step={0.1}
            min={0}
            max={2}
            placeholder="défaut global"
            className="text-sm text-foreground"
          />
        </FieldRow>

        <FieldRow label="LoRA scales">
          <LoraScalesEditor
            value={configDraft.loraScales}
            onChange={(next) => saveConfigPatch({ loraScales: next })}
          />
        </FieldRow>

        <FieldRow label="Prompt cache TTL (min)">
          <EditableField
            value={configDraft.promptCacheTtl}
            onSave={(v) => saveConfigPatch({ promptCacheTtl: v as number | undefined })}
            type="number"
            step={1}
            min={0}
            placeholder="30 (défaut)"
            className="text-sm text-foreground"
          />
        </FieldRow>

        <FieldRow label="Max completion tokens">
          <EditableField
            value={configDraft.maxCompletionTokens}
            onSave={(v) => saveConfigPatch({ maxCompletionTokens: v as number | undefined })}
            type="number"
            step={256}
            min={256}
            placeholder="—"
            format={(v) => v == null ? <span className="text-muted-foreground/50">—</span> : (v as number).toLocaleString()}
            className="text-sm text-foreground"
          />
        </FieldRow>

        <FieldRow label="Context messages (history)">
          <EditableField
            value={configDraft.contextMessages}
            onSave={(v) => saveConfigPatch({ contextMessages: v as number | undefined })}
            type="number"
            step={1}
            min={1}
            placeholder="20 (défaut)"
            className="text-sm text-foreground"
          />
        </FieldRow>

        <FieldRow label="Auto-compact threshold">
          <div className="flex items-center gap-2">
            <input
              type="range" min={80} max={100} step={1}
              value={configDraft.autoCompactThreshold ?? 90}
              onChange={e => saveConfigPatch({ autoCompactThreshold: Number(e.target.value) })}
              className="flex-1 accent-primary"
            />
            <span className="text-[11px] font-semibold text-foreground w-10 text-right">
              {configDraft.autoCompactThreshold ?? 90}%
            </span>
          </div>
        </FieldRow>

        <FieldRow label="Max context tokens">
          <EditableField
            value={configDraft.maxContextTokens}
            onSave={(v) => saveConfigPatch({ maxContextTokens: v as number | undefined })}
            type="number"
            format={(v) => v == null ? <span className="text-muted-foreground/50">—</span> : (v as number).toLocaleString()}
            className="text-sm text-foreground"
          />
        </FieldRow>
      </div>

      <FieldRow label="Reasoning effort">
        <ThinkBudgetSelector
          value={configDraft.thinkBudget ?? 'off'}
          onChange={(v) => saveConfigPatch({ thinkBudget: v })}
        />
      </FieldRow>

      <SwitchRow
        label="By-pass unified agent cache"
        description="Prompt sur mesure pour cet agent (skills starred uniquement, tools cochés uniquement) au lieu de la surface universelle. Plus léger mais cache non partagé avec les autres agents du même modèle. Voir détails dans l'onglet Cache."
        on={configDraft.bypassUnifiedCache ?? false}
        onToggle={() => saveConfigPatch({ bypassUnifiedCache: !configDraft.bypassUnifiedCache })}
      />

      <SwitchRow
        label="Lazy skills"
        description="Les skills sont annoncés en one-liner dans le system prompt; l'agent appelle inspect_skill('<id>') pour récupérer le schéma d'une action avant de l'invoquer. Gain ~10-12k tokens. Cumulable avec by-pass pour réduire encore le prefix. Voir détails dans l'onglet Cache."
        on={configDraft.lazySkills ?? false}
        onToggle={() => saveConfigPatch({ lazySkills: !configDraft.lazySkills })}
      />

      <SwitchRow
        label="Wildcard skill dispatch"
        description="Au lieu d'émettre un stub par skill action dans tools[], expose un seul tool call_skill_action(toolName, args). Économie ~3-4k tokens additionnels pour fleets 100+ skills, et clean l'API tools[] pour le LLM (2 tools vs 140+). L'agent route TOUTES les invocations skill via ce wildcard après inspect_skill."
        on={(configDraft.skillCallMode ?? 'stub') === 'wildcard'}
        onToggle={() => saveConfigPatch({ skillCallMode: (configDraft.skillCallMode ?? 'stub') === 'wildcard' ? 'stub' : 'wildcard' })}
        disabled={!configDraft.lazySkills}
        disabledHint="Nécessite Lazy skills activé"
      />

      <SwitchRow
        label="Exclure de la mémoire partagée"
        description="L'agent n'a PAS accès en lecture à la mémoire vectorielle partagée (scope shared) : ni auto-injection de blocs shared, ni memory_search dans le shared. Il reste limité à sa propre mémoire (scope agent). L'écriture en shared reste autorisée — il peut alimenter le pot commun sans jamais le relire."
        on={configDraft.excludeSharedMemory ?? false}
        onToggle={() => saveConfigPatch({ excludeSharedMemory: !configDraft.excludeSharedMemory })}
      />

      {!isSubAgent && (
        <SwitchRow
          label="Session unifiée (cross-plateforme)"
          description="Fusionne web + mobile + Telegram (DM owner) en UNE seule session « Cross-plateforme » qui te suit d'un device à l'autre (un seul KV chaud — plus besoin de switcher). Les groupes Telegram restent isolés. Activer déclenche un merge + compaction one-shot des historiques (confirmation demandée)."
          on={configDraft.unifiedSession ?? false}
          onToggle={handleUnifiedToggle}
        />
      )}

      <SwitchRow
        label="Traces de raisonnement"
        description="Capturer les blocs <think> pour analyse a posteriori"
        on={configDraft.captureReasoningTraces ?? false}
        onToggle={() => saveConfigPatch({ captureReasoningTraces: !configDraft.captureReasoningTraces })}
      />

      <div className="pt-2 border-t border-border/50 space-y-2">
        <SwitchRow
          label="Compact quotidien"
          description="Résume la session la plus récente à l'heure indiquée, purge l'historique, puis réchauffe le KV cache. Conversation fraîche au réveil."
          on={dc.enabled}
          onToggle={() => void patchDailyCompact({ enabled: !dcRef.current.enabled })}
        />
        {dc.enabled && (
          <>
            <FieldRow label="Heure (locale, HH:mm)">
              <EditableField
                value={dc.time ?? '06:00'}
                onSave={(v) => {
                  const raw = ((v as string) ?? '').trim();
                  const time = /^\d{1,2}:\d{2}$/.test(raw) ? raw : '06:00';
                  return patchDailyCompact({ time });
                }}
                placeholder="06:00"
                className="text-sm font-mono text-foreground"
                inputClassName="w-28 bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
              />
            </FieldRow>

            <SwitchRow
              label="Sauter le warmup post-compact"
              description="Pas de réchauffe du KV cache après le compact. Inutile pour les agents cloud (aucun cache local à réchauffer) — évite un appel d'inférence au réveil."
              on={dc.skipWarmup ?? false}
              onToggle={() => void patchDailyCompact({ skipWarmup: !dcRef.current.skipWarmup })}
            />

            <LoraShuffleEditor
              loraScales={configDraft.loraScales}
              value={dc.loraShuffle}
              onChange={(loraShuffle) => void patchDailyCompact({ loraShuffle })}
            />
          </>
        )}
      </div>
    </SectionCard>
  );

  const deliveryCard = (
    <SectionCard title="Livraison & Notifications">
      <DeliveryPolicyEditor policy={delivery} onChange={(next) => void onDeliveryChange(next)} embedded />
    </SectionCard>
  );

  const telegramCard = (
    <SectionCard
      title="Telegram"
      action={tg.enabled && (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/20">
          <Send className="w-2.5 h-2.5" />
          Connecté
        </span>
      )}
    >
      <SwitchRow
        label="Activé"
        on={tg.enabled ?? false}
        onToggle={() => saveTelegram({ enabled: !tg.enabled })}
      />

      {tg.enabled && (
        <>
          <div>
            <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Bot</label>
            <select
              value={tg.botId || ''}
              onChange={e => saveTelegram({ botId: e.target.value || undefined })}
              className="mt-1 w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-ring"
            >
              <option value="">-- premier bot disponible --</option>
              {availableBots.map(b => (
                <option key={b.id} value={b.id}>
                  {b.id}{b.running ? ' ●' : ' ○'}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Chat IDs (séparés par virgule)</label>
            <EditableField
              value={tg.chatIds?.join(', ') || ''}
              onSave={(v) => {
                const raw = (v as string) ?? '';
                const ids = raw.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
                return saveTelegram({ chatIds: ids });
              }}
              placeholder="123456789, 987654321"
              className="mt-1 block text-sm font-mono text-foreground"
              inputClassName="mt-1 w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
            />
          </div>

          <SwitchRow
            label="Streaming"
            description="Édition progressive du message Telegram"
            on={tg.streaming ?? false}
            onToggle={() => saveTelegram({ streaming: !tg.streaming })}
          />
        </>
      )}
    </SectionCard>
  );

  const identityCard = (agentDetail.identity.creature || agentDetail.identity.vibe) ? (
    <SectionCard title="Identité (IDENTITY.md)">
      {agentDetail.identity.creature && (
        <p className="text-[11px] text-muted-foreground/70">
          Créature : <span className="text-foreground font-semibold">{agentDetail.identity.creature}</span>
        </p>
      )}
      {agentDetail.identity.vibe && (
        <p className="text-[11px] text-muted-foreground/70">
          Vibe : <span className="text-foreground font-semibold">{agentDetail.identity.vibe}</span>
        </p>
      )}
    </SectionCard>
  ) : null;

  const workspaceCard = (
    <SectionCard title="Workspace">
      <div>
        <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Dossier workspace</label>
        <div className="mt-1 flex items-center gap-2">
          <EditableField
            value={configDraft.workspaceDir}
            onSave={(v) => saveConfigPatch({ workspaceDir: (v as string) ?? '' })}
            placeholder="workspace-myagent"
            className="text-sm font-mono text-foreground"
            inputClassName="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-ring"
          />
          {workspaceDirs.length > 0 && (
            <select
              onChange={e => { if (e.target.value) void saveConfigPatch({ workspaceDir: e.target.value }); }}
              className="bg-secondary border border-border rounded px-2 py-1 text-xs text-card-foreground focus:outline-none"
              value=""
            >
              <option value="">Découverte…</option>
              {workspaceDirs.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">Chemin absolu</label>
        <p className="mt-0.5 text-[10px] font-mono text-muted-foreground/60">{agentDetail.workspacePath}</p>
      </div>
    </SectionCard>
  );

  const starredFileCount =
    (configDraft.promptInjection?.sharedStarredFiles?.length ?? 0) +
    (configDraft.promptInjection?.workspaceStarredFiles?.length ?? 0);

  const injectionCard = isSubAgent ? (
    <SubAgentInjectionCard starredFileCount={starredFileCount} configDraft={configDraft} promptSize={promptSize} />
  ) : (
    <MainAgentInjectionCard
      starredFileCount={starredFileCount}
      configDraft={configDraft}
      promptSize={promptSize}
    />
  );

  // ── Sub-agent card — caps + allowedCallers (visible uniquement si kind === 'subagent') ──
  const caps = configDraft.caps ?? agentDetail.caps ?? {};
  const allowedCallers = configDraft.allowedCallers ?? agentDetail.allowedCallers ?? [];
  const saveCaps = (patch: Partial<NonNullable<AgentFull['caps']>>) => {
    // Use capsRef (latest in-flight intent) — chains rapid edits across multiple fields.
    const next = { ...capsRef.current, ...patch };
    // Drop undefined keys so the YAML stays clean (not "key: null")
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
    capsRef.current = cleaned as NonNullable<AgentFull['caps']>;
    return saveConfigPatch({ caps: Object.keys(cleaned).length > 0 ? (cleaned as NonNullable<AgentFull['caps']>) : undefined });
  };
  const toggleCaller = (id: string) => {
    const cur = allowedCallersRef.current;
    const next = cur.includes(id) ? cur.filter(c => c !== id) : [...cur, id];
    allowedCallersRef.current = next;
    return saveConfigPatch({ allowedCallers: next });
  };

  const subAgentCard = (
    <SectionCard title="Sub-agent">
      <div className="space-y-4">
        <div>
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Caps par run</h4>
          <p className="text-[11px] text-muted-foreground/70 mb-3">
            Limites d'exécution pour chaque run de ce sub-agent. Si un cap est atteint, le run finit
            avec un rapport partiel et <code className="px-1 py-0.5 bg-secondary rounded">caps_hit</code> indique la cause.
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <FieldRow label="Max iterations">
              <EditableField
                value={caps.maxIterations}
                onSave={(v) => saveCaps({ maxIterations: (v as number | undefined) })}
                type="number"
                min={1}
                max={100}
                placeholder="15 (défaut)"
                className="text-sm font-mono text-foreground"
              />
            </FieldRow>
            <FieldRow label="Max tool calls">
              <EditableField
                value={caps.maxToolCalls}
                onSave={(v) => saveCaps({ maxToolCalls: (v as number | undefined) })}
                type="number"
                min={1}
                max={500}
                placeholder="30 (défaut)"
                className="text-sm font-mono text-foreground"
              />
            </FieldRow>
            <FieldRow label="Max output tokens">
              <EditableField
                value={caps.maxOutputTokens}
                onSave={(v) => saveCaps({ maxOutputTokens: (v as number | undefined) })}
                type="number"
                min={256}
                max={64000}
                placeholder="8000 (défaut)"
                className="text-sm font-mono text-foreground"
              />
            </FieldRow>
            <FieldRow label="Timeout (s)">
              <EditableField
                value={caps.timeoutSeconds}
                onSave={(v) => saveCaps({ timeoutSeconds: (v as number | undefined) })}
                type="number"
                min={10}
                max={3600}
                placeholder="300 (défaut)"
                className="text-sm font-mono text-foreground"
              />
            </FieldRow>
          </div>
        </div>

        <div>
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Allowed callers</h4>
          <p className="text-[11px] text-muted-foreground/70 mb-2">
            Agents principaux autorisés à spawner ce sub-agent. Si rien coché → tous autorisés.
          </p>
          {mainAgentIds.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">Aucun agent principal détecté.</div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              {mainAgentIds.map(id => (
                <label key={id} className="flex items-center gap-2 cursor-pointer text-xs text-foreground hover:bg-secondary/40 px-2 py-1.5 rounded transition-colors">
                  <input
                    type="checkbox"
                    checked={allowedCallers.includes(id)}
                    onChange={() => void toggleCaller(id)}
                    className="cursor-pointer"
                  />
                  <span className="font-mono">{id}</span>
                </label>
              ))}
            </div>
          )}
          {allowedCallers.length === 0 && mainAgentIds.length > 0 && (
            <p className="mt-2 text-[10px] text-muted-foreground/60 italic">→ Tous les agents principaux autorisés.</p>
          )}
        </div>
      </div>
    </SectionCard>
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 w-full max-w-6xl mx-auto space-y-4">
      {/* 2 colonnes alignées au top — gauche : Outils, droite : Identité, Modèle, [Sub-agent OU Telegram], Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {toolsCard}
        <div className="flex flex-col gap-4">
          {identityCard}
          {modelCard}
          {isSubAgent ? subAgentCard : telegramCard}
          {!isSubAgent && deliveryCard}
          {workspaceCard}
        </div>
      </div>

      {/* Injectés dans le prompt — pleine largeur */}
      {injectionCard}

      <ModelPickerPopup
        isOpen={pickerOpen}
        anchorEl={modelBtnRef.current}
        providers={modelPickerProviders}
        currentModelId={configDraft.model}
        onClose={() => setPickerOpen(false)}
        onSelect={(modelId) => {
          void saveConfigPatch({ model: modelId });
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

/** Multi-LoRA scales editor — un slider par LoRA chargé côté brain.
 *
 * Convention contractuelle : l'index du slider = l'`id` LoRA côté llama-server
 * (ordre `--lora` au boot). N'envoie `loraScales: undefined` au backend quand la
 * liste devient vide → backend purge le YAML. Un slider à 0 reste envoyé (utile
 * pour désactiver un LoRA tout en gardant le slot d'ordre pour les suivants).
 */
function LoraScalesEditor({
  value,
  onChange,
}: {
  value: number[] | undefined;
  onChange: (next: number[] | undefined) => void;
}) {
  const scales = value ?? [];
  const MAX_SLIDERS = 8;

  const updateAt = (idx: number, v: number) => {
    const next = [...scales];
    next[idx] = v;
    onChange(next);
  };
  const addOne = () => {
    if (scales.length >= MAX_SLIDERS) return;
    onChange([...scales, 1.0]);
  };
  const removeAt = (idx: number) => {
    const next = scales.filter((_, i) => i !== idx);
    onChange(next.length > 0 ? next : undefined);
  };

  if (scales.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground/60 flex-1">off</span>
        <button
          type="button"
          onClick={addOne}
          className="text-[10px] font-medium px-2 py-1 rounded border border-border hover:bg-secondary/50 text-foreground"
          title="Activer le LoRA #0 avec scale 1.0"
        >
          + activer LoRA
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {scales.map((scale, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground/70 w-10 shrink-0">#{idx}</span>
          <input
            type="range" min={0} max={5} step={0.05}
            value={scale}
            onChange={e => updateAt(idx, Number(e.target.value))}
            className="flex-1 accent-primary"
          />
          <span className="text-[11px] font-semibold text-foreground w-10 text-right tabular-nums">
            ×{scale.toFixed(2)}
          </span>
          <button
            type="button"
            onClick={() => removeAt(idx)}
            className="text-[11px] leading-none w-5 h-5 rounded border border-border hover:bg-destructive/10 hover:border-destructive hover:text-destructive text-muted-foreground"
            title={`Retirer LoRA #${idx}`}
            aria-label={`Retirer LoRA #${idx}`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addOne}
        disabled={scales.length >= MAX_SLIDERS}
        className="text-[10px] font-medium px-2 py-1 rounded border border-border hover:bg-secondary/50 text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
        title={scales.length >= MAX_SLIDERS ? `Max ${MAX_SLIDERS} LoRAs` : 'Ajouter un slider pour le LoRA suivant'}
      >
        + LoRA #{scales.length}
      </button>
    </div>
  );
}

/** Éditeur du shuffle LoRA quotidien — une ligne par LoRA configuré (index ⇄ loraScales).
 *
 * Chaque jour, AVANT le compact quotidien, le backend tire pour chaque index coché une scale
 * aléatoire uniforme dans [min, max] (quantifiée, clampée [0,5]) ; le warmup post-compact la
 * cuit dans le KV cache. Les plages référencent loraScales par index — on n'expose que les
 * index réellement configurés via l'éditeur "LoRA scales" au-dessus.
 */
function LoraShuffleEditor({
  loraScales,
  value,
  onChange,
}: {
  loraScales: number[] | undefined;
  value: NonNullable<AgentFull['dailyCompact']>['loraShuffle'];
  onChange: (next: NonNullable<NonNullable<AgentFull['dailyCompact']>['loraShuffle']>) => void;
}) {
  const scales = loraScales ?? [];
  const ranges = value?.ranges ?? [];
  const masterOn = value?.enabled ?? false;

  // Race-safe ref : des éditions rapprochées (min puis max d'une même plage, ou un toggle
  // cliqué deux fois avant le refetch) lisent la dernière intention plutôt que la prop de
  // rendu encore périmée. Même pattern que toolsRef/capsRef plus haut dans ce fichier.
  const stateRef = useRef<NonNullable<typeof value>>(value ?? { enabled: false });
  useEffect(() => {
    stateRef.current = value ?? { enabled: false };
  }, [value]);

  const clamp = (v: number) => Math.max(0, Math.min(5, v));
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const rangeFor = (i: number) => ranges.find(r => r.index === i);
  const emit = (next: NonNullable<typeof value>) => {
    stateRef.current = next;
    onChange(next);
  };

  const toggleMaster = () => emit({ enabled: !stateRef.current.enabled, ranges: stateRef.current.ranges });

  const toggleIndex = (i: number, scale: number) => {
    const cur = stateRef.current.ranges ?? [];
    if (cur.some(r => r.index === i)) {
      emit({ enabled: stateRef.current.enabled, ranges: cur.filter(r => r.index !== i) });
    } else {
      const lo = clamp(round2(scale - 0.2));
      let hi = clamp(round2(scale + 0.2));
      if (hi <= lo) hi = clamp(round2(lo + 0.1));
      emit({
        enabled: stateRef.current.enabled,
        ranges: [...cur, { index: i, min: lo, max: hi }].sort((a, b) => a.index - b.index),
      });
    }
  };

  const updateBound = (i: number, key: 'min' | 'max', raw: number) => {
    const v = clamp(round2(Number.isFinite(raw) ? raw : 0));
    const cur = stateRef.current.ranges ?? [];
    emit({ enabled: stateRef.current.enabled, ranges: cur.map(r => (r.index === i ? { ...r, [key]: v } : r)) });
  };

  if (scales.length === 0) {
    return (
      <div className="pt-1">
        <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider block">Shuffle LoRA quotidien</label>
        <p className="mt-1 text-[11px] text-muted-foreground/60">
          Configure d'abord des <span className="font-medium text-foreground/80">LoRA scales</span> ci-dessus pour pouvoir les shuffler.
        </p>
      </div>
    );
  }

  return (
    <div className="pt-1 space-y-2">
      <SwitchRow
        label="Shuffle LoRA quotidien"
        description="Avant chaque compact, tire une scale aléatoire dans [min, max] pour les LoRA cochés. La nouvelle valeur est cuite dans le KV cache par le warmup qui suit."
        on={masterOn}
        onToggle={toggleMaster}
      />
      {masterOn && (
        <div className="space-y-1.5 pl-1">
          {scales.map((scale, idx) => {
            const r = rangeFor(idx);
            return (
              <div key={idx} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleIndex(idx, scale)}
                  className="flex items-center gap-1.5 shrink-0"
                  title={r ? `Ne plus shuffler LoRA #${idx}` : `Shuffler LoRA #${idx}`}
                  aria-label={r ? `Ne plus shuffler LoRA #${idx}` : `Shuffler LoRA #${idx}`}
                >
                  <SwitchThumb on={!!r} />
                  <span className="text-[10px] font-mono text-muted-foreground/70 w-7 text-left">#{idx}</span>
                </button>
                <span className="text-[10px] font-mono text-muted-foreground/50 w-12 shrink-0">×{scale.toFixed(2)}</span>
                {r ? (
                  <div className="flex items-center gap-1.5 flex-1">
                    <span className="text-[10px] text-muted-foreground/60">min</span>
                    <input
                      type="number" min={0} max={5} step={0.05}
                      value={r.min}
                      onChange={e => updateBound(idx, 'min', Number(e.target.value))}
                      className="w-16 bg-secondary border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground focus:outline-none focus:border-ring"
                    />
                    <span className="text-[10px] text-muted-foreground/60">max</span>
                    <input
                      type="number" min={0} max={5} step={0.05}
                      value={r.max}
                      onChange={e => updateBound(idx, 'max', Number(e.target.value))}
                      className="w-16 bg-secondary border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground focus:outline-none focus:border-ring"
                    />
                  </div>
                ) : (
                  <span className="text-[11px] text-muted-foreground/40 italic flex-1">figé</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] text-muted-foreground/70 uppercase tracking-wider block">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SwitchRow({ label, description, on, onToggle, disabled, disabledHint }: {
  label: string;
  description?: string;
  on: boolean;
  onToggle: () => void;
  /** Visually grey out + block clicks. Pair with `disabledHint` to explain why. */
  disabled?: boolean;
  /** Short text appended to the description (italic) when disabled — e.g. "Nécessite Lazy skills". */
  disabledHint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={clsx(
        'w-full flex items-center justify-between gap-3 py-1 rounded px-1 -mx-1 transition-colors text-left',
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-secondary/40',
      )}
    >
      <div>
        <span className="text-[12px] text-foreground block">{label}</span>
        {description && <p className="text-[11px] text-muted-foreground/60 mt-0.5">{description}</p>}
        {disabled && disabledHint && (
          <p className="text-[11px] text-muted-foreground/40 italic mt-0.5">↳ {disabledHint}</p>
        )}
      </div>
      <SwitchThumb on={on} />
    </button>
  );
}

function ThinkBudgetSelector({ value, onChange }: {
  value: 'off' | 'low' | 'medium' | 'high';
  onChange: (v: 'off' | 'low' | 'medium' | 'high') => void;
}) {
  const options: Array<'off' | 'low' | 'medium' | 'high'> = ['off', 'low', 'medium', 'high'];
  return (
    <div className="flex gap-1">
      {options.map(opt => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={`flex-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors ${
              active
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
