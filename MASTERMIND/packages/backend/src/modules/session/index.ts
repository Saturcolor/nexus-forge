import type { Module, MastermindContext, Session, ChatMessage, MessageRole, MessageSource } from '@mastermind/shared';
import { SessionStore, type SessionSearchHit } from './store.js';
import type { SessionOptions } from '../agent/directives.js';

export class SessionModule implements Module {
  name = 'session';
  store!: SessionStore;

  async init(ctx: MastermindContext): Promise<void> {
    this.store = new SessionStore(ctx.db);
    console.log('[session] Initialized');
  }

  getOrCreate(sessionId: string, agentId: string): Promise<Session> {
    console.debug(`[session] getOrCreate session=${sessionId} agent=${agentId}`);
    return this.store.getOrCreate(sessionId, agentId);
  }

  setTitle(sessionId: string, title: string): Promise<void> {
    console.debug(`[session] setTitle session=${sessionId} title="${title}"`);
    return this.store.setTitle(sessionId, title);
  }

  listByAgent(agentId: string): Promise<Session[]> {
    console.debug(`[session] listByAgent agent=${agentId}`);
    return this.store.listByAgent(agentId);
  }

  listAll(): Promise<Session[]> {
    console.debug('[session] listAll');
    return this.store.listAll();
  }

  delete(sessionId: string): Promise<void> {
    console.log(`[session] delete session=${sessionId}`);
    return this.store.delete(sessionId);
  }

  clearMessages(sessionId: string): Promise<number> {
    console.log(`[session] clearMessages session=${sessionId}`);
    return this.store.clearMessages(sessionId);
  }

  addMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    source: MessageSource = 'web',
    metadata?: Record<string, unknown>,
  ): Promise<ChatMessage> {
    console.debug(`[session] addMessage session=${sessionId} role=${role} source=${source} len=${content.length} metadata=${metadata ? Object.keys(metadata).join(',') : 'none'}`);
    return this.store.addMessage(sessionId, role, content, source, metadata);
  }

  /** Merge fields into an existing message's metadata (delta patch). */
  updateMessageMetadata(messageId: string, patch: Record<string, unknown>): Promise<void> {
    console.debug(`[session] updateMessageMetadata message=${messageId} keys=${Object.keys(patch).join(',')}`);
    return this.store.updateMessageMetadata(messageId, patch);
  }

  getMessages(
    sessionId: string,
    limit?: number,
    before?: string,
    options?: { excludeProactive?: boolean },
  ): Promise<ChatMessage[]> {
    console.debug(`[session] getMessages session=${sessionId} limit=${limit ?? 'default'} before=${before ?? 'none'} excludeProactive=${options?.excludeProactive ?? false}`);
    return this.store.getMessages(sessionId, limit, before, options);
  }

  replaceWithCompact(
    sessionId: string,
    idsToDelete: string[],
    content: string,
    source: MessageSource,
    metadata: Record<string, unknown>,
    insertBefore: Date,
  ): Promise<ChatMessage> {
    console.log(`[session] replaceWithCompact session=${sessionId} compacting=${idsToDelete.length} summaryLen=${content.length}`);
    return this.store.replaceWithCompact(sessionId, idsToDelete, content, source, metadata, insertBefore);
  }

  getMessagesByAgentAndDate(agentId: string, dateStr: string, includeCompacted = false): Promise<ChatMessage[]> {
    console.debug(`[session] getMessagesByAgentAndDate agent=${agentId} date=${dateStr} includeCompacted=${includeCompacted}`);
    return this.store.getMessagesByAgentAndDate(agentId, dateStr, includeCompacted);
  }

  /** Used by the async-jobs audit endpoint to replay a sandbox run's messages. */
  listMessagesInTimeRange(sessionId: string, source: string, fromIso: string, toIso: string): Promise<ChatMessage[]> {
    console.debug(`[session] listMessagesInTimeRange session=${sessionId} source=${source} from=${fromIso} to=${toIso}`);
    return this.store.listMessagesInTimeRange(sessionId, source, fromIso, toIso);
  }

  saveOptions(sessionId: string, options: SessionOptions): Promise<void> {
    console.log(`[session] saveOptions session=${sessionId} keys=${Object.keys(options).join(',')}`);
    return this.store.saveOptions(sessionId, options);
  }

  loadOptions(sessionId: string): Promise<SessionOptions> {
    console.debug(`[session] loadOptions session=${sessionId}`);
    return this.store.loadOptions(sessionId);
  }

  /** Recherche plein-texte sur l'historique des messages (cf. tool session_search + route /sessions/search). */
  searchMessages(query: string, opts?: { agentId?: string; limit?: number }): Promise<SessionSearchHit[]> {
    console.debug(`[session] searchMessages qlen=${query.length} agent=${opts?.agentId ?? 'all'} limit=${opts?.limit ?? 'default'}`);
    return this.store.searchMessages(query, opts);
  }
}
