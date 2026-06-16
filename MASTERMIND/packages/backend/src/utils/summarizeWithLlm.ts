/**
 * Helper unifié pour « résumer un texte via le LLM et récupérer le résultat ».
 *
 * Avant, 4 call-sites faisaient leur propre `providerMod.complete()` avec des conventions
 * divergentes (résolution du modèle, cap de tokens, gestion d'erreur, validation) :
 *   - consolidation/index.ts (résumé quotidien)         → AUCUNE validation
 *   - memory-consolidation/merger.ts (merge mémoire)    → throw sur vide
 *   - agent/run.ts (auto-compact)                       → try/catch + fallback
 *   - war-room/index.ts (résumé de room)                → try/catch + fallback
 *
 * Ce helper centralise l'appel + trim + check-vide + validation optionnelle, et renvoie un
 * résultat discriminé pour que CHAQUE appelant garde sa politique (skip / throw / fallback)
 * sans réécrire la plomberie. La validation est le point d'ancrage du garde-fou anti
 * « prompt-injection with a save button » (cf. consolidation).
 */
import type { CompletionRequest } from '@mastermind/shared';
import type { ProviderModule } from '../modules/provider/index.js';

export interface SummarizeOptions {
  /** Référence modèle (resolveModel côté provider). */
  model: string;
  /** Prompt utilisateur unique (le helper l'enveloppe en message role=user). */
  prompt: string;
  /** max_completion_tokens. Omis = défaut provider. */
  maxTokens?: number;
  /** Désactiver le reasoning/thinking (merge simple). Omis = défaut provider. */
  reasoning?: boolean;
  /** Critère d'acceptation optionnel. Retourne false → résultat { ok:false, reason:'invalid' }. */
  validate?: (summary: string) => boolean;
}

export type SummarizeResult =
  | { ok: true; summary: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'error'; error?: unknown };

/**
 * Appelle le LLM, trim, vérifie le non-vide puis `validate`. Ne throw JAMAIS — renvoie un
 * résultat discriminé. L'appelant décide quoi faire d'un `ok:false` (skip / throw / fallback).
 */
export async function summarizeWithLlm(
  providerMod: ProviderModule,
  opts: SummarizeOptions,
): Promise<SummarizeResult> {
  const request: Omit<CompletionRequest, 'model' | 'stream'> = {
    messages: [{ role: 'user', content: opts.prompt }],
  };
  if (opts.maxTokens !== undefined) request.max_completion_tokens = opts.maxTokens;
  if (opts.reasoning !== undefined) request.reasoning = opts.reasoning;

  let raw: string;
  try {
    raw = await providerMod.complete(opts.model, request);
  } catch (error) {
    console.warn(`[summarize] appel LLM échoué (model=${opts.model}): ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: 'error', error };
  }

  const summary = (raw ?? '').trim();
  if (!summary) {
    console.warn(`[summarize] résumé vide (model=${opts.model})`);
    return { ok: false, reason: 'empty' };
  }
  if (opts.validate && !opts.validate(summary)) {
    console.warn(`[summarize] résumé rejeté par validate() (model=${opts.model}, ${summary.length} chars)`);
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, summary };
}
