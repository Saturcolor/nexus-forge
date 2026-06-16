// Suppress Node deprecation for built-in punycode (used by deps e.g. grammy/ws) until they switch to userland
process.removeAllListeners('warning');
process.on('warning', (warning: Error & { code?: string }) => {
  if ((warning as any).code === 'DEP0040' && (warning.message || '').includes('punycode')) return;
  console.warn(warning.name + ':', warning.message);
});

import 'dotenv/config';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, mountStatic } from './server.js';
import { createPool } from './db/index.js';
import { ensureSchema } from './db/schema.js';
import { WsManager } from './ws.js';
import { ModuleLoader } from './modules/loader.js';
import { ConfigModule, loadConfigFromFile } from './modules/config/index.js';
import { MemoryModule } from './modules/memory/index.js';
import { ProviderModule } from './modules/provider/index.js';
import { AgentModule } from './modules/agent/index.js';
import { SessionModule } from './modules/session/index.js';
import { TelegramModule } from './modules/telegram/index.js';
import { PushModule } from './modules/push/index.js';
import { ConsolidationModule } from './modules/consolidation/index.js';
import { MemoryStoreModule } from './modules/memory-store/index.js';
import { MemoryConsolidationModule } from './modules/memory-consolidation/index.js';
import { SkillActionsModule } from './modules/skill-actions/index.js';
import { PromptTemplatesModule } from './modules/prompt-templates/index.js';
import { invalidateTelegramPromptCache } from './modules/agent/run.js';
import { SchedulerModule } from './modules/scheduler/index.js';
import { WarRoomModule } from './modules/war-room/index.js';
import { BoardModule } from './modules/board/index.js';
import { ProactiveSourceModule } from './modules/proactive-source/index.js';
import { AsyncJobsModule } from './modules/async-jobs/index.js';
import { initLogger, getLogger, buildLoggerOptions } from './modules/logger.js';
import { installGlobalHttpDebug } from './modules/http-debug.js';
import type { MastermindContext, WsClientMessage, WsServerMessage } from '@mastermind/shared';
import { validateChatSendImages } from './modules/agent/chatImageLimits.js';
import { resolveSessionId } from './modules/agent/sessionResolve.js';
import type { Server as HttpServer } from 'node:http';

// Routes
import { agentRoutes } from './routes/agents.js';
import { sessionRoutes } from './routes/sessions.js';
import { chatRoutes } from './routes/chat.js';
import { memoryRoutes } from './routes/memory.js';
import { providerRoutes } from './routes/providers.js';
import { telegramRoutes } from './routes/telegram.js';
import { pushRoutes } from './routes/push.js';
import { configRoutes } from './routes/config.js';
import { logRoutes } from './routes/logs.js';
import { statusRoutes } from './routes/status.js';
import { consolidationRoutes } from './routes/consolidation.js';
import { uploadRoutes } from './routes/upload.js';
import { filesRoutes } from './routes/files.js';
import { asyncJobsRoutes } from './routes/async-jobs.js';
import { subAgentsRoutes } from './routes/sub-agents.js';
import { codebaseSearchRoutes } from './routes/codebaseSearch.js';
import { promptTemplatesRoutes } from './routes/prompt-templates.js';
import { skillsRoutes } from './routes/skills.js';
import { memoryStoreRoutes } from './routes/memory-store.js';
import { memoryConsolidationRoutes } from './routes/memory-consolidation.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { warRoomRoutes } from './routes/war-room.js';
import { boardRoutes } from './routes/board.js';
import { proactiveSourceRoutes } from './routes/proactive-source.js';
import { debugRoutes } from './routes/debug.js';
import { clientLogRoutes } from './routes/client-logs.js';
import { systemRoutes } from './routes/system.js';
import { cancelCodebaseEmbedCron, scheduleCodebaseEmbedCron } from './modules/codebase-search/embedCron.js';
import { cancelUploadsJanitor, scheduleUploadsJanitor } from './modules/uploads-janitor/index.js';
import { cleanupZombieEmbedRuns } from './modules/codebase-search/embedRunner.js';

async function main() {
  const configPath = process.env.MASTERMIND_CONFIG
    ?? path.resolve(import.meta.dirname, '../../../config/mastermind.yml');

  const config = loadConfigFromFile(configPath);
  const logOpts = buildLoggerOptions(configPath, config.logging);
  initLogger(logOpts);
  installGlobalHttpDebug();

  console.log(`[mastermind] Loading config from ${configPath}`);
  console.log(`[mastermind] Logging to ${logOpts.logFilePath} (level=${logOpts.minLevel}, rotate ${logOpts.maxFileSizeMb}MiB × ${logOpts.maxFiles} files)`);

  // Create PostgreSQL pool
  const pool = createPool(config.database);
  await ensureSchema(pool);

  // Create Hono app + mount routes later
  const app = createApp(config);

  // Readiness flag — flipped to true once all modules init() resolve.
  // Used by GET /health/ready (declared below, public, no auth) so nexusctl
  // can health-check us without an API key. /api/status remains behind auth.
  let ready = false;
  app.get('/health/ready', (c) => {
    if (ready) return c.json({ ok: true });
    return c.json({ ok: false, error: 'Bootstrap in progress' }, 503);
  });

  // Module loader
  const modules = new ModuleLoader();

  // Start HTTP server via @hono/node-server (returns the underlying http.Server)
  const { port, host } = config.server;
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  // Create WebSocket manager on the HTTP server
  // Hono's ServerType is a broad union; this app runs on the default Node HTTP server.
  const wsManager = new WsManager(server as HttpServer);

  // Context
  const ctx: MastermindContext = { config, db: pool, ws: wsManager, modules };

  // Register and init modules in order
  const configMod = new ConfigModule(configPath);
  const memoryMod = new MemoryModule();
  const memoryStoreMod = new MemoryStoreModule();
  const providerMod = new ProviderModule();
  const sessionMod = new SessionModule();
  const agentMod = new AgentModule();
  const telegramMod = new TelegramModule();
  const pushMod = new PushModule();
  const consolidationMod = new ConsolidationModule();
  const memoryConsolidationMod = new MemoryConsolidationModule();
  const skillActionsMod = new SkillActionsModule();
  const schedulerMod = new SchedulerModule();
  const warRoomMod = new WarRoomModule();
  const boardMod = new BoardModule();
  const proactiveSourceMod = new ProactiveSourceModule();
  const asyncJobsMod = new AsyncJobsModule();
  const promptTemplatesMod = new PromptTemplatesModule();

  modules.register(configMod);
  modules.register(memoryMod);
  modules.register(memoryStoreMod);
  modules.register(providerMod);
  modules.register(sessionMod);
  modules.register(agentMod);
  modules.register(telegramMod);
  modules.register(pushMod);
  modules.register(consolidationMod);
  modules.register(memoryConsolidationMod);
  modules.register(skillActionsMod);
  modules.register(schedulerMod);
  modules.register(warRoomMod);
  modules.register(boardMod);
  modules.register(proactiveSourceMod);
  modules.register(asyncJobsMod);
  modules.register(promptTemplatesMod);

  for (const mod of modules.getAll()) {
    console.log(`[modules] init ${mod.name}…`);
    await mod.init(ctx);
    console.log(`[modules] init ${mod.name} ok`);
  }

  // Wire prompt-templates change events to the system prompt cache invalidation.
  // Covers both UI saves (via PUT route) AND external edits (Syncthing / file editor →
  // fs.watch → reloadFromDisk → fireChange). Without this subscription the cache
  // would stay stale until TTL expiry on Syncthing-driven changes.
  promptTemplatesMod.onChange((key) => {
    console.log(`[prompt-templates] change detected key=${key} — invalidating agent prompt cache (all sessions)`);
    invalidateTelegramPromptCache();
  });

  cleanupZombieEmbedRuns(ctx);
  void scheduleCodebaseEmbedCron(ctx);
  void scheduleUploadsJanitor(ctx);

  // Wire WebSocket message handler
  wsManager.setMessageHandler(async (_client, data) => {
    const msg = data as WsClientMessage;
    if (msg.type === 'chat.send') {
      // Session unifiée (cross-plateforme) : si l'agent a `unifiedSession`, web/mobile/NCM
      // convergent vers `{agent}-unified`. On canonicalise AVANT tout pour que la validation,
      // le broadcast d'erreur ET run() utilisent le même id que le client abonné (sinon les
      // deltas sont émis sur un id auquel personne n'écoute).
      const sendCfg = agentMod.getAgent(msg.agentId);
      const sessionId = sendCfg ? resolveSessionId(msg.agentId, msg.sessionId, sendCfg) : msg.sessionId;
      const imgCheck = validateChatSendImages(msg.images);
      if (!imgCheck.ok) {
        // Log to server: without this an attacker could spam oversized images
        // and we'd have zero visibility (frontend just sees the chat.error UX).
        console.warn(`[ws] chat.send image rejected agent=${msg.agentId} session=${sessionId} count=${msg.images?.length ?? 0}: ${imgCheck.error}`);
        wsManager.broadcast(sessionId, {
          type: 'chat.error',
          sessionId,
          agentId: msg.agentId,
          error: imgCheck.error,
        } satisfies WsServerMessage);
        return;
      }
      const preview = typeof msg.content === 'string'
        ? `${msg.content.slice(0, 80)}${msg.content.length > 80 ? '…' : ''}`
        : '';
      const imgs = msg.images?.length ? ` images=${msg.images.length}` : '';
      console.debug(`[ws] chat.send agent=${msg.agentId} session=${sessionId}${sessionId !== msg.sessionId ? ` (unified, req=${msg.sessionId})` : ''}${preview ? ` preview="${preview}"` : ''}${imgs}`);
      agentMod.run(msg.agentId, sessionId, msg.content, 'web', {
        images: msg.images,
        // Origine vocale NCM avec « masquer le transcript » : le réveil mobile de fin de
        // run ne doit pas révéler la réponse en clair (cf. run.ts bloc B / interactive push).
        ...(msg.hideTranscript ? { hidePushTranscript: true } : {}),
      }).catch(err => {
        console.error(`[ws] Agent run error:`, err.message);
      });
    } else if (msg.type === 'chat.abort') {
      console.debug(`[ws] chat.abort agent=${msg.agentId}`);
      agentMod.abort(msg.agentId);
    } else if (msg.type === 'cache.warm') {
      const warmCfg = agentMod.getAgent(msg.agentId);
      const sessionId = warmCfg ? resolveSessionId(msg.agentId, msg.sessionId, warmCfg) : msg.sessionId;
      console.debug(`[ws] cache.warm agent=${msg.agentId} session=${sessionId}`);
      agentMod.run(msg.agentId, sessionId, '', 'web', { warmup: true }).catch((err: unknown) => {
        console.error(`[ws] Cache warm error:`, err instanceof Error ? err.message : err);
      });
    }
    // subscribe/unsubscribe handled directly in WsManager
  });

  // Mount API routes
  app.route('/api/agents', agentRoutes(ctx));
  app.route('/api/sessions', sessionRoutes(ctx));
  app.route('/api/chat', chatRoutes(ctx));
  app.route('/api/memory', memoryRoutes(ctx));
  app.route('/api/providers', providerRoutes(ctx));
  app.route('/api/telegram', telegramRoutes(ctx));
  app.route('/api/push', pushRoutes(ctx));
  app.route('/api/config', configRoutes(ctx));
  app.route('/api/logs', logRoutes(ctx));
  app.route('/api/status', statusRoutes(ctx));
  app.route('/api/consolidation', consolidationRoutes(ctx));
  app.route('/api/upload', uploadRoutes(ctx));
  app.route('/api/files', filesRoutes(ctx));
  app.route('/api/async-jobs', asyncJobsRoutes(ctx));
  app.route('/api/sub-agents', subAgentsRoutes(ctx));
  app.route('/api/codebase-search', codebaseSearchRoutes(ctx));
  app.route('/api/skills', skillsRoutes(ctx));
  app.route('/api/prompt-templates', promptTemplatesRoutes(ctx));
  app.route('/api/memory-store', memoryStoreRoutes(ctx));
  app.route('/api/memory-consolidation', memoryConsolidationRoutes(ctx));
  app.route('/api/scheduler', schedulerRoutes(ctx));
  app.route('/api/war-rooms', warRoomRoutes(ctx));
  app.route('/api/board', boardRoutes(ctx));
  app.route('/api/proactive', proactiveSourceRoutes(ctx));
  app.route('/api/debug', debugRoutes(ctx));
  app.route('/api/client-logs', clientLogRoutes(ctx));
  app.route('/api/system', systemRoutes(ctx));

  // Mount static AFTER all API routes so the wildcard does not shadow them
  mountStatic(app);

  // All modules + routes mounted: service is ready to serve traffic.
  ready = true;

  console.log(`[mastermind] Server running at http://${host}:${port}`);
  console.log(`[mastermind] WebSocket at ws://${host}:${port}/ws`);

  let shutdownStarted = false;
  const destroyModuleWithTimeout = async (mod: { name: string; destroy?: () => Promise<void> | void }) => {
    if (!mod.destroy) return;
    console.log(`[modules] destroy ${mod.name}…`);
    let timedOut = false;
    await Promise.race([
      Promise.resolve(mod.destroy()).catch((err) => {
        console.error(`[modules] destroy ${mod.name} failed:`, err instanceof Error ? err.message : err);
      }),
      new Promise<void>(resolve => setTimeout(() => {
        timedOut = true;
        console.error(`[modules] destroy ${mod.name} timed out after 5000ms; continuing shutdown`);
        resolve();
      }, 5_000)),
    ]);
    if (!timedOut) console.log(`[modules] destroy ${mod.name} ok`);
  };

  // Graceful shutdown
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    setTimeout(() => {
      console.error('[mastermind] Shutdown exceeded 30000ms; forcing exit(1)');
      process.exit(1);
    }, 30_000);

    console.log('\n[mastermind] Shutting down...');
    // Mark ready=false so external health-checkers (nexusctl) see us as draining.
    ready = false;
    cancelCodebaseEmbedCron();
    cancelUploadsJanitor();
    try {
      configMod.save();
    } catch (err: any) {
      console.error('[mastermind] Config flush on shutdown failed:', err?.message ?? err);
    }
    wsManager.close();
    for (const mod of [...modules.getAll()].reverse()) {
      await destroyModuleWithTimeout(mod);
    }
    await pool.end();
    server.close();
    getLogger().close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[mastermind] Fatal error:', err);
  process.exit(1);
});
