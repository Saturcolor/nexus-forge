export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
/**
 * Source of a message.
 * - `web` / `telegram`: visible user-facing messages.
 * - `proactive`: messages produced during a proactive run (watcher or handler during
 *   escalation) — persisted for KV cache continuity, hidden from chat history by default.
 * - `sandbox`: messages produced during a background sandbox run — same persistence +
 *   hiding semantics as `proactive`, but initiated by the agent itself via
 *   `dispatch_sandbox_run` instead of the scheduler/proactive pipeline.
 * - `subagent`: messages produced during a sub-agent run (cloud one-shot spawned via
 *   `spawn_subagent`). The full markdown report is stored in `async_jobs.result` and
 *   forwarded as the input of a NEW parent agent run (source='proactive', handler phase)
 *   triggered post-loop by `runSubAgent`. The parent synthesises and calls `send_to_user`
 *   to reach the user. Anti-recursion: `spawn_subagent` is hidden when source==='subagent'.
 */
export type MessageSource = 'web' | 'telegram' | 'proactive' | 'sandbox' | 'subagent';

/**
 * An image attached to a user message, encoded as a data-URL.
 * Stored in message metadata under the key `images` and sent to vision-capable LLMs
 * as OpenAI-compatible `image_url` content parts.
 */
export interface MessageImage {
  /** data:image/<subtype>;base64,<data> */
  dataUrl: string;
  mimeType: string;
  /** Original filename (display only) */
  name?: string;
}

/**
 * A file delivered by an agent via `send_to_user` (image, video, audio, or generic file).
 * Stored in assistant message metadata under the key `attachments`. The backend serves the
 * underlying bytes through `/api/files/...` — the `url` is relative and auth-gated like the
 * rest of the API.
 */
export type MessageAttachmentKind = 'image' | 'video' | 'audio' | 'file';
export interface MessageAttachment {
  kind: MessageAttachmentKind;
  /** Relative URL (e.g. `/api/files/agent/researcher/outputs/chart.png`). Auth token added by the client. */
  url: string;
  mime: string;
  name: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  source: MessageSource;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface StreamChunk {
  type: 'delta' | 'done' | 'error';
  sessionId: string;
  agentId: string;
  content?: string;
  messageId?: string;
  error?: string;
}
