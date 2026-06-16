/**
 * Manifest of variables available per template.
 *
 * Used by:
 *  - PUT /api/prompt-templates/:key validation (refuses if `required: true` variable
 *    is missing from the user's edited content)
 *  - UI variables panel (lists available + insert at cursor + highlight required)
 *
 * If you add a new `{{var}}` to a default template (defaults.ts), you MUST add the
 * matching entry here so the UI knows about it and validation works.
 */

export interface VariableSpec {
  /** The variable name as it appears in `{{name}}` (without braces). */
  name: string;
  /** When true, removing this variable from the template makes the PUT fail with 400. */
  required: boolean;
  /** Short human-readable explanation shown in the UI. */
  description: string;
  /** Optional example value (rendered in the variables panel for context). */
  example?: string;
}

export const TEMPLATE_VARIABLES: Record<string, VariableSpec[]> = {
  'platform': [
    { name: 'userName',         required: false, description: 'Nom de l\'utilisateur principal', example: 'Alice' },
    { name: 'userLocale',       required: false, description: 'Code locale courte', example: 'FR' },
    { name: 'fleetRosterBlock', required: true,  description: 'Bloc complet "## Fleet roster" + listes standard + sub-agents, généré depuis agentsList. Sans cette variable, l\'agent ne sait pas qui sont ses pairs.' },
  ],
  'subagent-harness': [
    { name: 'presetIdentity', required: true,  description: 'Identité parsée d\'IDENTITY.md (Name / Role / Vibe / Emoji en bullets)' },
    { name: 'presetId',       required: true,  description: 'ID du preset sub-agent', example: 'morpheus' },
    { name: 'deliveryBlock',  required: true,  description: 'Bloc "## Delivery contract" (ou "## Delivery" si pas de harness) — explique submit_subagent_report' },
  ],
  'environment': [
    { name: 'agentsRoot',         required: true,  description: 'Chemin absolu du dossier agents',           example: '/workspace/agents' },
    { name: 'sharedMemory',       required: true,  description: 'Chemin absolu shared memory',                example: '/workspace/memory/shared' },
    { name: 'userImagesDir',      required: true,  description: 'Chemin où les images chat sont dumpées',     example: '/workspace/memory/shared/user-images' },
    { name: 'skillsDirLine',      required: false, description: 'Ligne complète "\\n- Skills directory: ..." ou string vide si skills désactivées' },
    { name: 'memoryStoreTrigger', required: false, description: 'Ligne "\\n- Before saying ... call memory_search first" ou vide selon module memory-store' },
    { name: 'schedulerTriggers',  required: false, description: 'Bloc 4 lignes scheduler-related triggers (\\n-prefixed) ou vide si scheduler off' },
    { name: 'visionTrigger',      required: false, description: 'Ligne "\\n- You need to SEE/read an image → inspect_image" ou vide si aucun provider vision (Mercury statsUrl) configuré' },
  ],
  'memory-stub': [
    // No variables — content is a 1-liner reminder, but listed for UI completeness.
  ],
  'lazy-skills-summary.stub': [
    { name: 'skillsList', required: true, description: 'Liste markdown des skills (un bullet par skill, généré depuis skillActionsMod). Sans cette variable, l\'agent ne sait pas quelles skills existent.' },
  ],
  'lazy-skills-summary.wildcard': [
    { name: 'skillsList', required: true, description: 'Liste markdown des skills (un bullet par skill, généré depuis skillActionsMod). Sans cette variable, l\'agent ne sait pas quelles skills existent.' },
  ],
};

/** Extract all `{{varName}}` occurrences from a template string. */
export function extractTemplateVariables(content: string): string[] {
  const found = new Set<string>();
  const re = /\{\{([\w.]+)\}\}/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * Validate that all `required: true` variables for `key` are present in `content`.
 * Returns the list of missing required vars (empty = valid).
 */
export function validateRequiredVariables(key: string, content: string): string[] {
  const specs = TEMPLATE_VARIABLES[key] ?? [];
  const required = specs.filter(s => s.required).map(s => s.name);
  if (required.length === 0) return [];
  const present = new Set(extractTemplateVariables(content));
  return required.filter(name => !present.has(name));
}
