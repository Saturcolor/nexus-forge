/**
 * Tests unitaires pour la reconstruction de messages LLM depuis la DB (agent/run).
 *
 * Cible les transformations PURES qui gouvernent la parité du préfixe KV-cache — le point dur
 * de Mastermind (cf. en-têtes de fonction dans run.ts) :
 *   - toAiMessage           : reconstruit le message exact envoyé au modèle (rawAssistantStream,
 *                             visionFallbackPrefix, injectedPrefix, footer images, cap tool 12k)
 *   - truncateToolContentForLlm : cap dur à 12 000 caractères, identique push-time / DB-rebuild
 *   - estimateTokens        : épingle le ratio CHARS_PER_TOKEN = 3.5
 *
 * Ces fonctions sont pures ; run.ts s'importe tel quel sous tsx (aucun refactor du hot path).
 *   node --import tsx --test src/modules/agent/toAiMessage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toAiMessage, truncateToolContentForLlm, estimateTokens } from './run.js';
import type { ChatMessage, MessageRole } from '@mastermind/shared';

/** Construit un ChatMessage minimal pour les tests. */
function msg(role: MessageRole, content: string, metadata?: Record<string, unknown>): ChatMessage {
  return { id: 'm1', sessionId: 's1', role, content, source: 'web', createdAt: '2026-06-17T00:00:00Z', metadata };
}

// ── user : reconstruction byte-identique de ce qui a été envoyé au modèle ────

test('user simple : contenu inchangé', () => {
  const r = toAiMessage(msg('user', 'hi')) as { role: string; content: string };
  assert.deepEqual(r, { role: 'user', content: 'hi' });
});

test('user : injectedPrefix préfixé', () => {
  const r = toAiMessage(msg('user', 'hi', { injectedPrefix: 'MEM\n\n[MESSAGE]\n' })) as { content: string };
  assert.equal(r.content, 'MEM\n\n[MESSAGE]\nhi');
});

test('user : visionFallbackPrefix splicé ENTRE injectedPrefix et le contenu brut', () => {
  // Ordre attendu (cf. run.ts) : injectedPrefix + visionFallbackPrefix + content
  const r = toAiMessage(msg('user', 'hi', { injectedPrefix: 'P|', visionFallbackPrefix: 'V|' })) as { content: string };
  assert.equal(r.content, 'P|V|hi');
});

test('user : footer userImagePaths appended (chemins listés)', () => {
  const r = toAiMessage(msg('user', 'hi', { userImagePaths: ['/tmp/a.png'] })) as { content: string };
  assert.ok(r.content.startsWith('hi'), 'le contenu commence par le texte utilisateur');
  assert.ok(r.content.includes('`/tmp/a.png`'), 'le chemin de l’image est listé dans la note système');
});

// ── assistant : KV-parity via rawAssistantStream, strip <think> ─────────────

test('assistant : rawAssistantStream préféré au m.content (parité KV-cache)', () => {
  const r = toAiMessage(
    msg('assistant', 'DISPLAY-BLOB', { rawAssistantStream: 'RAW-STREAM-BYTES' }),
    false, // stripThink=false pour isoler la préférence raw vs content
  ) as { content: string };
  assert.equal(r.content, 'RAW-STREAM-BYTES');
});

test('assistant : <think> retiré quand stripThink=true (défaut), conservé sinon', () => {
  const withThink = msg('assistant', '<think>secret reasoning</think>visible answer');
  assert.equal((toAiMessage(withThink, true) as { content: string }).content, 'visible answer');
  assert.equal(
    (toAiMessage(withThink, false) as { content: string }).content,
    '<think>secret reasoning</think>visible answer',
  );
});

test('assistant : tool_calls nettoyés (null filtrés), clé omise si vide', () => {
  const withCalls = toAiMessage(msg('assistant', 'x', { tool_calls: [{ id: 'a' }, null] })) as {
    tool_calls?: unknown[];
  };
  assert.deepEqual(withCalls.tool_calls, [{ id: 'a' }]);

  const emptyCalls = toAiMessage(msg('assistant', 'x', { tool_calls: [] })) as Record<string, unknown>;
  assert.ok(!('tool_calls' in emptyCalls), 'tool_calls vide → message assistant simple (pas de clé)');
});

// ── tool : cap dur 12k + tool_call_id ───────────────────────────────────────

test('tool : contenu > 12 000 caractères tronqué avec marqueur', () => {
  const big = 'a'.repeat(15_000);
  const r = toAiMessage(msg('tool', big, { tool_call_id: 't1' })) as { content: string; tool_call_id?: string };
  assert.equal(r.tool_call_id, 't1');
  assert.ok(r.content.endsWith('\n... [truncated for context window]'));
  assert.equal(r.content.length, 12_000 + '\n... [truncated for context window]'.length);
  assert.ok(r.content.startsWith('aaaa'));
});

test('tool : contenu sous le cap inchangé ; tool_call_id absent → clé omise', () => {
  const r = toAiMessage(msg('tool', 'short result')) as Record<string, unknown>;
  assert.equal(r.content, 'short result');
  assert.ok(!('tool_call_id' in r), 'pas d’id (ancien format) → pas de clé tool_call_id');
});

// ── helpers exportés ────────────────────────────────────────────────────────

test('truncateToolContentForLlm : no-op sous le cap, tronque au-dessus', () => {
  assert.equal(truncateToolContentForLlm('short'), 'short');
  const r = truncateToolContentForLlm('b'.repeat(12_001));
  assert.equal(r.length, 12_000 + '\n... [truncated for context window]'.length);
});

test('estimateTokens : épingle le ratio CHARS_PER_TOKEN = 3.5', () => {
  // JSON.stringify('aaaa') === '"aaaa"' (6 chars) → ceil(6 / 3.5) === 2
  assert.equal(estimateTokens('aaaa'), 2);
  // monotone : plus de contenu → estimation ≥
  assert.ok(estimateTokens('a'.repeat(100)) > estimateTokens('a'));
});
