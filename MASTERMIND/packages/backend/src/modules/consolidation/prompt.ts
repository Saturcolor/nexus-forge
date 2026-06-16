import type { AgentConfig } from '@mastermind/shared';

interface Message {
  role: string;
  content: string;
  createdAt: string;
}

export function buildConsolidationPrompt(agent: AgentConfig, messages: Message[], dateStr: string): string {
  const transcript = messages
    .map(m => `[${m.role.toUpperCase()}] ${m.content}`)
    .join('\n\n');

  return `Tu es ${agent.identity.name} (${agent.identity.creature}).
Tu dois consolider ta mémoire long-terme pour la journée du ${dateStr}.

Voici la transcription complète des échanges de la journée :

---
${transcript}
---

Résume cette session en bullet points factuels et concis, à la première personne.
Concentre-toi sur :
- Les tâches accomplies et leurs résultats
- Les décisions prises et le contexte
- Les informations importantes à retenir
- Les problèmes rencontrés et résolus
- Les éléments de continuité pour les prochaines sessions

Format de réponse — markdown, titré "## Consolidation ${dateStr}" :`;
}
