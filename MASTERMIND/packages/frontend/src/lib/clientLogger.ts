type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface ClientLogEntry {
  level: ClientLogLevel;
  tag: string;
  message: string;
  ts: string;
  url: string;
  route: string;
  data?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
}

const STORAGE_KEY = 'mm_api_key';
const MAX_QUEUE = 200;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_DATA_STRING = 1_500;
const SENSITIVE_HEADER_RX = /authorization|proxy-authorization|cookie|x-api-key|api-key|token|secret/i;
const CLIENT_LOG_PATH = '/api/client-logs';

const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function getApiKeyForLog(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || import.meta.env.VITE_API_KEY || '';
  } catch {
    return import.meta.env.VITE_API_KEY || '';
  }
}

function safeData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/token|authorization|apikey|apiKey|password|secret/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') out[key] = value.slice(0, MAX_DATA_STRING);
    else if (typeof value === 'number' || typeof value === 'boolean' || value == null) out[key] = value;
    else {
      try {
        out[key] = JSON.stringify(value).slice(0, MAX_DATA_STRING);
      } catch {
        out[key] = '[unserializable]';
      }
    }
  }
  return out;
}

function safeString(value: unknown, max = MAX_DATA_STRING): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, max);
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function getFetchUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function getFetchMethod(input: FetchInput, init?: FetchInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase();
  return 'GET';
}

function fetchBodyHint(init?: FetchInit): string {
  if (!init || init.body == null) return 'none';
  if (typeof init.body === 'string') return `string:${init.body.length}`;
  if (init.body instanceof URLSearchParams) return `urlencoded:${init.body.toString().length}`;
  if (init.body instanceof FormData) return `formdata:${Array.from(init.body.keys()).length}`;
  if (init.body instanceof Blob) return `blob:${init.body.size}`;
  return 'stream';
}

function stringifyHeaders(headers: Headers): string {
  const pairs: string[] = [];
  for (const [k, v] of headers.entries()) {
    const value = SENSITIVE_HEADER_RX.test(k) ? '[redacted]' : v.slice(0, 160);
    pairs.push(`${k}=${value}`);
  }
  return pairs.join(', ');
}

function safeUrl(url: string): string {
  return url
    .replace(/([?&](?:token|api_key|apikey|key|password|secret)=)[^&]+/gi, '$1[redacted]')
    .slice(0, 1_000);
}

function isClientLogUrl(url: string): boolean {
  try {
    return new URL(url, window.location.origin).pathname === CLIENT_LOG_PATH;
  } catch {
    return url.includes(CLIENT_LOG_PATH);
  }
}

class ClientLogger {
  private queue: ClientLogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private initialized = false;
  private consoleCaptureInstalled = false;
  private fetchCaptureInstalled = false;
  private browserEventCaptureInstalled = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.installConsoleCapture();
    this.installFetchCapture();
    this.installBrowserEventCapture();

    window.addEventListener('error', (event) => {
      this.error('window', event.message || 'Unhandled browser error', {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      this.error('promise', reason instanceof Error ? reason.message : 'Unhandled promise rejection', {
        stack: reason instanceof Error ? reason.stack : undefined,
        reason: reason instanceof Error ? reason.name : String(reason).slice(0, 500),
      });
    });

    window.addEventListener('pagehide', () => void this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });

    this.info('bootstrap', 'frontend logger initialized', {
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      language: navigator.language,
      online: navigator.onLine,
    });
  }

  debug(tag: string, message: string, data?: Record<string, unknown>): void {
    originalConsole.debug(`[${tag}] ${message}`, data ?? '');
    this.enqueue('debug', tag, message, data);
  }

  info(tag: string, message: string, data?: Record<string, unknown>): void {
    originalConsole.log(`[${tag}] ${message}`, data ?? '');
    this.enqueue('info', tag, message, data);
  }

  warn(tag: string, message: string, data?: Record<string, unknown>): void {
    originalConsole.warn(`[${tag}] ${message}`, data ?? '');
    this.enqueue('warn', tag, message, data);
  }

  error(tag: string, message: string, data?: Record<string, unknown>): void {
    originalConsole.error(`[${tag}] ${message}`, data ?? '');
    this.enqueue('error', tag, message, data);
    void this.flush();
  }

  private enqueue(level: ClientLogLevel, tag: string, message: string, data?: Record<string, unknown>): void {
    this.queue.push({
      level,
      tag,
      message,
      ts: new Date().toISOString(),
      url: window.location.href.replace(/([?&]token=)[^&]+/i, '$1[redacted]'),
      route: window.location.pathname,
      data: safeData(data),
      agentId: typeof data?.agentId === 'string' ? data.agentId : undefined,
      sessionId: typeof data?.sessionId === 'string' ? data.sessionId : undefined,
    });
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    const apiKey = getApiKeyForLog();
    if (!apiKey) return;
    const entries = this.queue.splice(0, 50);
    this.flushing = true;
    try {
      const res = await fetch('/api/client-logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ entries }),
        keepalive: true,
      });
      if (!res.ok) {
        this.queue.unshift(...entries);
        originalConsole.warn('[client-logger] flush failed', res.status);
      }
    } catch (err) {
      this.queue.unshift(...entries);
      originalConsole.warn('[client-logger] flush error', err);
    } finally {
      this.flushing = false;
    }
  }

  private installConsoleCapture(): void {
    if (this.consoleCaptureInstalled) return;
    this.consoleCaptureInstalled = true;

    const capture = (level: ClientLogLevel, original: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        original(...args);
        this.enqueue(level, 'console', args.map(a => safeString(a, 500)).join(' '), {
          argc: args.length,
        });
      };

    console.debug = capture('debug', originalConsole.debug);
    console.info = capture('info', originalConsole.info);
    console.log = capture('info', originalConsole.log);
    console.warn = capture('warn', originalConsole.warn);
    console.error = capture('error', originalConsole.error);
  }

  private installFetchCapture(): void {
    if (this.fetchCaptureInstalled) return;
    this.fetchCaptureInstalled = true;

    const originalFetch = window.fetch.bind(window);
    const debugFetch: typeof fetch = async (input, init) => {
      const rawUrl = getFetchUrl(input);
      if (isClientLogUrl(rawUrl)) return originalFetch(input, init);

      const id = Math.random().toString(36).slice(2, 9);
      const startedAt = performance.now();
      const method = getFetchMethod(input, init);
      const reqHeaders = new Headers(
        init?.headers ?? (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined),
      );
      const headers = stringifyHeaders(reqHeaders);
      this.debug('http.out', 'fetch start', {
        id,
        method,
        url: safeUrl(rawUrl),
        body: fetchBodyHint(init),
        ...(headers ? { headers } : {}),
      });

      try {
        const res = await originalFetch(input, init);
        const ms = Math.round(performance.now() - startedAt);
        const data = {
          id,
          method,
          url: safeUrl(rawUrl),
          status: res.status,
          ok: res.ok,
          ms,
          contentType: res.headers.get('content-type') ?? '-',
          contentLength: res.headers.get('content-length') ?? '-',
          redirected: res.redirected,
          finalUrl: res.url && res.url !== rawUrl ? safeUrl(res.url) : undefined,
        };
        if (res.ok) {
          this.debug('http.out', 'fetch done', data);
        } else {
          // 429/502/503/504 = expected transient (rate limit, upstream blip).
          // Same gating as api.ts and http-debug.ts — demote to debug to avoid
          // shipping warns to the server log ingest for things that aren't bugs.
          const isTransient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
          if (isTransient) this.debug('http.out', 'fetch non-2xx', data);
          else this.warn('http.out', 'fetch non-2xx', data);
        }
        return res;
      } catch (err) {
        // `TypeError: Failed to fetch` is the browser's catch-all for network-layer
        // failures: TCP refused, DNS unresolved, CORS preflight rejected, Tailscale
        // blip, server briefly restarting, etc. They arrive in grappes (every poll
        // hits the same wall) and aren't actionable — the next poll either succeeds
        // or another error path (offline indicator, /health failing) surfaces it.
        // Demote to debug to avoid shipping warns to the server log ingest. Genuine
        // bugs (e.g. malformed URL throws an Error other than TypeError) stay error.
        const errMessage = err instanceof Error ? err.message : String(err);
        const isTransient = err instanceof TypeError && /Failed to fetch|NetworkError|Load failed/i.test(errMessage);
        const data = {
          id,
          method,
          url: safeUrl(rawUrl),
          ms: Math.round(performance.now() - startedAt),
          error: errMessage,
          stack: err instanceof Error ? err.stack : undefined,
        };
        if (isTransient) this.debug('http.out', 'fetch error (transient)', data);
        else this.error('http.out', 'fetch error', data);
        throw err;
      }
    };
    window.fetch = debugFetch;
  }

  private installBrowserEventCapture(): void {
    if (this.browserEventCaptureInstalled) return;
    this.browserEventCaptureInstalled = true;

    window.addEventListener('online', () => this.info('browser', 'network online'));
    window.addEventListener('offline', () => this.warn('browser', 'network offline'));
    window.addEventListener('focus', () => this.debug('browser', 'window focus'));
    window.addEventListener('blur', () => this.debug('browser', 'window blur'));
    window.addEventListener('pageshow', (event) => this.debug('browser', 'page show', { persisted: event.persisted }));
    window.addEventListener('pagehide', (event) => this.debug('browser', 'page hide', { persisted: event.persisted }));
    document.addEventListener('visibilitychange', () => {
      this.debug('browser', 'visibility change', { visibilityState: document.visibilityState });
    });
    window.addEventListener('popstate', () => this.info('navigation', 'popstate', { route: window.location.pathname }));
    window.addEventListener('hashchange', () => this.info('navigation', 'hashchange', { route: window.location.pathname, hash: window.location.hash }));

    const wrapHistory = (name: 'pushState' | 'replaceState') => {
      const original = history[name].bind(history);
      history[name] = ((state: unknown, title: string, url?: string | URL | null) => {
        const ret = original(state, title, url);
        this.info('navigation', name, {
          route: window.location.pathname,
          target: typeof url === 'string' || url instanceof URL ? safeUrl(String(url)) : undefined,
        });
        return ret;
      }) as History[typeof name];
    };
    wrapHistory('pushState');
    wrapHistory('replaceState');
  }
}

export const clientLogger = new ClientLogger();
