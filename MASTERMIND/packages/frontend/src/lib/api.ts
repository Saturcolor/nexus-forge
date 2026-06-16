// API key resolution order:
//   1. ?token= URL param (for iframe embedding from a parent application) — persisted to localStorage
//   2. localStorage 'mm_api_key' (set by AuthGate or by URL param)
//   3. VITE_API_KEY env (dev fallback)
// If none of the above are valid, the AuthGate will prompt the user.
import { clientLogger } from './clientLogger';

const STORAGE_KEY = 'mm_api_key';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export function getApiKey(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      localStorage.setItem(STORAGE_KEY, urlToken);
      clientLogger.info('api-auth', 'token captured from URL');
      // Strip ?token= from the visible URL
      params.delete('token');
      const clean = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (clean ? '?' + clean : ''));
      return urlToken;
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch (err) {
    clientLogger.warn('api-auth', 'getApiKey localStorage failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return import.meta.env.VITE_API_KEY || '';
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
  clientLogger.info('api-auth', 'api key stored', { hasKey: !!key });
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
  clientLogger.warn('api-auth', 'api key cleared');
}

/** Probe /api/status with the current key. Returns true on 2xx, false on 401. */
export async function verifyApiKey(): Promise<boolean> {
  const key = getApiKey();
  if (!key) return false;
  try {
    const startedAt = Date.now();
    clientLogger.debug('api', 'verifyApiKey start');
    const res = await fetch('/api/status', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    clientLogger.debug('api', 'verifyApiKey done', { status: res.status, ok: res.ok, ms: Date.now() - startedAt });
    return res.ok;
  } catch (err) {
    clientLogger.warn('api', 'verifyApiKey failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method ?? 'GET';
  const startedAt = Date.now();
  clientLogger.debug('api', 'request start', { method, path });
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getApiKey()}`,
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    clientLogger.warn('api', 'request unauthorized', { method, path, status: res.status, ms: Date.now() - startedAt });
    clearApiKey();
    // Force a reload so AuthGate intercepts on next mount
    window.location.reload();
    throw new UnauthorizedError();
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // 502/503/504 are upstream blips (Caddy can't reach backend, Mercury busy, etc.).
    // They're transient and not a frontend bug — log debug to avoid spamming the
    // server-side log ingest. 4xx and 500 stay warn (real client/server bugs).
    const isUpstreamBlip = res.status === 502 || res.status === 503 || res.status === 504;
    const logFn = isUpstreamBlip ? clientLogger.debug : clientLogger.warn;
    logFn.call(clientLogger, 'api', 'request failed', { method, path, status: res.status, ms: Date.now() - startedAt, error: err.error || res.statusText });
    throw new Error(err.error || res.statusText);
  }

  clientLogger.debug('api', 'request done', { method, path, status: res.status, ms: Date.now() - startedAt });
  // 204 No Content → resolve to null. Used by routes signalling "feature unavailable
  // for this resource" (e.g. live stats on a cloud LLM agent) — calling res.json()
  // on an empty body would throw.
  if (res.status === 204) return null as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /** Upload files via multipart form data (no Content-Type — browser sets boundary) */
  upload: <T>(path: string, formData: FormData) => {
    const startedAt = Date.now();
    clientLogger.info('api-upload', 'upload start', { path, fields: Array.from(formData.keys()).length });
    return fetch(path, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getApiKey()}` },
      body: formData,
    }).then(async (res) => {
      if (res.status === 401) {
        clientLogger.warn('api-upload', 'upload unauthorized', { path, status: res.status, ms: Date.now() - startedAt });
        clearApiKey();
        window.location.reload();
        throw new UnauthorizedError();
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        // Same gating as request() — upstream blips → debug, real failures → warn.
        const isUpstreamBlip = res.status === 502 || res.status === 503 || res.status === 504;
        const logFn = isUpstreamBlip ? clientLogger.debug : clientLogger.warn;
        logFn.call(clientLogger, 'api-upload', 'upload failed', { path, status: res.status, ms: Date.now() - startedAt, error: err.error || res.statusText });
        throw new Error(err.error || res.statusText);
      }
      clientLogger.info('api-upload', 'upload done', { path, status: res.status, ms: Date.now() - startedAt });
      return res.json() as Promise<T>;
    });
  },
};
