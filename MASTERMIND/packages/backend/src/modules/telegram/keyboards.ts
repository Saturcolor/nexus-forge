/**
 * Telegram inline keyboard builders for Mastermind session options.
 *
 * Navigation philosophy: every option opens a submenu (consistent UX).
 * Binary options show [✓ ON] [OFF] or [ON] [✓ OFF] + [← Retour].
 * Multi-value options (think, temp, model) show all choices + [← Retour].
 * Status shows live text + [🔄 Refresh] [← Menu].
 * Compact shows confirmation [✓ Confirmer] [✗ Annuler].
 *
 * Callback data (max 64 bytes):
 *   menu            main menu
 *   stat            status view
 *   stat:r          status refresh
 *   ctx:ask         CTX submenu (compact ou warm)
 *   ctx:compact     → compact confirmation
 *   ctx:warm        → warm cache
 *   ctx:back        → retour menu principal
 *   compact:ask     compact confirmation (depuis ctx:compact)
 *   compact:ok      confirm compact
 *   compact:no      cancel compact
 *   sub:think       think+reasoning submenu (merged)
 *   sub:temp        temp submenu
 *   sub:model       model submenu
 *   sub:tools       tools+display submenu (merged)
 *   sub:stream      streaming submenu
 *   sub:mercurystat Mercury status submenu
 *   think:off/low/med/high
 *   reason:full / reason:light / reason:off   (inside think submenu)
 *   temp:off/0.1/0.5/0.7/1.0/1.5
 *   tools:on / tools:off
 *   toolsv:show / toolsv:hide  (inside tools submenu)
 *   stream:on / stream:off
 *   draft:on / draft:off       (native Bot API 9.5+ sendMessageDraft animation)
 *   finalnotif:on / finalnotif:off  (delete+resend final to trigger push notif at end of stream)
 *   mercurystat:on / mercurystat:off
 *   mdl:off         reset model
 *   mdl:s:{key}     select model by registry key (m0, m1, …)
 */

import { InlineKeyboard } from 'grammy';
import type { SessionOptions } from '../agent/directives.js';
import type { ProviderConfig } from '@mastermind/shared';

// ── Model registry ────────────────────────────────────────────────────────────
//
// L6 : le registre est un cache key↔modelId partagé entre toutes les sessions. Il
// était module-level ET jamais purgé → un bouton inline périmé (rendu quand un modèle
// existait encore) restait résolvable via `resolveModelKey` longtemps après la
// suppression du modèle, et le handler `mdl:s:` du bridge écrivait alors ce modelId
// supprimé directement dans la config agent. On purge donc le registre au début de
// CHAQUE `buildModelMenu` (seul writer de clés) et on n'y ré-inscrit que les modèles
// effectivement présentés cette fois-ci : une clé absente du menu courant résout à
// `undefined`, et le garde `if (modelId)` du bridge ignore le clic périmé.

const modelRegistry = new Map<string, string>();
const modelRegistryReverse = new Map<string, string>();
let modelCounter = 0;

/** Vide le registre. Appelé en tête de `buildModelMenu` pour ne garder que les modèles du menu courant. */
function resetModelRegistry(): void {
  modelRegistry.clear();
  modelRegistryReverse.clear();
  modelCounter = 0;
}

export function getOrRegisterModel(modelId: string): string {
  const existing = modelRegistryReverse.get(modelId);
  if (existing) return existing;
  const key = `m${modelCounter++}`;
  modelRegistry.set(key, modelId);
  modelRegistryReverse.set(modelId, key);
  return key;
}

export function resolveModelKey(key: string): string | undefined {
  return modelRegistry.get(key);
}

// ── Label helpers ─────────────────────────────────────────────────────────────

/** Maps the agent-level thinkBudget enum to the menu label (med shorthand for medium). */
export function thinkLabel(agentThink: 'off' | 'low' | 'medium' | 'high'): string {
  return agentThink === 'medium' ? 'med' : agentThink;
}

export function tempLabel(opts: SessionOptions): string {
  return opts.temperatureOverride !== undefined
    ? String(opts.temperatureOverride)
    : 'défaut';
}

function modelShortLabel(opts: SessionOptions, agentDefault: string): string {
  const id = opts.modelOverride ?? agentDefault;
  const short = id.split('/').pop() ?? id;
  return short.length > 16 ? short.slice(0, 14) + '…' : short;
}

/** Mark active value with ✓ */
function mark(active: boolean, label: string): string {
  return active ? `✓ ${label}` : label;
}

// ── Main menu ─────────────────────────────────────────────────────────────────

export function buildMainMenu(
  opts: SessionOptions,
  agentDefault: string,
  agentThink: 'off' | 'low' | 'medium' | 'high',
): InlineKeyboard {
  const tl = thinkLabel(agentThink);
  const tep = tempLabel(opts);
  const ml = modelShortLabel(opts, agentDefault);

  return new InlineKeyboard()
    // Row 0 — actions
    .text('📊 Status', 'stat')
    .text('📦 Contexte', 'ctx:ask')
    .text('🕐 Tâches', 'jobs:list')
    .row()
    // Row 1 — generation
    .text(`💭 Think: ${tl}`, 'sub:think')
    .text(`🌡️ Temp: ${tep}`, 'sub:temp')
    .row()
    // Row 2 — model (full width)
    .text(`🤖 ${ml}`, 'sub:model')
    .row()
    // Row 3 — tools + streaming
    .text(`🛠️ Tools: ${opts.toolsDisabled ? 'OFF' : 'ON'}`, 'sub:tools')
    .text(`📡 Stream: ${opts.telegramStreaming ? 'ON' : 'OFF'}`, 'sub:stream')
    .row()
    // Row 4 — Mercury live stats display + voice
    .text(`⚡ Perf live: ${opts.telegramMercuryStatus ? 'ON' : 'OFF'}`, 'sub:mercurystat')
    .text(`🎙️ Voice: ${opts.telegramVoice ? 'ON' : 'OFF'}`, 'sub:voice');
}

// ── Status view ───────────────────────────────────────────────────────────────

export function buildStatusButtons(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Refresh', 'stat:r')
    .text('← Menu', 'menu');
}

// ── Jobs view ────────────────────────────────────────────────────────────────

/**
 * Build a keyboard for the active-jobs list. One row per job with a cancel button,
 * then a refresh + back row. Returns a bare menu keyboard (no job rows) when the list is empty.
 */
export function buildJobsButtons(activeJobIds: Array<{ id: string; shortLabel: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const job of activeJobIds) {
    kb.text(`❌ Cancel ${job.shortLabel}`, `jobs:cancel:${job.id}`).row();
  }
  kb.text('🔄 Refresh', 'jobs:list').text('← Menu', 'menu');
  return kb;
}

// ── CTX submenu (compact | warm) ──────────────────────────────────────────────

export function buildCtxMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🗜️ Compacter', 'ctx:compact')
    .text('🔥 Préchauffer', 'ctx:warm')
    .row()
    .text('← Retour', 'ctx:back');
}

// ── Compact confirmation ──────────────────────────────────────────────────────

export function buildCompactConfirm(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✓ Confirmer', 'compact:ok')
    .text('✗ Annuler', 'compact:no');
}

// ── Think + Reasoning submenu (merged) ────────────────────────────────────────

export function buildThinkMenu(
  agentThink: 'off' | 'low' | 'medium' | 'high',
  reasoningMode: 'full' | 'light' | 'off',
): InlineKeyboard {
  const cur = thinkLabel(agentThink);
  return new InlineKeyboard()
    .text(mark(cur === 'off', 'off'), 'think:off')
    .text(mark(cur === 'low', 'low'), 'think:low')
    .text(mark(cur === 'med', 'med'), 'think:med')
    .text(mark(cur === 'high', 'high'), 'think:high')
    .row()
    .text(mark(reasoningMode === 'full',  '🧠 Full'),  'reason:full')
    .text(mark(reasoningMode === 'light', '💡 Light'), 'reason:light')
    .text(mark(reasoningMode === 'off',   '🙈 Off'),   'reason:off')
    .row()
    .text('← Retour', 'menu');
}

// ── Temp submenu ──────────────────────────────────────────────────────────────

export function buildTempMenu(opts: SessionOptions): InlineKeyboard {
  const cur = tempLabel(opts);
  return new InlineKeyboard()
    .text(mark(cur === 'défaut', 'défaut'), 'temp:off')
    .text(mark(cur === '0.1', '0.1'), 'temp:0.1')
    .text(mark(cur === '0.5', '0.5'), 'temp:0.5')
    .row()
    .text(mark(cur === '0.7', '0.7'), 'temp:0.7')
    .text(mark(cur === '1.0', '1.0'), 'temp:1.0')
    .text(mark(cur === '1.5', '1.5'), 'temp:1.5')
    .row()
    .text('← Retour', 'menu');
}

// ── Model submenu ─────────────────────────────────────────────────────────────

export function buildModelMenu(
  opts: SessionOptions,
  agentDefault: string,
  providers: ProviderConfig[],
  extraModels: Array<{ alias: string; modelId: string }> = [],
): InlineKeyboard {
  // L6 : repart d'un registre propre — seuls les modèles rendus ci-dessous resteront
  // résolvables, neutralisant les boutons inline périmés pointant un modèle supprimé.
  resetModelRegistry();

  const kb = new InlineKeyboard();

  const aliases: Array<{ alias: string; modelId: string }> = [];
  const seenModelIds = new Set<string>();

  const pushModel = (alias: string, modelId: string): void => {
    if (!modelId || seenModelIds.has(modelId)) return;
    aliases.push({ alias, modelId });
    seenModelIds.add(modelId);
  };

  for (const p of providers) {
    const hidden = new Set(p.hiddenModelIds ?? []);
    const display = p.modelDisplayNames ?? {};
    for (const m of p.models ?? []) {
      if (hidden.has(m.modelId)) continue;
      pushModel(display[m.modelId] || m.alias, m.modelId);
    }
  }

  // Fallbacks when providers aliases are sparse:
  // include known model IDs from agent/default/current session config.
  for (const m of extraModels) {
    pushModel(m.alias, m.modelId);
  }

  const fallbackIds = [opts.modelOverride, agentDefault];
  for (const id of fallbackIds) {
    if (!id) continue;
    const short = id.split('/').pop() ?? id;
    pushModel(short, id);
  }

  if (aliases.length > 0) {
    let col = 0;
    for (const m of aliases.slice(0, 16)) {
      const key = getOrRegisterModel(m.modelId);
      const isActive = opts.modelOverride === m.modelId;
      kb.text(mark(isActive, m.alias.slice(0, 18)), `mdl:s:${key}`);
      col++;
      if (col % 2 === 0) kb.row();
    }
    if (col % 2 !== 0) kb.row();
  } else {
    kb.text('💬 /model <modelId>', 'menu').row();
  }

  const isDefault = !opts.modelOverride;
  kb.text(mark(isDefault, 'Défaut'), 'mdl:off').text('← Retour', 'menu');
  return kb;
}

// ── Tools + Display submenu (merged) ─────────────────────────────────────────

export function buildToolsMenu(opts: SessionOptions): InlineKeyboard {
  const on = !opts.toolsDisabled;
  const visible = !opts.toolsHidden;
  return new InlineKeyboard()
    .text(mark(on, '✅ Activés'), 'tools:on')
    .text(mark(!on, '❌ Désactivés'), 'tools:off')
    .row()
    .text(mark(visible, '👁️ Visible'), 'toolsv:show')
    .text(mark(!visible, '🙈 Masqué'), 'toolsv:hide')
    .row()
    .text('← Retour', 'menu');
}

// ── Streaming submenu ─────────────────────────────────────────────────────────

export function buildStreamingMenu(opts: SessionOptions): InlineKeyboard {
  const on = !!opts.telegramStreaming;
  const draft = !!opts.telegramDraft;
  const finalNotif = !!opts.telegramFinalNotif;
  return new InlineKeyboard()
    .text(mark(on, '✅ Stream activé'), 'stream:on')
    .text(mark(!on, '❌ Stream désactivé'), 'stream:off')
    .row()
    .text(mark(draft, '✍️ Draft natif ON'), 'draft:on')
    .text(mark(!draft, '✍️ Draft natif OFF'), 'draft:off')
    .row()
    .text(mark(finalNotif, '🔔 Notif finale ON'), 'finalnotif:on')
    .text(mark(!finalNotif, '🔔 Notif finale OFF'), 'finalnotif:off')
    .row()
    .text('← Retour', 'menu');
}

// ── Mercury status submenu ────────────────────────────────────────────────────

export function buildMercuryStatusMenu(opts: SessionOptions): InlineKeyboard {
  const on = !!opts.telegramMercuryStatus;
  return new InlineKeyboard()
    .text(mark(on, '✅ Activé'), 'mercurystat:on')
    .text(mark(!on, '❌ Désactivé'), 'mercurystat:off')
    .row()
    .text('← Retour', 'menu');
}

export function getMercuryStatusLabel(opts: SessionOptions): string {
  return `⚡ Perf live — chargement & prompt processing avant chaque réponse`;
}

// ── Voice submenu ────────────────────────────────────────────────────────────

export function buildVoiceMenu(opts: SessionOptions): InlineKeyboard {
  const on = !!opts.telegramVoice;
  return new InlineKeyboard()
    .text(mark(on, '✅ Activé'), 'voice:on')
    .text(mark(!on, '❌ Désactivé'), 'voice:off')
    .row()
    .text('← Retour', 'menu');
}
