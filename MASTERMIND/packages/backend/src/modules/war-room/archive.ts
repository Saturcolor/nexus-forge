import path from 'node:path';
import fs from 'node:fs/promises';
import type { WarRoom, WarRoomMember, WarRoomMessage } from '@mastermind/shared';

/**
 * Write the final war room archive markdown file to the shared memory directory.
 * Mirrors the pattern used by the `/compact` command and the consolidation module.
 *
 * Layout: `<sharedMemoryDir>/war-room/<room-name-slug>-<timestamp>.md`
 */
export async function writeWarRoomArchive(params: {
  sharedMemoryDir: string;
  room: WarRoom;
  members: WarRoomMember[];
  messages: WarRoomMessage[];
  summary: string;
  agentNames: Map<string, string>;
}): Promise<string> {
  const { sharedMemoryDir, room, members, messages, summary, agentNames } = params;

  const warRoomDir = path.join(sharedMemoryDir, 'war-room');
  await fs.mkdir(warRoomDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = slugify(room.name);
  const filename = `${slug}-${timestamp}.md`;
  const filePath = path.join(warRoomDir, filename);

  const memberLines = members
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map(m => `  - ${agentNames.get(m.agentId) ?? m.agentId} (\`${m.agentId}\`)`)
    .join('\n');

  const transcriptLines: string[] = [];
  for (const msg of messages) {
    const author = msg.authorKind === 'user'
      ? `**${room.userName ?? 'User'}**`
      : msg.authorKind === 'system'
        ? '_system_'
        : `**${agentNames.get(msg.authorAgentId ?? '') ?? msg.authorAgentId ?? '?'}**`;
    const tag = msg.passed ? ' _[PASS]_' : '';
    const ts = msg.createdAt.slice(11, 16);
    transcriptLines.push(`### ${ts} — ${author}${tag}`);
    if (!msg.passed) transcriptLines.push('', msg.content, '');
    else transcriptLines.push('');
  }

  const md = [
    `# War Room: ${escapeMd(room.name)}`,
    '',
    `- **ID:** \`${room.id}\``,
    `- **Status:** ${room.status}`,
    `- **Created:** ${room.createdAt}`,
    `- **Closed:** ${room.closedAt ?? '(open at archive time)'}`,
    `- **Total messages:** ${messages.length} / ${room.maxMessages}`,
    `- **Max tools per turn:** ${room.maxToolsPerTurn}`,
    '',
    '## Participants',
    memberLines || '_(aucun)_',
    '',
    '## Resume des decisions et conclusions',
    '',
    summary || '_(pas de resume genere)_',
    '',
    '---',
    '',
    '## Transcript complet',
    '',
    transcriptLines.join('\n'),
  ].join('\n');

  await fs.writeFile(filePath, md, 'utf-8');
  console.log(`[war-room] archive written: ${filePath}`);
  return filePath;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'war-room';
}

function escapeMd(s: string): string {
  return s.replace(/[|*_`]/g, m => `\\${m}`);
}
