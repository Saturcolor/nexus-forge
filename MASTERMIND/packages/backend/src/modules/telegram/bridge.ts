import { type Bot, type Context } from 'grammy';
import type { AgentModule } from '../agent/index.js';
import type { ProviderModule } from '../provider/index.js';
import type { ConfigModule } from '../config/index.js';  // passed via registerHandlers
import type { AsyncJobsModule } from '../async-jobs/index.js';
import type { MastermindConfig, ModuleRegistry } from '@mastermind/shared';
import { unloadMercuryModel } from '../agent/mercuryStats.js';
import { resolveTelegramSessionId } from '../agent/sessionResolve.js';
import {
  buildMainMenu,
  buildThinkMenu,
  buildTempMenu,
  buildModelMenu,
  buildToolsMenu,
  buildStreamingMenu,
  buildMercuryStatusMenu,
  buildVoiceMenu,
  buildStatusButtons,
  buildCompactConfirm,
  buildCtxMenu,
  buildJobsButtons,
  resolveModelKey,
} from './keyboards.js';
import { escHtml } from './format.js';
import { NcmClient } from '../ncm/client.js';
import {
  runAgentToTelegram,
  setupVoiceProgressMsg,
  type VoiceProgressController,
} from './stream/index.js';

/** Format an elapsed duration as `12s`, `3m40s`, or `1h05m` — compact for inline UI. */
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${String(mm).padStart(2, '0')}m`;
}

/**
 * Build per-bot chat→agent mappings.
 * Returns Map<botId, Map<chatId, agentId>>
 */
export function buildBotMappings(config: MastermindConfig): Map<string, Map<number, string>> {
  const botMappings = new Map<string, Map<number, string>>();

  for (const bot of config.telegram.bots) {
    botMappings.set(bot.id, new Map());
  }

  for (const [agentId, agentConf] of Object.entries(config.agents)) {
    if (agentConf.enabled === false) continue;
    if (!agentConf.telegram?.enabled) continue;

    const botId = agentConf.telegram.botId ?? config.telegram.bots[0]?.id;
    if (!botId) {
      console.warn(`[telegram:bridge] agent=${agentId} has telegram enabled but no botId resolved`);
      continue;
    }

    if (!botMappings.has(botId)) {
      botMappings.set(botId, new Map());
    }
    const chatMap = botMappings.get(botId)!;
    for (const chatId of agentConf.telegram.chatIds) {
      chatMap.set(chatId, agentId);
    }
  }

  for (const [botId, chatMap] of botMappings) {
    console.debug(`[telegram:bridge] mappings bot=${botId}: ${chatMap.size} chat(s) → ${[...chatMap.entries()].map(([c, a]) => `${c}→${a}`).join(', ')}`);
  }

  return botMappings;
}

const TELEGRAM_HELP_TEXT = `*Commandes Telegram disponibles*

/menu — ouvrir le menu des options \\(inline keyboard\\)
/reasoning \\[full|light|off|toggle|status\\] — affichage du raisonnement \\(full = streaming complet, light = "Réflexion en cours…" \\+ timer, off = masqué; toggle cycle full→light→off→full; on = alias full\\)
/streaming \\[on|off\\] — activer/désactiver le streaming progressif des réponses
/processing \\[on|off\\] — afficher le statut Mercury \\(chargement, prompt processing\\) avant chaque réponse
/voice \\[on|off\\] — activer/désactiver les réponses vocales \\(TTS via NCM\\)
/help — afficher cette aide

*Commandes partagées avec l'interface web:*
/think \\[off|low|med|high\\] — niveau de raisonnement
/model \\[<modelId>|off\\] — changer de modèle
/temp \\[<0\\.0\\-2\\.0>|off\\] — override de température
/tools \\[on|off|show|hide\\] — outils et affichage
/status — options actives de la session
/compact — compacter le contexte
/stop — interrompre le run en cours`;

// ── Helper: send the main menu message ───────────────────────────────────────

async function sendMainMenu(
  ctx: Context,
  _chatId: number,
  agentId: string,
  sessionId: string,
  agentMod: AgentModule,
  config: MastermindConfig,
): Promise<void> {
  await agentMod.loadSessionOptions(sessionId);
  const opts = agentMod.getSessionOptions(sessionId);
  const agentDefault = agentMod.getAgent(agentId)?.model ?? config.defaults.model;
  const agentName = agentMod.getAgent(agentId)?.identity.name ?? agentId;
  const agentThink = agentMod.getAgentThinkBudget(agentId);

  await ctx.reply(
    `⚙️ *Options — ${agentName}*\nAppuie pour modifier \\— persistant jusqu'à changement\\.`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: buildMainMenu(opts, agentDefault, agentThink),
    },
  ).catch(() =>
    ctx.reply(`⚙️ Options — ${agentName}`, {
      reply_markup: buildMainMenu(opts, agentDefault, agentThink),
    }),
  );
}

// ── Helper: edit message to show updated main menu ───────────────────────────

async function editMainMenu(
  ctx: Context,
  _chatId: number,
  agentId: string,
  sessionId: string,
  agentMod: AgentModule,
  config: MastermindConfig,
): Promise<void> {
  const opts = agentMod.getSessionOptions(sessionId);
  const agentDefault = agentMod.getAgent(agentId)?.model ?? config.defaults.model;
  const agentName = agentMod.getAgent(agentId)?.identity.name ?? agentId;
  const agentThink = agentMod.getAgentThinkBudget(agentId);

  await ctx.editMessageText(
    `⚙️ *Options — ${agentName}*\nAppuie pour modifier \\— persistant jusqu'à changement\\.`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: buildMainMenu(opts, agentDefault, agentThink),
    },
  ).catch(() => {});
}

// ── Register all handlers ─────────────────────────────────────────────────────

export function registerHandlers(
  bot: Bot,
  chatMapping: Map<number, string>,
  agentMod: AgentModule,
  config: MastermindConfig,
  providerMod: ProviderModule,
  configMod?: ConfigModule,
  modules?: ModuleRegistry,
): void {
  const getModelMenuCandidates = async (): Promise<Array<{ alias: string; modelId: string }>> => {
    const all: Array<{ alias: string; modelId: string }> = [];
    const seen = new Set<string>();
    const push = (alias: string, modelId: string) => {
      if (!modelId || seen.has(modelId)) return;
      all.push({ alias, modelId });
      seen.add(modelId);
    };

    // Live models first — so display names and hidden checks from providers take priority
    for (const provider of config.providers) {
      try {
        const available = await providerMod.fetchAvailableModels(provider.id);
        const hidden = new Set(provider.hiddenModelIds ?? []);
        const display = provider.modelDisplayNames ?? {};
        for (const m of available) {
          if (!m.id || hidden.has(m.id)) continue;
          push(display[m.id] || m.name || m.id, m.id);
        }
      } catch {
        // ignore unavailable provider
      }
    }

    // Static candidates as fallback — only if not already in the live list,
    // and only if not hidden across any provider
    const hiddenAll = new Set(config.providers.flatMap(p => p.hiddenModelIds ?? []));
    const displayAll: Record<string, string> = Object.assign(
      {},
      ...config.providers.map(p => p.modelDisplayNames ?? {}),
    );
    const staticCandidates = [
      config.defaults.model,
      ...Object.values(config.agents).map(agent => agent.model),
    ].filter(Boolean);
    for (const id of staticCandidates) {
      if (hiddenAll.has(id)) continue;
      const displayName = displayAll[id] || id.split('/').pop() || id;
      push(displayName, id);
    }

    return all;
  };

  // ── NCM client for voice (STT/TTS) ──────────────────────────────────────────
  const ncmClient = config.ncm?.baseUrl ? new NcmClient(config.ncm.baseUrl) : null;

  // ── Resolve session-level streaming/visibility flags ──────────────────────
  /** Pull the resolved policy flags for a session in one place. */
  const resolveFlags = (sessionId: string, agentId: string) => {
    const sessionOpts = agentMod.getSessionOptions(sessionId);
    const agentConf = agentMod.getAgent(agentId);
    const useStreaming = sessionOpts.telegramStreaming !== undefined
      ? sessionOpts.telegramStreaming
      : (agentConf?.telegram?.streaming ?? false);
    const reasoningMode: 'full' | 'light' | 'off' = sessionOpts.telegramReasoningMode ?? 'full';
    return {
      useStreaming,
      showToolEvents: !sessionOpts.toolsHidden,
      reasoningMode,
      showMercuryStatus: sessionOpts.telegramMercuryStatus === true,
      useTelegramDraft: sessionOpts.telegramDraft === true,
      useFinalNotif: sessionOpts.telegramFinalNotif === true,
      voiceMode: !!sessionOpts.telegramVoice,
    };
  };

  // ── Callback query handler (inline keyboard button presses) ────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.callbackQuery.message?.chat.id;
    if (!chatId) { await ctx.answerCallbackQuery(); return; }

    await ctx.answerCallbackQuery().catch(() => {});

    const agentId = chatMapping.get(chatId);
    if (!agentId) {
      console.debug(`[telegram:bridge] callback chatId=${chatId} data=${data} → no agent mapped`);
      return;
    }
    console.debug(`[telegram:bridge] callback chatId=${chatId} agent=${agentId} action=${data}`);
    const sessionId = resolveTelegramSessionId(agentId, chatId, config.agents[agentId]);
    // Ensure DB options are in memory before any read or write — prevents stale {} on first use after restart.
    await agentMod.loadSessionOptions(sessionId);
    const agentDefault = agentMod.getAgent(agentId)?.model ?? config.defaults.model;

    const edit = (text: string, kb: ReturnType<typeof buildMainMenu>) =>
      ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});

    // ── Main menu ────────────────────────────────────────────────────────────
    if (data === 'menu') {
      await editMainMenu(ctx, chatId, agentId, sessionId, agentMod, config);
      return;
    }

    // ── Status ───────────────────────────────────────────────────────────────
    if (data === 'stat' || data === 'stat:r') {
      const statusText = await agentMod.generateStatusText(sessionId, agentId);
      await ctx.editMessageText(statusText, {
        parse_mode: 'Markdown',
        reply_markup: buildStatusButtons(),
      }).catch(() => {});
      return;
    }

    // ── Async jobs list ──────────────────────────────────────────────────────
    if (data === 'jobs:list') {
      const asyncJobsMod = modules?.tryGet<AsyncJobsModule>('async-jobs');
      if (!asyncJobsMod) {
        await ctx.editMessageText('⚠️ Module async-jobs indisponible.', { reply_markup: buildStatusButtons() }).catch(() => {});
        return;
      }
      const jobs = await asyncJobsMod.list({ agentId, status: ['queued', 'running'], limit: 20 });
      if (jobs.length === 0) {
        await ctx.editMessageText(
          '🕐 *Tâches en cours*\n\nAucune tâche active.',
          { parse_mode: 'Markdown', reply_markup: buildJobsButtons([]) },
        ).catch(() => {});
        return;
      }
      const now = Date.now();
      const lines = ['🕐 *Tâches en cours*', ''];
      const buttonEntries: Array<{ id: string; shortLabel: string }> = [];
      for (const j of jobs) {
        const shortId = j.id.slice(0, 6);
        const displayName = j.toolName.replace(/^skill_/, '').slice(0, 30);
        if (j.status === 'running') {
          const elapsedMs = j.startedAt ? now - new Date(j.startedAt).getTime() : 0;
          const elapsedStr = formatElapsed(elapsedMs);
          lines.push(`⚙️ \`${shortId}\` \`${displayName}\` — running · ${elapsedStr}`);
        } else {
          const waitedMs = now - new Date(j.createdAt).getTime();
          lines.push(`⏳ \`${shortId}\` \`${displayName}\` — queued · ${formatElapsed(waitedMs)}`);
        }
        buttonEntries.push({ id: j.id, shortLabel: shortId });
      }
      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: buildJobsButtons(buttonEntries),
      }).catch(() => {});
      return;
    }

    if (data.startsWith('jobs:cancel:')) {
      const jobId = data.slice('jobs:cancel:'.length);
      const asyncJobsMod = modules?.tryGet<AsyncJobsModule>('async-jobs');
      if (!asyncJobsMod) {
        await ctx.editMessageText('⚠️ Module async-jobs indisponible.', { reply_markup: buildStatusButtons() }).catch(() => {});
        return;
      }
      const result = await asyncJobsMod.cancel(jobId);
      const msg = result.cancelled ? `✅ Job \`${jobId.slice(0, 6)}\` annulé.` : `⚠️ Annulation refusée: ${result.reason ?? 'unknown'}`;
      // After cancel, redraw the jobs list
      const remaining = await asyncJobsMod.list({ agentId, status: ['queued', 'running'], limit: 20 });
      const now = Date.now();
      const lines = [msg, '', '🕐 *Tâches en cours*', ''];
      const buttonEntries: Array<{ id: string; shortLabel: string }> = [];
      if (remaining.length === 0) lines.push('Aucune tâche active.');
      for (const j of remaining) {
        const shortId = j.id.slice(0, 6);
        const displayName = j.toolName.replace(/^skill_/, '').slice(0, 30);
        const elapsedMs = j.startedAt ? now - new Date(j.startedAt).getTime() : now - new Date(j.createdAt).getTime();
        lines.push(`${j.status === 'running' ? '⚙️' : '⏳'} \`${shortId}\` \`${displayName}\` · ${formatElapsed(elapsedMs)}`);
        buttonEntries.push({ id: j.id, shortLabel: shortId });
      }
      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: buildJobsButtons(buttonEntries),
      }).catch(() => {});
      return;
    }

    // ── CTX submenu (compact | warm) ─────────────────────────────────────────
    if (data === 'ctx:ask') {
      await ctx.editMessageText(
        '📦 *Contexte*\nChoisissez une action :',
        { parse_mode: 'MarkdownV2', reply_markup: buildCtxMenu() },
      ).catch(() =>
        ctx.editMessageText('📦 Contexte — choisissez une action :', { reply_markup: buildCtxMenu() }).catch(() => {}),
      );
      return;
    }

    if (data === 'ctx:back') {
      await editMainMenu(ctx, chatId, agentId, sessionId, agentMod, config);
      return;
    }

    if (data === 'ctx:compact') {
      await ctx.editMessageText(
        '🗜️ *Compacter le contexte ?*\nLa conversation sera résumée et réinitialisée\\.',
        { parse_mode: 'MarkdownV2', reply_markup: buildCompactConfirm() },
      ).catch(() =>
        ctx.editMessageText(
          '🗜️ Compacter le contexte ? La conversation sera résumée et réinitialisée.',
          { reply_markup: buildCompactConfirm() },
        ).catch(() => {}),
      );
      return;
    }

    if (data === 'ctx:warm') {
      await ctx.editMessageText('🔥 Préchauffage du cache en cours…').catch(() => {});
      // Fire-and-forget: an awaited agentMod.run would block grammY's long-polling
      // loop (default sequential update processing) and freeze every other chat.
      void (async () => {
        try {
          await agentMod.run(agentId, sessionId, '', 'web', { warmup: true });
          await ctx.editMessageText('✅ Cache préchauffé.').catch(() => {});
          await new Promise(r => setTimeout(r, 1200));
        } catch { /* ignore */ }
        await editMainMenu(ctx, chatId, agentId, sessionId, agentMod, config);
      })().catch(() => {});
      return;
    }

    // ── Compact ──────────────────────────────────────────────────────────────
    if (data === 'compact:no') {
      await editMainMenu(ctx, chatId, agentId, sessionId, agentMod, config);
      return;
    }

    if (data === 'compact:ok') {
      await ctx.editMessageText('🗜️ Compactage en cours…').catch(() => {});
      // Fire-and-forget: an awaited agentMod.run would block grammY's long-polling
      // loop (default sequential update processing) and freeze every other chat.
      void (async () => {
        try {
          await agentMod.run(agentId, sessionId, '/compact', 'telegram');
        } catch { /* ignore */ }
        await editMainMenu(ctx, chatId, agentId, sessionId, agentMod, config);
      })().catch(() => {});
      return;
    }

    // ── Open submenus ────────────────────────────────────────────────────────
    if (data === 'sub:think') {
      const reasoningMode = agentMod.getSessionOptions(sessionId).telegramReasoningMode ?? 'full';
      await edit('💭 *Think — 🧠 Reasoning*', buildThinkMenu(agentMod.getAgentThinkBudget(agentId), reasoningMode));
      return;
    }
    if (data === 'sub:temp') {
      await edit('🌡️ *Température*', buildTempMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }
    if (data === 'sub:model') {
      const modelMenuCandidates = await getModelMenuCandidates();
      await edit('🤖 *Modèle*', buildModelMenu(
        agentMod.getSessionOptions(sessionId),
        agentDefault,
        config.providers,
        modelMenuCandidates,
      ));
      return;
    }
    if (data === 'sub:tools') {
      await edit('🛠️ *Outils — 👁️ Affichage*', buildToolsMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }
    if (data === 'sub:stream') {
      await edit('📡 *Streaming Telegram*', buildStreamingMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }
    if (data === 'sub:mercurystat') {
      await edit('⚡ *Perf live* — chargement & prompt processing', buildMercuryStatusMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Think level ──────────────────────────────────────────────────────────
    // Agent-level (single source of truth): the value persists across chat / Telegram / scheduler.
    if (data.startsWith('think:')) {
      const LEVELS: Record<string, 'off' | 'low' | 'medium' | 'high'> = {
        off: 'off', low: 'low', med: 'medium', high: 'high',
      };
      const val = data.slice(6);
      if (val in LEVELS) {
        await agentMod.setAgentThinkBudget(agentId, LEVELS[val]);
        const reasoningMode = agentMod.getSessionOptions(sessionId).telegramReasoningMode ?? 'full';
        await edit('💭 *Think — 🧠 Reasoning*', buildThinkMenu(agentMod.getAgentThinkBudget(agentId), reasoningMode));
      }
      return;
    }

    // ── Temperature ──────────────────────────────────────────────────────────
    if (data.startsWith('temp:')) {
      const val = data.slice(5);
      const temp = val === 'off' ? null : parseFloat(val);
      if (val === 'off' || (!isNaN(temp as number) && (temp as number) >= 0 && (temp as number) <= 2)) {
        await agentMod.setSessionOptions(sessionId, agentId, { temperatureOverride: temp as number | null });
        await edit('🌡️ *Température*', buildTempMenu(agentMod.getSessionOptions(sessionId)));
      }
      return;
    }

    // ── Tools on/off ─────────────────────────────────────────────────────────
    if (data === 'tools:on' || data === 'tools:off') {
      await agentMod.setSessionOptions(sessionId, agentId, { toolsDisabled: data === 'tools:off' || undefined });
      await edit('🛠️ *Outils agent*', buildToolsMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Tool display show/hide ────────────────────────────────────────────────
    if (data === 'toolsv:show' || data === 'toolsv:hide') {
      await agentMod.setSessionOptions(sessionId, agentId, { toolsHidden: data === 'toolsv:hide' || undefined });
      await edit('🛠️ *Outils — 👁️ Affichage*', buildToolsMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Streaming on/off ──────────────────────────────────────────────────────
    if (data === 'stream:on' || data === 'stream:off') {
      await agentMod.setSessionOptions(sessionId, agentId, { telegramStreaming: data === 'stream:on' || undefined });
      await edit('📡 *Streaming Telegram*', buildStreamingMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Native draft on/off ──────────────────────────────────────────────────
    // When on AND streaming is on, the streaming preview uses Bot API 9.5+
    // sendMessageDraft (native client-side animation, no editMessageText
    // rate-limit pressure). DM/private chats only — group chats fall back
    // to edit mode automatically.
    if (data === 'draft:on' || data === 'draft:off') {
      await agentMod.setSessionOptions(sessionId, agentId, { telegramDraft: data === 'draft:on' || undefined });
      await edit('📡 *Streaming Telegram*', buildStreamingMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Final-notif toggle ────────────────────────────────────────────────────
    // ON: at finalize, delete the streaming bubble (live reasoning preview is
    // transient anyway) and send the final answer as a new sendMessage, which
    // triggers a push notification. Useful when reasoningMode != 'off' because
    // the first send is a reasoning placeholder, so the native streaming flow
    // would notify on a useless frame and leave the actual answer silent.
    if (data === 'finalnotif:on' || data === 'finalnotif:off') {
      await agentMod.setSessionOptions(sessionId, agentId, { telegramFinalNotif: data === 'finalnotif:on' || undefined });
      await edit('📡 *Streaming Telegram*', buildStreamingMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Mercury status on/off ─────────────────────────────────────────────────
    if (data === 'mercurystat:on' || data === 'mercurystat:off') {
      await agentMod.setSessionOptions(sessionId, agentId, { telegramMercuryStatus: data === 'mercurystat:on' || undefined });
      await edit('⚡ *Perf live* — chargement & prompt processing', buildMercuryStatusMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Voice submenu ────────────────────────────────────────────────────────
    if (data === 'sub:voice') {
      await edit('🎙️ *Réponse vocale* — TTS via NCM', buildVoiceMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Voice on/off ─────────────────────────────────────────────────────────
    if (data === 'voice:on' || data === 'voice:off') {
      await agentMod.setSessionOptions(sessionId, agentId, { telegramVoice: data === 'voice:on' || undefined });
      await edit('🎙️ *Réponse vocale* — TTS via NCM', buildVoiceMenu(agentMod.getSessionOptions(sessionId)));
      return;
    }

    // ── Reasoning display: full / light / off ─────────────────────────────────
    if (data === 'reason:full' || data === 'reason:light' || data === 'reason:off') {
      const mode = data.slice('reason:'.length) as 'full' | 'light' | 'off';
      await agentMod.setSessionOptions(sessionId, agentId, { telegramReasoningMode: mode });
      await edit('💭 *Think — 🧠 Reasoning*', buildThinkMenu(agentMod.getAgentThinkBudget(agentId), mode));
      return;
    }

    // ── Model: reset to default ───────────────────────────────────────────────
    if (data === 'mdl:off') {
      // Clear any session model override — agent uses its configured default
      await agentMod.setSessionOptions(sessionId, agentId, { modelOverride: null });
      const currentAgent = agentMod.getAgent(agentId);
      const modelMenuCandidates = await getModelMenuCandidates();
      await edit('🤖 *Modèle*', buildModelMenu(
        agentMod.getSessionOptions(sessionId),
        currentAgent?.model ?? agentDefault,
        config.providers,
        modelMenuCandidates,
      ));
      return;
    }

    // ── Model: select by registry key ─────────────────────────────────────────
    if (data.startsWith('mdl:s:')) {
      const modelId = resolveModelKey(data.slice(6));
      if (modelId) {
        // Best-effort: unload current model from Mercury before switching, gated by
        // defaults.autoUnloadOnSwitch (set false when agents share one model).
        if (config.defaults.autoUnloadOnSwitch !== false) {
          const currentModelRef = agentMod.getSessionOptions(sessionId).modelOverride ?? agentDefault;
          try {
            const { providerId, modelId: currentModelId } = providerMod.resolveModel(currentModelRef);
            let provider = config.providers.find(p => p.id === providerId);
            if (!provider?.statsUrl) {
              provider = config.providers.find(p => !!p.statsUrl && p.statsEnabled === true);
            }
            if (provider) await unloadMercuryModel(provider, currentModelId).catch(() => {});
          } catch { /* model not resolvable — skip unload */ }
        }

        // Update agent config directly (persistent change, not a session override).
        // save() serializes the live config object, so we must mutate before saving;
        // if the disk write throws (full/RO FS) we roll back the in-memory mutation and
        // skip updateAgentConfig so config-object, disk, and runtime Map stay coherent.
        const agentYaml = config.agents[agentId];
        if (agentYaml) {
          const previousModel = agentYaml.model;
          agentYaml.model = modelId;
          try {
            configMod?.save();
            agentMod.updateAgentConfig(agentId, { model: modelId });
          } catch (err) {
            agentYaml.model = previousModel;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[telegram:bridge] model switch save failed agent=${agentId} model=${modelId}: ${msg}`);
            await ctx.editMessageText(`⚠️ Échec de l'enregistrement du modèle (config inchangée): ${msg}`).catch(() => {});
            return;
          }
        }
        // Clear any stale session model override
        const currentOpts = agentMod.getSessionOptions(sessionId);
        if (currentOpts.modelOverride) {
          await agentMod.setSessionOptions(sessionId, agentId, { modelOverride: null });
        }
        const modelMenuCandidates = await getModelMenuCandidates();
        await edit('🤖 *Modèle*', buildModelMenu(
          agentMod.getSessionOptions(sessionId),
          agentYaml?.model ?? modelId,
          config.providers,
          modelMenuCandidates,
        ));
      }
      return;
    }
  });

  // ── Text message handler ───────────────────────────────────────────────────
  bot.on('message:text', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!chatId || !text) return;

    // /menu — open inline options menu
    if (isMenuCommand(text)) {
      const agentId = chatMapping.get(chatId);
      if (!agentId) { await ctx.reply('Aucun agent configuré pour ce chat.').catch(() => {}); return; }
      const sessionId = resolveTelegramSessionId(agentId, chatId, config.agents[agentId]);
      await agentMod.loadSessionOptions(sessionId);
      await sendMainMenu(ctx, chatId, agentId, sessionId, agentMod, config);
      return;
    }

    // /help — gated to mapped chats, consistent with /menu (no command-surface disclosure to unmapped chats)
    if (isHelpCommand(text)) {
      if (!chatMapping.has(chatId)) { await ctx.reply('Aucun agent configuré pour ce chat.').catch(() => {}); return; }
      await ctx.reply(TELEGRAM_HELP_TEXT, { parse_mode: 'MarkdownV2' }).catch(() =>
        ctx.reply('Commandes: /menu, /reasoning, /streaming, /help, /think, /model, /temp, /tools, /status, /compact'),
      );
      return;
    }

    const agentId = chatMapping.get(chatId);
    if (!agentId) {
      console.log(`[telegram] Ignoring message from unmapped chat ${chatId}`);
      return;
    }

    // /stop — abort the agent's current run immediately
    // Strip the @botname suffix Telegram appends in group chats (e.g. `/stop@MonBot`).
    if (text.trim().split(/\s+/)[0]?.toLowerCase().split('@')[0] === '/stop') {
      console.log(`[telegram:bridge] /stop agent=${agentId} chatId=${chatId}`);
      agentMod.abort(agentId);
      await ctx.reply('⏹ Run interrompu.').catch(() => {});
      return;
    }

    const sessionId = resolveTelegramSessionId(agentId, chatId, config.agents[agentId]);
    // Ensure DB options are in memory before any read — covers /reasoning, streaming flag, etc.
    await agentMod.loadSessionOptions(sessionId);

    // /reasoning [full|light|off|toggle|status] [message...]
    const reasoningCmd = parseReasoningCommand(text);
    if (reasoningCmd) {
      const current = agentMod.getSessionOptions(sessionId).telegramReasoningMode ?? 'full';
      // Toggle cycles full → light → off → full
      const cycle: Record<'full' | 'light' | 'off', 'full' | 'light' | 'off'> = { full: 'light', light: 'off', off: 'full' };
      let next: 'full' | 'light' | 'off' = current;
      if (reasoningCmd.mode === 'full' || reasoningCmd.mode === 'light' || reasoningCmd.mode === 'off') next = reasoningCmd.mode;
      else if (reasoningCmd.mode === 'toggle') next = cycle[current];
      if (reasoningCmd.mode !== 'status') {
        await agentMod.setSessionOptions(sessionId, agentId, { telegramReasoningMode: next });
      }
      // Inline message after the mode (e.g. `/reasoning light explique X`): apply the
      // mode silently and relay the rest to the agent, mirroring the web directive
      // parser which strips the directive and forwards the remaining content. Without
      // an inline message, just acknowledge the new display mode.
      if (!reasoningCmd.remaining) {
        const shown = reasoningCmd.mode === 'status' ? current : next;
        const label = shown === 'full' ? 'Full (streaming complet)' : shown === 'light' ? 'Light (Réflexion en cours… + timer)' : 'Off (masqué)';
        await ctx.reply(
          `Affichage du reasoning: ${label}.\n` +
          'Note: le thinking/reasoning interne du modele reste actif.',
        ).catch(() => {});
        return;
      }
      // Re-resolve flags so the freshly applied reasoning mode takes effect on this run.
      const flags = resolveFlags(sessionId, agentId);
      console.log(`[telegram:bridge] /reasoning inline chatId=${chatId} agent=${agentId} mode=${next} remainingLen=${reasoningCmd.remaining.length}`);
      void runAgentToTelegram({
        ctx,
        chatId,
        agentId,
        sessionId,
        agentMod,
        userText: reasoningCmd.remaining,
        showToolEvents: flags.showToolEvents,
        reasoningMode: flags.reasoningMode,
        showMercuryStatus: flags.showMercuryStatus,
        streaming: flags.useStreaming,
        useTelegramDraft: flags.useTelegramDraft,
        useFinalNotif: flags.useFinalNotif,
        voiceOnlyOutput: false,
        ncmClient,
        alsoSendTtsReply: flags.voiceMode,
        typingAction: 'typing',
      });
      return;
    }

    const flags = resolveFlags(sessionId, agentId);
    console.log(`[telegram:bridge] message chatId=${chatId} agent=${agentId} session=${sessionId} streaming=${flags.useStreaming} textLen=${text.length}`);

    // Fire-and-forget so grammY can process /stop while the agent is running.
    void runAgentToTelegram({
      ctx,
      chatId,
      agentId,
      sessionId,
      agentMod,
      userText: text,
      showToolEvents: flags.showToolEvents,
      reasoningMode: flags.reasoningMode,
      showMercuryStatus: flags.showMercuryStatus,
      streaming: flags.useStreaming,
      useTelegramDraft: flags.useTelegramDraft,
      useFinalNotif: flags.useFinalNotif,
      voiceOnlyOutput: false,
      ncmClient,
      alsoSendTtsReply: flags.voiceMode,
      typingAction: 'typing',
    });
  });

  // ── Photo message handler ──────────────────────────────────────────────────
  bot.on('message:photo', async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const agentId = chatMapping.get(chatId);
    if (!agentId) {
      console.log(`[telegram] Ignoring photo from unmapped chat ${chatId}`);
      return;
    }

    const sessionId = resolveTelegramSessionId(agentId, chatId, config.agents[agentId]);
    await agentMod.loadSessionOptions(sessionId);
    const flags = resolveFlags(sessionId, agentId);

    // Caption text (or empty — agent will describe the image)
    const rawContent = ctx.message?.caption ?? '';
    const userText = rawContent || 'Décris cette image.';
    console.log(`[telegram:bridge] photo chatId=${chatId} agent=${agentId} streaming=${flags.useStreaming} caption=${rawContent.length > 0 ? rawContent.slice(0, 40) : '(none)'}`);

    // Download the largest photo variant as base64 dataUrl
    const photos = ctx.message?.photo ?? [];
    const photo = photos.at(-1); // Telegram sorts by ascending size; last = largest
    let images: Array<{ dataUrl: string; mimeType: string; name?: string }> | undefined;
    if (photo) {
      try {
        const file = await ctx.api.getFile(photo.file_id);
        if (file.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
          const res = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
            images = [{ dataUrl, mimeType: 'image/jpeg', name: `photo_${photo.file_unique_id}.jpg` }];
            console.log(`[telegram] Photo downloaded: ${buffer.length} bytes for chat ${chatId}`);
          }
        }
      } catch (err) {
        console.error('[telegram] Photo download failed:', err);
      }
    }

    void runAgentToTelegram({
      ctx,
      chatId,
      agentId,
      sessionId,
      agentMod,
      userText,
      images,
      showToolEvents: flags.showToolEvents,
      reasoningMode: flags.reasoningMode,
      showMercuryStatus: flags.showMercuryStatus,
      streaming: flags.useStreaming,
      useTelegramDraft: flags.useTelegramDraft,
      useFinalNotif: flags.useFinalNotif,
      voiceOnlyOutput: false,
      ncmClient,
      alsoSendTtsReply: flags.voiceMode,
      typingAction: 'typing',
    });
  });

  // ── Shared voice/video_note handler logic ───────────────────────────────────
  // Voice ON  → transcript shown, agent response as audio ONLY (no text, no reasoning)
  // Voice OFF → transcript shown, agent response as text (streaming/batch respected)
  const handleVoiceInput = async (ctx: Context, fileId: string, kind: 'voice' | 'video_note') => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const agentId = chatMapping.get(chatId);
    if (!agentId) {
      console.log(`[telegram] Ignoring ${kind} from unmapped chat ${chatId}`);
      return;
    }

    if (!ncmClient) {
      await ctx.reply('⚠️ NCM non configuré — impossible de transcrire les vocaux.').catch(() => {});
      return;
    }

    const sessionId = resolveTelegramSessionId(agentId, chatId, config.agents[agentId]);
    await agentMod.loadSessionOptions(sessionId);
    const flags = resolveFlags(sessionId, agentId);
    console.log(`[telegram:bridge] ${kind} chatId=${chatId} agent=${agentId} session=${sessionId} voiceMode=${flags.voiceMode} streaming=${flags.useStreaming}`);

    // 1. Download file from Telegram
    let audioBuffer: Buffer;
    try {
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) throw new Error('No file_path in Telegram response');
      const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      audioBuffer = Buffer.from(await res.arrayBuffer());
      console.log(`[telegram:voice] Downloaded ${audioBuffer.length} bytes (${kind}) from chat ${chatId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram:voice] Download failed:`, msg);
      await ctx.reply('❌ Impossible de télécharger le vocal.').catch(() => {});
      return;
    }

    // 2. Transcribe via NCM
    const filename = kind === 'video_note' ? 'video_note.mp4' : 'voice.ogg';
    let transcript: string;
    try {
      await ctx.replyWithChatAction('typing').catch(() => {});
      const result = await ncmClient.transcribe(audioBuffer, agentId, filename);
      transcript = result.text;
      if (!transcript.trim()) {
        await ctx.reply('🔇 Aucun texte détecté dans le vocal.').catch(() => {});
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram:voice] STT failed:`, msg);
      await ctx.reply(`❌ Transcription échouée: ${msg}`).catch(() => {});
      return;
    }

    // 3. Show transcript to user
    await ctx.reply(`🎤 ${escHtml(transcript)}`, { parse_mode: 'HTML' }).catch(() =>
      ctx.reply(`🎤 ${transcript}`),
    );

    // 3.b Voice-only mode: spin up a progress bubble UNDER the transcript that
    // will edit in-place through "🤔 Réflexion → ⚙️ Prompt → 🔧 Outil → 🔊
    // Synthèse" and be deleted right before the audio reply arrives. Only
    // active when the voice toggle is ON — text-reply path keeps its existing
    // streaming UX (draftStream provides the progress signal there).
    let voiceProgress: VoiceProgressController | undefined;
    if (flags.voiceMode) {
      voiceProgress = await setupVoiceProgressMsg(ctx, chatId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[telegram:voice] voiceProgress setup failed (continuing without): ${msg}`);
        return undefined;
      });
    }

    // 4. Hand off to the streaming module.
    //    voice ON  → voice-only output (audio reply, no text, no reasoning, no streaming)
    //    voice OFF → normal streaming/batch text reply
    void runAgentToTelegram({
      ctx,
      chatId,
      agentId,
      sessionId,
      agentMod,
      userText: transcript,
      showToolEvents: flags.showToolEvents,
      reasoningMode: flags.reasoningMode,
      showMercuryStatus: flags.showMercuryStatus,
      streaming: !flags.voiceMode && flags.useStreaming,
      useTelegramDraft: flags.useTelegramDraft && !flags.voiceMode,
      useFinalNotif: flags.useFinalNotif && !flags.voiceMode,
      voiceOnlyOutput: flags.voiceMode,
      ncmClient,
      alsoSendTtsReply: false, // already covered by voiceOnlyOutput when voiceMode
      typingAction: flags.voiceMode ? 'upload_voice' : 'typing',
      voiceProgress,
    });
  };

  // ── Voice message handler (audio-only) ────────────────────────────────────
  bot.on('message:voice', async (ctx: Context) => {
    const voice = ctx.message?.voice;
    if (voice) await handleVoiceInput(ctx, voice.file_id, 'voice');
  });

  // ── Video note handler (round video with audio) ───────────────────────────
  bot.on('message:video_note', async (ctx: Context) => {
    const videoNote = ctx.message?.video_note;
    if (videoNote) await handleVoiceInput(ctx, videoNote.file_id, 'video_note');
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isMenuCommand(text: string): boolean {
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase().split('@')[0];
  return cmd === '/menu' || cmd === '/options';
}

function isHelpCommand(text: string): boolean {
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase().split('@')[0];
  return cmd === '/help' || cmd === '/aide';
}

type ReasoningMode = 'full' | 'light' | 'off' | 'toggle' | 'status';

/**
 * Parse a `/reasoning [mode] [inline message...]` command.
 * Returns the resolved mode plus any inline message that follows the mode token,
 * so the bridge can relay it to the agent instead of dropping it — mirroring the
 * web directive parser (directives.ts), which strips the directive and keeps the
 * remaining content for the LLM.
 */
function parseReasoningCommand(text: string): { mode: ReasoningMode; remaining: string } | null {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 0) return null;
  const cmd = parts[0].toLowerCase().split('@')[0];
  if (cmd !== '/reasoning') return null;
  const arg = (parts[1] ?? '').toLowerCase();

  let mode: ReasoningMode;
  let consumed: number; // number of leading tokens consumed (command [+ mode arg])
  if (!arg || arg === 'toggle') {
    mode = 'toggle';
    consumed = arg ? 2 : 1;
  } else if (arg === 'full' || arg === 'on' || arg === 'enable' || arg === '1' || arg === 'true') {
    mode = 'full';
    consumed = 2;
  } else if (arg === 'light') {
    mode = 'light';
    consumed = 2;
  } else if (arg === 'off' || arg === 'disable' || arg === '0' || arg === 'false') {
    mode = 'off';
    consumed = 2;
  } else if (arg === 'status' || arg === 'state') {
    mode = 'status';
    consumed = 2;
  } else {
    // Unknown token after /reasoning — treat as status query, keep the token as message content.
    mode = 'status';
    consumed = 1;
  }

  const remaining = parts.slice(consumed).join(' ').trim();
  return { mode, remaining };
}
