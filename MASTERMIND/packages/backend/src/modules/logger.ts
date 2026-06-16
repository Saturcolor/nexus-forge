/**
 * Journal JSON Lines, rotation par taille (mastermind.log → .1 …), filtre par niveau.
 * Sous Linux, logrotate externe peut compléter la rotation intégrée.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LogLevelName } from '@mastermind/shared';

export type LogLevel = LogLevelName;

const VALID_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

function coerceLevel(v: string | undefined, fallback: LogLevel): LogLevel {
  if (v && (VALID_LEVELS as string[]).includes(v)) return v as LogLevel;
  return fallback;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  tag: string;
  msg: string;
}

const RING_SIZE = 3000;
const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export interface LoggerRuntimeOptions {
  logFilePath: string;
  minLevel: LogLevel;
  maxFileSizeMb: number;
  maxFiles: number;
}

function levelPasses(entryLevel: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[entryLevel] >= LEVEL_ORDER[minLevel];
}

/** Résout le chemin du fichier log (défaut : répertoire parent du YAML + ../logs/mastermind.log). */
export function resolveLogFilePath(
  configPath: string,
  fileFromConfig: string | undefined,
): string {
  const dir = path.dirname(path.resolve(configPath));
  if (fileFromConfig?.trim()) {
    const f = fileFromConfig.trim();
    return path.isAbsolute(f) ? f : path.resolve(dir, f);
  }
  return path.resolve(dir, '..', 'logs', 'mastermind.log');
}

/** Fusionne defaults + YAML + overrides env (MASTERMIND_LOG_LEVEL, MASTERMIND_LOG_FILE). */
export function buildLoggerOptions(
  configPath: string,
  logging: { level?: LogLevel; file?: string; maxFileSizeMb?: number; maxFiles?: number } | undefined,
): LoggerRuntimeOptions {
  const minLevel = coerceLevel(
    process.env.MASTERMIND_LOG_LEVEL,
    coerceLevel(logging?.level, 'INFO'),
  );
  const logFilePath = process.env.MASTERMIND_LOG_FILE?.trim()
    ? path.resolve(process.env.MASTERMIND_LOG_FILE.trim())
    : resolveLogFilePath(configPath, logging?.file);
  const maxFileSizeMb = logging?.maxFileSizeMb ?? 50;
  const maxFiles = logging?.maxFiles ?? 5;
  return {
    logFilePath,
    minLevel,
    maxFileSizeMb,
    maxFiles,
  };
}

export class Logger {
  private buffer: LogEntry[] = [];
  private logFilePath: string;
  private minLevel: LogLevel;
  private maxFileSizeBytes: number;
  private maxFiles: number;

  constructor(opts: LoggerRuntimeOptions) {
    this.logFilePath = opts.logFilePath;
    this.minLevel = opts.minLevel;
    this.maxFileSizeBytes = Math.max(1, opts.maxFileSizeMb) * 1024 * 1024;
    this.maxFiles = Math.max(2, Math.min(100, opts.maxFiles));
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
    this.interceptConsole();
  }

  /** Applique à chaud niveau, tailles, ou chemin (réouvre l’écriture sur le nouveau fichier). */
  setOptions(partial: Partial<LoggerRuntimeOptions>): void {
    if (partial.minLevel !== undefined) this.minLevel = partial.minLevel;
    if (partial.maxFileSizeMb !== undefined) {
      this.maxFileSizeBytes = Math.max(1, partial.maxFileSizeMb) * 1024 * 1024;
    }
    if (partial.maxFiles !== undefined) {
      this.maxFiles = Math.max(2, Math.min(100, partial.maxFiles));
    }
    if (partial.logFilePath !== undefined && partial.logFilePath !== this.logFilePath) {
      this.logFilePath = partial.logFilePath;
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
    }
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  getMinLevel(): LogLevel {
    return this.minLevel;
  }

  private shouldPersist(level: LogLevel): boolean {
    return levelPasses(level, this.minLevel);
  }

  private appendLineToFile(line: string): void {
    let size = 0;
    try {
      size = fs.statSync(this.logFilePath).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const add = Buffer.byteLength(line, 'utf8');
    if (size > 0 && size + add > this.maxFileSizeBytes) {
      this.rotateFilesSync();
    }
    fs.appendFileSync(this.logFilePath, line, 'utf8');
  }

  private rotateFilesSync(): void {
    const dir = path.dirname(this.logFilePath);
    const base = path.basename(this.logFilePath);
    const max = this.maxFiles;
    const lastNum = max - 1;
    const lastPath = path.join(dir, `${base}.${lastNum}`);
    if (fs.existsSync(lastPath)) {
      try {
        fs.unlinkSync(lastPath);
      } catch {
        /* ignore */
      }
    }
    for (let i = lastNum - 1; i >= 1; i--) {
      const from = path.join(dir, `${base}.${i}`);
      const to = path.join(dir, `${base}.${i + 1}`);
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }
    const firstArchive = path.join(dir, `${base}.1`);
    if (fs.existsSync(this.logFilePath)) {
      try {
        fs.renameSync(this.logFilePath, firstArchive);
      } catch {
        /* ignore */
      }
    }
  }

  private push(entry: LogEntry): void {
    if (this.shouldPersist(entry.level)) {
      const line = JSON.stringify(entry) + '\n';
      try {
        this.appendLineToFile(line);
      } catch (err) {
        const orig = console.error;
        orig.call(console, '[logger] append failed:', (err as Error).message);
      }
      this.buffer.push(entry);
      if (this.buffer.length > RING_SIZE) this.buffer.shift();
    }
  }

  private parseArgs(args: unknown[]): { tag: string; msg: string } {
    const first = String(args[0] ?? '');
    const m = first.match(/^\[([^\]]+)\](.*)/s);
    if (m) {
      const rest = args.slice(1).map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      return { tag: m[1].trim(), msg: (m[2] + (rest ? ' ' + rest : '')).trim() };
    }
    return {
      tag: 'system',
      msg: args.map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
    };
  }

  private interceptConsole(): void {
    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug?.bind(console),
    };

    const intercept = (level: LogLevel, origFn: (...a: unknown[]) => void) =>
      (...args: unknown[]) => {
        origFn(...args);
        const { tag, msg } = this.parseArgs(args);
        this.push({ ts: new Date().toISOString(), level, tag, msg });
      };

    console.log = intercept('INFO', orig.log);
    console.warn = intercept('WARN', orig.warn);
    console.error = intercept('ERROR', orig.error);
    if (orig.debug) console.debug = intercept('DEBUG', orig.debug);
  }

  debug(tag: string, msg: string): void {
    this.push({ ts: new Date().toISOString(), level: 'DEBUG', tag, msg });
  }
  info(tag: string, msg: string): void {
    this.push({ ts: new Date().toISOString(), level: 'INFO', tag, msg });
  }
  warn(tag: string, msg: string): void {
    this.push({ ts: new Date().toISOString(), level: 'WARN', tag, msg });
  }
  error(tag: string, msg: string): void {
    this.push({ ts: new Date().toISOString(), level: 'ERROR', tag, msg });
  }

  private readEntriesFromFile(maxLines: number): LogEntry[] {
    const entries: LogEntry[] = [];
    try {
      const content = fs.readFileSync(this.logFilePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines.slice(-maxLines)) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (entry.ts && entry.level && entry.tag != null && entry.msg != null) {
            entries.push(entry);
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.buffer.push({
          ts: new Date().toISOString(),
          level: 'WARN',
          tag: 'logger',
          msg: `Could not read log file: ${(err as Error).message}`,
        });
      }
    }
    return entries;
  }

  getEntries(opts?: { tail?: number; minLevel?: LogLevel; search?: string; tag?: string; excludeTags?: string[] }): LogEntry[] {
    const tail = opts?.tail ?? 500;
    const fileMult = opts?.tag?.trim() ? 8 : 2;
    const fromFile = this.readEntriesFromFile(tail * fileMult);

    const oldestBufferTs = this.buffer.length > 0 ? this.buffer[0].ts : null;
    const fileOnly = oldestBufferTs ? fromFile.filter(e => e.ts < oldestBufferTs) : fromFile;
    let entries = [...fileOnly, ...this.buffer];
    entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    if (opts?.minLevel) {
      const min = LEVEL_ORDER[opts.minLevel];
      entries = entries.filter(e => LEVEL_ORDER[e.level] >= min);
    }
    if (opts?.search) {
      const s = opts.search.toLowerCase();
      entries = entries.filter(e => e.msg.toLowerCase().includes(s) || e.tag.toLowerCase().includes(s));
    }
    if (opts?.tag?.trim()) {
      const t = opts.tag.trim().toLowerCase();
      entries = entries.filter(e => e.tag.toLowerCase().includes(t));
    }
    if (opts?.excludeTags?.length) {
      const excluded = opts.excludeTags.map(t => t.toLowerCase());
      entries = entries.filter(e => !excluded.some(ex => e.tag.toLowerCase().includes(ex)));
    }
    if (tail > 0) {
      entries = entries.slice(-tail);
    }
    return entries;
  }

  close(): void {
    /* appendFileSync — rien à fermer */
  }
}

let _instance: Logger | null = null;

export function initLogger(opts: LoggerRuntimeOptions): Logger {
  _instance = new Logger(opts);
  return _instance;
}

export function getLogger(): Logger {
  if (!_instance) throw new Error('Logger not initialized — call initLogger() first');
  return _instance;
}

/** Applique la config logging Mastermind + persistance (chemins résolus). */
export function applyLoggingFromConfig(
  configPath: string,
  logging: { level?: LogLevel; file?: string; maxFileSizeMb?: number; maxFiles?: number } | undefined,
): void {
  const opts = buildLoggerOptions(configPath, logging);
  const log = getLogger();
  const nextPath = opts.logFilePath;
  log.setOptions({
    minLevel: opts.minLevel,
    maxFileSizeMb: opts.maxFileSizeMb,
    maxFiles: opts.maxFiles,
    ...(nextPath !== log.getLogFilePath() ? { logFilePath: nextPath } : {}),
  });
}
