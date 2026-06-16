/**
 * Voice-mode progress message helper.
 *
 * Lifecycle dedicated to the Telegram voice-only path (`telegramVoice=on`):
 *   sent AFTER the transcript message → bubbles step-by-step under it
 *   → "🤔 Réflexion en cours…" (default)
 *   → "⏳ Chargement du modèle…" / "⚙️ Traitement du prompt… X%" (Mercury phases)
 *   → "🔧 Outil : <name>" (during tool execution)
 *   → "🔊 Synthèse vocale en cours…" (after agent.run, before TTS)
 *   → deleted by the caller right before `ctx.replyWithVoice()` so the audio
 *     bubble takes its place ("swallow when audio is here").
 *
 * Why distinct from `setupMercuryStatusMsg`:
 *   - Voice-only mode runs in BATCH (no draftStream); user has no other visible
 *     progress signal during the 5–120s window between transcript and audio.
 *   - This controller composes Mercury stats + tool events + TTS phase into a
 *     single in-place edited message, instead of letting the Mercury bubble
 *     disappear silently when the first chunk arrives (chunks never reach the
 *     UI in voice-only mode).
 *
 * Throttled at 900ms (same as MercuryStatus) to stay under Telegram's
 * ~1 edit/sec/chat rate-limit. State transitions to `synthesizing` and
 * `cleanup` bypass throttling because they are terminal/user-visible.
 */

import type { Context } from 'grammy';
import type { ProviderStats } from '@mastermind/shared';
import type { ToolEvent } from './rendering.js';

const VOICE_PROGRESS_EDIT_INTERVAL_MS = 900;

export type VoiceProgressController = {
  /** Wire as `onMercuryStats` on `agentMod.run()`. */
  onMercuryStats: (stats: Partial<ProviderStats>) => void;
  /**
   * Wire as `onToolCall` on `agentMod.run()`. Safe to compose with the
   * existing tool accumulator handler — call both in sequence.
   */
  onToolCall: (event: ToolEvent) => void;
  /**
   * Transition to "🔊 Synthèse vocale en cours…". Call right before
   * `ncmClient.synthesize()` to signal the long TTS phase.
   */
  setSynthesizing: () => void;
  /** Delete the progress message. Idempotent — safe to call multiple times. */
  cleanup: () => Promise<void>;
};

export async function setupVoiceProgressMsg(
  ctx: Context,
  chatId: number,
): Promise<VoiceProgressController> {
  let messageId: number | null = null;
  let lastEditAt = 0;
  let lastRenderedText = '';
  let cleaned = false;

  // State that drives `render()` — updated by callbacks, read on each edit tick.
  const activeTools: string[] = [];
  let mercuryPhase: 'loading' | 'processing' | null = null;
  let processingPct: number | null = null;
  let synthesizing = false;

  const sent = await ctx.reply('🤔 Réflexion en cours…').catch(() => null);
  messageId = sent?.message_id ?? null;
  lastRenderedText = '🤔 Réflexion en cours…';
  lastEditAt = Date.now();
  console.log(`[telegram:voice-progress] sent chatId=${chatId} msgId=${messageId ?? 'null'}`);

  const render = (): string => {
    if (synthesizing) return '🔊 Synthèse vocale en cours…';
    if (activeTools.length > 0) {
      const last = activeTools[activeTools.length - 1];
      return activeTools.length === 1
        ? `🔧 Outil : ${last}`
        : `🔧 Outils : ${last} (+${activeTools.length - 1})`;
    }
    if (mercuryPhase === 'loading') return '⏳ Chargement du modèle…';
    if (mercuryPhase === 'processing') {
      return processingPct != null
        ? `⚙️ Traitement du prompt… ${processingPct}%`
        : '⚙️ Traitement du prompt…';
    }
    return '🤔 Réflexion en cours…';
  };

  const tryEdit = (force = false): void => {
    if (cleaned || messageId === null) return;
    const now = Date.now();
    if (!force && now - lastEditAt < VOICE_PROGRESS_EDIT_INTERVAL_MS) return;

    const text = render();
    if (text === lastRenderedText) return; // no-op: avoid spurious 400 from TG

    lastEditAt = now;
    lastRenderedText = text;
    const id = messageId;
    ctx.api.editMessageText(chatId, id, text).catch((err) => {
      // 400 "message is not modified" can happen on rapid identical edits — ignore.
      // 429 rate-limit is rare given our 900ms throttle but possible if other
      // edits happen on the same chat; silently swallow (next event will retry).
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not modified')) {
        console.log(`[telegram:voice-progress] edit failed msgId=${id}: ${msg}`);
      }
    });
  };

  const onMercuryStats = (stats: Partial<ProviderStats>): void => {
    if (stats.isLoading) {
      mercuryPhase = 'loading';
      processingPct = null;
    } else if (stats.isPromptProcessing) {
      mercuryPhase = 'processing';
      if (stats.promptProcessingProgress != null) {
        processingPct = stats.promptProcessingProgress;
      }
    } else {
      // Generation phase — clear Mercury state so we fall back to "Réflexion"
      // (unless a tool is currently running, which takes precedence).
      mercuryPhase = null;
      processingPct = null;
    }
    tryEdit();
  };

  const onToolCall = (event: ToolEvent): void => {
    if (event.type === 'start') {
      activeTools.push(event.name);
    } else if (event.type === 'done') {
      const idx = activeTools.lastIndexOf(event.name);
      if (idx >= 0) activeTools.splice(idx, 1);
    }
    tryEdit();
  };

  const setSynthesizing = (): void => {
    synthesizing = true;
    tryEdit(true); // force: terminal state, bypass throttle
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned || messageId === null) {
      cleaned = true;
      return;
    }
    cleaned = true;
    const id = messageId;
    messageId = null;
    await ctx.api.deleteMessage(chatId, id).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[telegram:voice-progress] delete failed msgId=${id}: ${msg}`);
    });
  };

  return { onMercuryStats, onToolCall, setSynthesizing, cleanup };
}
