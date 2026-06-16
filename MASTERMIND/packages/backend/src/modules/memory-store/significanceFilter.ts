/**
 * Filtre de pertinence pour les entrées mémoire.
 * Adapté de Cipher (byterover) — purement regex, zéro appel LLM.
 */

export interface SignificanceResult {
  significant: boolean;
  reason: string;
}

/** Patterns indiquant un contenu trivial à ignorer */
const SKIP_PATTERNS: RegExp[] = [
  /^(hello|hi|hey|bonjour|salut|bonsoir|coucou)\s*[.!?]?\s*$/i,
  /^(thanks|thank you|merci|parfait|super|ok|okay|oui|non|yes|no|sure|d'accord|vu)\s*[.!?]?\s*$/i,
  /^(done|fait|terminé|finished|completed|task completed|operation successful)\s*[.!?]?\s*$/i,
  /^(noted|noté|je note|compris|understood|got it)\s*[.!?]?\s*$/i,
  /^\[.*tool.*result.*\]$/i,
  /^(error|erreur):\s*\w+\s*$/i,  // erreur one-liner sans contexte
];

/** Patterns indiquant un contenu significatif à mémoriser */
const SIGNIFICANT_PATTERNS: RegExp[] = [
  // Blocs de code
  /```[\s\S]{10,}```/,
  // Entités CamelCase (classes, composants, types TypeScript)
  /\b[A-Z][a-z]+[A-Z][a-zA-Z]+\b/,
  // Keywords techniques généraux
  /\b(api|endpoint|database|schema|config|auth|token|secret|key|url|port|host)\b/i,
  // Keywords de code
  /\b(function|class|interface|type|const|import|export|module|package|dependency)\b/i,
  // Marqueurs mnémotechniques explicites
  /\b(always|never|prefer|remember|important|deadline|priority|note|todo|fixme)\b/i,
  // Technologies et frameworks
  /\b(react|vue|angular|node|postgres|redis|docker|kubernetes|typescript|python)\b/i,
  // Patterns de chemin de fichier
  /[\w\-./]+\.(ts|tsx|js|py|md|yml|yaml|json|sql|sh)\b/,
  // Patterns de commande shell
  /\bnpm\s+(run|install|build)|npx\s+\w+|git\s+(commit|push|pull|merge)\b/i,
  // Décisions ou règles explicites
  /\b(décision|decision|règle|rule|convention|standard|best practice)\b/i,
];

/** Contenu trop court pour être utile */
const MIN_LENGTH = 25;

/**
 * Détermine si un contenu vaut la peine d'être mémorisé.
 * En mode `overwrite`, le filtre est bypassé (l'agent réécrit intentionnellement).
 */
export function isSignificant(content: string, mode: 'append' | 'overwrite' = 'append'): SignificanceResult {
  if (mode === 'overwrite') {
    return { significant: true, reason: 'overwrite mode bypasses filter' };
  }

  const trimmed = content.trim();

  if (trimmed.length < MIN_LENGTH) {
    return { significant: false, reason: `too short (${trimmed.length} < ${MIN_LENGTH} chars)` };
  }

  // Skip patterns
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { significant: false, reason: 'matches trivial skip pattern' };
    }
  }

  // Blocs de code = toujours significatif
  if (/```/.test(trimmed)) {
    return { significant: true, reason: 'contains code block' };
  }

  // Score par patterns significatifs
  const hits = SIGNIFICANT_PATTERNS.filter(p => p.test(trimmed));
  if (hits.length >= 1) {
    return { significant: true, reason: `${hits.length} significance pattern(s) matched` };
  }

  // Fallback : contenu long (> 200 chars) sans pattern trivial = significatif
  if (trimmed.length > 200) {
    return { significant: true, reason: 'long content without trivial pattern' };
  }

  return { significant: false, reason: 'no significance patterns matched' };
}
