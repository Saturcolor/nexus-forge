import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Square, Paperclip, X, FileText, Image, Flame, Mic, Settings, ArchiveX, ChevronRight } from 'lucide-react';
import type { SessionOptions, MessageImage } from '../hooks/useChat';
import { api } from '../lib/api';

const AUTO_SEND_KEY = 'mastermind.stt.autoSend';

interface CommandDef {
  name: string;
  args: string;
  desc: string;
  values?: string[];
}

const COMMANDS: CommandDef[] = [
  {
    name: '/think',
    args: '[off|low|med|high]',
    desc: 'Niveau de raisonnement (extended thinking)',
    values: ['off', 'low', 'med', 'high'],
  },
  {
    name: '/model',
    args: '[<modelId>|off]',
    desc: 'Override de modèle pour cette session',
  },
  {
    name: '/temp',
    args: '[<0.0-2.0>|off]',
    desc: 'Override de température pour cette session',
    values: ['off', '0.0', '0.2', '0.5', '0.7', '1.0', '1.5'],
  },
  {
    name: '/tools',
    args: '[on|off|show|hide]',
    desc: 'Activer/désactiver ou afficher/masquer les outils',
    values: ['on', 'off', 'show', 'hide'],
  },
  {
    name: '/compact',
    args: '',
    desc: 'Sauvegarder et compacter le contexte de la session',
  },
  {
    name: '/status',
    args: '',
    desc: 'Afficher les options actives de la session',
  },
  {
    name: '/help',
    args: '',
    desc: 'Afficher toutes les commandes disponibles',
  },
];

function getActiveLabel(name: string, opts: SessionOptions, agentThink?: ThinkLevel): string | null {
  switch (name) {
    case '/think':
      // Agent-level (single source of truth) — passed via thinkLevel prop.
      return agentThink ?? 'off';
    case '/model':
      return opts.modelOverride ?? null;
    case '/temp':
      return opts.temperatureOverride !== undefined ? String(opts.temperatureOverride) : null;
    case '/tools':
      if (opts.toolsDisabled) return 'off';
      if (opts.toolsHidden) return 'hidden';
      return null;
    default:
      return null;
  }
}

export interface AttachedFile {
  name: string;
  size: number;
  /** Inline content extracted by the backend for text files ≤500KB */
  content?: string;
  /** Workspace-relative path on the server (e.g. `uploads/xY3.csv`) */
  relativePath?: string;
  /** Absolute path on the server — preferred for agent tool calls to avoid cwd ambiguity */
  absolutePath?: string;
  isText: boolean;
  /** For image files: base64 data URL (data:image/...;base64,...) */
  dataUrl?: string;
  mimeType?: string;
  isImage?: boolean;
}

export type ThinkLevel = 'off' | 'low' | 'med' | 'high';

interface Props {
  onSend: (content: string, images?: MessageImage[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  agentState?: string;
  sessionOptions?: SessionOptions;
  /** Called when files are dropped/selected — parent handles upload */
  onFilesAttached?: (files: File[]) => void;
  /** Currently attached files (managed by parent) */
  attachedFiles?: AttachedFile[];
  /** Remove an attached file by index */
  onRemoveFile?: (index: number) => void;
  /** Warm the KV cache in advance */
  onWarmCache?: () => void;
  /** Agent id used for voice transcription (NCM STT). Required to enable mic. */
  agentId?: string | null;
  /** Reasoning / thinking controls (shown in the settings popup) */
  thinkLevel?: ThinkLevel;
  onSetThinkLevel?: (level: ThinkLevel) => void;
  showThink?: boolean;
  onToggleShowThink?: () => void;
  /** Tool calls display toggle */
  showTools?: boolean;
  onToggleShowTools?: () => void;
  /** Replie les rows dupliquées send_to_user (📤) quand une réponse finale suit. */
  collapseDelivered?: boolean;
  onToggleCollapseDelivered?: () => void;
  /** Compact action */
  onCompact?: () => void;
  compacting?: boolean;
  canCompact?: boolean;
  /** Auto-unload previous model on agent switch */
  autoUnloadOnSwitch?: boolean;
  onToggleAutoUnload?: () => void;
  /** LoRA scales shortcut (un par adapter chargé brain, index = id llama-server). */
  loraScales?: number[];
  onSetLoraScales?: (scales: number[] | undefined) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function SwitchThumb({ on }: { on: boolean }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      className={`relative shrink-0 inline-block w-[30px] h-[18px] rounded-full transition-colors ${
        on ? 'bg-theme-green' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 h-[14px] w-[14px] rounded-full bg-white shadow transition-[left] ${
          on ? 'left-[14px]' : 'left-[2px]'
        }`}
      />
    </span>
  );
}

export default function InputBar({
  onSend, onAbort, isStreaming, disabled, agentState,
  sessionOptions = {},
  onFilesAttached, attachedFiles = [], onRemoveFile, onWarmCache,
  agentId,
  thinkLevel, onSetThinkLevel, showThink, onToggleShowThink,
  showTools, onToggleShowTools,
  collapseDelivered, onToggleCollapseDelivered,
  onCompact, compacting, canCompact,
  autoUnloadOnSwitch, onToggleAutoUnload,
  loraScales, onSetLoraScales,
}: Props) {
  const [text, setText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  const [autoSend, setAutoSend] = useState<boolean>(() => {
    try { return localStorage.getItem(AUTO_SEND_KEY) === '1'; } catch { return false; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAnchor, setSettingsAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [thinkSubmenuOpen, setThinkSubmenuOpen] = useState(false);
  const thinkSubmenuCloseTimer = useRef<number | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const settingsPopupRef = useRef<HTMLDivElement>(null);

  const openThinkSubmenu = useCallback(() => {
    if (thinkSubmenuCloseTimer.current) {
      clearTimeout(thinkSubmenuCloseTimer.current);
      thinkSubmenuCloseTimer.current = null;
    }
    setThinkSubmenuOpen(true);
  }, []);

  const scheduleCloseThinkSubmenu = useCallback(() => {
    if (thinkSubmenuCloseTimer.current) clearTimeout(thinkSubmenuCloseTimer.current);
    thinkSubmenuCloseTimer.current = window.setTimeout(() => {
      setThinkSubmenuOpen(false);
      thinkSubmenuCloseTimer.current = null;
    }, 150);
  }, []);

  const openSettings = useCallback(() => {
    const btn = settingsBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setSettingsAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
    setSettingsOpen(true);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recStartRef = useRef<number>(0);

  const toggleAutoSend = useCallback(() => {
    setAutoSend(prev => {
      const next = !prev;
      try { localStorage.setItem(AUTO_SEND_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Detect slash-command trigger in the text
  const slashMatch = text.match(/(?:^|\s)(\/\S*)$/);
  const slashToken = slashMatch?.[1] ?? null;

  // Filter commands based on what's been typed
  const filtered = slashToken
    ? COMMANDS.filter(c => c.name.startsWith(slashToken.toLowerCase()))
    : [];

  // Show picker when slash is typed and matches exist
  useEffect(() => {
    if (slashToken && filtered.length > 0) {
      setPickerOpen(true);
      setPickerIndex(0);
    } else {
      setPickerOpen(false);
    }
  }, [slashToken, filtered.length]);

  const applyCommand = useCallback(
    (cmd: CommandDef) => {
      if (!textareaRef.current) return;
      const newText = slashToken
        ? text.slice(0, text.lastIndexOf(slashToken)) + cmd.name + ' '
        : text + cmd.name + ' ';
      setText(newText);
      setPickerOpen(false);
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px';
    },
    [text, slashToken],
  );

  const handleSend = useCallback(() => {
    if (disabled) return;

    // Build message with attached file contents (text files only, images are sent separately)
    let fullContent = text.trim();

    if (attachedFiles.length > 0) {
      const fileParts: string[] = [];
      for (const f of attachedFiles) {
        if (f.isImage) continue; // images sent as vision attachments, not inline text

        // Prefer the absolute path for tool calls — removes any cwd-resolution
        // ambiguity between `read_file` (workspace cwd) and `bash` (process cwd).
        const path = f.absolutePath ?? f.relativePath;

        if (path && f.content) {
          // Text file uploaded with extracted content — give the agent a preview for
          // structure + the disk path so it can read/parse the full file with tools.
          const totalLines = f.content.split('\n').length;
          const PREVIEW_LINES = 10;
          const PREVIEW_CHARS = 1000;
          const lines = f.content.split('\n').slice(0, PREVIEW_LINES);
          let preview = lines.join('\n');
          let truncated = totalLines > PREVIEW_LINES;
          if (preview.length > PREVIEW_CHARS) {
            preview = preview.slice(0, PREVIEW_CHARS);
            truncated = true;
          }
          const header = `[attached: ${f.name} (${formatSize(f.size)}, ${totalLines} lines) saved at \`${path}\`]`;
          const footer = truncated
            ? `\n[preview truncated — use \`read_file\` or \`bash\` on \`${path}\` for the full file or to compute over it]`
            : `\n[full file shown above also available at \`${path}\` — use \`read_file\` or \`bash\` to compute/parse if needed]`;
          fileParts.push(`${header}\n\`\`\`\n${preview}\n\`\`\`${footer}`);
        } else if (path) {
          // Binary or oversized text file — path only, no inline content.
          fileParts.push(`[attached: ${f.name} (${formatSize(f.size)}) saved at \`${path}\` — use \`read_file\` or \`bash\` to access]`);
        } else if (f.content) {
          // Fallback: content-only attachment (no server upload happened).
          fileParts.push(`[attached: ${f.name} (${formatSize(f.size)})]\n\`\`\`\n${f.content}\n\`\`\``);
        }
      }
      if (fileParts.length > 0) {
        fullContent = fileParts.join('\n\n') + (fullContent ? '\n\n' + fullContent : '');
      }
    }

    // Collect image attachments for vision models
    const images: MessageImage[] = attachedFiles
      .filter(f => f.isImage && f.dataUrl && f.mimeType)
      .map(f => ({ dataUrl: f.dataUrl!, mimeType: f.mimeType!, name: f.name }));

    if (!fullContent && images.length === 0) return;
    // If there's no text but there are images, send a placeholder prompt
    if (!fullContent && images.length > 0) fullContent = 'Décris cette image.';
    onSend(fullContent, images.length > 0 ? images : undefined);
    setText('');
    setPickerOpen(false);
    if (onRemoveFile && attachedFiles.length > 0) {
      for (let i = attachedFiles.length - 1; i >= 0; i--) onRemoveFile(i);
    }
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, onSend, disabled, isStreaming, attachedFiles, onRemoveFile]);

  const stopRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const uploadAudio = useCallback(async (blob: Blob) => {
    if (!agentId) return;
    setTranscribing(true);
    setSttError(null);
    try {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const form = new FormData();
      form.append('file', blob, `voice.${ext}`);
      const json = await api.upload<{ ok?: boolean; text?: string; error?: string }>(
        `/api/chat/${encodeURIComponent(agentId)}/audio`,
        form,
      );
      if (!json.ok || !json.text) throw new Error(json.error ?? 'empty transcript');
      const transcript = json.text.trim();
      if (!transcript) {
        setSttError('Transcription vide');
        return;
      }
      if (autoSend) {
        onSend(transcript);
      } else {
        setText(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + transcript);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 160) + 'px';
          }
        });
      }
    } catch (err) {
      setSttError(err instanceof Error ? err.message : 'Erreur STT');
    } finally {
      setTranscribing(false);
    }
  }, [agentId, autoSend, onSend]);

  const startRecording = useCallback(async () => {
    if (!agentId || recording || transcribing || disabled) return;
    setSttError(null);
    // Hoisted so the catch can stop the mic if MediaRecorder construction or
    // start() throws after getUserMedia already opened the device (otherwise the
    // stream stays live and the mic LED stays on — leaked capture).
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      recStartRef.current = Date.now();
      rec.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream?.getTracks().forEach(t => t.stop());
        setRecording(false);
        const duration = Date.now() - recStartRef.current;
        const blob = new Blob(audioChunksRef.current, { type: rec.mimeType || 'audio/webm' });
        audioChunksRef.current = [];
        if (duration < 300 || blob.size < 1024) {
          setSttError('Enregistrement trop court');
          return;
        }
        void uploadAudio(blob);
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      // Release the mic if it was opened before the failure (e.g. MediaRecorder
      // ctor / start() threw). On the happy path rec.onstop stops the tracks, so
      // this only runs when onstop won't fire — no double-stop.
      stream?.getTracks().forEach(t => t.stop());
      setSttError(err instanceof Error ? err.message : 'Micro indisponible');
      setRecording(false);
    }
  }, [agentId, recording, transcribing, disabled, uploadAudio]);

  const handleMicClick = useCallback(() => {
    if (recording) stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording]);

  useEffect(() => () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    if (thinkSubmenuCloseTimer.current) clearTimeout(thinkSubmenuCloseTimer.current);
  }, []);

  useEffect(() => {
    if (!settingsOpen) setThinkSubmenuOpen(false);
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        settingsBtnRef.current?.contains(target) ||
        settingsPopupRef.current?.contains(target)
      ) return;
      setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    const onReflow = () => setSettingsOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [settingsOpen]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPickerIndex(i => (i + 1) % filtered.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPickerIndex(i => (i - 1 + filtered.length) % filtered.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && pickerOpen)) { e.preventDefault(); applyCommand(filtered[pickerIndex]); return; }
      if (e.key === 'Escape') { setPickerOpen(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0 && onFilesAttached) onFilesAttached(files);
  };
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0 && onFilesAttached) onFilesAttached(files);
    e.target.value = '';
  };

  return (
    <div
      className="px-3 pb-3 bg-background"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`relative rounded-2xl border bg-card transition-colors shadow-sm overflow-hidden ${dragOver ? 'border-primary bg-primary/5' : 'border-border'}`}>

        {/* Drag overlay */}
        {dragOver && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
            <span className="text-sm font-mono text-primary bg-card/90 px-4 py-2 rounded-xl border border-primary/40">
              Drop files here
            </span>
          </div>
        )}

        {/* Command picker popup */}
        {pickerOpen && filtered.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-1.5 bg-card border border-border rounded-xl shadow-xl z-20 overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border flex items-center justify-between">
              <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                Commandes — Tab/Enter
              </span>
              <span className="text-[9px] text-muted-foreground">↑↓ · Esc</span>
            </div>
            {filtered.map((cmd, i) => {
              const active = getActiveLabel(cmd.name, sessionOptions, thinkLevel);
              return (
                <button
                  key={cmd.name}
                  onMouseDown={(e) => { e.preventDefault(); applyCommand(cmd); }}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === pickerIndex ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <span className="font-mono text-[12px] text-primary font-bold shrink-0">{cmd.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground/60 shrink-0">{cmd.args}</span>
                  <span className="text-[11px] flex-1 truncate">{cmd.desc}</span>
                  {active && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-theme-green/20 text-theme-green shrink-0">
                      {active}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Attached files */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {attachedFiles.map((f, i) => (
              <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-mono bg-secondary text-muted-foreground">
                {f.isImage && f.dataUrl ? (
                  <img src={f.dataUrl} alt={f.name} className="h-5 w-5 object-cover rounded" />
                ) : (
                  <FileText size={10} />
                )}
                <span className="truncate max-w-[100px]">{f.name}</span>
                <span className="text-muted-foreground/40">{formatSize(f.size)}</span>
                {onRemoveFile && (
                  <button onClick={() => onRemoveFile(i)} className="hover:text-destructive transition-colors ml-0.5">
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message…"
          disabled={disabled}
          rows={1}
          className="w-full bg-transparent text-foreground font-mono text-[13px] px-4 pt-3 pb-2 resize-none outline-none min-h-[48px] max-h-[160px] placeholder:text-muted-foreground/40 disabled:opacity-50"
        />

        {/* Bottom action row */}
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <button
            ref={settingsBtnRef}
            onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())}
            disabled={disabled}
            className={`p-1.5 rounded-lg transition-colors disabled:opacity-40 ${
              settingsOpen
                ? 'text-foreground bg-secondary'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
            title="Paramètres du chat"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
            title="Joindre un fichier"
          >
            <Paperclip size={14} />
          </button>
          {onWarmCache && (
            <button
              onClick={onWarmCache}
              disabled={disabled || isStreaming || agentState === 'warming'}
              className={`p-1.5 rounded-lg transition-colors disabled:opacity-40 ${
                agentState === 'warming'
                  ? 'text-orange-400 animate-pulse'
                  : 'text-muted-foreground hover:text-orange-400 hover:bg-orange-500/10'
              }`}
              title="Préchauffer le cache KV"
            >
              <Flame size={14} />
            </button>
          )}
          {agentId && (
            <button
              onClick={handleMicClick}
              disabled={disabled || transcribing}
              className={`p-1.5 rounded-lg transition-colors disabled:opacity-40 ${
                recording
                  ? 'text-red-500 animate-pulse bg-red-500/10'
                  : transcribing
                    ? 'text-primary animate-pulse'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
              title={recording ? 'Arrêter l\'enregistrement' : transcribing ? 'Transcription…' : 'Enregistrer un message vocal'}
            >
              <Mic size={14} />
            </button>
          )}

          <div className="flex-1" />

          {sttError && (
            <span className="text-[9px] font-mono text-destructive mr-2 truncate max-w-[180px]" title={sttError}>
              {sttError}
            </span>
          )}

          <span className="text-[9px] text-muted-foreground/30 mr-2 hidden sm:block">
            Enter · Shift+Enter · /cmds
          </span>

          {isStreaming && !text.trim() && attachedFiles.length === 0 ? (
            <button
              onClick={onAbort}
              className="p-2 rounded-xl bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all"
              title="Arreter la generation"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!text.trim() && attachedFiles.length === 0) || disabled}
              className="p-2 rounded-xl bg-primary text-primary-foreground hover:brightness-110 transition-all disabled:opacity-40"
              title={isStreaming ? 'Interrompre et envoyer' : 'Envoyer'}
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          accept=".txt,.md,.log,.json,.csv,.tsv,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.sh,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg"
        />
      </div>

      {settingsOpen && settingsAnchor && createPortal(
        <div
          ref={settingsPopupRef}
          className="fixed z-[9999] w-72 bg-card border border-border rounded-xl shadow-xl"
          style={{ left: settingsAnchor.left, bottom: settingsAnchor.bottom }}
        >
          <div className="px-3 py-1.5 border-b border-border rounded-t-xl">
            <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
              Paramètres
            </span>
          </div>

          {onSetThinkLevel && thinkLevel !== undefined && (
            <div className="border-b border-border">
              <div
                className="relative"
                onMouseEnter={openThinkSubmenu}
                onMouseLeave={scheduleCloseThinkSubmenu}
              >
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-secondary/50 transition-colors"
                >
                  <span className="flex-1 text-[11px] font-medium text-foreground">Raisonnement</span>
                  <span className={`text-[10px] font-mono ${thinkLevel === 'off' ? 'text-muted-foreground/60' : 'text-theme-green'}`}>
                    {thinkLevel}
                  </span>
                  <ChevronRight size={12} className="text-muted-foreground/60" />
                </button>
                {thinkSubmenuOpen && (
                  <div
                    onMouseEnter={openThinkSubmenu}
                    onMouseLeave={scheduleCloseThinkSubmenu}
                    className="absolute top-0 left-full ml-1 w-28 bg-card border border-border rounded-xl shadow-xl z-10 py-1"
                  >
                    {(['off', 'low', 'med', 'high'] as const).map(level => (
                      <button
                        key={level}
                        onClick={() => onSetThinkLevel(level)}
                        className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-[11px] font-mono transition-colors hover:bg-secondary ${
                          thinkLevel === level ? 'text-theme-green' : 'text-muted-foreground'
                        }`}
                      >
                        {level}
                        {thinkLevel === level && <span className="w-1.5 h-1.5 rounded-full bg-theme-green shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {onToggleShowThink && (
                <button
                  type="button"
                  onClick={onToggleShowThink}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/50 transition-colors"
                >
                  <SwitchThumb on={!!showThink} />
                  <span className="text-[11px] text-foreground">Afficher le raisonnement</span>
                </button>
              )}
            </div>
          )}

          {onToggleShowTools && (
            <button
              type="button"
              onClick={onToggleShowTools}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer hover:bg-secondary/50 transition-colors border-b border-border"
            >
              <SwitchThumb on={!!showTools} />
              <span className="flex-1 min-w-0">
                <span className="block text-[11px] font-medium text-foreground">Afficher les tool calls</span>
                <span className="block text-[10px] text-muted-foreground/70 leading-snug mt-0.5">
                  Montre les appels d'outils de l'agent dans le fil.
                </span>
              </span>
            </button>
          )}

          {onToggleCollapseDelivered && (
            <button
              type="button"
              onClick={onToggleCollapseDelivered}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer hover:bg-secondary/50 transition-colors border-b border-border"
            >
              <SwitchThumb on={!!collapseDelivered} />
              <span className="flex-1 min-w-0">
                <span className="block text-[11px] font-medium text-foreground">Replier les messages livrés (📤)</span>
                <span className="block text-[10px] text-muted-foreground/70 leading-snug mt-0.5">
                  Quand send_to_user a livré un contenu ET qu'une réponse finale suit, la row dupliquée est repliée (badge 📤 cliquable) — évite de lire deux fois la même chose.
                </span>
              </span>
            </button>
          )}

          {agentId && (
            <button
              type="button"
              onClick={toggleAutoSend}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer hover:bg-secondary/50 transition-colors border-b border-border"
            >
              <SwitchThumb on={autoSend} />
              <span className="flex-1 min-w-0">
                <span className="block text-[11px] font-medium text-foreground">Auto-envoi vocal</span>
                <span className="block text-[10px] text-muted-foreground/70 leading-snug mt-0.5">
                  Envoie le transcript directement sans passer par le champ de saisie.
                </span>
              </span>
            </button>
          )}

          {onToggleAutoUnload && (
            <button
              type="button"
              onClick={onToggleAutoUnload}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer hover:bg-secondary/50 transition-colors"
            >
              <SwitchThumb on={!!autoUnloadOnSwitch} />
              <span className="flex-1 min-w-0">
                <span className="block text-[11px] font-medium text-foreground">Auto-unload au switch</span>
                <span className="block text-[10px] text-muted-foreground/70 leading-snug mt-0.5">
                  Décharge le modèle précédent à chaque changement d'agent. Désactive si plusieurs agents partagent le même modèle.
                </span>
              </span>
            </button>
          )}

          {onSetLoraScales && (
            <div className="px-3 py-2.5 border-t border-border space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-foreground">LoRA scales</span>
                <span className={`text-[10px] font-mono ${(loraScales?.length ?? 0) > 0 ? 'text-theme-green' : 'text-muted-foreground/60'}`}>
                  {(loraScales?.length ?? 0) === 0
                    ? 'off'
                    : `${loraScales!.length} actif${loraScales!.length > 1 ? 's' : ''}`}
                </span>
              </div>
              {(loraScales ?? []).map((scale, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <span className="text-[9px] font-mono text-muted-foreground/70 w-6 shrink-0">#{idx}</span>
                  <input
                    type="range" min={0} max={5} step={0.05}
                    value={scale}
                    onChange={e => {
                      const next = [...(loraScales ?? [])];
                      next[idx] = Number(e.target.value);
                      onSetLoraScales(next);
                    }}
                    className="flex-1 accent-primary h-1.5"
                  />
                  <span className="text-[9px] font-mono text-foreground w-9 text-right tabular-nums">
                    ×{scale.toFixed(2)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = (loraScales ?? []).filter((_, i) => i !== idx);
                      onSetLoraScales(next.length > 0 ? next : undefined);
                    }}
                    className="text-[10px] leading-none w-4 h-4 rounded border border-border hover:bg-destructive/10 hover:border-destructive hover:text-destructive text-muted-foreground/70"
                    aria-label={`Retirer LoRA #${idx}`}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const current = loraScales ?? [];
                  if (current.length >= 8) return;
                  onSetLoraScales([...current, 1.0]);
                }}
                disabled={(loraScales?.length ?? 0) >= 8}
                className="w-full text-[10px] font-medium px-2 py-1 rounded border border-border hover:bg-secondary/50 text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {(loraScales?.length ?? 0) === 0 ? '+ activer LoRA' : `+ LoRA #${loraScales!.length}`}
              </button>
            </div>
          )}

          {onCompact && (
            <button
              type="button"
              onClick={() => { setSettingsOpen(false); onCompact(); }}
              disabled={!canCompact || compacting}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left border-t border-border rounded-b-xl text-[11px] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              <ArchiveX size={13} />
              <span>{compacting ? 'Compactage…' : 'Compacter le contexte'}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
