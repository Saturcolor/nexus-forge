import type { AgentDeliveryPolicy, DeliveryTrigger, DeliveryWakeChannel, MessageSource } from '@mastermind/shared';

/**
 * delivery/resolve — résolution centrale des canaux de réveil pour UNE livraison (v3).
 *
 * Séparé de l'exécution (delivery/index → executeDelivery) : cette fonction est PURE
 * (aucun I/O), elle décide seulement QUELS canaux tenter. Tous les chemins de livraison
 * (send_to_user, auto-deliver proactif, filets) passent par ici pour une décision unique
 * et cohérente — fini les implémentations divergentes.
 *
 * v3 : la policy est granulaire par CANAL × TRIGGER. Un agent choisit QUELS types de run
 * (`DeliveryTrigger`) réveillent QUEL canal. La résolution prend un `trigger` explicite
 * (calculé en amont depuis le runKind) au lieu des anciens flags isProactive/isBackground.
 */

/**
 * Canal de push ADDITIONNEL (le contenu est TOUJOURS aussi posé en chat/WS).
 * Legacy : conservé pour la valeur `channel` reçue du LLM ; la résolution effective
 * passe par `resolveDelivery`.
 */
export type DeliveryChannel = 'chat' | 'telegram' | 'mobile' | 'both';

/**
 * Souhait de canaux exprimé par l'appelant de `send_to_user`.
 *  - 'auto' : pas de souhait (arg omis, 'auto', ou valeur inconnue) → policy décide
 *  - 'set'  : souhait explicite, soit enum legacy soit array de canaux
 */
export type RequestedChannels =
  | { kind: 'auto' }
  | { kind: 'set'; set: Set<DeliveryWakeChannel>; raw: string };

/** Parse l'arg `channel` du tool — accepte l'enum legacy ET un array (`["mobile","telegram"]`). */
export function parseRequestedChannels(raw: unknown): RequestedChannels {
  if (Array.isArray(raw)) {
    const set = new Set<DeliveryWakeChannel>();
    for (const v of raw) {
      const s = String(v ?? '').toLowerCase();
      if (s === 'mobile' || s === 'telegram') set.add(s);
      else if (s === 'both') { set.add('mobile'); set.add('telegram'); }
      // 'chat' dans un array = pas de réveil supplémentaire, déjà couvert par la ligne chat
    }
    return { kind: 'set', set, raw: raw.map(v => String(v)).join(',') };
  }
  const s = String(raw ?? '').toLowerCase();
  if (s === 'chat') return { kind: 'set', set: new Set(), raw: s };
  if (s === 'telegram') return { kind: 'set', set: new Set<DeliveryWakeChannel>(['telegram']), raw: s };
  if (s === 'mobile') return { kind: 'set', set: new Set<DeliveryWakeChannel>(['mobile']), raw: s };
  if (s === 'both') return { kind: 'set', set: new Set<DeliveryWakeChannel>(['telegram', 'mobile']), raw: s };
  return { kind: 'auto' };
}

export interface ResolveDeliveryParams {
  /** Souhait de l'appelant (LLM) — cf. parseRequestedChannels. */
  requested: RequestedChannels;
  /** Override par tâche (ScheduledTask/ProactiveSource.deliveryChannels, configuré en UI). */
  taskChannels?: DeliveryWakeChannel[] | null;
  /** Policy de l'agent (AgentConfig.delivery, configurée en UI), TOUJOURS en v3 (normalisée). */
  policy?: AgentDeliveryPolicy;
  /**
   * Type de run qui déclenche cette livraison — détermine quels canaux la policy réveille
   * (granularité par CANAL × TRIGGER). Remplace les anciens flags isProactive/isBackground.
   */
  trigger: DeliveryTrigger;
  /** Source visible de la session — 'telegram' = thread TG natif (reply TG toujours permise). */
  visibleSource?: MessageSource;
}

export interface ResolvedDelivery {
  /** Réveils à tenter directement (la ligne chat est toujours persistée à part). */
  wake: Set<DeliveryWakeChannel>;
  /** TG en mode fallback : ne tenter TG que si le leg mobile n'a atteint personne. */
  telegramFallback: boolean;
  /** Skip le push APNs si un client web/mobile regarde déjà la session. */
  presenceDedup: boolean;
  /** Provenance de la décision (pour les logs). */
  origin: 'task' | 'explicit' | 'policy' | 'legacy';
  /**
   * true quand un souhait explicite NON VIDE du LLM s'est effondré à zéro réveil à cause du mode
   * TG (fallback/off sans leg mobile) et a été rattrapé par le plancher auto de la policy. Purement
   * observationnel (logs) — signale qu'on a évité un silence non désiré.
   */
  rescued: boolean;
}

/** Défaut legacy mobile : un agent SANS policy réveille le mobile sur tous les triggers. */
const LEGACY_MOBILE: DeliveryTrigger[] = ['interactive', 'proactive', 'task', 'sandbox'];

/**
 * Résolution centrale des canaux de réveil pour UNE livraison (v3).
 *
 * Hiérarchie (du plus au moins autoritaire) :
 *  1. Override par tâche (UI) — bypass total de la policy, y compris le mode Telegram
 *     ('off' n'empêche pas une tâche épinglée TG).
 *  2. Souhait explicite du LLM (`channel` non-'auto') — FILTRÉ par le mode Telegram de la
 *     policy (le modèle ne réveille pas TG par habitude sur un agent TG-déprécié).
 *  3. Policy agent (`mobile.triggers` / `telegram.triggers`) pour le trigger courant.
 *  4. Legacy (agent sans triggers configurés) : mobile sur tous les triggers, TG seulement
 *     si thread TG natif.
 *
 * IMPORTANT : seul `triggers` explicite bloque le legacy. `presenceDedup`/`mode`/`liveActivity`
 * ne sont PAS des opt-out de wake — configurer juste `presenceDedup:true` ne doit pas couper
 * le réveil mobile (fix bug hasPolicy : avant, toute clé de policy court-circuitait le legacy).
 *
 * Reply TG-native (visibleSource='telegram' && trigger='interactive') : jamais filtrée —
 * l'utilisateur écrit DEPUIS Telegram, la réponse doit lui revenir là-bas (bridge entrant).
 */
export function resolveDelivery(p: ResolveDeliveryParams): ResolvedDelivery {
  const policy = p.policy ?? {};
  const hasMobileTriggers = policy.mobile?.triggers !== undefined;
  const hasTgTriggers = policy.telegram?.triggers !== undefined;
  const tgMode = policy.telegram?.mode ?? 'on';
  const nativeTgReply = p.visibleSource === 'telegram' && p.trigger === 'interactive';
  // Défaut legacy Telegram : un agent sans triggers TG ne sonne TG QUE sur une session TG-native
  // (la reply entrante). Hors session TG, pas de TG auto sans configuration explicite.
  const legacyTg: DeliveryTrigger[] = p.visibleSource === 'telegram'
    ? ['interactive', 'proactive', 'task', 'sandbox']
    : [];

  // Réveil "auto" dérivé de la policy pour le trigger courant (respecte mobile.triggers /
  // telegram.triggers). Réutilisé tel quel pour le chemin auto ET comme plancher de secours
  // d'une requête explicite effondrée par le mode TG (cf. filet de secours plus bas).
  const autoWake = (): Set<DeliveryWakeChannel> => {
    const mobileTriggers = policy.mobile?.triggers ?? LEGACY_MOBILE;
    const tgTriggers = policy.telegram?.triggers ?? legacyTg;
    const w = new Set<DeliveryWakeChannel>();
    if (mobileTriggers.includes(p.trigger)) w.add('mobile');
    if (tgTriggers.includes(p.trigger)) w.add('telegram');
    return w;
  };

  let wake: Set<DeliveryWakeChannel>;
  let origin: ResolvedDelivery['origin'];
  let userPinned = false;
  // Souhait explicite NON VIDE = le LLM a choisi un canal de RÉVEIL (vs `channel='chat'` qui
  // donne un set vide = silence volontaire). Sert à n'armer le filet de secours QUE sur une
  // vraie intention de réveil, jamais sur un chat-only délibéré.
  let explicitNonEmpty = false;

  if (p.taskChannels != null) {
    wake = new Set(p.taskChannels);
    origin = 'task';
    userPinned = true;
  } else if (p.requested.kind === 'set') {
    wake = new Set(p.requested.set);
    origin = 'explicit';
    explicitNonEmpty = p.requested.set.size > 0;
  } else {
    // Auto : triggers par canal. Seul `triggers` explicite bloque le legacy.
    wake = autoWake();
    origin = (hasMobileTriggers || hasTgTriggers) ? 'policy' : 'legacy';
  }

  // Reply TG-native : la réponse à un message reçu DEPUIS Telegram repart toujours sur TG,
  // quel que soit le mode (bridge entrant, jamais filtré).
  if (nativeTgReply) wake.add('telegram');

  // Application du mode Telegram (off/fallback). Ne s'applique ni à un override tâche épinglé
  // (userPinned) ni à la reply TG-native (bridge entrant) — uniquement aux canaux auto/explicites
  // non pinnés. Factorisée pour être rejouée sur le plancher de secours. Mute `telegramFallback`.
  let telegramFallback = false;
  const applyTgMode = (w: Set<DeliveryWakeChannel>): void => {
    if (userPinned || nativeTgReply) return;
    if (tgMode === 'off') {
      w.delete('telegram');
    } else if (tgMode === 'fallback') {
      w.delete('telegram');
      telegramFallback = w.has('mobile');
    }
  };
  applyTgMode(wake);

  // ── FILET DE SECOURS (fix logique d'exécution) ──
  // Une requête explicite NON VIDE exprime une intention de RÉVEILLER l'utilisateur. Si le mode TG
  // (fallback/off) la réduit à ZÉRO réveil SANS armer de fallback (cas `channel='telegram'` + TG
  // fallback/off sans leg mobile dans le souhait), on ne laisse PAS la livraison tomber en silence
  // (chat-only) : on retombe sur le réveil auto de la policy pour ce trigger. Ce plancher respecte
  // mobile.triggers (un agent opted-out du mobile sur ce trigger RESTE muet) et préserve
  // `channel='chat'` = silence VOLONTAIRE (set vide → explicitNonEmpty=false → pas de rescue).
  //
  // RÉSERVÉ AUX TRIGGERS D'ARRIÈRE-PLAN (proactive/task/sandbox). En INTERACTIF l'utilisateur est
  // présent par définition (il vient d'écrire, la réponse streame sous ses yeux) : un canal explicite
  // qui s'effondre doit rester chat-only, JAMAIS être promu en push. Sans ce garde, un
  // `channel='telegram'` en pleine conversation web réveillait le tel (régression 2026-06-15).
  let rescued = false;
  if (explicitNonEmpty && wake.size === 0 && !telegramFallback && p.trigger !== 'interactive') {
    const floor = autoWake();
    applyTgMode(floor);
    if (floor.size > 0 || telegramFallback) {
      wake = floor;
      origin = 'policy';
      rescued = true;
    }
  }

  return {
    wake,
    telegramFallback,
    presenceDedup: policy.mobile?.presenceDedup ?? false,
    origin,
    rescued,
  };
}
