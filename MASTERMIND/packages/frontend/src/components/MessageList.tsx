import { useEffect, useRef, useState, useCallback } from 'react';
import type { ChatMessage, ToolEvent } from '../hooks/useChat';
import type { MessageAttachment } from '@mastermind/shared';
import { getApiKey } from '../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { ChevronDown, ChevronRight, Copy, Check, Download, FileIcon } from 'lucide-react';

interface Props {
  messages: ChatMessage[];
  streamingContent: string;
  isStreaming: boolean;
  streamingError?: string | null;
  toolEvents?: ToolEvent[];
  agentState?: string;
  agentEmoji?: string;
  agentName?: string;
  showThink?: boolean;
  showTools?: boolean;
  /** Replie automatiquement les rows dupliquées send_to_user (📤) quand une réponse finale les suit. */
  collapseDelivered?: boolean;
}

const MARKDOWN_CLASSES =
  '[&_h1]:text-foreground [&_h2]:text-foreground [&_code]:bg-secondary [&_code]:text-primary [&_code]:px-1 [&_code]:rounded [&_pre]:bg-secondary [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto [&_a]:text-primary [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 text-foreground text-sm break-words';

function extractText(children: React.ReactNode): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number' || typeof children === 'boolean') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (typeof children === 'object' && 'props' in children) {
    return extractText((children as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return '';
}

function CodeBlockWithCopy({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const language = className?.replace('language-', '') ?? '';
  const raw = extractText(children);
  const code = raw.replace(/\n$/, '');

  const handleCopy = () => {
    if (!code) return;
    // Primary: Clipboard API (requires secure context)
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }).catch(() => fallbackCopy());
    } else {
      fallbackCopy();
    }
  };

  const fallbackCopy = () => {
    const el = document.createElement('textarea');
    el.value = code;
    el.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(el);
    el.focus();
    el.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } finally {
      document.body.removeChild(el);
    }
  };

  return (
    <div className="relative my-2 group">
      <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
        {language && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-background/80 text-muted-foreground border border-border uppercase">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="p-1.5 rounded border border-border bg-card/90 text-muted-foreground hover:text-foreground hover:border-primary transition-colors"
          title="Copier le code"
        >
          {copied
            ? <Check size={13} className="text-theme-green" />
            : <Copy size={13} />
          }
        </button>
      </div>
      <pre className="bg-secondary p-3 rounded overflow-x-auto pt-8">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export function MarkdownWithCopy({ content, className }: { content: string; className: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, {
          // Silence KaTeX strict warnings that fire on FALSE POSITIVES — content that
          // KaTeX interprets as math mode but is actually plain prose / code / output:
          //  - `unicodeTextInMathMode`: every `à`, `é`, `ç` near a `$` (ultra-fréquent en FR)
          //  - `commentAtEnd`: every `%` near a `$` (50%, 30%, etc. — ultra-fréquent)
          //  - `mathVsTextUnits`, `htmlExtension`: autres faux positifs récurrents avec les
          //    LLMs qui balancent du markdown approximatif
          // On garde tous les autres warnings (vraies erreurs LaTeX) en `warn` pour qu'elles
          // remontent. Ajouter un code à la liste si un nouveau warning spam est observé.
          strict: (errorCode: string) => {
            const IGNORED_CODES = new Set([
              'unicodeTextInMathMode',
              'commentAtEnd',
              'mathVsTextUnits',
              'htmlExtension',
              // `unknownSymbol`: em-dash / en-dash / autres Unicode hors-ASCII qui se
              // retrouvent en math-mode par accident — spam massif sur les réponses LLM.
              'unknownSymbol',
            ]);
            return IGNORED_CODES.has(errorCode) ? 'ignore' : 'warn';
          },
        }]]}
        components={{
          code({ className: codeClassName, children, ...props }) {
            // Inline code : single-line string without language tag → no copy button
            const isInline = !codeClassName?.startsWith('language-') &&
              !(typeof children === 'string' && (children as string).includes('\n'));
            if (isInline) return <code className={codeClassName} {...props}>{children}</code>;
            return <CodeBlockWithCopy className={codeClassName}>{children}</CodeBlockWithCopy>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Append the auth token to an attachment URL so `<img>`/`<video>` tags can load it. */
function authedUrl(url: string): string {
  const key = getApiKey();
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(key)}`;
}

function AttachmentsBlock({ attachments }: { attachments: MessageAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {attachments.map((att, idx) => {
        const src = authedUrl(att.url);
        if (att.kind === 'image') {
          return (
            <a key={`${att.url}-${idx}`} href={src} target="_blank" rel="noreferrer" className="block">
              <img
                src={src}
                alt={att.name}
                className="max-h-96 max-w-full rounded border border-border object-contain bg-secondary/30"
                loading="lazy"
              />
              <span className="text-[10px] text-muted-foreground font-mono mt-0.5 block truncate">
                {att.name} · {formatSize(att.size)}
              </span>
            </a>
          );
        }
        if (att.kind === 'video') {
          return (
            <div key={`${att.url}-${idx}`}>
              <video
                controls
                src={src}
                className="max-h-96 max-w-full rounded border border-border bg-black"
                preload="metadata"
              />
              <span className="text-[10px] text-muted-foreground font-mono mt-0.5 block truncate">
                {att.name} · {formatSize(att.size)}
              </span>
            </div>
          );
        }
        if (att.kind === 'audio') {
          return (
            <div key={`${att.url}-${idx}`} className="flex items-center gap-2">
              <audio controls src={src} className="h-8" preload="metadata" />
              <span className="text-[10px] text-muted-foreground font-mono truncate">
                {att.name} · {formatSize(att.size)}
              </span>
            </div>
          );
        }
        return (
          <a
            key={`${att.url}-${idx}`}
            href={src}
            download={att.name}
            className="inline-flex items-center gap-2 px-2 py-1 rounded border border-border bg-secondary/50 text-xs text-foreground hover:border-primary transition-colors"
          >
            <FileIcon size={12} className="text-muted-foreground" />
            <span className="font-mono truncate max-w-[320px]">{att.name}</span>
            <span className="text-muted-foreground">· {formatSize(att.size)}</span>
            <Download size={11} className="text-muted-foreground ml-1" />
          </a>
        );
      })}
    </div>
  );
}

/** Read `attachments` off a message's metadata if present and well-formed. */
function getAttachments(msg: ChatMessage): MessageAttachment[] {
  const raw = msg.metadata?.['attachments'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a: unknown): a is MessageAttachment =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as MessageAttachment).url === 'string' &&
      typeof (a as MessageAttachment).kind === 'string',
  );
}

function preview(text: string, len = 40): string {
  const flat = text.replace(/\n/g, ' ').trim();
  return flat.length > len ? flat.slice(0, len) + '…' : flat;
}

function splitThinkAndAnswer(text: string): { reasoning: string | null; answer: string } {
  const reasoningParts: string[] = [];

  // Strip <tool_call>...</tool_call> blocks (shown separately via tool events)
  let cleaned = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  // Strip unclosed <tool_call> at end (still streaming)
  cleaned = cleaned.replace(/<tool_call>[\s\S]*$/i, '');

  // Extract all complete <think>...</think> blocks
  let answer = cleaned.replace(/<think>([\s\S]*?)<\/think>/gi, (_, content) => {
    reasoningParts.push(content.trim());
    return '';
  });

  // Handle unclosed <think> at end (still streaming)
  const unclosed = answer.match(/<think>([\s\S]*)$/i);
  if (unclosed) {
    reasoningParts.push(unclosed[1].trim());
    answer = answer.slice(0, unclosed.index!);
  }

  // Fallback: try [THINK]...[/THINK]
  if (reasoningParts.length === 0) {
    answer = cleaned.replace(/\[THINK\]([\s\S]*?)\[\/THINK\]/gi, (_, content) => {
      reasoningParts.push(content.trim());
      return '';
    });
    const unclosed2 = answer.match(/\[THINK\]([\s\S]*)$/i);
    if (unclosed2) {
      reasoningParts.push(unclosed2[1].trim());
      answer = answer.slice(0, unclosed2.index!);
    }
  }

  if (reasoningParts.length === 0) return { reasoning: null, answer: answer.trim() || text };
  return { reasoning: reasoningParts.join('\n\n'), answer: answer.trim() };
}

function formatInputPreview(input: Record<string, unknown>): string {
  const first = Object.values(input)[0];
  if (typeof first === 'string') return first.slice(0, 60) + (first.length > 60 ? '…' : '');
  return JSON.stringify(input).slice(0, 60);
}

export function ToolEventBlock({ ev }: { ev: ToolEvent }) {
  const [open, setOpen] = useState(false);

  const statusColor =
    ev.status === 'running'
      ? 'text-yellow-400'
      : ev.status === 'error'
      ? 'text-red-400'
      : 'text-theme-green';

  const statusLabel =
    ev.status === 'running'
      ? 'en cours…'
      : ev.status === 'error'
      ? `erreur`
      : `${ev.durationMs}ms`;

  return (
    <div className="text-xs font-mono border border-border rounded my-1 bg-secondary/30">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1 hover:bg-secondary/50 transition-colors text-left"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="text-primary font-bold">{ev.toolName}</span>
        <span className="text-muted-foreground truncate flex-1">{formatInputPreview(ev.input)}</span>
        <span className={statusColor}>[{statusLabel}]</span>
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-1 border-t border-border">
          <div className="text-muted-foreground mt-1">
            <span className="font-bold">input: </span>
            <span className="whitespace-pre-wrap">{JSON.stringify(ev.input, null, 2)}</span>
          </div>
          {ev.output && (
            <div className="text-foreground">
              <span className="font-bold">{ev.error ? 'error: ' : 'output: '}</span>
              <span className="whitespace-pre-wrap">{ev.output.slice(0, 2000)}{ev.output.length > 2000 ? '\n…' : ''}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolEventsSection({ events, label }: { events: ToolEvent[]; label?: string }) {
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  const doneCount = events.filter(e => e.status === 'done' || e.status === 'error').length;
  const hasError = events.some(e => e.status === 'error');

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 mb-1 text-left hover:opacity-80 transition-opacity"
      >
        {open ? <ChevronDown size={11} className="text-muted-foreground" /> : <ChevronRight size={11} className="text-muted-foreground" />}
        <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-sm ${
          hasError ? 'bg-destructive/20 text-destructive' : 'bg-secondary text-muted-foreground'
        }`}>
          {label ?? 'Tool calls'} · {doneCount}/{events.length}
        </span>
      </button>
      {open && events.map(ev => (
        <ToolEventBlock key={ev.toolCallId} ev={ev} />
      ))}
    </div>
  );
}

function CollapsibleReasoning({ reasoning, streaming }: { reasoning: string; streaming?: boolean }) {
  const [open, setOpen] = useState(!!streaming); // expanded during streaming, collapsed after

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 mb-1 text-left hover:opacity-80 transition-opacity"
      >
        {open ? <ChevronDown size={11} className="text-theme-green" /> : <ChevronRight size={11} className="text-theme-green" />}
        <span className="text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-sm bg-theme-green/20 text-theme-green">
          Reasoning
        </span>
        {!open && (
          <span className="text-[10px] text-muted-foreground truncate max-w-[400px]">
            {reasoning.replace(/\n/g, ' ').trim().slice(0, 80)}…
          </span>
        )}
      </button>
      {open && (
        <div className={MARKDOWN_CLASSES + ' text-sm text-muted-foreground pl-4 border-l-2 border-l-theme-green/30'}>
          <MarkdownWithCopy content={reasoning} className="" />
        </div>
      )}
    </div>
  );
}

function AssistantBody({
  content,
  toolEvents,
  showThink,
  showTools,
  streaming,
}: {
  content: string;
  toolEvents?: ToolEvent[];
  showThink: boolean;
  showTools: boolean;
  streaming?: boolean;
}) {
  const think = splitThinkAndAnswer(content);

  return (
    <div>
      {/* Persisted / live tool events — always collapsible, never disappear */}
      {showTools && toolEvents && toolEvents.length > 0 && (
        <ToolEventsSection key="tools" events={toolEvents} />
      )}

      {/* Reasoning block — collapsible toggle (expanded during streaming, collapsed after) */}
      {showThink && think.reasoning ? (
        streaming ? (
          /* During streaming: show reasoning expanded with live indicator */
          <div key="reasoning" className="mb-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-sm bg-theme-green/20 text-theme-green">
                Reasoning
              </span>
              <span className="inline-block w-1.5 h-1.5 bg-theme-green animate-pulse rounded-full" />
            </div>
            <div className={MARKDOWN_CLASSES + ' text-sm text-muted-foreground pl-4 border-l-2 border-l-theme-green/30'}>
              <MarkdownWithCopy content={think.reasoning} className="" />
            </div>
          </div>
        ) : (
          /* After completion: collapsible with one-line preview */
          <CollapsibleReasoning key="reasoning" reasoning={think.reasoning} />
        )
      ) : null}

      {/* Final answer */}
      {think.answer && think.answer.trim().length > 0 ? (
        <MarkdownWithCopy key="answer" content={think.answer} className={MARKDOWN_CLASSES} />
      ) : think.reasoning ? (
        <div key="answer" className="text-muted-foreground text-sm italic">
          {streaming ? 'En cours de génération…' : 'En attente de la réponse finale…'}
        </div>
      ) : (
        <MarkdownWithCopy key="answer" content={content} className={MARKDOWN_CLASSES} />
      )}
    </div>
  );
}

export default function MessageList({
  messages,
  streamingContent,
  isStreaming,
  streamingError,
  toolEvents = [],
  agentState,
  agentEmoji: _agentEmoji,
  agentName,
  showThink = true,
  showTools = true,
  collapseDelivered = true,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const initialCollapseRef = useRef(false);
  // Rows 📤 déjà auto-repliées — un repli automatique par row, jamais re-forcé après
  // un dépliage manuel de l'utilisateur.
  const autoCollapsedDeliveredRef = useRef<Set<string>>(new Set());

  // Auto-collapse older user messages only on initial history load (tracked by message ID)
  useEffect(() => {
    if (messages.length <= 3) return;
    if (initialCollapseRef.current) return;
    initialCollapseRef.current = true;
    setCollapsed((prev) => {
      const next = new Set(prev);
      messages.forEach((msg, idx) => {
        if (msg.role === 'user' && idx < messages.length - 3) {
          next.add(msg.id);
        }
      });
      return next;
    });
  }, [messages.length]);

  // Auto-collapse des rows dupliquées send_to_user (📤) : seulement quand une réponse
  // assistant NON-dupliquée arrive APRÈS — dans un run proactif la row 📤 est l'unique
  // contenu visible, on ne la replie donc jamais tant que rien ne la suit. Tourne à
  // chaque évolution du fil (live), un seul repli par row (ref ci-dessus).
  useEffect(() => {
    const toCollapse: string[] = [];
    messages.forEach((msg, idx) => {
      if (msg.role !== 'assistant' || !msg.metadata?.['delivered_via_send_to_user']) return;
      if (autoCollapsedDeliveredRef.current.has(msg.id)) return;
      const followedByReply = messages.slice(idx + 1).some(
        m => m.role === 'assistant' && !m.metadata?.['delivered_via_send_to_user'],
      );
      if (followedByReply) toCollapse.push(msg.id);
    });
    if (toCollapse.length === 0) return;
    // Le ref de garde se peuple MÊME quand le toggle est OFF : une row qualifiée pendant
    // OFF est "consommée" — re-activer la feature ne doit pas replier rétroactivement des
    // rows que l'utilisateur a vues/dépliées (bug hunt 2026-06-12). Seul le setCollapsed
    // est gated par le toggle.
    toCollapse.forEach(id => autoCollapsedDeliveredRef.current.add(id));
    if (!collapseDelivered) return;
    setCollapsed(prev => {
      const next = new Set(prev);
      toCollapse.forEach(id => next.add(id));
      return next;
    });
  }, [messages, collapseDelivered]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Scroll to bottom on mount and new messages/streaming — only if user hasn't scrolled up
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [messages, streamingContent, isStreaming, agentState, scrollToBottom]);

  // Track whether user is at bottom; show scroll button when scrolled up
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      isAtBottomRef.current = atBottom;
      setShowScrollBtn(!atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const toggleCollapse = (msgId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  };

  const agentLabel = agentName?.toUpperCase() ?? 'AGENT';

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden divide-y divide-border relative">
      {messages.map((msg) => {
        const isUser = msg.role === 'user';
        const isCollapsed = collapsed.has(msg.id);

        return (
          <div key={msg.id} className={isUser ? 'bg-background' : 'bg-card'}>
            {/* Header */}
            <div
              className="flex items-center gap-2 px-4 py-1.5 cursor-pointer hover:bg-secondary/50 select-none"
              onClick={() => toggleCollapse(msg.id)}
            >
              {/* Role badge */}
              {isUser ? (
                <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-primary/20 text-primary">
                  OPERATOR
                </span>
              ) : (
                <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-theme-green/20 text-theme-green">
                  {agentLabel}
                </span>
              )}

              {/* Telegram badge */}
              {msg.source === 'telegram' && (
                <span className="text-[9px] text-muted-foreground bg-secondary px-1 py-0.5 rounded">
                  via TG
                </span>
              )}

              {/* Badge livraison send_to_user — row dupliquée du contenu livré */}
              {!isUser && msg.metadata?.['delivered_via_send_to_user'] === true && (
                <span
                  className="text-[9px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded"
                  title="Contenu livré via send_to_user — replié automatiquement quand une réponse finale suit (option dans le menu ⚙ de la barre de saisie)."
                >
                  📤 envoyé{(() => {
                    const ch = msg.metadata?.['delivered_channels'];
                    return Array.isArray(ch) && ch.length > 0 ? ` · ${ch.join(', ')}` : '';
                  })()}
                </span>
              )}

              {/* Tool call badge on collapsed assistant messages */}
              {!isUser && !isCollapsed && msg.toolEvents && msg.toolEvents.length > 0 && showTools && (
                <span className="text-[9px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                  {msg.toolEvents.length} tool{msg.toolEvents.length > 1 ? 's' : ''}
                </span>
              )}

              {/* Collapsed preview */}
              {isCollapsed && (
                <span className="text-[11px] text-muted-foreground truncate max-w-[320px]">
                  {preview(msg.content)}
                </span>
              )}

              {/* Timestamp right */}
              <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                {formatTime(msg.createdAt)}
              </span>
            </div>

            {/* Body */}
            {!isCollapsed && (
              <div
                className={`px-4 pl-10 pb-3 border-l-2 ml-4 ${
                  isUser ? 'border-l-primary' : 'border-l-theme-green'
                }`}
              >
                {isUser ? (
                  <p className="whitespace-pre-wrap text-sm text-foreground break-words">{msg.content}</p>
                ) : (
                  <AssistantBody
                    content={msg.content}
                    toolEvents={msg.toolEvents}
                    showThink={showThink}
                    showTools={showTools}
                  />
                )}
                <AttachmentsBlock attachments={getAttachments(msg)} />
              </div>
            )}
          </div>
        );
      })}

      {/* Thinking lane — animated typing indicator */}
      {(agentState === 'thinking' || (agentState === 'streaming' && !streamingContent)) && !isStreaming && (
        <div className="bg-card">
          <div className="flex items-center gap-2 px-4 py-1.5 select-none">
            <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-theme-green/20 text-theme-green">
              {agentLabel}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          </div>
          <div className="px-4 pl-10 pb-3 border-l-2 border-l-theme-green ml-4">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span>En cours de réflexion</span>
              <span className="flex gap-0.5 ml-1">
                <span className="w-1.5 h-1.5 bg-theme-green rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-theme-green rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-theme-green rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Live tool events (shown while agent is running, before/during streaming) */}
      {showTools && toolEvents.length > 0 && (
        <div className="bg-card">
          <div className="flex items-center gap-2 px-4 py-1.5 select-none">
            <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-theme-green/20 text-theme-green">
              {agentLabel}
            </span>
            <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-secondary text-muted-foreground">
              Tools live
            </span>
          </div>
          <div className="px-4 pl-10 pb-2 border-l-2 border-l-theme-green ml-4">
            {toolEvents.map(ev => (
              <ToolEventBlock key={ev.toolCallId} ev={ev} />
            ))}
          </div>
        </div>
      )}

      {/* Streaming message */}
      {(isStreaming || (agentState === 'streaming' && streamingContent)) && (
        <div className="bg-card">
          <div className="flex items-center gap-2 px-4 py-1.5 select-none">
            <span className="text-[9px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded-sm bg-theme-green/20 text-theme-green">
              {agentLabel}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          </div>
          <div className="px-4 pl-10 pb-3 border-l-2 border-l-theme-green ml-4">
            <AssistantBody
              content={streamingContent}
              showThink={showThink}
              showTools={false} /* live tools shown separately above */
              streaming
            />
            <span className="inline-block w-1.5 h-3.5 bg-primary animate-pulse ml-0.5 align-middle" />
          </div>
        </div>
      )}

      {streamingError && !isStreaming && (
        <div className="flex justify-start px-4 py-2">
          <div className="max-w-2xl border border-destructive/40 bg-destructive/10 rounded px-3 py-2 text-sm text-destructive font-mono">
            ⚠ {streamingError}
          </div>
        </div>
      )}

      <div ref={bottomRef} />

      {/* Scroll-to-bottom floating button */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-24 right-6 z-10 p-1.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground hover:border-primary transition-all shadow-lg"
          title="Scroll to bottom"
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  );
}
