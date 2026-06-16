import fs from 'node:fs/promises';
import path from 'node:path';
import { InputFile } from 'grammy';
import type {
  AgentConfig,
  MastermindConfig,
  MessageAttachment,
  MessageAttachmentKind,
  MessageSource,
  WebSocketManager,
  WsServerMessage,
} from '@mastermind/shared';
import type { SessionModule } from '../session/index.js';
import type { TelegramModule } from '../telegram/index.js';
import type { PushModule } from '../push/index.js';
import { resolveSafePath } from '../../utils/paths.js';

/**
 * delivery/channels — primitives de livraison par canal (chat WS, Telegram, push APNs mobile)
 * + résolution des pièces jointes. Ces helpers ne décident RIEN (pas de policy, pas de
 * presence) : ils exécutent un leg donné. La décision vit dans delivery/resolve, l'orchestration
 * dans delivery/index (executeDelivery). DELIVER semantics partagées par send_to_user, l'auto-
 * deliver et les filets.
 */

/** Minimum MIME map covering the extensions agents commonly produce. */
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

function mimeFor(filename: string): string {
  return MIME_MAP[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function kindOf(mime: string): MessageAttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Telegram Bot API hard limits (bytes). */
const TG_LIMIT_PHOTO = 10 * 1024 * 1024;
const TG_LIMIT_VIDEO_DOC = 50 * 1024 * 1024;

export interface ResolvedAttachment {
  absPath: string;
  url: string;
  mime: string;
  kind: MessageAttachmentKind;
  name: string;
  size: number;
}

/**
 * Resolve `workspace:<rel>`, `shared:<rel>`, or bare `<rel>` (= workspace) into an absolute
 * filesystem path + the auth-gated URL the frontend loads. Throws on traversal / missing file.
 */
async function resolveAttachment(
  spec: string,
  roots: { workspace: string; shared: string },
  agentId: string,
): Promise<ResolvedAttachment> {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error('empty path');

  let scope: 'workspace' | 'shared' = 'workspace';
  let rel = trimmed;
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon).toLowerCase();
    if (prefix === 'shared') {
      scope = 'shared';
      rel = trimmed.slice(colon + 1);
    } else if (prefix === 'workspace') {
      rel = trimmed.slice(colon + 1);
    }
  }

  const baseDir = scope === 'shared' ? roots.shared : roots.workspace;
  const absPath = resolveSafePath(baseDir, rel);
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) throw new Error(`not a file: ${rel}`);

  const name = path.basename(absPath);
  const mime = mimeFor(absPath);
  const urlRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const encodedPath = urlRel.split('/').map(encodeURIComponent).join('/');
  const url =
    scope === 'shared'
      ? `/api/files/shared/${encodedPath}`
      : `/api/files/agent/${encodeURIComponent(agentId)}/${encodedPath}`;

  return { absPath, url, mime, kind: kindOf(mime), name, size: stat.size };
}

/** Resolve every path spec. Individual failures are returned as errors; the others still resolve. */
export async function resolveAttachments(
  specs: string[],
  roots: { workspace: string; shared: string },
  agentId: string,
): Promise<{ resolved: ResolvedAttachment[]; errors: string[] }> {
  const resolved: ResolvedAttachment[] = [];
  const errors: string[] = [];
  console.debug(`[deliver] resolveAttachments agent=${agentId} specs=${specs.length}`);
  for (const spec of specs) {
    try {
      const item = await resolveAttachment(spec, roots, agentId);
      resolved.push(item);
      console.debug(`[deliver] attachment resolved agent=${agentId} name=${item.name} kind=${item.kind} size=${item.size}`);
    } catch (err) {
      console.warn(`[deliver] attachment resolve failed agent=${agentId} spec="${spec.slice(0, 120)}": ${err instanceof Error ? err.message : err}`);
      errors.push(`"${spec}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { resolved, errors };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface DeliverChatOptions {
  sessionModule: SessionModule;
  ws: WebSocketManager;
  sessionId: string;
  content: string;
  attachments: ResolvedAttachment[];
  /** Extra keys merged into the persisted message metadata (e.g. subject, proactiveTrigger). */
  extraMetadata?: Record<string, unknown>;
  /**
   * Visible source to persist the message with. Defaults to 'web' when omitted.
   * Callers should pass the session's native channel — 'web' for the UI, 'telegram' for
   * Telegram-bridged sessions — so the delivered message matches its neighbours rather
   * than being mislabelled as 'web' on a telegram thread.
   */
  source?: MessageSource;
}

/** Insert a visible assistant message into the handler session and broadcast it over WS. */
export async function deliverToChat(opts: DeliverChatOptions): Promise<void> {
  const attachmentsMeta: MessageAttachment[] = opts.attachments.map(r => ({
    kind: r.kind,
    url: r.url,
    mime: r.mime,
    name: r.name,
    size: r.size,
  }));
  const metadata: Record<string, unknown> = {
    ...(opts.extraMetadata ?? {}),
    ...(attachmentsMeta.length > 0 ? { attachments: attachmentsMeta } : {}),
  };
  console.debug(`[deliver] chat start session=${opts.sessionId} source=${opts.source ?? 'web'} contentLen=${opts.content.length} attachments=${opts.attachments.length}`);
  const msg = await opts.sessionModule.addMessage(
    opts.sessionId,
    'assistant',
    opts.content,
    opts.source ?? 'web',
    metadata,
  );
  opts.ws.broadcast(opts.sessionId, {
    type: 'session.message',
    sessionId: opts.sessionId,
    message: msg,
  } satisfies WsServerMessage);
  console.log(`[deliver] chat done session=${opts.sessionId} message=${msg.id} attachments=${attachmentsMeta.length}`);
}

export interface DeliverTelegramOptions {
  telegramModule?: TelegramModule;
  mastermindConfig: MastermindConfig;
  handlerAgentConfig: AgentConfig;
  content: string;
  attachments: ResolvedAttachment[];
  /** Optional bold subject prepended to the caption/message. */
  subject?: string;
  /**
   * Restreint la livraison à CE seul chatId (s'il fait partie des chatIds de l'agent).
   * Utilisé en mode session unifiée : seul le DM owner (primaryChatId) reçoit le push,
   * pas les groupes. Absent = comportement legacy (tous les chatIds configurés).
   */
  targetChatId?: number;
}

export interface TelegramDeliveryResult {
  deliveredCount: number;
  errors: string[];
}

/** Send content + attachments to every chatId configured on the handler agent. Throws on setup errors. */
export async function deliverToTelegram(opts: DeliverTelegramOptions): Promise<TelegramDeliveryResult> {
  if (!opts.telegramModule) throw new Error('telegram module not loaded');
  const tg = opts.handlerAgentConfig.telegram;
  if (!tg?.enabled || !tg.chatIds?.length) throw new Error('handler agent has no telegram chatIds');
  const botId = tg.botId ?? opts.mastermindConfig.telegram.bots[0]?.id;
  if (!botId) throw new Error('no telegram bot configured');
  const bot = opts.telegramModule.getBot(botId);
  if (!bot) throw new Error(`telegram bot "${botId}" not found`);

  const header = opts.subject ? `<b>${escapeHtml(opts.subject)}</b>\n\n` : '';
  const caption = opts.content ? `${header}${escapeHtml(opts.content.slice(0, 1000))}` : header;
  // Mode unifié : restreint au DM owner si targetChatId est fourni (et présent dans chatIds).
  // Sinon legacy = tous les chatIds. Si targetChatId est fourni mais absent des chatIds, on
  // ne livre à personne (plutôt que de blaster les groupes) — failsafe explicite.
  const targetChats = opts.targetChatId !== undefined
    ? tg.chatIds.filter(c => c === opts.targetChatId)
    : tg.chatIds;
  const perAttachmentErrors: string[] = [];
  let deliveredCount = 0;
  console.debug(`[deliver] telegram start bot=${botId} chats=${targetChats.length}${opts.targetChatId !== undefined ? ` (target=${opts.targetChatId})` : ''} contentLen=${opts.content.length} attachments=${opts.attachments.length}`);

  for (const chatId of targetChats) {
    if (opts.attachments.length > 0) {
      for (let i = 0; i < opts.attachments.length; i++) {
        const att = opts.attachments[i]!;
        const isLast = i === opts.attachments.length - 1;
        const thisCaption = isLast && opts.content.length <= 1000 ? caption : undefined;
        const captionOpts = thisCaption ? { caption: thisCaption, parse_mode: 'HTML' as const } : {};

        try {
          if (att.kind === 'image' && att.size <= TG_LIMIT_PHOTO) {
            await bot.api.sendPhoto(chatId, new InputFile(att.absPath), captionOpts);
          } else if (att.kind === 'video' && att.size <= TG_LIMIT_VIDEO_DOC) {
            await bot.api.sendVideo(chatId, new InputFile(att.absPath), captionOpts);
          } else if (att.kind === 'audio' && att.size <= TG_LIMIT_VIDEO_DOC) {
            await bot.api.sendAudio(chatId, new InputFile(att.absPath), captionOpts);
          } else if (att.size <= TG_LIMIT_VIDEO_DOC) {
            await bot.api.sendDocument(chatId, new InputFile(att.absPath, att.name), captionOpts);
          } else {
            throw new Error(`"${att.name}" exceeds Telegram 50MB limit`);
          }
          deliveredCount++;
          console.debug(`[deliver] telegram attachment sent chat=${chatId} name=${att.name} kind=${att.kind} size=${att.size}`);
        } catch (err) {
          console.warn(`[deliver] telegram attachment failed chat=${chatId} name=${att.name}: ${err instanceof Error ? err.message : err}`);
          perAttachmentErrors.push(`attachment "${att.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Remainder as a separate message if content didn't fit in a caption (>1000 chars)
      if (opts.content.length > 1000) {
        try {
          await bot.api.sendMessage(chatId, `${header}${escapeHtml(opts.content.slice(0, 3500))}`, { parse_mode: 'HTML' });
          deliveredCount++;
          console.debug(`[deliver] telegram overflow message sent chat=${chatId}`);
        } catch (err) {
          console.warn(`[deliver] telegram overflow message failed chat=${chatId}: ${err instanceof Error ? err.message : err}`);
          perAttachmentErrors.push(`message: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      // Text-only path — original 3500-char budget. Per-chat try/catch so one failing
      // recipient (chat not found, bot blocked, 429, transient network) doesn't unwind the
      // whole loop and silently suppress delivery to every subsequent chatId — best-effort
      // like the attachment branch above.
      const message = `${header}${escapeHtml(opts.content.slice(0, 3500))}`;
      try {
        await bot.api.sendMessage(chatId, message, { parse_mode: 'HTML' });
        deliveredCount++;
        console.debug(`[deliver] telegram text sent chat=${chatId}`);
      } catch (err) {
        console.warn(`[deliver] telegram text failed chat=${chatId}: ${err instanceof Error ? err.message : err}`);
        perAttachmentErrors.push(`message (chat ${chatId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`[deliver] telegram done bot=${botId} delivered=${deliveredCount} errors=${perAttachmentErrors.length}`);
  return { deliveredCount, errors: perAttachmentErrors };
}

export interface DeliverMobileOptions {
  pushModule?: PushModule;
  content: string;
  /** Optional bold subject — devient le titre de la notif (sinon "Assistant"). */
  subject?: string;
  /** Deep-link : ouvre cette session/agent au tap de la notif (payload custom APNs). */
  sessionId?: string;
  agentId?: string;
}

export interface MobileDeliveryResult {
  deliveredCount: number;
  errors: string[];
}

/**
 * Push APNs vers tous les appareils mobile app enregistrés. Miroir de `deliverToTelegram` :
 * le contenu complet vit déjà dans la session (chat/WS), ici on n'envoie qu'un aperçu
 * pour réveiller le téléphone. Les pièces jointes ne sont PAS poussées (APNs = texte) —
 * elles sont déjà visibles dans la session quand l'user ouvre l'app. Throw sur erreur de setup.
 */
export async function deliverToMobile(opts: DeliverMobileOptions): Promise<MobileDeliveryResult> {
  if (!opts.pushModule) throw new Error('push module not loaded');
  if (!opts.pushModule.isEnabled()) throw new Error('push channel not enabled (config.push + APNs key required)');

  const title = (opts.subject?.trim() || 'Assistant').slice(0, 120);
  const rawBody = opts.content.trim() || (opts.subject ? '' : 'Nouveau message');
  const body = rawBody.slice(0, 300);
  const data: Record<string, unknown> = { kind: 'agent_reply' };
  if (opts.sessionId) data['sessionId'] = opts.sessionId;
  if (opts.agentId) data['agentId'] = opts.agentId;

  console.debug(`[deliver] mobile start title="${title.slice(0, 40)}" bodyLen=${body.length} session=${opts.sessionId ?? '-'}`);
  const res = await opts.pushModule.sendToAll({ title, body, threadId: 'agent-reply', data });
  console.log(`[deliver] mobile done delivered=${res.delivered} pruned=${res.pruned} errors=${res.errors.length}`);
  return { deliveredCount: res.delivered, errors: res.errors };
}
