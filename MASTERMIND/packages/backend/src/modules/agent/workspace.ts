import type { AgentConfig, AgentIdentity } from '@mastermind/shared';
import type { WorkspaceMemory } from '../memory/workspace.js';

const DEFAULT_CREATURE = 'AI assistant';

function stripIdentityValue(s: string): string {
  return s.trim().replace(/^\*+|\*+$/g, '').replace(/\*\*/g, '').trim();
}

/** Normalise les libellés IDENTITY.md (Name, Rôle, etc.) pour le dispatch des champs. */
function normalizeIdentityKey(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function applyIdentityField(identity: AgentIdentity, rawKey: string, rawValue: string): void {
  const value = stripIdentityValue(rawValue);
  if (!value) return;
  const key = normalizeIdentityKey(rawKey);
  if (key === 'name' || key === 'nom') {
    identity.name = value;
    return;
  }
  if (key === 'role' || key === 'roles' || key === 'type' || key === 'creature') {
    identity.creature = value;
    return;
  }
  if (key === 'vibe' || key === 'style') {
    identity.vibe = value;
    return;
  }
  if (key === 'emoji') {
    identity.emoji = value;
  }
}

/**
 * Parse IDENTITY.md — format canonique (puces markdown) :
 *   - **Name:** …
 *   - **Role:** / **Roles:** …  (stocké dans `identity.creature`, champ partagé « rôle / type »)
 *   - **Vibe:** …
 *   - **Emoji:** …
 * Rétro-compat : lignes `name:`, `nom:`, `creature:`, `vibe:`, etc. (sans gras).
 */
export async function parseIdentity(
  memory: WorkspaceMemory,
  workspaceDir: string,
  agentId: string,
): Promise<AgentIdentity> {
  const content = await memory.readFile(workspaceDir, 'IDENTITY.md');

  const identity: AgentIdentity = {
    id: agentId,
    name: agentId.charAt(0).toUpperCase() + agentId.slice(1),
    emoji: '',
    creature: DEFAULT_CREATURE,
    vibe: '',
  };

  if (!content) {
    console.debug(`[agent:workspace] parseIdentity agent=${agentId} → no IDENTITY.md, using defaults`);
    return identity;
  }

  const strip = (s: string) => s.trim().replace(/\*\*/g, '').trim();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const bulletBold = line.match(/^-\s*\*\*([^:]+):\*\*\s*(.+)$/);
    const bareBold = bulletBold ? null : line.match(/^\*\*([^:]+):\*\*\s*(.+)$/);
    const m = bulletBold ?? bareBold;
    if (m) {
      applyIdentityField(identity, m[1], m[2]);
      continue;
    }

    const nameMatch = line.match(/(?:^|\s)(?:name|nom)\s*[:=]\s*(.+)$/i);
    if (nameMatch) identity.name = strip(nameMatch[1]);

    const emojiMatch = line.match(/(?:^|\s)emoji\s*[:=]\s*(.+)$/i);
    if (emojiMatch) identity.emoji = strip(emojiMatch[1]);

    const creatureMatch = line.match(/(?:^|\s)(?:creature|type|roles?|rôle)\s*[:=]\s*(.+)$/i);
    if (creatureMatch) identity.creature = strip(creatureMatch[1]);

    const vibeMatch = line.match(/(?:^|\s)(?:vibe|style)\s*[:=]\s*(.+)$/i);
    if (vibeMatch) identity.vibe = strip(vibeMatch[1]);
  }

  console.debug(
    `[agent:workspace] parseIdentity agent=${agentId} → name="${identity.name}" emoji="${identity.emoji}" role/creature="${identity.creature}"`,
  );
  return identity;
}

/** Rôle affichable : on masque le défaut générique quand aucun fichier utile. */
export function identityRoleForDisplay(id: AgentIdentity): string | null {
  const r = id.creature?.trim();
  if (!r || r === DEFAULT_CREATURE) return null;
  return r;
}

/**
 * Bloc markdown aligné sur le format IDENTITY.md (puces **Label:**) — harness / doc.
 */
export function formatIdentityMarkdownBullets(id: AgentIdentity): string {
  const lines: string[] = [`- **Name:** ${id.name}`];
  const role = identityRoleForDisplay(id);
  if (role) lines.push(`- **Role:** ${role}`);
  if (id.vibe?.trim()) lines.push(`- **Vibe:** ${id.vibe.trim()}`);
  if (id.emoji?.trim()) lines.push(`- **Emoji:** ${id.emoji.trim()}`);
  return lines.join('\n');
}

/**
 * Une ligne compacte pour listes d’agents (plateforme, `list_subagents`, etc.).
 * `kindTag` : libellé court pour différencier standard vs preset.
 */
export function formatAgentRosterLine(a: AgentConfig, kindTag: 'standard' | 'subagent'): string {
  const id = a.identity;
  const lead = id.emoji?.trim() ? `${id.emoji.trim()} ` : '';
  const kindLabel = kindTag === 'subagent' ? 'sub-agent preset' : 'standard agent';
  const parts: string[] = [
    `${lead}**${id.id}** _(${kindLabel})_`,
    `**Name:** ${id.name}`,
  ];
  const role = identityRoleForDisplay(id);
  if (role) parts.push(`**Role:** ${role}`);
  if (id.vibe?.trim()) parts.push(`**Vibe:** ${id.vibe.trim()}`);
  return `- ${parts.join(' · ')}`;
}
