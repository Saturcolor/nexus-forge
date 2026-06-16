/**
 * Telegram streaming module — public API.
 *
 * Single entry point for the bridge handlers (text / photo / voice).
 * See `agentStream.ts` for the orchestration logic and `draftStream.ts` for
 * the underlying send→edit primitive (inspired by OpenClaw).
 */

export {
  runAgentToTelegram,
  type AgentTelegramRunOptions,
} from './agentStream.js';

// Lower-level primitives, exported for advanced callers / tests.
export { createDraftStream, type DraftStream, type DraftStreamOptions } from './draftStream.js';
export { createNativeDraftStream, type NativeDraftStream, type NativeDraftStreamOptions } from './nativeDraftStream.js';
export { createThinkAnswerFSM, splitThinkAndAnswer, stripToolCallBlocks } from './thinkAnswerFSM.js';
export { setupMercuryStatusMsg } from './statusMessage.js';
export {
  setupVoiceProgressMsg,
  type VoiceProgressController,
} from './voiceProgressMessage.js';
export {
  buildMessageWithToolFooter,
  formatThinkMs,
  makeToolAccumulator,
  STREAM_CURSOR,
  type ToolEvent,
  type ToolAccumulator,
} from './rendering.js';
export { splitMessage, TELEGRAM_HARD_LIMIT, TELEGRAM_SAFE_LIMIT } from './chunking.js';
export { withTelegramRetry, parseRetryAfter } from './networkErrors.js';
