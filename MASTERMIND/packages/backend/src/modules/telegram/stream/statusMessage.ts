/**
 * Mercury status message helper.
 *
 * Shows "⚙️ Traitement en cours…" in a separate message, edited with progress
 * (loading model / prompt processing %) until the first generated token arrives.
 * Then deleted by the caller (typically on the first onChunk).
 *
 * This is the "⚙️ status message" UX that lives separately from the streaming
 * answer message — kept verbatim from the original bridge.ts.
 */

import type { Context } from 'grammy';
import type { ProviderStats } from '@mastermind/shared';

const STATUS_EDIT_INTERVAL_MS = 900;

export type MercuryStatusController = {
  /** Hand to agentMod.run() as `onMercuryStats`. */
  onMercuryStats: (stats: Partial<ProviderStats>) => void;
  /** Delete the status message. Idempotent — safe to call multiple times. */
  cleanupStatus: () => Promise<void>;
};

export async function setupMercuryStatusMsg(
  ctx: Context,
  chatId: number,
): Promise<MercuryStatusController> {
  let statusMsgId: number | null = null;
  let lastStatusEdit = 0;

  const sent = await ctx.reply('⚙️ Traitement en cours…').catch(() => null);
  statusMsgId = sent?.message_id ?? null;

  const onMercuryStats = (stats: Partial<ProviderStats>): void => {
    if (statusMsgId === null) return;
    const now = Date.now();
    if (now - lastStatusEdit < STATUS_EDIT_INTERVAL_MS) return;
    lastStatusEdit = now;

    let statusText: string;
    if (stats.isLoading) {
      statusText = '⏳ Chargement du modèle…';
    } else if (stats.isPromptProcessing) {
      if (stats.promptProcessingProgress != null) {
        statusText = `⚙️ Traitement du prompt… ${stats.promptProcessingProgress}%`;
      } else {
        statusText = '⚙️ Traitement du prompt…';
      }
    } else {
      return;
    }

    ctx.api.editMessageText(chatId, statusMsgId, statusText).catch(() => {});
  };

  const cleanupStatus = async (): Promise<void> => {
    if (statusMsgId !== null) {
      const id = statusMsgId;
      statusMsgId = null;
      await ctx.api.deleteMessage(chatId, id).catch(() => {});
    }
  };

  return { onMercuryStats, cleanupStatus };
}
