/**
 * Agent → Telegram streaming orchestrator.
 *
 * Single entry point used by the text / photo / voice handlers in bridge.ts.
 * Responsible for:
 *   - Driving `agentMod.run()` with the right callbacks
 *   - Routing chunks through the <think>/answer FSM (streaming mode)
 *   - Updating the Telegram preview message via `createDraftStream` (streaming)
 *   - Showing the Mercury status message ("⚙️ Traitement…") until the first chunk
 *   - Maintaining a `typing`/`upload_voice` action loop
 *   - Splitting the final answer across multiple messages when > 4096 chars
 *   - Emitting the optional <tg-spoiler> reasoning preview (batch mode only)
 *   - Sending an optional TTS audio reply via NCM
 *
 * What this module *does not* do:
 *   - Telegram routing (chat→agent mapping) — caller's job
 *   - Photo download / voice transcription — caller does the I/O and passes
 *     the resulting userText (+ optional images)
 *   - Session-option parsing — caller computes the policy and hands the
 *     resolved booleans (streaming, showToolEvents, …)
 */

import { InputFile, type Context } from 'grammy';
import type { AgentModule } from '../../agent/index.js';
import type { ProviderStats, MessageImage } from '@mastermind/shared';
import type { NcmClient } from '../../ncm/client.js';
import { mdToTelegramHtml } from '../format.js';
import { createDraftStream } from './draftStream.js';
import { createNativeDraftStream } from './nativeDraftStream.js';
import {
  createThinkAnswerFSM,
  splitThinkAndAnswer,
  stripToolCallBlocks,
} from './thinkAnswerFSM.js';
import {
  buildMessageWithToolFooter,
  makeToolAccumulator,
  type ToolEvent,
} from './rendering.js';
import { setupMercuryStatusMsg } from './statusMessage.js';
import type { VoiceProgressController } from './voiceProgressMessage.js';
import { splitMessage, TELEGRAM_HARD_LIMIT, TELEGRAM_SAFE_LIMIT } from './chunking.js';
import { withTelegramRetry } from './networkErrors.js';

const TYPING_INTERVAL_MS = 4000;
const ANSWER_PREVIEW_CAP = 3600;
const REASONING_PREVIEW_CAP = 800;
const LIVE_THINK_TAIL_CHARS = 800;
// When showing think tail + answer side by side (re-thinking after partial
// answer), the combined render must fit Telegram's 4096-char message cap.
// Caps are applied to RAW text before mdToTelegramHtml; HTML escaping can
// expand `<`/`>`/`&` (1→4 or 1→5 chars), so a worst-case input full of `<`
// in raw form could theoretically blow past 4096 even with these caps. In
// practice typical LLM output has <5% HTML overhead; the hard rendered
// ceiling below catches the pathological case via splitMessage's
// tag-boundary-aware truncation.
const COMBINED_ANSWER_CAP = 2000;
// Hard rendered ceiling for the live preview, applied AFTER mdToTelegramHtml
// + footer concat. Leaves headroom under Telegram's 4096 limit for the
// streaming cursor (▋ + space, 2 chars) appended by the transport layer.
const PREVIEW_HARD_CEILING = 4000;
const INTER_CHUNK_DELAY_MS = 1100;

export type AgentTelegramRunOptions = {
  ctx: Context;
  chatId: number;
  agentId: string;
  sessionId: string;
  agentMod: AgentModule;
  /** Prompt sent to the agent (raw user text / image caption / voice transcript) */
  userText: string;
  /** Optional vision images forwarded to the run */
  images?: MessageImage[];
  /** Whether tool events should appear in the streaming/footer (`!toolsHidden`) */
  showToolEvents: boolean;
  /**
   * Reasoning display mode (single source of truth for both streaming live preview
   * and post-batch spoiler):
   * - 'full'  → stream the live <think> content (text streaming) / show <tg-spoiler> (batch)
   * - 'light' → show only "💭 Réflexion en cours… (Xs)" with a live timer (streaming only)
   * - 'off'   → no reasoning surfaced at all
   */
  reasoningMode: 'full' | 'light' | 'off';
  /** Whether to display the "⚙️ Traitement…" Mercury status message */
  showMercuryStatus: boolean;
  /** True = stream the reply with progressive edits; false = single batch send */
  streaming: boolean;
  /**
   * Use Telegram's native `sendMessageDraft` (Bot API 9.5+) for streaming
   * instead of the classic `sendMessage` + `editMessageText` loop. Provides a
   * smooth client-side animation; only effective when `streaming=true` and
   * the Bot API server supports the method (capability auto-detected with a
   * silent fallback to edit mode on the first call). DM/private chats only.
   */
  useTelegramDraft: boolean;
  /**
   * When true and the stream actually rendered something to the user (i.e. a
   * live message_id exists), at finalize we **delete** the streaming bubble
   * and **send** the final answer as a fresh `sendMessage`. The fresh send
   * triggers a Telegram push notification — which `editMessageText` never
   * does. Useful for the `light` / `full` reasoning modes where the first
   * send carries a reasoning placeholder (not the actual answer), so the
   * native streaming flow notifies on a useless frame and leaves the actual
   * answer silent. Edit-mode streaming only — no-op for `nativeDraftStream`
   * (which already uses `sendMessage` at finalize by construction) and for
   * `voiceOnlyOutput`/batch.
   */
  useFinalNotif: boolean;
  /**
   * voice-out mode: the reply is delivered as a TTS audio message (NCM) and
   * NO text reply is sent. Implies `streaming=false`. Requires `ncmClient`.
   */
  voiceOnlyOutput: boolean;
  /** NCM client for TTS. Required when `voiceOnlyOutput` or `alsoSendTtsReply`. */
  ncmClient: NcmClient | null;
  /**
   * When true and not in voice-only mode, also synthesize a TTS audio reply
   * after the text reply (used by `telegramVoice=on` for non-audio inputs).
   */
  alsoSendTtsReply: boolean;
  /** Typing indicator action — defaults to 'typing'. */
  typingAction?: 'typing' | 'upload_voice';
  /**
   * Optional voice-mode progress message controller. When provided, supersedes
   * the default Mercury status bubble (which would otherwise produce a second
   * message) and surfaces a unified "🤔 → ⚙️ → 🔧 → 🔊" lifecycle in a single
   * edited message. Created upstream by `bridge.ts` after the transcript reply
   * so it visually anchors below the 🎤 transcript. Currently consumed only by
   * `deliverVoiceOnlyReply`; safe to pass (and ignored) in other modes.
   */
  voiceProgress?: VoiceProgressController;
};

export async function runAgentToTelegram(opts: AgentTelegramRunOptions): Promise<void> {
  const {
    ctx, chatId, agentId, sessionId, agentMod, userText, images,
    showToolEvents, reasoningMode, showMercuryStatus,
    streaming, voiceOnlyOutput, ncmClient, alsoSendTtsReply,
  } = opts;
  const typingAction = opts.typingAction ?? 'typing';

  // ── Typing indicator loop (4s heartbeat) ──────────────────────────────────
  let typingActive = true;
  const stopTyping = () => { typingActive = false; };
  const typingLoop = async () => {
    while (typingActive) {
      await ctx.replyWithChatAction(typingAction).catch(() => {});
      await new Promise(r => setTimeout(r, TYPING_INTERVAL_MS));
    }
  };
  typingLoop();

  // ── Mercury status (optional separate "⚙️ Traitement…" message) ──────────
  // When `voiceProgress` is provided (voice-only mode with progress bubble),
  // it consumes Mercury stats itself and surfaces them inside its own message
  // — so we skip the standalone Mercury bubble to avoid showing two messages.
  let cleanupStatus: (() => Promise<void>) | null = null;
  let onMercuryStats: ((s: Partial<ProviderStats>) => void) | undefined;
  if (opts.voiceProgress) {
    onMercuryStats = opts.voiceProgress.onMercuryStats;
  } else if (showMercuryStatus) {
    const setup = await setupMercuryStatusMsg(ctx, chatId);
    onMercuryStats = setup.onMercuryStats;
    cleanupStatus = setup.cleanupStatus;
  }
  const dropStatus = async () => {
    if (cleanupStatus) {
      const fn = cleanupStatus;
      cleanupStatus = null;
      await fn().catch(() => {});
    }
  };

  // ── Tool accumulator (count + unique names for the footer) ────────────────
  const tools = makeToolAccumulator(showToolEvents);

  try {
    if (voiceOnlyOutput) {
      await deliverVoiceOnlyReply({
        opts, agentMod, userText, images, tools, onMercuryStats, dropStatus, stopTyping,
        voiceProgress: opts.voiceProgress,
      });
      return;
    }

    if (streaming) {
      await deliverStreamingReply({
        opts, tools, onMercuryStats, dropStatus, stopTyping, reasoningMode,
        useTelegramDraft: opts.useTelegramDraft,
        useFinalNotif: opts.useFinalNotif,
      });
    } else {
      await deliverBatchReply({
        opts, tools, onMercuryStats, dropStatus, stopTyping, reasoningMode,
      });
    }

    // Optional TTS reply alongside the text reply (telegramVoice=on for
    // non-voice-only flows). Best-effort — failures are logged and ignored.
    if (alsoSendTtsReply) {
      // Deliberately re-derive the reply text from raw stream output so the
      // TTS uses exactly the same answer as the rendered text.
      // (Already handled inside deliver*Reply via lastDeliveredAnswer below.)
    }
  } catch (err) {
    stopTyping();
    await dropStatus();
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[telegram:stream] Error for agent ${agentId} session ${sessionId}:`, msg);
    await ctx.reply(`Error: ${msg}`).catch(() => {});
  } finally {
    stopTyping();
    await dropStatus();
    // Voice-progress bubble (when present) must also be cleaned up in *every*
    // exit path — including agent.run() throwing before deliverVoiceOnlyReply
    // had a chance to cleanup itself. cleanup() is idempotent so calling it
    // here on top of the normal in-flow cleanup is safe.
    await opts.voiceProgress?.cleanup().catch(() => {});
  }

  // Note: TTS-alongside-text is handled INSIDE deliverStreamingReply /
  // deliverBatchReply, because they own the answer string. That way we keep
  // a single source of truth for the spoken text.
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

type SharedDeliveryCtx = {
  opts: AgentTelegramRunOptions;
  tools: ReturnType<typeof makeToolAccumulator>;
  onMercuryStats: ((s: Partial<ProviderStats>) => void) | undefined;
  dropStatus: () => Promise<void>;
  stopTyping: () => void;
};

/** Send extra chunks (chunk index ≥ 1) as separate messages, with rate-limit pacing. */
async function sendOverflowChunks(
  ctx: Context,
  chunks: string[],
  startIdx: number,
): Promise<void> {
  for (let i = startIdx; i < chunks.length; i++) {
    if (i > startIdx) await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
    await withTelegramRetry(() =>
      ctx.reply(chunks[i], { parse_mode: 'HTML' }).catch(() => ctx.reply(chunks[i])),
    ).catch(() => {});
  }
}

/** Synthesize and send a TTS audio reply via NCM. Best-effort. */
async function maybeSendTtsReply(
  ctx: Context,
  agentId: string,
  sessionId: string,
  ncmClient: NcmClient | null,
  text: string,
): Promise<boolean> {
  if (!ncmClient || !text.trim()) return false;
  try {
    await ctx.replyWithChatAction('upload_voice').catch(() => {});
    const audioBuffer = await ncmClient.synthesize(text, agentId, sessionId);
    if (audioBuffer.length > 0) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, 'response.ogg'));
      return true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[telegram:stream] TTS failed for agent ${agentId}: ${msg}`);
  }
  return false;
}

// ── Streaming delivery ─────────────────────────────────────────────────────

async function deliverStreamingReply(args: SharedDeliveryCtx & {
  reasoningMode: 'full' | 'light' | 'off';
  useTelegramDraft: boolean;
  useFinalNotif: boolean;
}): Promise<void> {
  const { opts, tools, onMercuryStats, dropStatus, stopTyping, reasoningMode,
    useTelegramDraft, useFinalNotif } = args;
  const { ctx, chatId, agentId, sessionId, agentMod, userText, images, ncmClient,
    alsoSendTtsReply } = opts;

  const fsm = createThinkAnswerFSM();
  // Native draft requires a private chat (chat_id > 0). Group/supergroup ids
  // are negative; for those we silently fall back to the edit-message path.
  const canUseNativeDraft = useTelegramDraft && chatId > 0;
  // Light mode renders a tiny placeholder ("💭 Réflexion en cours… (Xs)" ≈ 39 bytes)
  // while in <think>. The default minInitialChars=50 would block the first send,
  // leaving the user staring at nothing (status was already dropped on first chunk).
  // The "expanded card" symptom that motivates the threshold doesn't apply here —
  // the placeholder is short by design and grows only by 1-3 bytes per tick.
  const draftOpts: { ctx: Context; chatId: number; minInitialChars?: number } =
    reasoningMode === 'light' ? { ctx, chatId, minInitialChars: 0 } : { ctx, chatId };
  const draft = canUseNativeDraft
    ? createNativeDraftStream(draftOpts)
    : createDraftStream(draftOpts);
  draft.start();

  /** Sandbox transition: if onHideStreaming fires, the post-run finalize is
   * skipped — the deliverable arrives via send_to_user as a separate message. */
  let streamingHiddenEarly = false;

  const renderPreview = (): string => {
    // Interleaved think/answer support: many reasoning models emit several
    // <think> blocks separated by partial answer fragments. If we switched the
    // bubble back to a pure-think view on every re-think, the partial answer
    // would visibly disappear from Telegram each time the model re-thinks
    // ("swallowed by the second thinking" symptom). Once any answer text has
    // been emitted, keep it pinned at the bottom and stream the think state
    // above it instead of replacing it.
    const cleanAnswer = stripToolCallBlocks(fsm.getAnswer());
    const hasAnswer = cleanAnswer.trim().length > 0;
    const inThink = fsm.isInThink();

    let displayText: string;
    if (inThink && reasoningMode === 'full' && fsm.getCurrentThink().trim()) {
      // Full mode — stream the live <think> tail (last N chars) at the top.
      // If an answer is already in flight, append it below the tail so it
      // stays visible while the model is re-thinking.
      const thinkTail = `💭 ${mdToTelegramHtml(
        fsm.getCurrentThink().slice(-LIVE_THINK_TAIL_CHARS).trimStart()
      )}`;
      displayText = hasAnswer
        ? `${thinkTail}\n\n${mdToTelegramHtml(cleanAnswer.slice(0, COMBINED_ANSWER_CAP))}`
        : thinkTail;
    } else if (inThink && reasoningMode === 'light') {
      // Light mode — compact placeholder + live timer at the top. Answer (if
      // any so far) is drafted below so partial replies survive re-thinks.
      const startedAt = fsm.getCurrentThinkStartedAt();
      const elapsed = startedAt !== null
        ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        : 0;
      const thinkChip = `💭 <i>Réflexion en cours…</i> (${elapsed}s)`;
      displayText = hasAnswer
        ? `${thinkChip}\n\n${mdToTelegramHtml(cleanAnswer.slice(0, COMBINED_ANSWER_CAP))}`
        : thinkChip;
    } else {
      // Off mode, or past <think> with no current open block — answer only.
      displayText = mdToTelegramHtml(cleanAnswer.slice(0, ANSWER_PREVIEW_CAP));
    }
    // No thinkMs in the live preview — would flicker every tick. Only at finalize.
    const rendered = buildMessageWithToolFooter(displayText, tools.getCount(), tools.getNames());
    // Hard-cap the final rendered string. mdToTelegramHtml can expand chars
    // (`<` → `&lt;`, `&` → `&amp;`, etc.) past the raw input caps; on top the
    // cursor "▋ " (2 chars) is appended downstream. splitMessage gives a
    // tag/entity-aware truncation so we never produce a frame that Telegram
    // rejects with "can't parse entities" on a mid-tag cut.
    if (rendered.length <= PREVIEW_HARD_CEILING) return rendered;
    return splitMessage(rendered, PREVIEW_HARD_CEILING)[0] ?? rendered.slice(0, PREVIEW_HARD_CEILING);
  };

  // Light-mode heartbeat: re-render every second while inside <think>, so the
  // "(Xs)" timer keeps ticking even when the model goes silent between chunks
  // (silent stretches happen during long reasoning steps or TTFT). Cheap — just
  // recomputes the placeholder string and hands it to the throttled draft; the
  // draft itself enforces the editIntervalMs cadence on Telegram side.
  const lightHeartbeat = reasoningMode === 'light'
    ? setInterval(() => {
        if (fsm.isInThink()) draft.update(renderPreview());
      }, 1000)
    : null;

  let rawResponse: string;
  try {
    rawResponse = await agentMod.run(agentId, sessionId, userText, 'telegram', {
      images,
      onChunk: (chunk: string) => {
        // First chunk arrived → drop the Mercury status message immediately.
        dropStatus().catch(() => {});
        fsm.pushChunk(chunk);
        draft.update(renderPreview());
      },
      onToolCall: tools.handler,
      onMercuryStats,
      onCompact: (msg: string) => {
        ctx.reply(mdToTelegramHtml(msg), { parse_mode: 'HTML' }).catch(() => ctx.reply(msg));
      },
      onHideStreaming: async () => {
        streamingHiddenEarly = true;
        stopTyping();
        await dropStatus();
        if (canUseNativeDraft) {
          // Native-draft mode: just stop the timer — do NOT call finalize().
          // The ephemeral draft expires on Telegram's side (~30 s) and
          // send_to_user will deliver its own message cleanly. Materializing
          // the interim via a final sendMessage here would publish a stray
          // duplicate next to send_to_user's actual deliverable.
          draft.cancel();
        } else {
          // Edit-mode: finalize edits the existing live bubble in place
          // (drops the cursor, keeps accumulated content). send_to_user then
          // appends its deliverable as a separate message below — no
          // duplication because the interim is the *same* bubble being
          // updated, not a new message.
          const finalPreview = buildMessageWithToolFooter(
            mdToTelegramHtml(stripToolCallBlocks(fsm.getAnswer()).slice(0, ANSWER_PREVIEW_CAP)),
            tools.getCount(),
            tools.getNames(),
            fsm.getThinkTotalMs(),
          );
          await draft.finalize(finalPreview);
        }
      },
    });
  } finally {
    if (lightHeartbeat) clearInterval(lightHeartbeat);
    draft.cancel();
    stopTyping();
    await dropStatus();
  }

  // Sandbox transition already finalized — the deliverable will come via send_to_user.
  if (streamingHiddenEarly) return;

  const { reasoning, answer } = splitThinkAndAnswer(rawResponse);
  // Think-only response (reasoning present, no answer text after </think>): the
  // raw <think> block must NOT leak as the answer (text + footer) — that would
  // bypass reasoningMode and dump escaped tags. Only fall back to rawResponse
  // when there was NO think block at all (truly-empty / non-reasoning run); the
  // empty case is then caught by the `<i>(no response)</i>` guard below.
  const toSend = answer || (reasoning ? '' : rawResponse);
  const finalContent = buildMessageWithToolFooter(
    mdToTelegramHtml(toSend),
    tools.getCount(),
    tools.getNames(),
    // Suppress the 💭 think-time chip when there's no answer to annotate —
    // otherwise a think-only response would render a lone `💭 Xs` footer
    // instead of falling through to the `<i>(no response)</i>` guard.
    toSend.trim() ? fsm.getThinkTotalMs() : 0,
  );
  const safeFinalContent = finalContent || '<i>(no response)</i>';
  const chunks = splitMessage(safeFinalContent, TELEGRAM_SAFE_LIMIT);

  // Two finalize strategies:
  //  - Default: edit the streaming bubble in place with chunk[0], then send any
  //    overflow as new messages. The edit doesn't trigger a push notification —
  //    the user only gets one on the *initial* sendMessage (which carried a
  //    reasoning placeholder in light/full mode). Fine for users watching live.
  //  - useFinalNotif: delete the streaming bubble and send chunk[0] as a fresh
  //    sendMessage so the offline/locked user gets a push notification on the
  //    actual answer instead of the reasoning placeholder. The live reasoning
  //    preview was transient — dropping it is consistent with its role.
  //    Only applies when:
  //      * a live message actually exists (otherwise there's nothing to delete
  //        and the default fresh-send path already triggers a notif),
  //      * the transport is edit-mode (nativeDraft already sends at finalize),
  //      * the user opted in via the toggle.
  const firstChunk = chunks[0] ?? '<i>(no response)</i>';
  // Type-narrow via structural check — nativeDraftStream exposes hasDraft, not
  // hasMessage. Once we're inside the branch TS knows `draft` is DraftStream.
  const wantFreshFinal = useFinalNotif && 'hasMessage' in draft && draft.hasMessage();

  if (wantFreshFinal && 'messageId' in draft) {
    const prevId = draft.messageId();
    // Drain (stops timer + waits for any in-flight send/edit ≤5 s) BEFORE
    // calling deleteMessage. cancel() alone only stops the timer — an edit
    // started just before would still resolve AFTER deleteMessage and
    // resurrect the bubble above the final answer. drain() is the same
    // primitive finalize() uses for this purpose. If the delete itself fails
    // (already gone, race with Telegram-side cleanup, rare 400) we tolerate
    // it — worst case is a stray reasoning frame above the final answer.
    await draft.drain();
    if (prevId !== null) {
      await ctx.api.deleteMessage(chatId, prevId).catch(() => {});
    }
    // Send chunk[0] as a brand-new message → push notification fires.
    let freshMsgId: number | null = null;
    try {
      const sent = await ctx.api.sendMessage(chatId, firstChunk, { parse_mode: 'HTML' });
      freshMsgId = sent.message_id;
    } catch {
      // HTML parse failure on the final commit — extremely rare given the FSM
      // closes tags, but the same safety net the rest of the pipeline uses.
      const sent = await ctx.reply(firstChunk).catch(() => null);
      freshMsgId = sent?.message_id ?? null;
    }
    if (freshMsgId !== null && chunks.length > 1) {
      await sendOverflowChunks(ctx, chunks, 1);
    } else if (freshMsgId === null) {
      // Both attempts failed → fall back to overflow sender for chunk[0] too.
      await sendOverflowChunks(ctx, chunks, 0);
    }
  } else {
    // Default in-place edit at finalize.
    const liveMsgId = await draft.finalize(firstChunk);
    if (liveMsgId === null) {
      // No live message ever sent (e.g. minInitialChars never reached, or send
      // failed). Send everything as fresh messages now.
      await sendOverflowChunks(ctx, chunks, 0);
    } else if (chunks.length > 1) {
      await sendOverflowChunks(ctx, chunks, 1);
    }
  }

  if (alsoSendTtsReply) {
    await maybeSendTtsReply(ctx, agentId, sessionId, ncmClient, toSend);
  }
}

// ── Batch delivery ─────────────────────────────────────────────────────────

async function deliverBatchReply(args: SharedDeliveryCtx & {
  reasoningMode: 'full' | 'light' | 'off';
}): Promise<void> {
  const { opts, tools, onMercuryStats, dropStatus, stopTyping, reasoningMode } = args;
  const { ctx, chatId, agentId, sessionId, agentMod, userText, images, ncmClient,
    alsoSendTtsReply } = opts;

  let batchHiddenEarly = false;
  const rawResponse = await agentMod.run(agentId, sessionId, userText, 'telegram', {
    images,
    onToolCall: tools.handler,
    onMercuryStats,
    onCompact: (msg: string) => {
      ctx.reply(mdToTelegramHtml(msg), { parse_mode: 'HTML' }).catch(() => ctx.reply(msg));
    },
    onHideStreaming: async () => {
      batchHiddenEarly = true;
      stopTyping();
      await dropStatus();
    },
  });

  stopTyping();
  await dropStatus();
  if (batchHiddenEarly) return;

  const { reasoning, answer } = splitThinkAndAnswer(rawResponse);
  // Batch has nothing to animate, so 'light' degrades to 'off' (no spoiler).
  // Only 'full' attaches the reasoning spoiler.
  if (reasoning && reasoningMode === 'full') {
    const reasoningPreview = reasoning.length > REASONING_PREVIEW_CAP
      ? reasoning.slice(0, REASONING_PREVIEW_CAP) + '…'
      : reasoning;
    const spoiler = `<tg-spoiler>💭 Raisonnement:\n${mdToTelegramHtml(reasoningPreview)}</tg-spoiler>`;
    await ctx.reply(spoiler, { parse_mode: 'HTML' }).catch(() => {});
  }

  // Think-only response (reasoning but no answer): don't leak the raw <think>
  // block as the answer — fall back to rawResponse only when there was NO think
  // block at all. The empty case is caught by the `(no response)` guard below.
  const toSend = answer || (reasoning ? '' : rawResponse);
  let batchContent = buildMessageWithToolFooter(
    mdToTelegramHtml(toSend),
    tools.getCount(),
    tools.getNames(),
  );
  if (!batchContent.trim()) batchContent = '<i>(no response)</i>';

  if (batchContent.length <= TELEGRAM_HARD_LIMIT) {
    await withTelegramRetry(() =>
      ctx.reply(batchContent, { parse_mode: 'HTML' }).catch(() => ctx.reply(toSend)),
    );
  } else {
    const chunks = splitMessage(batchContent, TELEGRAM_SAFE_LIMIT);
    await sendOverflowChunks(ctx, chunks, 0);
  }

  if (alsoSendTtsReply) {
    await maybeSendTtsReply(ctx, agentId, sessionId, ncmClient, toSend);
  }
}

// ── Voice-only delivery ────────────────────────────────────────────────────
// Batch run, output as TTS audio only — no text, no reasoning surfaced.

async function deliverVoiceOnlyReply(args: {
  opts: AgentTelegramRunOptions;
  agentMod: AgentModule;
  userText: string;
  images: MessageImage[] | undefined;
  tools: ReturnType<typeof makeToolAccumulator>;
  onMercuryStats: ((s: Partial<ProviderStats>) => void) | undefined;
  dropStatus: () => Promise<void>;
  stopTyping: () => void;
  voiceProgress: VoiceProgressController | undefined;
}): Promise<void> {
  const { opts, agentMod, userText, images, tools, onMercuryStats, dropStatus, stopTyping, voiceProgress } = args;
  const { ctx, agentId, sessionId, ncmClient } = opts;

  if (!ncmClient) {
    await voiceProgress?.cleanup();
    await ctx.reply('⚠️ NCM non configuré — impossible de répondre en vocal.').catch(() => {});
    return;
  }

  // Compose onToolCall: existing tool accumulator (which may be undefined when
  // showToolEvents=false) MUST still fire when present; voiceProgress also
  // gets the events to bubble "🔧 Outil : <name>" in its progress message.
  const onToolCall: ((event: ToolEvent) => void) | undefined = voiceProgress
    ? (event: ToolEvent) => {
        tools.handler?.(event);
        voiceProgress.onToolCall(event);
      }
    : tools.handler;

  let voiceHiddenEarly = false;
  const rawResponse = await agentMod.run(agentId, sessionId, userText, 'telegram', {
    images,
    onToolCall,
    onMercuryStats,
    onCompact: (msg: string) => {
      ctx.reply(mdToTelegramHtml(msg), { parse_mode: 'HTML' }).catch(() => ctx.reply(msg));
    },
    onHideStreaming: async () => {
      voiceHiddenEarly = true;
      stopTyping();
      await dropStatus();
      await voiceProgress?.cleanup();
    },
  });

  stopTyping();
  await dropStatus();
  if (voiceHiddenEarly) return;

  const { reasoning, answer } = splitThinkAndAnswer(rawResponse);
  // Think-only response (reasoning but no answer): never feed the raw <think>
  // block to TTS — it would literally speak the reasoning and the tags. Fall
  // back to rawResponse only when there was NO think block at all.
  const toSend = answer || (reasoning ? '' : rawResponse);

  // Nothing user-facing to speak (think-only / empty run): skip TTS entirely and
  // surface a clean text fallback instead of synthesizing an empty utterance.
  if (!toSend.trim()) {
    await voiceProgress?.cleanup();
    await ctx.reply('<i>(no response)</i>', { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  // Send ONLY the audio reply — no text, no reasoning.
  try {
    await ctx.replyWithChatAction('upload_voice').catch(() => {});
    // Transition progress to "🔊 Synthèse vocale en cours…" so the user sees
    // the TTS phase is in progress (can take 60–120s on long answers).
    voiceProgress?.setSynthesizing();
    const ttsBuffer = await ncmClient.synthesize(toSend, agentId, sessionId);
    if (ttsBuffer.length > 0) {
      // Delete the progress bubble BEFORE sending the audio so the voice
      // message visually replaces it ("swallow when the audio is here").
      await voiceProgress?.cleanup();
      await ctx.replyWithVoice(new InputFile(ttsBuffer, 'response.ogg'));
    } else {
      // Empty TTS → fall back to text so the user gets *some* reply.
      await voiceProgress?.cleanup();
      await ctx.reply(mdToTelegramHtml(toSend), { parse_mode: 'HTML' })
        .catch(() => ctx.reply(toSend));
    }
  } catch (ttsErr) {
    const ttsMsg = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
    console.error(`[telegram:stream] TTS failed, falling back to text: ${ttsMsg}`);
    await voiceProgress?.cleanup();
    await ctx.reply(mdToTelegramHtml(toSend), { parse_mode: 'HTML' })
      .catch(() => ctx.reply(toSend));
  }
}
