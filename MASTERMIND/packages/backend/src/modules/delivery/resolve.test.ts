/**
 * Tests unitaires pour delivery/resolve — la fonction PURE qui décide quels canaux de réveil
 * tenter pour UNE livraison (v3, granulaire par CANAL × TRIGGER).
 *
 * Aucune dépendance d'I/O : `resolveDelivery` et `parseRequestedChannels` sont pures, on les
 * teste en isolation totale (pas de DB, pas de réseau, pas de build préalable).
 *
 * Runner : node:test + tsx (aucune dépendance de test supplémentaire).
 *   node --import tsx --test src/modules/delivery/resolve.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDelivery, parseRequestedChannels, type ResolveDeliveryParams } from './resolve.js';
import type { AgentDeliveryPolicy, DeliveryWakeChannel } from '@mastermind/shared';

/** Set de canaux trié → comparable avec assert.deepEqual. */
const wakeOf = (r: { wake: Set<DeliveryWakeChannel> }): DeliveryWakeChannel[] => [...r.wake].sort();

/** Construit des params avec des défauts raisonnables (auto, web, interactive). */
function params(over: Partial<ResolveDeliveryParams> = {}): ResolveDeliveryParams {
  return {
    requested: { kind: 'auto' },
    trigger: 'interactive',
    visibleSource: 'web',
    ...over,
  };
}

// ── parseRequestedChannels ──────────────────────────────────────────────────

test('parseRequestedChannels: enum legacy', () => {
  assert.equal(parseRequestedChannels('mobile').kind, 'set');
  assert.deepEqual([...(parseRequestedChannels('mobile') as { set: Set<string> }).set], ['mobile']);
  assert.deepEqual([...(parseRequestedChannels('telegram') as { set: Set<string> }).set], ['telegram']);
  assert.deepEqual(
    [...(parseRequestedChannels('both') as { set: Set<string> }).set].sort(),
    ['mobile', 'telegram'],
  );
});

test('parseRequestedChannels: "chat" = set vide (silence volontaire, pas auto)', () => {
  const r = parseRequestedChannels('chat');
  assert.equal(r.kind, 'set');
  assert.equal((r as { set: Set<string> }).set.size, 0);
});

test('parseRequestedChannels: array de canaux', () => {
  const r = parseRequestedChannels(['mobile', 'telegram']);
  assert.deepEqual([...(r as { set: Set<string> }).set].sort(), ['mobile', 'telegram']);
});

test('parseRequestedChannels: inconnu / vide → auto', () => {
  assert.equal(parseRequestedChannels(undefined).kind, 'auto');
  assert.equal(parseRequestedChannels('garbage').kind, 'auto');
});

// ── resolveDelivery : legacy (agent sans policy) ────────────────────────────

test('legacy: auto sur session web réveille le mobile, pas Telegram', () => {
  const r = resolveDelivery(params({ requested: { kind: 'auto' }, trigger: 'proactive' }));
  assert.deepEqual(wakeOf(r), ['mobile']);
  assert.equal(r.origin, 'legacy');
  assert.equal(r.telegramFallback, false);
  assert.equal(r.rescued, false);
});

test('legacy: reply TG-native (interactive depuis Telegram) repart toujours sur Telegram', () => {
  const r = resolveDelivery(params({ visibleSource: 'telegram', trigger: 'interactive' }));
  assert.ok(r.wake.has('telegram'), 'bridge entrant : la réponse doit revenir sur TG');
});

// ── resolveDelivery : override par tâche (le plus autoritaire) ──────────────

test('task override: canaux épinglés, bypass total du mode Telegram off', () => {
  const r = resolveDelivery(
    params({
      taskChannels: ['telegram'],
      trigger: 'task',
      policy: { telegram: { mode: 'off' } },
    }),
  );
  assert.deepEqual(wakeOf(r), ['telegram']);
  assert.equal(r.origin, 'task');
  assert.equal(r.telegramFallback, false);
});

// ── resolveDelivery : souhait explicite du LLM ──────────────────────────────

test('explicite: channel="mobile" réveille le mobile', () => {
  const r = resolveDelivery(params({ requested: parseRequestedChannels('mobile') }));
  assert.deepEqual(wakeOf(r), ['mobile']);
  assert.equal(r.origin, 'explicit');
});

test('explicite: channel="chat" = silence volontaire (jamais rattrapé)', () => {
  const r = resolveDelivery(
    params({
      requested: parseRequestedChannels('chat'),
      trigger: 'proactive',
      policy: { mobile: { triggers: ['proactive'] } },
    }),
  );
  assert.deepEqual(wakeOf(r), []);
  assert.equal(r.rescued, false, 'set vide → pas de filet de secours');
});

// ── resolveDelivery : policy granulaire mobile × trigger ────────────────────

test('policy: mobile.triggers exclut le trigger courant → pas de réveil', () => {
  const r = resolveDelivery(
    params({ requested: { kind: 'auto' }, trigger: 'proactive', policy: { mobile: { triggers: ['interactive'] } } }),
  );
  assert.deepEqual(wakeOf(r), []);
  assert.equal(r.origin, 'policy');
});

// ── resolveDelivery : mode Telegram (off / fallback) ────────────────────────

test('mode telegram "off": retire Telegram du réveil auto', () => {
  const r = resolveDelivery(
    params({
      requested: { kind: 'auto' },
      trigger: 'proactive',
      policy: { mobile: { triggers: ['proactive'] }, telegram: { triggers: ['proactive'], mode: 'off' } },
    }),
  );
  assert.deepEqual(wakeOf(r), ['mobile']);
  assert.equal(r.telegramFallback, false);
});

test('mode telegram "fallback": Telegram retiré du réveil immédiat, fallback armé si mobile présent', () => {
  const r = resolveDelivery(
    params({
      requested: { kind: 'auto' },
      trigger: 'proactive',
      policy: { mobile: { triggers: ['proactive'] }, telegram: { triggers: ['proactive'], mode: 'fallback' } },
    }),
  );
  assert.deepEqual(wakeOf(r), ['mobile']);
  assert.equal(r.telegramFallback, true, 'TG ne sonne que si le leg mobile n’atteint personne');
  assert.equal(r.origin, 'policy');
});

// ── resolveDelivery : FILET DE SECOURS (et son garde interactif) ────────────

test('filet de secours: channel="telegram" effondré par TG off sur trigger d’arrière-plan → plancher policy mobile', () => {
  const r = resolveDelivery(
    params({
      requested: parseRequestedChannels('telegram'),
      trigger: 'proactive',
      policy: { mobile: { triggers: ['proactive'] }, telegram: { mode: 'off' } },
    }),
  );
  assert.deepEqual(wakeOf(r), ['mobile'], 'la livraison ne tombe pas en silence : on retombe sur le mobile auto');
  assert.equal(r.rescued, true);
  assert.equal(r.origin, 'policy');
});

test('PAS de filet en interactif (régression 2026-06-15) : channel="telegram" effondré reste chat-only', () => {
  const r = resolveDelivery(
    params({
      requested: parseRequestedChannels('telegram'),
      trigger: 'interactive',
      visibleSource: 'web', // pas une session TG-native : pas de bridge entrant
      policy: { mobile: { triggers: ['interactive'] }, telegram: { mode: 'off' } },
    }),
  );
  assert.deepEqual(wakeOf(r), [], 'en interactif un canal explicite effondré ne doit JAMAIS être promu en push');
  assert.equal(r.rescued, false);
});

// ── resolveDelivery : presenceDedup n’est PAS un opt-out de réveil ──────────

test('presenceDedup remonté tel quel dans le résultat', () => {
  const r = resolveDelivery(
    params({
      requested: { kind: 'auto' },
      trigger: 'proactive',
      policy: { mobile: { triggers: ['proactive'], presenceDedup: true } },
    }),
  );
  assert.equal(r.presenceDedup, true);
  assert.deepEqual(wakeOf(r), ['mobile']);
});

test('fix hasPolicy: presenceDedup seul (sans triggers) ne coupe pas le réveil legacy mobile', () => {
  const policy: AgentDeliveryPolicy = { mobile: { presenceDedup: true } };
  const r = resolveDelivery(params({ requested: { kind: 'auto' }, trigger: 'proactive', policy }));
  assert.deepEqual(wakeOf(r), ['mobile'], 'configurer juste presenceDedup ne doit pas court-circuiter le legacy');
  assert.equal(r.presenceDedup, true);
  assert.equal(r.origin, 'legacy', 'aucun triggers explicite → comportement legacy');
});
