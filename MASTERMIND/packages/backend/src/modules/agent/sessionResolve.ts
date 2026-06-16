import type { AgentConfig } from '@mastermind/shared';

/**
 * Couche de résolution de session pour le mode "session unifiée" (cross-plateforme).
 *
 * Source de vérité UNIQUE de la canonicalisation : tous les points d'entrée (REST chat,
 * WS web/mobile, bridge Telegram, NCM) passent par ici. Quand `unifiedSession` est actif
 * pour un agent, web + mobile + NCM + le DM Telegram owner convergent vers une seule
 * session `{agentId}-unified` ; la conversation suit l'utilisateur d'un device à l'autre,
 * avec un seul KV chaud.
 */

/** Suffixe canonique de la session unifiée cross-plateforme. */
export const UNIFIED_SESSION_SUFFIX = '-unified';

/** Id canonique de la session unifiée d'un agent (titre affiché : "Cross-plateforme"). */
export function unifiedSessionId(agentId: string): string {
  return `${agentId}${UNIFIED_SESSION_SUFFIX}`;
}

/** True si `sessionId` est la session unifiée de `agentId`. */
export function isUnifiedSessionId(agentId: string, sessionId: string): boolean {
  return sessionId === unifiedSessionId(agentId);
}

/**
 * Résout l'id de session effectif pour un point d'entrée web / mobile / NCM.
 *  - `unifiedSession` OFF → renvoie `requestedId` tel quel (legacy : une session par canal).
 *  - ON → renvoie TOUJOURS l'id canonique `{agentId}-unified`, quel que soit ce que le
 *    client a demandé (`{agent}-web`, `{agent}-mobile`, …). Cette canonicalisation serveur
 *    permet aux clients legacy de continuer d'envoyer leur suffixe et d'atterrir quand même
 *    dans l'unifiée — aucune mise à jour client n'est requise pour que le merge fonctionne
 *    (le polish client = s'abonner directement au canonique pour le streaming).
 */
export function resolveSessionId(
  agentId: string,
  requestedId: string,
  agentConfig: Pick<AgentConfig, 'unifiedSession'>,
): string {
  return agentConfig.unifiedSession ? unifiedSessionId(agentId) : requestedId;
}

/**
 * Vue minimale (structurelle) suffisante pour la résolution Telegram. Satisfaite à la fois
 * par `AgentConfig` (runtime) et par la config YAML brute (`config.agents[id]`) — on évite
 * ainsi de coupler ce helper à l'un ou l'autre des deux types.
 */
export interface UnifiedTelegramView {
  unifiedSession?: boolean;
  telegram?: { chatIds?: number[]; primaryChatId?: number };
}

/**
 * Chat Telegram "owner" qui fold dans la session unifiée.
 *  - `primaryChatId` explicite → toujours prioritaire (permet de désigner n'importe quel chat).
 *  - sinon fallback sur `chatIds[0]` UNIQUEMENT si c'est un chat privé (id Telegram positif =
 *    DM). Les groupes/supergroupes ont un id négatif : on refuse de les fold automatiquement
 *    (sinon un groupe listé en premier polluerait la session cross-plateforme). Pour fold un
 *    groupe il faut le déclarer explicitement via `primaryChatId`.
 */
export function primaryTelegramChatId(agentConfig: UnifiedTelegramView): number | undefined {
  if (agentConfig.telegram?.primaryChatId !== undefined) return agentConfig.telegram.primaryChatId;
  const first = agentConfig.telegram?.chatIds?.[0];
  return first !== undefined && first > 0 ? first : undefined;
}

/**
 * Résout l'id de session pour un message Telegram entrant.
 *  - `unifiedSession` ON ET `chatId` === chat owner primaire → session unifiée.
 *  - sinon (flag off, ou groupe Telegram non-primaire) → `{agentId}-tg-{chatId}` (legacy).
 */
export function resolveTelegramSessionId(
  agentId: string,
  chatId: number,
  agentConfig: UnifiedTelegramView | undefined,
): string {
  if (agentConfig?.unifiedSession && chatId === primaryTelegramChatId(agentConfig)) {
    return unifiedSessionId(agentId);
  }
  return `${agentId}-tg-${chatId}`;
}
