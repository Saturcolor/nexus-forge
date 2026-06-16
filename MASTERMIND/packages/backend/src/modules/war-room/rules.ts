/**
 * Generates the briefing content injected into every agent's fresh session when they
 * join a war room. This tells the agent what a war room is, how to behave, how to pass
 * their turn, and who the other participants are. The briefing is persisted as the very
 * first `role='user'` message of the agent's war room session so the rules remain in the
 * KV cache and the conversation prefix for the whole duration.
 */
export interface BriefingContext {
  roomName: string;
  participants: Array<{ kind: 'user' | 'agent'; id: string; name: string }>;
  maxMessages: number;
  maxToolsPerTurn: number;
  yourAgentName: string;
  yourAgentId: string;
}

export function buildBriefing(ctx: BriefingContext): string {
  const userName = ctx.participants.find(p => p.kind === 'user')?.name ?? 'User';

  const participantList = ctx.participants
    .map((p, idx) => {
      const marker = p.kind === 'user' ? '(human, facilitator)' : p.id === ctx.yourAgentId ? '(you)' : '';
      return `  ${idx + 1}. ${p.name} ${marker}`.trim();
    })
    .join('\n');

  return [
    `[WAR ROOM] You have joined a war room called "${ctx.roomName}".`,
    '',
    'Participants (in speaking order, round-robin):',
    participantList,
    '',
    '# War room rules',
    '',
    '- Messages from other participants are shown as `[NAME]: content`. Your own history is shown normally (role=assistant).',
    `- ${userName} guides the discussion as the human facilitator. Agents are contributors.`,
    '- You speak only when it is your turn. You will receive the signal `[Your turn]` each time.',
    `- If you have nothing constructive to add on your turn, respond with exactly \`[PASS]\` and nothing else. Never pretend to have something to say just to fill space.`,
    `- You can use your tools and skills normally during your turn, but you are limited to ${ctx.maxToolsPerTurn} tool calls per turn. Stay efficient.`,
    `- The war room has a total cap of ${ctx.maxMessages} messages. Be concise — do not monopolize bandwidth.`,
    '- Address participants by name when relevant. You can challenge, propose ideas, ask for clarification, and build on what others have said.',
    '- This session is isolated from your normal chat — it is a fresh space created for this discussion.',
    '',
    'Wait for the next message with the `[Your turn]` signal to start speaking. Do NOT respond to this briefing — just acknowledge it mentally and wait.',
  ].join('\n');
}

/**
 * Short nudge appended as the user content of each agent turn — tells them "it's your turn now".
 * The actual content they should respond to is already in their session history via earlier
 * broadcasted user messages prefixed with [NAME]: ...
 */
export function buildTurnNudge(roomName: string, currentMessages: number, maxMessages: number): string {
  return `[Your turn] War room "${roomName}" — message ${currentMessages + 1}/${maxMessages}. Respond or say [PASS].`;
}
