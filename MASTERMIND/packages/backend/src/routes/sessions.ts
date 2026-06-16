import { Hono } from 'hono';
import type { MastermindContext } from '@mastermind/shared';
import type { SessionModule } from '../modules/session/index.js';
import type { AgentModule } from '../modules/agent/index.js';
import type { ProviderModule } from '../modules/provider/index.js';
import type { MemoryModule } from '../modules/memory/index.js';
import type { ConfigModule } from '../modules/config/index.js';
import { assembleSystemPrompt, resolveEnvironmentPaths } from '../modules/agent/prompt.js';
import { buildCodebaseSearchToolNote } from '../modules/codebase-search/promptNote.js';
import { estimateTokens, toAiMessage } from '../modules/agent/run.js';

export function sessionRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();
  const sessionMod = ctx.modules.get<SessionModule>('session');

  // List sessions (optionally filter by agent)
  app.get('/', async (c) => {
    const agentId = c.req.query('agentId');
    console.debug(`[route:sessions] list agentId=${agentId ?? 'all'}`);
    const sessions = agentId
      ? await sessionMod.listByAgent(agentId)
      : await sessionMod.listAll();
    return c.json(sessions);
  });

  // Full-text search over message history (#12) — HTTP counterpart of the session_search tool.
  app.get('/search', async (c) => {
    const q = c.req.query('q') ?? '';
    if (!q.trim()) return c.json({ error: 'q (query) is required' }, 400);
    const agentId = c.req.query('agentId') || undefined;
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));
    console.debug(`[route:sessions] search qlen=${q.length} agent=${agentId ?? 'all'} limit=${limit}`);
    const hits = await sessionMod.searchMessages(q, { agentId, limit });
    return c.json(hits);
  });

  // Get session messages (proactive messages hidden by default — pass includeProactive=true to see them)
  app.get('/:id/messages', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50');
    const before = c.req.query('before') ?? undefined;
    const includeProactive = c.req.query('includeProactive') === 'true';
    console.debug(`[route:sessions] getMessages session=${c.req.param('id')} limit=${limit} before=${before ?? 'none'} includeProactive=${includeProactive}`);
    const messages = await sessionMod.getMessages(c.req.param('id'), limit, before, {
      excludeProactive: !includeProactive,
    });
    return c.json(messages);
  });

  // Session runtime stats (token estimate, model, provider, session options)
  app.get('/:id/stats', async (c) => {
    const sessionId = c.req.param('id');
    console.debug(`[route:sessions] stats session=${sessionId}`);
    const agentMod = ctx.modules.get<AgentModule>('agent');
    const providerMod = ctx.modules.get<ProviderModule>('provider');
    const memoryMod = ctx.modules.get<MemoryModule>('memory');
    const configMod = ctx.modules.get<ConfigModule>('config');

    // Find session in DB to get agentId
    const sessRow = await ctx.db.query<{ agentId: string }>(
      'SELECT agent_id AS "agentId" FROM sessions WHERE id = $1',
      [sessionId],
    );
    if (!sessRow.rows[0]) return c.json({ error: 'Session not found' }, 404);

    const agentId = sessRow.rows[0].agentId;
    const agentConfig = agentMod.getAgent(agentId);
    if (!agentConfig) return c.json({ error: 'Agent not found' }, 404);

    // Assemble le system prompt réel (SOUL.md, AGENTS.md, MEMORY.md, etc.) — on garde
    // la string complète pour la passer telle quelle à estimateTokens (cf. plus bas).
    let systemPrompt = '';
    try {
      const isMainSession = !sessionId.includes('-tg-');
      const environmentPaths = resolveEnvironmentPaths(
        configMod,
        ctx.config.paths,
        agentConfig,
        agentId,
        memoryMod.shared.dir,
      );
      const codebaseSearchToolNote = buildCodebaseSearchToolNote(
        ctx.config,
        (p) => configMod.resolvePath(p),
        agentConfig,
        agentId,
      );
      systemPrompt = await assembleSystemPrompt(memoryMod, {
        agentConfig,
        sessionId,
        isMainSession,
        environmentPaths,
        codebaseSearchToolNote,
      });
    } catch (err) {
      console.warn(`[route:sessions] stats prompt assembly failed session=${sessionId}: ${err instanceof Error ? err.message : err}`);
      // Fallback conservateur — placeholder de 2000 chars pour ne pas afficher 0 token
      systemPrompt = ' '.repeat(2000);
    }
    const systemPromptChars = systemPrompt.length;

    // Estimation aussi proche que possible du prompt réellement envoyé par runAgent :
    // on réutilise `toAiMessage` + `estimateTokens` exportés par run.ts → JSON wrapping
    // (clés "role"/"content"), tool result truncation à 12k, strip <think> selon config,
    // injectedPrefix prepend, etc. Byte-identique au calcul réel modulo l'auto-injection
    // mémoire/board qui se produit live au moment de buildLlmPayload (donc absente ici).
    // → Cohérent avec le `usage.prompt_tokens` réel renvoyé par le provider après le 1er run.
    const historyLimit = agentConfig.contextMessages ?? 20;
    const messages = await sessionMod.getMessages(sessionId, historyLimit);
    const stripThink = ctx.config.defaults.stripThinkBlocks ?? false;
    const estimatedTokens = estimateTokens([
      { role: 'system', content: systemPrompt },
      ...messages.map(m => toAiMessage(m, stripThink)),
    ]);

    const sessionOptions = await agentMod.loadSessionOptions(sessionId);
    const effectiveModel = sessionOptions.modelOverride ?? agentConfig.model;

    let providerId = '';
    try {
      providerId = providerMod.resolveModel(effectiveModel).providerId;
    } catch {
      // model might not be resolvable yet
    }

    // Also return total messages in DB for context
    const allMessages = await sessionMod.getMessages(sessionId, 200);

    return c.json({
      sessionId,
      agentId,
      messageCount: allMessages.length,
      historyWindow: historyLimit,
      estimatedTokens,
      // Keep consistent with estimatedTokens ratio (~3.5 chars/token).
      systemPromptTokens: Math.round(systemPromptChars / 3.5),
      maxContextTokens: agentConfig.maxContextTokens ?? 8000,
      effectiveModel,
      providerId,
      sessionOptions,
    });
  });

  // Get session options (persisted runtime overrides: think, model, tools…)
  app.get('/:id/options', async (c) => {
    const agentMod = ctx.modules.get<AgentModule>('agent');
    const opts = await agentMod.loadSessionOptions(c.req.param('id'));
    return c.json(opts);
  });

  // Delete session
  app.delete('/:id', async (c) => {
    const sessionId = c.req.param('id');
    console.log(`[route:sessions] delete session=${sessionId}`);
    await sessionMod.delete(sessionId);
    ctx.modules.tryGet<AgentModule>('agent')?.clearSessionOptions(sessionId);
    return c.json({ ok: true });
  });

  return app;
}
