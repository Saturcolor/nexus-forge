import { Config } from './types.js';

interface OpenAIEmbeddingResponse {
  object: string;
  data: {
    object: string;
    index: number;
    embedding: number[];
  }[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// Troncation par texte pour rester sous 8192 tokens même en code dense (~1.2 car/token) → max 8000 car
const MAX_CHARS = 8000;
// Limite par requête : 8192 tokens. Pour le code ~2.5–3 car/token → max ~20000 car ; on reste à 16000 pour marge
const MAX_CHARS_PER_BATCH = 16000;
const MAX_RETRIES = 3;

function truncateText(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const truncated = text.slice(0, MAX_CHARS);
  const lastNewline = truncated.lastIndexOf('\n');
  return lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
}

// Timeout genereux : les grands modeles d'embedding (Qwen3-8b) peuvent prendre 90s+ pour un gros batch
const FETCH_TIMEOUT_MS = 120_000;
const RATE_LIMIT_BACKOFF_MS = [500, 1_000, 2_000];
const SERVER_ERROR_BACKOFF_MS = 1_000;

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string; cause?: { code?: string } }).code
    ?? (error as Error & { cause?: { code?: string } }).cause?.code;
  return code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || error.name === 'TimeoutError'
    || error.message.includes('timeout')
    || error.message.includes('ECONNRESET')
    || error.message.includes('ETIMEDOUT');
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempt: number = 0,
): Promise<Response> {
  const optionsWithTimeout: RequestInit = {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  try {
    const response = await fetch(url, optionsWithTimeout);
    if (!response.ok && response.status === 429 && attempt < MAX_RETRIES) {
      const delay = retryAfterMs(response) ?? jitter(RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)]!);
      console.warn(`HTTP ${response.status} — retry ${attempt + 1}/${MAX_RETRIES} dans ${delay}ms`);
      await response.body?.cancel().catch(() => {});
      await sleep(delay);
      return fetchWithRetry(url, options, attempt + 1);
    }
    if (!response.ok && response.status >= 500 && attempt < 1) {
      console.warn(`HTTP ${response.status} — retry ${attempt + 1}/1 dans ${SERVER_ERROR_BACKOFF_MS}ms`);
      await response.body?.cancel().catch(() => {});
      await sleep(SERVER_ERROR_BACKOFF_MS);
      return fetchWithRetry(url, options, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt < 1 && isRetryableNetworkError(error)) {
      console.warn(`Network error — retry ${attempt + 1}/1 dans ${SERVER_ERROR_BACKOFF_MS}ms`);
      await sleep(SERVER_ERROR_BACKOFF_MS);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw error;
  }
}

export async function generateEmbeddings(
  texts: string[],
  config: Config
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Mode broker (Mercury) : config.apiKey === '' explicitement, on ne consulte pas les env vars
  // pour pas injecter accidentellement la clé OpenRouter (Mercury gère l'auth de son côté).
  const brokerMode = config.apiKey === '' && Boolean(config.baseUrl);
  const apiKey = brokerMode
    ? ''
    : (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || config.apiKey);
  if (!brokerMode && !apiKey) {
    throw new Error('OPENROUTER_API_KEY/OPENAI_API_KEY non définie(s) et apiKey non configuré');
  }
  
  // Tronquer les textes trop longs
  const truncatedTexts = texts.map(truncateText);

  // Batches dynamiques : somme des caractères par batch <= MAX_CHARS_PER_BATCH (limite 8192 tokens/requête)
  const batches: string[][] = [];
  let i = 0;
  while (i < truncatedTexts.length) {
    const batch: string[] = [];
    let charCount = 0;
    while (
      i < truncatedTexts.length &&
      (charCount + truncatedTexts[i].length <= MAX_CHARS_PER_BATCH || batch.length === 0)
    ) {
      batch.push(truncatedTexts[i]);
      charCount += truncatedTexts[i].length;
      i++;
    }
    batches.push(batch);
  }

  const results: number[][] = [];
  let processedCount = 0;
  const totalBatches = batches.length;

  for (let batchNum = 0; batchNum < batches.length; batchNum++) {
    const batch = batches[batchNum];

    try {
      const embeddingUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1/embeddings';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const payload: Record<string, unknown> = { input: batch, encoding_format: 'float' };
      if (config.embeddingModel) payload.model = config.embeddingModel;

      const response = await fetchWithRetry(
        embeddingUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const rawError = await response.text();
        // Truncate to avoid leaking verbose provider error bodies upstream
        const safeError = rawError.slice(0, 200);
        throw new Error(`Embedding API error (${response.status}): ${safeError}`);
      }

      const data = (await response.json()) as OpenAIEmbeddingResponse;

      // Garde-fou alignement : le contrat OpenAI embeddings garantit 1 embedding par input,
      // dans le même ordre via `index`. Si le provider (broker Mercury / cascade local→cloud,
      // succès partiel renvoyé en 200, dédup...) renvoie un nombre d'embeddings différent du
      // batch envoyé, le tableau plat `results` se décale : tous les chunks suivants seraient
      // appariés au MAUVAIS vecteur et les derniers recevraient `undefined` (cf. indexer.ts
      // `vector: embeddings[j]!`). On préfère échouer bruyamment (erreur attrapée par le catch
      // du batch puis re-throw) plutôt qu'écrire des vecteurs désalignés/undefined dans l'index.
      if (!Array.isArray(data.data) || data.data.length !== batch.length) {
        throw new Error(
          `Embedding count mismatch: provider a renvoyé ${Array.isArray(data.data) ? data.data.length : 'aucun'} embedding(s) pour ${batch.length} input(s) (batch ${batchNum + 1}/${totalBatches})`
        );
      }

      // Trier par index pour garder l'ordre
      const sortedData = data.data.sort((a, b) => a.index - b.index);

      // Vérifier que chaque slot [0..batch.length) est couvert exactement une fois par un
      // embedding valide. Protège contre un `index` hors borne / dupliqué / un embedding vide
      // qui survivrait au seul check de longueur ci-dessus et corromprait silencieusement l'index.
      for (let k = 0; k < sortedData.length; k++) {
        const d = sortedData[k]!;
        if (d.index !== k) {
          throw new Error(
            `Embedding index out of order/range: attendu ${k}, reçu ${d.index} (batch ${batchNum + 1}/${totalBatches})`
          );
        }
        if (!Array.isArray(d.embedding) || d.embedding.length === 0) {
          throw new Error(
            `Embedding vide/invalide à l'index ${d.index} (batch ${batchNum + 1}/${totalBatches})`
          );
        }
      }

      results.push(...sortedData.map((d) => d.embedding));

      processedCount += batch.length;

      // Afficher progression tous les 10 batches
      if ((batchNum + 1) % 10 === 0 || batchNum + 1 === totalBatches) {
        console.log(
          `  Embeddings... ${processedCount}/${truncatedTexts.length} (${batchNum + 1}/${totalBatches} batches)`
        );
      }

      // Pause pour rate limits
      if (batchNum + 1 < batches.length) {
        await sleep(50);
      }
    } catch (error) {
      console.error(`\n❌ Erreur sur le batch ${batchNum + 1}:`, error);
      throw error;
    }
  }

  return results;
}

export async function generateEmbedding(
  text: string,
  config: Config
): Promise<number[]> {
  const embeddings = await generateEmbeddings([text], config);
  const embedding = embeddings[0];
  // generateEmbeddings peut renvoyer [] (input dégénéré côté provider : data:[] en 200 sur
  // input vide/whitespace). Le type de retour number[] mentirait alors et embedding=undefined
  // se propagerait dans table.search(undefined) -> erreur opaque LanceDB. On échoue clair ici.
  if (!embedding) {
    throw new Error('Embedding provider returned no vector for the given input');
  }
  return embedding;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fonction pour générer des embeddings mock (pour tests sans API)
export function generateMockEmbedding(dimensions: number = 1536): number[] {
  return Array.from({ length: dimensions }, () => (Math.random() - 0.5) * 0.1);
}

export function generateMockEmbeddings(
  count: number,
  dimensions: number = 1536
): number[][] {
  return Array.from({ length: count }, () => generateMockEmbedding(dimensions));
}
