import type { MastermindConfig } from '@mastermind/shared';
import type { Config } from '@mastermind/codebase-search/lib';
import { findMercuryEmbeddingProvider, getMercuryEmbeddingsUrl } from '../memory-store/embedder.js';

export interface BuildOverridesOptions {
  /** Force cloud pour cet appel (typiquement embedRunner avec embedCronCloudOnly). */
  forceCloudOverride?: boolean;
}

/** Construit les surcharges de config pour le package @mastermind/codebase-search.
 *  Mercury broker only — les champs flats legacy `codebaseSearch.embedding*` ne sont plus supportés.
 *  forceCloudOverride : injecte `?prefer=cloud` dans l'URL Mercury (combine avec le toggle global).
 */
export function buildCodebaseSearchConfigOverrides(
  config: MastermindConfig | undefined,
  opts: BuildOverridesOptions = {},
): Partial<Config> | undefined {
  if (!config) return undefined;
  const mercury = findMercuryEmbeddingProvider(config.providers);
  if (!mercury) return undefined;

  const forceCloud = opts.forceCloudOverride === true || config.codebaseSearch?.embeddingForceCloud === true;
  const baseUrl = getMercuryEmbeddingsUrl(mercury) + (forceCloud ? '?prefer=cloud' : '');
  return {
    apiKey: '',          // Mercury gère l'auth
    embeddingModel: '',  // Mercury choisit selon sa chaine
    baseUrl,
  };
}
