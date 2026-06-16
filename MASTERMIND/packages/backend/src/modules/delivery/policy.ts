import type { AgentDeliveryPolicy, DeliveryTrigger, DeliveryWakeChannel } from '@mastermind/shared';

/**
 * delivery/policy — normalisation des policies de livraison stockées en v3 canonique.
 *
 * Le type `AgentDeliveryPolicy` a migré d'un format PLAT (`wake[]`, `telegram` string,
 * `presenceDedup` top-level) vers un format v3 GRANULAIRE par CANAL × TRIGGER (mobile.{triggers,
 * presenceDedup} / telegram.{mode,triggers} / liveActivity / proactiveAlerts). Les configs YAML
 * persistées sont encore au format ancien : on les convertit À LA LECTURE (jamais de migration de
 * stockage). `normalizeDeliveryPolicy` est le point d'entrée unique : ancien-plat OU v3 OU {} → v3
 * canonique (ou `undefined` si vide). Branchée via `.transform()` sur les schémas Zod `delivery`
 * pour que `AgentConfig.delivery` soit TOUJOURS v3 en mémoire.
 */

/** Tous les triggers — défaut legacy pour le réveil mobile (l'ancien `wake:['mobile']` = tout). */
const ALL_TRIGGERS: DeliveryTrigger[] = ['interactive', 'proactive', 'task', 'sandbox'];
/** Triggers d'arrière-plan — défaut legacy pour le réveil Telegram (l'ancien `wake:['telegram']`
 *  ne sonnait pas en interactif : la reply TG-native est gérée à part par resolveDelivery). */
const BG_TRIGGERS: DeliveryTrigger[] = ['proactive', 'task', 'sandbox'];

/** Forme PLATE legacy possible reçue en entrée (avant normalisation). */
interface LegacyFlatPolicy {
  wake?: DeliveryWakeChannel[];
  telegram?: 'on' | 'fallback' | 'off';
  presenceDedup?: boolean;
  liveActivity?: 'all' | 'user' | 'off';
  proactiveAlerts?: 'all' | 'quiet' | 'off';
}

function sanitizeTriggers(input: unknown): DeliveryTrigger[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: DeliveryTrigger[] = [];
  for (const v of input) {
    if (v === 'interactive' || v === 'proactive' || v === 'task' || v === 'sandbox') {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

/** true si la policy résultante n'a AUCUN champ signifiant → équivalente à "pas de policy". */
function isEmptyV3(p: AgentDeliveryPolicy): boolean {
  const mobileEmpty =
    p.mobile === undefined ||
    (p.mobile.triggers === undefined && p.mobile.presenceDedup === undefined);
  const tgEmpty =
    p.telegram === undefined ||
    (p.telegram.mode === undefined && p.telegram.triggers === undefined);
  return (
    mobileEmpty &&
    tgEmpty &&
    p.liveActivity === undefined &&
    p.proactiveAlerts === undefined
  );
}

/**
 * Normalise une policy de livraison vers v3 canonique. Idempotente (v3 → v3 inchangée hors
 * nettoyage des sous-objets vides). Retourne `undefined` quand l'entrée est nulle OU que le
 * résultat ne porte aucun champ signifiant — c.-à-d. comportement legacy par défaut.
 *
 * IMPORTANT : retourner `undefined` pour `{}` corrige le bug "delivery:{} coupe
 * unifiedTelegramFallback" (le scheduler teste `agentCfg.delivery === undefined` ; une policy
 * vide doit être indistinguable d'une absence de policy).
 */
export function normalizeDeliveryPolicy(input: unknown): AgentDeliveryPolicy | undefined {
  if (input == null || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;

  // Détection ancien-plat : un `telegram` string, OU un `wake` présent, OU un `presenceDedup`
  // au top-level sont les marqueurs distinctifs du format pré-v3. MAIS si un sous-objet v3
  // (`mobile`/`telegram` objet) est présent, on traite en v3 et on ne perd PAS ses triggers
  // (format mixte malformé : les champs v3 priment, cf. bug hunt 2026-06-13).
  const hasV3 =
    (typeof raw['mobile'] === 'object' && raw['mobile'] !== null) ||
    (typeof raw['telegram'] === 'object' && raw['telegram'] !== null);
  const isLegacy =
    !hasV3 &&
    (typeof raw['telegram'] === 'string' ||
      raw['wake'] !== undefined ||
      raw['presenceDedup'] !== undefined);

  let result: AgentDeliveryPolicy;

  if (isLegacy) {
    const flat = raw as LegacyFlatPolicy;
    const wake = Array.isArray(flat.wake)
      ? flat.wake.filter((w): w is DeliveryWakeChannel => w === 'mobile' || w === 'telegram')
      : undefined;

    const mobile: NonNullable<AgentDeliveryPolicy['mobile']> = {};
    // wake.includes('mobile') → réveil sur tous les triggers (l'ancien wake était binaire).
    // wake présent mais SANS 'mobile' → opt-out explicite = aucun trigger ([]).
    // wake absent → pas d'avis = défaut legacy (undefined, resolveDelivery applique LEGACY_MOBILE).
    if (wake !== undefined) {
      mobile.triggers = wake.includes('mobile') ? [...ALL_TRIGGERS] : [];
    }
    if (typeof flat.presenceDedup === 'boolean') mobile.presenceDedup = flat.presenceDedup;

    const telegram: NonNullable<AgentDeliveryPolicy['telegram']> = {};
    // Le `telegram` plat (string) était le MODE. S'il était présent on le porte ; sinon, comme
    // une partie legacy avait un telegram, on défaut sur 'on' uniquement si c'était une string.
    if (typeof flat.telegram === 'string') telegram.mode = flat.telegram;
    if (wake !== undefined) {
      telegram.triggers = wake.includes('telegram') ? [...BG_TRIGGERS] : [];
    }

    result = {};
    if (mobile.triggers !== undefined || mobile.presenceDedup !== undefined) result.mobile = mobile;
    if (telegram.mode !== undefined || telegram.triggers !== undefined) result.telegram = telegram;
    if (flat.liveActivity !== undefined) result.liveActivity = flat.liveActivity;
    if (flat.proactiveAlerts !== undefined) result.proactiveAlerts = flat.proactiveAlerts;
  } else {
    // Déjà v3 (ou {}) : passthrough en nettoyant les sous-objets vides (idempotence).
    const v3 = raw as AgentDeliveryPolicy & Record<string, unknown>;
    result = {};

    const mobileIn = (v3.mobile ?? undefined) as AgentDeliveryPolicy['mobile'] | undefined;
    if (mobileIn && typeof mobileIn === 'object') {
      const mobile: NonNullable<AgentDeliveryPolicy['mobile']> = {};
      const trig = sanitizeTriggers(mobileIn.triggers);
      if (trig !== undefined) mobile.triggers = trig;
      if (typeof mobileIn.presenceDedup === 'boolean') mobile.presenceDedup = mobileIn.presenceDedup;
      if (mobile.triggers !== undefined || mobile.presenceDedup !== undefined) result.mobile = mobile;
    }

    const tgIn = (v3.telegram ?? undefined) as AgentDeliveryPolicy['telegram'] | undefined;
    if (tgIn && typeof tgIn === 'object') {
      const telegram: NonNullable<AgentDeliveryPolicy['telegram']> = {};
      if (tgIn.mode === 'on' || tgIn.mode === 'fallback' || tgIn.mode === 'off') telegram.mode = tgIn.mode;
      const trig = sanitizeTriggers(tgIn.triggers);
      if (trig !== undefined) telegram.triggers = trig;
      if (telegram.mode !== undefined || telegram.triggers !== undefined) result.telegram = telegram;
    }

    if (v3.liveActivity === 'all' || v3.liveActivity === 'user' || v3.liveActivity === 'off') {
      result.liveActivity = v3.liveActivity;
    }
    if (v3.proactiveAlerts === 'all' || v3.proactiveAlerts === 'quiet' || v3.proactiveAlerts === 'off') {
      result.proactiveAlerts = v3.proactiveAlerts;
    }
  }

  // EMPTY CHECK final : une policy sans aucun champ signifiant = pas de policy (legacy).
  if (isEmptyV3(result)) return undefined;
  return result;
}
