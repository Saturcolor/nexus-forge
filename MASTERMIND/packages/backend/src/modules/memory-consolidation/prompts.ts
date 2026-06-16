import type { MemoryCluster } from './clusterer.js';

/**
 * Construit le prompt de fusion pour un cluster de mémoires similaires.
 */
export function buildMergePrompt(cluster: MemoryCluster): string {
  const entries = cluster.members
    .map((m, i) => {
      const date = m.createdAt.toISOString().split('T')[0];
      return `[Entrée ${i + 1} — créée le ${date}]\n${m.text}`;
    })
    .join('\n\n');

  return `Fusionne ces mémoires similaires en UNE SEULE entrée concise.

RÈGLES STRICTES :
- MAX 400 caractères. Sois bref et factuel.
- Préserve : faits, décisions, noms, dates, URLs, code
- Contradiction → garde le plus récent
- Supprime les répétitions
- PAS de commentaire, PAS de préambule, UNIQUEMENT le texte fusionné

ENTRÉES :

${entries}

RÉSULTAT :`;
}
