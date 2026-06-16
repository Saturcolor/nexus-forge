import fs from 'node:fs/promises';
import path from 'node:path';
import type { Module, MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../agent/index.js';
import type { SessionModule } from '../session/index.js';
import type { ProviderModule } from '../provider/index.js';
import type { ConfigModule } from '../config/index.js';
import { buildConsolidationPrompt } from './prompt.js';
import { summarizeWithLlm } from '../../utils/summarizeWithLlm.js';

/**
 * Refus/excuse LLM courants — un résumé qui commence ainsi est du bruit, pas une consolidation.
 * La branche « je » EXIGE la négation : le prompt impose la 1re personne, donc un résumé légitime
 * ouvre souvent par « Je suis parvenu… / Je peux confirmer… » — il ne faut PAS le rejeter. Seuls
 * « Je ne peux/sais/suis… » et « Je n'ai/arrive… » sont des refus. Biais volontaire vers le
 * faux-négatif (un refus écrit = bénin, minChars filtre ; un résumé rejeté = jour perdu).
 */
const CONSOLIDATION_REFUSAL_RE = /^(je ne (peux|sais|suis)|je n'(ai|arrive)|i (cannot|can'?t|am sorry|'?m sorry)|d[ée]sol[ée]|sorry|as an ai|en tant qu'|unable to)/i;

/**
 * Gate de validation (#1) — un résumé doit être assez long et ne pas être un refus/excuse LLM
 * avant d'être écrit (donc injecté via `# Recent Context` dans le system prompt de SON agent —
 * chaque agent ne lit que sa propre section, cf. DailyMemory.readRecent(days, agentId)).
 * Conservateur : length + pattern de refus attrapent le vide/tronqué/apologie sans faux positifs.
 */
function isValidConsolidationSummary(summary: string, minChars: number): boolean {
  const s = summary.trim();
  if (!s) return false; // empty est toujours invalide, même si minSummaryChars=0
  if (s.length < minChars) return false;
  if (CONSOLIDATION_REFUSAL_RE.test(s)) return false;
  return true;
}

export class ConsolidationModule implements Module {
  name = 'consolidation';
  private ctx!: MastermindContext;
  private cronTimer: ReturnType<typeof setTimeout> | null = null;

  private get chatCfg() {
    return this.ctx.config.consolidation?.chat;
  }

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    if (this.chatCfg?.enabled === false) {
      console.log('[consolidation] Désactivé (consolidation.chat.enabled: false)');
      return;
    }
    this.scheduleCron();
    const hour = this.chatCfg?.cronHour ?? 0;
    console.log(`[consolidation] Initialized — cron scheduled for ${hour}h`);
  }

  async destroy(): Promise<void> {
    if (this.cronTimer) {
      clearTimeout(this.cronTimer);
      this.cronTimer = null;
    }
  }

  private scheduleCron(): void {
    const hour = this.chatCfg?.cronHour ?? 0;
    const msUntil = this.msUntilNextHour(hour);
    console.log(`[consolidation] Next run in ${Math.round(msUntil / 60_000)} minutes (target: ${hour}h)`);

    this.cronTimer = setTimeout(async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split('T')[0]!;

      console.log(`[consolidation] Running cron for ${dateStr}`);
      try {
        await this.runAll(dateStr);
      } catch (err) {
        console.error('[consolidation] Cron error:', err instanceof Error ? err.message : String(err));
      }

      this.scheduleCron();
    }, msUntil);
  }

  private msUntilNextHour(hour: number): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  async runAll(dateStr?: string): Promise<{ agents: string[]; date: string }> {
    const date = dateStr ?? new Date().toISOString().split('T')[0]!;
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const agents = agentMod.listAgents();
    console.log(`[consolidation] runAll date=${date} agents=${agents.length}`);

    const completed: string[] = [];
    let written = 0;
    for (const agent of agents) {
      try {
        const out = await this.runForAgent(agent.identity.id, date);
        completed.push(agent.identity.id);
        if (out && out.trim()) written++; // '' = pas de message du jour OU rejeté par la gate
      } catch (err) {
        console.error(`[consolidation] Failed for agent ${agent.identity.id}:`, err instanceof Error ? err.message : String(err));
      }
    }

    console.log(`[consolidation] runAll complete: ${completed.length}/${agents.length} traités, ${written} écrits (reste = pas de message ou rejeté par la gate)`);
    return { agents: completed, date };
  }

  async runForAgent(agentId: string, dateStr?: string): Promise<string> {
    const date = dateStr ?? new Date().toISOString().split('T')[0]!;

    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const providerMod = this.ctx.modules.get<ProviderModule>('provider');
    const configMod = this.ctx.modules.get<ConfigModule>('config');

    const agent = agentMod.getAgent(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);

    // includeCompacted=true : récupère les messages originaux (pas les résumés auto_compact)
    const messages = await sessionMod.getMessagesByAgentAndDate(agentId, date, true);
    console.debug(`[consolidation] runForAgent agent=${agentId} date=${date} messages=${messages.length}`);
    if (messages.length === 0) {
      console.log(`[consolidation] No messages for agent ${agentId} on ${date} — skipping`);
      return '';
    }

    const model = this.chatCfg?.model?.trim() || agent.model;

    // Chunking si le transcript est trop volumineux (>30K chars → consolider en segments)
    const MAX_TRANSCRIPT_CHARS = 30_000;
    const fullTranscript = messages.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n');

    let summary: string;
    if (fullTranscript.length <= MAX_TRANSCRIPT_CHARS) {
      // Cas normal : tout tient en un seul appel
      const prompt = buildConsolidationPrompt(agent, messages, date);
      console.debug(`[consolidation] runForAgent agent=${agentId} model=${model} promptLen=${prompt.length}`);
      const mainRes = await summarizeWithLlm(providerMod, { model, prompt, maxTokens: 2048 });
      summary = mainRes.ok ? mainRes.summary : '';
    } else {
      // Chunking : découper en segments, consolider chaque segment, puis fusionner
      console.log(`[consolidation] runForAgent agent=${agentId} transcript too large (${fullTranscript.length} chars) — chunking`);
      const chunkSummaries: string[] = [];
      let chunkMessages: typeof messages = [];
      let chunkLen = 0;

      for (const msg of messages) {
        const msgLen = msg.role.length + msg.content.length + 10;
        if (chunkLen + msgLen > MAX_TRANSCRIPT_CHARS && chunkMessages.length > 0) {
          // Consolider ce chunk
          const chunkPrompt = buildConsolidationPrompt(agent, chunkMessages, date);
          console.debug(`[consolidation] chunk ${chunkSummaries.length + 1}: ${chunkMessages.length} msgs, ${chunkLen} chars`);
          const partial = await summarizeWithLlm(providerMod, { model, prompt: chunkPrompt, maxTokens: 1024 });
          if (partial.ok) chunkSummaries.push(partial.summary);
          chunkMessages = [];
          chunkLen = 0;
        }
        chunkMessages.push(msg);
        chunkLen += msgLen;
      }
      // Dernier chunk
      if (chunkMessages.length > 0) {
        const chunkPrompt = buildConsolidationPrompt(agent, chunkMessages, date);
        console.debug(`[consolidation] chunk ${chunkSummaries.length + 1} (final): ${chunkMessages.length} msgs, ${chunkLen} chars`);
        const partial = await summarizeWithLlm(providerMod, { model, prompt: chunkPrompt, maxTokens: 1024 });
        if (partial.ok) chunkSummaries.push(partial.summary);
      }

      if (chunkSummaries.length === 0) {
        summary = '';
      } else if (chunkSummaries.length === 1) {
        summary = chunkSummaries[0]!;
      } else {
        // Fusionner les résumés partiels
        console.log(`[consolidation] merging ${chunkSummaries.length} chunk summaries for agent=${agentId}`);
        const mergePrompt = `Tu es ${agent.identity.name}. Fusionne ces ${chunkSummaries.length} résumés partiels de ta journée du ${date} en un seul résumé cohérent. Format markdown, titre "## Consolidation ${date}".\n\n${chunkSummaries.map((s, i) => `### Partie ${i + 1}\n${s}`).join('\n\n')}`;
        const mergeRes = await summarizeWithLlm(providerMod, { model, prompt: mergePrompt, maxTokens: 2048 });
        summary = mergeRes.ok ? mergeRes.summary : '';
      }
    }

    // Garde inconditionnel : un résumé vide (tous les appels LLM ont échoué) ne doit JAMAIS être
    // écrit — même avec validateSummaries=false — sinon une section agent vide serait injectée
    // dans le `# Recent Context` de cet agent.
    if (!summary.trim()) {
      console.warn(`[consolidation] résumé ${agentId} ${date} vide (LLM indisponible) — non écrit.`);
      return '';
    }

    // Gate de validation (#1) — n'injecte JAMAIS un résumé non-validé : il est lu par prompt.ts
    // via `# Recent Context` dans le system prompt de l'agent concerné (~2 jours ; chaque agent
    // ne lit que sa propre section). Un appel LLM qui échoue/refuse/sort du bruit ne doit pas polluer.
    const validateOn = this.chatCfg?.validateSummaries !== false;
    const minChars = this.chatCfg?.minSummaryChars ?? 40;
    if (validateOn && !isValidConsolidationSummary(summary, minChars)) {
      console.warn(`[consolidation] résumé ${agentId} ${date} rejeté (low-signal/vide, ${summary.length} chars) — non écrit.`);
      return '';
    }

    // Write to shared memory: sharedMemoryDir/daily/consolidated/consolidated-YYYY-MM-DD.md
    const sharedDir = configMod.resolvePath(this.ctx.config.paths.sharedMemoryDir);
    const consolidatedDir = path.join(sharedDir, 'daily', 'consolidated');
    await fs.mkdir(consolidatedDir, { recursive: true });

    const filePath = path.join(consolidatedDir, `consolidated-${date}.md`);

    // Append per-agent section if file already exists (multiple agents)
    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch { /* new file */ }

    // Idempotent re-consolidation: drop any pre-existing section(s) for THIS agent
    // before appending, so re-running a date already processed replaces instead of
    // duplicating. Match an H3 header ending in `(<agentId>)` up to the next *agent*
    // header or EOF. agentId is the stable unique key (name may collide/change), so
    // key off it.
    //
    // The lookahead MUST only stop at another agent header — i.e. an H3 whose line
    // ends in `(<something>)` — and NOT at any `### `. The merge path below emits
    // intra-section sub-headers `### Partie N` (for chunked transcripts) that can end
    // up inside an agent's summary body; stopping at a bare `### ` would truncate the
    // strip mid-body and leave orphaned `### Partie N` fragments, breaking idempotence
    // for large-transcript agents. The `... (...)` shape is the reliable agent-header
    // marker.
    const escapedId = agentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRe = new RegExp(`\\n*^### .*\\(${escapedId}\\)\\s*$[\\s\\S]*?(?=\\n^### .*\\([^)]+\\)\\s*$|$(?![\\s\\S]))`, 'gm');
    existing = existing.replace(sectionRe, '').replace(/\s+$/, '');

    const agentSection = `\n\n### ${agent.identity.name} (${agentId})\n\n${summary}`;
    await fs.writeFile(filePath, existing + agentSection, 'utf-8');

    console.log(`[consolidation] Wrote summary for ${agentId} on ${date} (${summary.length} chars)`);
    return summary;
  }
}
