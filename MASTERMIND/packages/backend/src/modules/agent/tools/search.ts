/**
 * Brave Web Search tool — uses the Brave Search API.
 * Requires a Brave API key configured in mastermind.yml under `search.braveApiKey`.
 *
 * Process-wide throttle: Brave Free plan = 1 req/s. Concurrent callers are
 * serialized through a chained promise; each call waits until at least
 * BRAVE_MIN_INTERVAL_MS has elapsed since the previous one returned.
 */

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

const BRAVE_MIN_INTERVAL_MS = 1500;
let braveNextAllowedAt = 0;
let braveChain: Promise<void> = Promise.resolve();
let braveQueueDepth = 0;

async function throttleBrave(): Promise<void> {
  braveQueueDepth++;
  const myTurn = braveChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, braveNextAllowedAt - now);
    if (wait > 0) {
      console.log(`[tool:web_search] throttle wait=${wait}ms queueDepth=${braveQueueDepth}`);
      await new Promise(r => setTimeout(r, wait));
    }
    braveNextAllowedAt = Date.now() + BRAVE_MIN_INTERVAL_MS;
  });
  braveChain = myTurn.catch(() => {});
  try {
    await myTurn;
  } finally {
    braveQueueDepth--;
  }
}

export async function braveSearch(
  query: string,
  apiKey: string,
  count: number = 5,
): Promise<string> {
  if (!apiKey) {
    throw new Error('Brave Search API key not configured (search.braveApiKey in config)');
  }

  console.debug(`[tool:web_search] query="${query.slice(0, 80)}" count=${count}`);
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(count, 20)));

  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Brave Search request failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  await throttleBrave();
  let res = await doFetch();

  if (res.status === 429) {
    console.log('[tool:web_search] got 429, retrying once after extra backoff');
    await throttleBrave();
    res = await doFetch();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brave Search HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };

  const results = data.web?.results ?? [];
  console.debug(`[tool:web_search] results=${results.length}`);
  if (results.length === 0) {
    return 'No search results found.';
  }

  const formatted = results.map((r, i) =>
    `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.description}`,
  ).join('\n\n');

  return formatted;
}
