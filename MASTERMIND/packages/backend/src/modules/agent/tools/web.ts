const DEFAULT_MAX_CHARS = 20_000;

async function fetchRaw(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': 'Mastermind-Agent/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
}

export async function webFetch(url: string, maxChars?: number): Promise<string> {
  const MAX_CHARS = maxChars ?? DEFAULT_MAX_CHARS;
  console.debug(`[tool:web_fetch] url=${url} maxChars=${MAX_CHARS}`);

  let res: Response;
  try {
    res = await fetchRaw(url);
  } catch (err) {
    throw new Error(`Fetch failed: ${err instanceof Error ? err.message : err}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const isHtml = contentType.includes('text/html');

  if (isHtml) {
    // Re-fetch via Jina Reader for clean Markdown extraction
    const jinaUrl = `https://r.jina.ai/${url}`;
    let jinaRes: Response;
    try {
      jinaRes = await fetchRaw(jinaUrl);
    } catch (err) {
      throw new Error(`Jina fetch failed: ${err instanceof Error ? err.message : err}`);
    }
    if (!jinaRes.ok) {
      throw new Error(`Jina HTTP ${jinaRes.status} — ${url}`);
    }
    const md = await jinaRes.text();
    console.debug(`[tool:web_fetch] done url=${url} isHtml=true len=${md.length}`);
    if (md.length > MAX_CHARS) {
      return md.slice(0, MAX_CHARS) + `\n\n[truncated — response was ${md.length} chars]`;
    }
    return md;
  }

  const text = await res.text();
  console.debug(`[tool:web_fetch] done url=${url} isHtml=false len=${text.length}`);
  if (text.length > MAX_CHARS) {
    return text.slice(0, MAX_CHARS) + `\n\n[truncated — response was ${text.length} chars]`;
  }
  return text;
}
