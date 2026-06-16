/**
 * Tool `spawn_subagent` — déclenche un sub-agent cloud one-shot en async.
 *
 * Flow :
 *  1) Le caller (agent principal) invoque ce tool avec `{ preset, prompt }`
 *  2) On résout le preset (lookup AgentConfig avec kind='subagent')
 *  3) Vérifications : preset existe, caller dans allowedCallers, caller non-subagent (anti-recursion),
 *     compteur global de spawns par run de parent (max global)
 *  4) Enqueue async_job kind='sub_agent' → AsyncJobsModule.runSubAgent prend le relais
 *  5) Retour immédiat au caller : { status: 'spawned', job_id, message: "..." }
 *
 * Le rapport final du sub-agent est ré-injecté en session parente via deliverToChat
 * (mécanique proactive existante). Le caller ne bloque PAS son turn courant.
 */

import type { AgentConfig, MastermindConfig } from '@mastermind/shared';
import type { AsyncJobsModule } from '../../async-jobs/index.js';

export interface SpawnSubagentOptions {
  /** Module async-jobs pour enqueue le run cloud */
  asyncJobsModule: AsyncJobsModule;
  /** Liste complète des agents (pour lookup du preset par id) */
  agentsList: AgentConfig[];
  /** Caller : ID de l'agent principal qui spawne */
  currentAgentId: string;
  /** Caller : config (utilisée pour double-check kind!=='subagent') */
  callerConfig?: AgentConfig;
  /** Session parente — où le rapport sera ré-injecté */
  currentSessionId: string;
  /** Compteur de spawns dans le run courant (mutable, incrémenté ici) + plafond */
  spawnCounter: { count: number };
  spawnsLimit: number;
  /** Config Mastermind globale (pour subagentDefaults.caps) */
  mastermindConfig?: MastermindConfig;
  /** Native visible channel of the parent session — propagated to runSubAgent so the
   *  TL;DR delivery lands tagged with the right source ('telegram' if parent runs in
   *  Telegram, 'web' otherwise). */
  parentVisibleSource?: 'web' | 'telegram';
}

/** Retourne un message tool destiné au LLM caller — soit erreur explicite, soit confirmation. */
export async function executeSpawnSubagent(
  args: Record<string, unknown>,
  opts: SpawnSubagentOptions,
): Promise<string> {
  const preset = String(args['preset'] ?? '').trim();
  const prompt = String(args['prompt'] ?? '').trim();

  if (!preset) return 'spawn_subagent: "preset" parameter is required.';
  if (!prompt) return 'spawn_subagent: "prompt" parameter is required.';

  // Anti-recursion (defense in depth — getAllTools cache aussi le tool si source==='subagent')
  if (opts.callerConfig?.kind === 'subagent') {
    console.warn(`[tool:spawn_subagent] rejected recursion caller=${opts.currentAgentId} (sub-agents cannot spawn)`);
    return 'spawn_subagent: sub-agents cannot spawn other sub-agents (anti-recursion). Continue your task with the tools you have.';
  }

  // Cap global par run de parent
  if (opts.spawnCounter.count >= opts.spawnsLimit) {
    console.warn(`[tool:spawn_subagent] rejected limit reached caller=${opts.currentAgentId} count=${opts.spawnCounter.count}/${opts.spawnsLimit}`);
    return `spawn_subagent: limit reached for this run (${opts.spawnsLimit} spawns max). Wait for previous sub-agents to complete or finish your task with what you have.`;
  }

  // Soft-cap journalier global (anti-bug-loop sur 24h glissantes). Vérifié AVANT enqueue
  // pour ne pas créer de row qui mangerait un slot inutilement. Failed spawns ne comptent
  // pas eux-mêmes (la row n'est jamais créée → countSubAgentSpawnsSince les ignore).
  const dailyLimit = opts.mastermindConfig?.subagentDefaults?.maxSpawnsPerDay ?? 100;
  if (dailyLimit > 0) {
    const dayWindowMs = 24 * 60 * 60 * 1000;
    const since = Date.now() - dayWindowMs;
    let dailyCount = 0;
    try {
      dailyCount = await opts.asyncJobsModule.countSubAgentSpawnsSince(since);
    } catch (err) {
      // DB hiccup — log mais laisse passer (le cap par run de parent reste actif).
      console.warn(`[tool:spawn_subagent] daily count query failed (proceeding without daily cap): ${err instanceof Error ? err.message : err}`);
    }
    if (dailyCount >= dailyLimit) {
      console.warn(`[tool:spawn_subagent] rejected daily limit reached caller=${opts.currentAgentId} dailyCount=${dailyCount}/${dailyLimit}`);
      return `spawn_subagent: daily spawn limit reached (${dailyLimit} sub-agent runs in the last 24h, all parents combined). This is a soft anti-runaway ceiling. Wait or raise \`subagentDefaults.maxSpawnsPerDay\` in mastermind.yml.`;
    }
  }

  // Résoudre le preset
  const subAgent = opts.agentsList.find(a => a.identity.id === preset && a.kind === 'subagent');
  if (!subAgent) {
    const available = opts.agentsList.filter(a => a.kind === 'subagent').map(a => a.identity.id);
    console.warn(`[tool:spawn_subagent] unknown preset=${preset} available=${available.join(',')}`);
    return `spawn_subagent: unknown preset "${preset}". Available sub-agents: ${available.length ? available.join(', ') : '(none configured)'}.`;
  }

  if (subAgent.enabled === false) {
    console.warn(`[tool:spawn_subagent] preset disabled preset=${preset}`);
    return `spawn_subagent: sub-agent "${preset}" is currently disabled.`;
  }

  // Permissions : allowedCallers
  if (subAgent.allowedCallers && subAgent.allowedCallers.length > 0) {
    if (!subAgent.allowedCallers.includes(opts.currentAgentId)) {
      console.warn(`[tool:spawn_subagent] caller not allowed caller=${opts.currentAgentId} preset=${preset} allowed=${subAgent.allowedCallers.join(',')}`);
      return `spawn_subagent: agent "${opts.currentAgentId}" is not authorized to spawn sub-agent "${preset}".`;
    }
  }

  // Enqueue le job — AsyncJobsModule.runSubAgent prendra le relais au prochain workerTick
  const startedAt = Date.now();
  const { jobId } = await opts.asyncJobsModule.enqueueSubAgent({
    parentAgentId: opts.currentAgentId,
    parentSessionId: opts.currentSessionId,
    subAgentId: preset,
    taskPrompt: prompt,
    ...(opts.parentVisibleSource ? { parentVisibleSource: opts.parentVisibleSource } : {}),
  });

  opts.spawnCounter.count += 1;
  console.log(`[tool:spawn_subagent] queued caller=${opts.currentAgentId} preset=${preset} job=${jobId} promptLen=${prompt.length} count=${opts.spawnCounter.count}/${opts.spawnsLimit} took=${Date.now() - startedAt}ms`);

  return (
    `spawn_subagent: queued (job ${jobId}, preset "${preset}"). The sub-agent is working ` +
    `in the background. Its final report will arrive as a separate message in this session ` +
    `when it completes. You can continue with other work or finish your turn — you don't ` +
    `need to wait synchronously. (${opts.spawnCounter.count}/${opts.spawnsLimit} spawns used in this run.)`
  );
}
