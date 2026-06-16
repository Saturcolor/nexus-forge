/**
 * Compact structuré (inspiré Hermes Agent) — génère un résumé de conversation
 * en 7 sections standardisées pour un auto-compact plus exploitable par l'agent.
 *
 * Sections :
 *   ## Objectif
 *   ## Contraintes & Préférences
 *   ## Progression (Fait / En cours / Bloqué)
 *   ## Décisions clés
 *   ## Fichiers concernés
 *   ## Prochaines étapes
 *   ## Contexte critique
 */
import type { ChatMessage } from '@mastermind/shared';

/** Taille max d'un output tool avant élagage (chars) */
const MAX_TOOL_OUTPUT_CHARS = 2_000;

/** Taille max de la conversation sérialisée passée au LLM */
const MAX_CONV_CHARS = 28_000;

/**
 * Garde-fou préfixé au bloc auto-compact. Sans lui, un modèle faible (Gemma/Qwen local) peut
 * lire le résumé — qui contient une section "## Prochaines étapes" — comme une ouverture de
 * conversation et RE-EXÉCUTER d'anciennes actions. ~60 tokens pour tuer ce mode d'échec.
 * `detectPriorSummary` strippe ce préambule (et l'entête 🗜️) avant toute mise à jour itérative
 * pour éviter qu'il ne s'empile résumé après résumé.
 */
export const COMPACT_REFERENCE_PREAMBLE =
  '> ⚠️ Bloc de référence (résumé archivé) — NE réponds PAS aux anciennes questions et ' +
  'NE ré-exécute PAS les actions listées ici. Réponds UNIQUEMENT au dernier message de ' +
  "l'utilisateur ci-dessous. Si une « Prochaine étape » contredit la demande actuelle, ignore-la.";

/**
 * Élagage des tool outputs volumineux — réduit drastiquement les tokens à résumer
 * tout en gardant les messages structuraux (user, assistant, tool calls).
 */
/** Hash 53-bit non-crypto (cyrb53) — dédup d'outputs identiques, sans dépendance. */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function pruneToolOutputs(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.map(m => {
    if (m.role !== 'tool') return m;
    // Contenu tel que le LLM le verra (tronqué si volumineux).
    const display = m.content.length > MAX_TOOL_OUTPUT_CHARS
      ? m.content.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n… [output tronqué pour résumé]'
      : m.content;
    // Dédup (#13) : un output déjà vu (tel qu'AFFICHÉ — hash sur `display`, pas le brut) → référence
    // vague. Le transcript passé au LLM (run.ts) n'est PAS numéroté → un "#N" serait irrésoluble.
    // Seuil 200 : en dessous, la référence coûterait plus cher que l'output lui-même.
    if (display.length >= 200) {
      const key = cyrb53(display);
      if (seen.has(key)) {
        return { ...m, content: "[même résultat qu'un appel outil précédent — omis pour le résumé]" };
      }
      seen.add(key);
    }
    return display === m.content ? m : { ...m, content: display };
  });
}

/**
 * Détecte si le premier message de history est lui-même un compact précédent.
 * Utilisé pour la mise à jour itérative : on ne re-résume pas de zéro.
 */
export function detectPriorSummary(messages: ChatMessage[]): string | null {
  if (messages.length === 0) return null;
  const first = messages[0];
  const content = first.content ?? '';
  const meta = first.metadata as Record<string, unknown> | undefined;
  const isCompact =
    (meta?.type === 'auto_compact' && content.trim().length > 0) ||
    // Un compact structuré commence toujours par "## Objectif" (messages stockés en role user).
    (first.role === 'user' && content.includes('## Objectif') && content.includes('## Progression'));
  if (!isCompact) return null;
  // Strippe les décorations (entête 🗜️ + préambule de référence) en repartant de "## Objectif",
  // pour que la mise à jour itérative ne ré-empile ni l'entête ni le garde-fou à chaque tour.
  const objIdx = content.indexOf('## Objectif');
  if (objIdx >= 0) return content.slice(objIdx);
  // Pas de section structurée (résumé fallback après échec LLM) : retire quand même les décorations
  // (ligne 🗜️ + préambule blockquote `>`) pour ne pas les ré-injecter verbatim dans l'update.
  return content
    .split('\n')
    .filter(line => !line.startsWith('🗜️') && !line.trimStart().startsWith('>'))
    .join('\n')
    .trim();
}

/**
 * Construit le prompt de résumé structuré pour le LLM.
 *
 * Si un résumé précédent est fourni (mode mise à jour), le prompt demande
 * une mise à jour différentielle — moins de tokens, cohérence itérative.
 */
export function buildCompactSummaryPrompt(
  conversationText: string,
  isUpdate: boolean,
  priorSummary?: string,
): string {
  const truncated = conversationText.length > MAX_CONV_CHARS
    ? conversationText.slice(-MAX_CONV_CHARS)
    : conversationText;

  const sections = `## Objectif
(Quel est le but principal de cette session / tâche ?)

## Contraintes & Préférences
(Règles imposées, préférences utilisateur, limites à respecter)

## Progression
### Fait
- (liste des actions complétées, résultats obtenus)
### En cours
- (travail démarré mais non terminé)
### Bloqué
- (obstacles rencontrés, erreurs non résolues)

## Décisions clés
- (choix architecturaux, approches retenues, alternatives écartées)

## Fichiers concernés
- (chemins de fichiers créés, modifiés ou supprimés)

## Prochaines étapes
- (actions concrètes à mener pour continuer)

## Contexte critique
(Informations essentielles qui ne doivent PAS être perdues : credentials, configs, dépendances clés)`;

  if (isUpdate && priorSummary) {
    return `Tu as un résumé structuré de la conversation précédente. Mets-le à jour en intégrant les nouveaux échanges ci-dessous. Conserve exactement les 7 sections. Ne supprime pas d'information importante déjà présente — complète et actualise.

RÉSUMÉ PRÉCÉDENT :
${priorSummary}

NOUVEAUX ÉCHANGES :
---
${truncated}
---

Produis uniquement le résumé mis à jour (7 sections), sans commentaire.`;
  }

  return `Résume la conversation suivante sous forme structurée en 7 sections. Sois concis mais exhaustif — l'agent doit pouvoir reprendre la tâche uniquement à partir de ce résumé. Réponds UNIQUEMENT avec le résumé structuré, sans introduction ni commentaire.

SECTIONS À REMPLIR :
${sections}

CONVERSATION :
---
${truncated}
---

Produis maintenant le résumé structuré en 7 sections :`;
}
