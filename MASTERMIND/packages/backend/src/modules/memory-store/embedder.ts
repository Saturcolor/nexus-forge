/**
 * Génération d'embeddings pour le memory store.
 * Réutilise le même endpoint/modèle que codebase-search (via MastermindConfig).
 */
import type { MastermindConfig, ProviderConfig } from '@mastermind/shared';
import { fetchWithRetry } from '../provider/utils.js';

export interface EmbedConfig {
  apiKey: string;
  embeddingModel: string;
  baseUrl?: string;
}

/** Options pour buildEmbedConfig — permet aux call sites (ex. embedRunner cron) de forcer cloud. */
export interface BuildEmbedOptions {
  /** Force cloud pour cet appel uniquement (override le toggle global embeddingForceCloud). */
  forceCloudOverride?: boolean;
}

const MAX_CHARS = 8000;
const FETCH_TIMEOUT_MS = 120_000;

/** Trouve le provider avec embeddingFallbackEnabled=true (le toggle suffit comme déclaration broker). */
export function findMercuryEmbeddingProvider(providers?: ProviderConfig[]): ProviderConfig | null {
  if (!providers || providers.length === 0) return null;
  return providers.find(p => p.embeddingFallbackEnabled === true) ?? null;
}

/** Normalise l'URL Mercury : si baseUrl finit déjà par /v1, on n'ajoute que le suffixe ; sinon on ajoute /v1 + suffixe. */
function joinMercuryUrl(provider: ProviderConfig, suffix: string): string {
  const base = (provider.statsUrl || provider.baseUrl).replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}${suffix}` : `${base}/v1${suffix}`;
}

/** URL POST /v1/embeddings (broker). */
export function getMercuryEmbeddingsUrl(provider: ProviderConfig): string {
  return joinMercuryUrl(provider, '/embeddings');
}

/** URL GET /v1/embeddings/chain (introspection pour validation dim). */
export function getMercuryEmbeddingChainUrl(provider: ProviderConfig): string {
  return joinMercuryUrl(provider, '/embeddings/chain');
}

/** Construit la config embedding via un provider Mercury (broker only — legacy flat fields supprimés).
 *  forceCloudOverride : passe `?prefer=cloud` à Mercury pour skip les entrées local de la chaine.
 *  Combine avec le toggle global `codebaseSearch.embeddingForceCloud`.
 */
export function buildEmbedConfig(config: MastermindConfig, opts: BuildEmbedOptions = {}): EmbedConfig {
  const mercury = findMercuryEmbeddingProvider(config.providers);
  if (!mercury) {
    throw new Error(
      '[memory-store] aucun provider Mercury n\'a embeddingFallbackEnabled. ' +
      'Active le toggle « Embed » sur un provider dans ProvidersPage.',
    );
  }
  const forceCloud = opts.forceCloudOverride === true || config.codebaseSearch?.embeddingForceCloud === true;
  const baseUrl = getMercuryEmbeddingsUrl(mercury) + (forceCloud ? '?prefer=cloud' : '');
  return {
    apiKey: '',          // Mercury gère l'auth cloud lui-même
    embeddingModel: '',  // Mercury choisit selon sa chaine
    baseUrl,
  };
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const nl = cut.lastIndexOf('\n');
  return nl > 0 ? cut.slice(0, nl) : cut;
}

/** Génère les embeddings de plusieurs textes */
export async function embedTexts(texts: string[], cfg: EmbedConfig): Promise<number[][]> {
  if (texts.length === 0) return [];
  const url = cfg.baseUrl ?? 'https://openrouter.ai/api/v1/embeddings';
  const input = texts.map(truncate);
  const charTotal = input.reduce((a, t) => a + t.length, 0);
  console.debug(`[memory-store] embedTexts n=${texts.length} chars≈${charTotal} url=${url}`);

  const payload: Record<string, unknown> = { input, encoding_format: 'float' };
  if (cfg.embeddingModel) payload.model = cfg.embeddingModel;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = (await res.text()).slice(0, 200);
    throw new Error(`[memory-store] Embedding API error (${res.status}): ${err}`);
  }
  const data = await res.json() as { data: { index: number; embedding: number[] }[] };
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

/** Génère l'embedding d'un seul texte */
export async function embedText(text: string, cfg: EmbedConfig): Promise<number[]> {
  const [vec] = await embedTexts([text], cfg);
  return vec!;
}
