import { useState, useEffect, useCallback, useRef } from 'react';
import type { MessageImage } from '@mastermind/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { clientLogger } from '../lib/clientLogger';

export type { MessageImage };

export interface SessionOptions {
  modelOverride?: string;
  temperatureOverride?: number;
  toolsDisabled?: boolean;
  toolsHidden?: boolean;
  telegramStreaming?: boolean;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  source: string;
  createdAt: string;
  metadata?: Record<string, unknown>; // DB metadata (includes toolEvents, etc.)
  toolEvents?: ToolEvent[]; // persisted tool events for completed assistant messages
}

export interface ToolEvent {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  output?: string;
  durationMs?: number;
  error?: string;
}

export function useChat(sessionId: string | null, agentId?: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingError, setStreamingError] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<string>('idle');
  const [loading, setLoading] = useState(false);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [sessionOptions, setSessionOptions] = useState<SessionOptions>({});
  const streamingRef = useRef('');
  // Accumulate tool events during a run so they can be attached to the final message.
  const pendingToolEventsRef = useRef<ToolEvent[]>([]);
  const isStreamingRef = useRef(false);
  // Track when a new message was sent (pending = waiting for backend 'thinking' confirmation).
  // Used to ignore stale 'idle' WS events from the previous request that arrive late.
  const pendingSendRef = useRef(false);
  // Debounce 'idle' state: between tool calls the backend briefly emits idle→thinking.
  // Delay applying idle so rapid idle→thinking transitions don't flicker the UI.
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Filter internal model-context messages and hydrate toolEvents on assistant messages */
  const hydrateToolEvents = useCallback((msgs: ChatMessage[]): ChatMessage[] => {
    return msgs
      .filter(m => {
        // Drop raw tool outputs — internal context only
        if (m.role === 'tool') return false;
        const meta = m.metadata as Record<string, unknown> | undefined;
        // Drop intermediate tool-call turns EXCEPT the one that triggered a sandbox flip:
        // that row carries the user-visible preamble ("OK je bascule en sandbox…") and is
        // the only DB trace of it — without this exception, fetchMessages() would wipe the
        // text from the chat the moment the run goes idle.
        if (meta?.type === 'tool_call_turn' && !meta?.sandbox_trigger) return false;
        return true;
      })
      .map(m => {
        if (m.toolEvents) return m; // already hydrated (e.g. from chat.done)
        const meta = m.metadata as { toolEvents?: ToolEvent[] } | undefined;
        if (meta?.toolEvents && meta.toolEvents.length > 0) {
          return { ...m, toolEvents: meta.toolEvents };
        }
        return m;
      });
  }, []);

  const mergeMessageLists = useCallback((fetched: ChatMessage[], current: ChatMessage[]): ChatMessage[] => {
    const byId = new Map(fetched.map(m => [m.id, m]));
    for (const msg of current) {
      if (msg.sessionId === sessionId && !byId.has(msg.id)) {
        byId.set(msg.id, msg);
      }
    }
    return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [sessionId]);

  const fetchMessages = useCallback(() => {
    if (!sessionId) return;
    const requestedSessionId = sessionId;
    api.get<ChatMessage[]>(`/api/sessions/${sessionId}/messages`)
      .then(msgs => {
        if (requestedSessionId !== sessionId) return;
        const fetched = hydrateToolEvents(msgs);
        setMessages(prev => mergeMessageLists(fetched, prev));
        clientLogger.debug('chat', 'messages refreshed', { sessionId, count: fetched.length });
      })
      .catch(err => clientLogger.warn('chat', 'messages refresh failed', { sessionId, error: err instanceof Error ? err.message : String(err) }));
  }, [sessionId, hydrateToolEvents, mergeMessageLists]);

  // Load persisted session options when session changes
  useEffect(() => {
    if (!sessionId) { setSessionOptions({}); return; }
    api.get<SessionOptions>(`/api/sessions/${sessionId}/options`)
      .then(opts => {
        setSessionOptions(opts);
        clientLogger.debug('chat', 'session options loaded', { sessionId, keys: Object.keys(opts).join(',') });
      })
      .catch(err => {
        clientLogger.warn('chat', 'session options load failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
        setSessionOptions({});
      });
  }, [sessionId]);

  // Reset agent state when agent changes
  useEffect(() => {
    setAgentState('idle');
    clientLogger.debug('chat', 'agent changed', { agentId: agentId ?? undefined });
  }, [agentId]);

  // Fetch history when session changes
  useEffect(() => {
    // Reset all transient streaming state — an in-progress run on the previous
    // session must not bleed into the new view (stale streamingContent, isStreaming
    // blocking the input, leftover tool events, etc.).
    isStreamingRef.current = false;
    setIsStreaming(false);
    streamingRef.current = '';
    setStreamingContent('');
    setStreamingError(null);
    pendingToolEventsRef.current = [];
    setToolEvents([]);
    pendingSendRef.current = false;
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    setAgentState('idle');

    if (!sessionId) {
      setMessages([]);
      return;
    }

    setLoading(true);
    let active = true;
    const requestedSessionId = sessionId;
    api.get<ChatMessage[]>(`/api/sessions/${sessionId}/messages`)
      .then(msgs => {
        if (!active || requestedSessionId !== sessionId) return;
        setMessages(hydrateToolEvents(msgs));
        clientLogger.debug('chat', 'session history loaded', { sessionId, count: msgs.length });
      })
      .catch(err => clientLogger.warn('chat', 'session history load failed', { sessionId, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { if (active) setLoading(false); });

    // Subscribe to session
    clientLogger.info('chat', 'session view subscribed', { sessionId, agentId: agentId ?? undefined });
    wsClient.send({ type: 'session.subscribe', sessionId });

    return () => {
      active = false;
      if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
      clientLogger.debug('chat', 'session view unsubscribed', { sessionId, agentId: agentId ?? undefined });
      wsClient.send({ type: 'session.unsubscribe', sessionId });
    };
  }, [sessionId, agentId, hydrateToolEvents]);

  // Listen for WS events
  useEffect(() => {
    if (!sessionId) return;

    const unsub = wsClient.subscribe((msg) => {
      // agent.state events are broadcast to all — handle them without session filter
      if (msg.type === 'agent.state') {
        if (agentId && msg.agentId === agentId) {
          // When the backend confirms 'thinking', our pending send is acknowledged.
          if (msg.state === 'thinking') pendingSendRef.current = false;
          clientLogger.debug('chat', 'agent state received', { agentId: msg.agentId, state: msg.state, sessionId });

          // Ignore stale 'idle' events from the previous request that arrive after
          // a new message was sent (pendingSendRef still true = backend hasn't responded yet).
          // warm.done is never stale (warming never overlaps a send).
          if (msg.state === 'idle' && pendingSendRef.current) return;

          if (msg.state === 'warm.done') {
            // Cache warming finished — set idle but do NOT fetchMessages (nothing was written to DB)
            if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
            setAgentState('idle');
          } else if (msg.state === 'idle') {
            // Debounce idle: the backend briefly emits idle between tool calls and the next
            // LLM turn. Delay applying it so rapid idle→thinking transitions don't flicker.
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            idleTimerRef.current = setTimeout(() => {
              idleTimerRef.current = null;
              setAgentState('idle');
              if (!isStreamingRef.current) fetchMessages();
            }, 300);
          } else {
            // Any active state cancels a pending idle transition
            if (idleTimerRef.current) {
              clearTimeout(idleTimerRef.current);
              idleTimerRef.current = null;
            }
            setAgentState(msg.state);
          }
        }
        return;
      }

      if (!('sessionId' in msg) || (msg as { sessionId: string }).sessionId !== sessionId) return;
      // Cross-agent filter: if multiple agents share this session (war-room, agent
      // hand-off mid-stream), ignore streaming/error events meant for a DIFFERENT
      // agent than the one this hook is bound to. Limited to streaming-state events
      // — `session.message` is intentionally NOT filtered: persisted messages from
      // any agent must remain visible to all viewers of the session (including a
      // user who switched agents mid-conversation). Don't add session.message here.
      if (
        agentId
        && 'agentId' in msg
        && typeof (msg as { agentId?: string }).agentId === 'string'
        && (msg as { agentId: string }).agentId !== agentId
        && (msg.type === 'chat.error' || msg.type === 'chat.delta' || msg.type === 'chat.done' || msg.type === 'tool.start' || msg.type === 'tool.done')
      ) {
        return;
      }

      switch (msg.type) {
        case 'session.message':
          // New message from another source (e.g., Telegram)
          setMessages(prev => {
            if (prev.some(m => m.id === msg.message.id)) return prev;
            return [...prev, msg.message];
          });
          break;

        case 'chat.delta':
          isStreamingRef.current = true;
          setIsStreaming(true);
          setStreamingError(null);
          streamingRef.current += msg.content;
          setStreamingContent(streamingRef.current);
          break;

        case 'chat.done': {
          isStreamingRef.current = false;
          setIsStreaming(false);
          streamingRef.current = '';
          setStreamingContent('');
          // Prefer server-sent toolEvents (persisted in DB), fall back to client-side accumulated
          const capturedTools = pendingToolEventsRef.current;
          const finalToolEvents = (msg.toolEvents && msg.toolEvents.length > 0)
            ? msg.toolEvents
            : (capturedTools.length > 0 ? capturedTools : undefined);
          pendingToolEventsRef.current = [];
          setToolEvents([]);
          // Add the complete message with attached tool events
          if (msg.messageId) {
            setMessages(prev => {
              if (prev.some(m => m.id === msg.messageId)) return prev;
              return [
                ...prev,
                {
                  id: msg.messageId,
                  sessionId: msg.sessionId,
                  role: 'assistant',
                  content: msg.content,
                  source: 'web',
                  createdAt: new Date().toISOString(),
                  toolEvents: finalToolEvents,
                  metadata: msg.partial ? { partial: true } : undefined,
                },
              ];
            });
          }
          break;
        }

        case 'chat.error':
          isStreamingRef.current = false;
          setIsStreaming(false);
          streamingRef.current = '';
          setStreamingContent('');
          pendingToolEventsRef.current = [];
          setToolEvents([]);
          pendingSendRef.current = false;
          if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
            idleTimerRef.current = null;
          }
          setAgentState('idle');
          setStreamingError(msg.error ?? 'Connection error');
          clientLogger.error('chat', 'streaming error received', { agentId: agentId ?? undefined, sessionId, error: msg.error ?? 'Connection error' });
          break;

        case 'tool.start': {
          const newEv: ToolEvent = {
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            input: msg.input,
            status: 'running',
          };
          pendingToolEventsRef.current = [...pendingToolEventsRef.current, newEv];
          setToolEvents(prev => [...prev, newEv]);
          clientLogger.info('chat-tool', 'tool started', { agentId: agentId ?? undefined, sessionId, toolName: msg.toolName, toolCallId: msg.toolCallId });
          break;
        }

        case 'session.options':
          setSessionOptions(msg.options ?? {});
          break;

        case 'tool.done': {
          const updater = (prev: ToolEvent[]) =>
            prev.map(ev =>
              ev.toolCallId === msg.toolCallId
                ? {
                    ...ev,
                    status: (msg.error ? 'error' : 'done') as ToolEvent['status'],
                    output: msg.output,
                    durationMs: msg.durationMs,
                    error: msg.error,
                  }
                : ev,
            );
          pendingToolEventsRef.current = updater(pendingToolEventsRef.current);
          setToolEvents(updater);
          if (msg.error) {
            clientLogger.warn('chat-tool', 'tool failed', { agentId: agentId ?? undefined, sessionId, toolCallId: msg.toolCallId, durationMs: msg.durationMs, error: msg.error });
          } else {
            clientLogger.debug('chat-tool', 'tool done', { agentId: agentId ?? undefined, sessionId, toolCallId: msg.toolCallId, durationMs: msg.durationMs });
          }
          break;
        }
      }
    });

    return () => {
      if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
      unsub();
    };
  }, [sessionId, agentId, fetchMessages]);

  const sendMessage = useCallback((agentId: string, content: string, images?: MessageImage[]) => {
    if (!sessionId || !content.trim()) return;

    // Clear any previous streaming state; the canonical `user` message
    // will be pushed by the backend via `session.message`.
    isStreamingRef.current = false;
    setIsStreaming(false);
    streamingRef.current = '';
    setStreamingContent('');

    // Optimistically set agent state to 'thinking' so the bouncing dots
    // appear immediately — no need to wait for the WS agent.state event
    // (which may arrive so fast it gets batched with 'streaming').
    // Also guard against stale 'idle' WS events from the previous request.
    pendingSendRef.current = true;
    setAgentState('thinking');
    clientLogger.info('chat', 'message send', { agentId, sessionId, contentLen: content.length, images: images?.length ?? 0 });

    // Send via WebSocket
    wsClient.send({
      type: 'chat.send',
      agentId,
      sessionId,
      content,
      ...(images && images.length > 0 ? { images } : {}),
    });
  }, [sessionId]);

  const abort = useCallback((agentId: string) => {
    if (!sessionId) return;
    clientLogger.warn('chat', 'abort requested', { agentId, sessionId });
    wsClient.send({ type: 'chat.abort', agentId, sessionId });
  }, [sessionId]);

  const warmCache = useCallback((agentId: string) => {
    if (!sessionId) return;
    clientLogger.info('chat', 'cache warm requested', { agentId, sessionId });
    wsClient.send({ type: 'cache.warm', agentId, sessionId });
  }, [sessionId]);

  return { messages, streamingContent, isStreaming, streamingError, clearStreamingError: () => setStreamingError(null), agentState, loading, toolEvents, sessionOptions, sendMessage, abort, warmCache };
}
