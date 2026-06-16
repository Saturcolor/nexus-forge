const SENSITIVE_HEADER_RX = /authorization|proxy-authorization|cookie|x-api-key|api-key|token|secret/i;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

let installed = false;
let requestSeq = 0;

function shouldEnableHttpDebug(): boolean {
  const raw = process.env.MASTERMIND_HTTP_DEBUG?.trim().toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function stringifyHeaders(headers: Headers): string {
  const pairs: string[] = [];
  for (const [k, v] of headers.entries()) {
    const value = SENSITIVE_HEADER_RX.test(k) ? '[redacted]' : (v.length > 120 ? `${v.slice(0, 117)}...` : v);
    pairs.push(`${k}=${value}`);
  }
  return pairs.join(', ');
}

function getUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function getMethod(input: FetchInput, init?: FetchInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase();
  return 'GET';
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function bodyHint(init?: FetchInit): string {
  if (!init || init.body == null) return 'none';
  if (typeof init.body === 'string') return `string:${init.body.length}`;
  if (init.body instanceof URLSearchParams) return `urlencoded:${init.body.toString().length}`;
  if (init.body instanceof FormData) return 'formdata';
  if (init.body instanceof Blob) return `blob:${init.body.size}`;
  return 'stream';
}

export function installGlobalHttpDebug(): void {
  if (installed) return;
  installed = true;

  if (!shouldEnableHttpDebug()) {
    console.log('[http.out] global fetch debug disabled (MASTERMIND_HTTP_DEBUG=0)');
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const debugFetch: typeof fetch = async (input, init) => {
    const url = getUrl(input);
    if (!isHttpUrl(url)) return originalFetch(input, init);

    const id = (++requestSeq).toString(36);
    const method = getMethod(input, init);
    const reqHeaders = new Headers(
      init?.headers ?? (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined),
    );
    const started = Date.now();
    const headersLine = stringifyHeaders(reqHeaders);
    console.debug(
      `[http.out] req.start id=${id} method=${method} url=${url} body=${bodyHint(init)}${headersLine ? ` headers="${headersLine}"` : ''}`,
    );

    try {
      const res = await originalFetch(input, init);
      const ms = Date.now() - started;
      const contentType = res.headers.get('content-type') ?? '-';
      const contentLength = res.headers.get('content-length') ?? '-';
      const redirected = res.url && res.url !== url ? ` redirectedTo=${res.url}` : '';
      // 429 = rate limit on external APIs (Brave, etc.) — expected when free tier
      // saturates, not a bug. 502/503/504 = upstream blip (Mercury busy, brain-daemon
      // restart, etc.) — same pattern as the frontend api.ts gating. Demote those to
      // debug to avoid log spam; real failures (4xx/500) stay warn.
      const isExpectedTransient = res.status === 429
        || res.status === 502
        || res.status === 503
        || res.status === 504;
      const level = res.ok || isExpectedTransient ? 'debug' : 'warn';
      const line = `[http.out] req.done id=${id} method=${method} url=${url} status=${res.status} ms=${ms} ct="${contentType}" len=${contentLength}${redirected}`;
      if (level === 'warn') console.warn(line);
      else console.debug(line);
      return res;
    } catch (err) {
      const ms = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[http.out] req.error id=${id} method=${method} url=${url} ms=${ms}: ${msg}`);
      throw err;
    }
  };
  globalThis.fetch = debugFetch;

  console.log('[http.out] global fetch debug enabled');
}
