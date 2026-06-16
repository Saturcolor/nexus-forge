import { Bot } from 'grammy';
import type { Module, MastermindContext, TelegramBotConfig } from '@mastermind/shared';
import { buildBotMappings, registerHandlers } from './bridge.js';
import type { AgentModule } from '../agent/index.js';
import type { ProviderModule } from '../provider/index.js';
import type { ConfigModule } from '../config/index.js';

interface BotStatus {
  id: string;
  enabled: boolean;
  hasToken: boolean;
  running: boolean;
}

export class TelegramModule implements Module {
  name = 'telegram';
  private bots = new Map<string, Bot>();
  /**
   * Si plusieurs entrées `telegram.bots` partagent le même token,
   * Telegram polling ne doit tourner qu'une fois par token.
   * Map: token -> botId "primaire" à démarrer.
   */
  private primaryBotIdByToken = new Map<string, string>();
  private ctx!: MastermindContext;

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    const enabledBots = ctx.config.telegram.bots.filter(b => b.enabled && b.token);
    if (enabledBots.length === 0) {
      console.log('[telegram] No bots configured or enabled');
      return;
    }
    this.computePrimaryBots();
    await this.startAll();
  }

  // ── Start / Stop ──────────────────────────────────────────

  private computePrimaryBots(): void {
    this.primaryBotIdByToken.clear();

    // Keep first enabled bot for a given token (config order).
    // This prevents multiple polling loops for the same token.
    for (const botConf of this.ctx.config.telegram.bots) {
      if (!botConf.enabled || !botConf.token) continue;
      const token = botConf.token;
      if (!this.primaryBotIdByToken.has(token)) {
        this.primaryBotIdByToken.set(token, botConf.id);
      } else {
        console.debug(`[telegram] computePrimaryBots: bot=${botConf.id} shares token with primary=${this.primaryBotIdByToken.get(token)} → will be skipped`);
      }
    }
    console.debug(`[telegram] computePrimaryBots: ${this.primaryBotIdByToken.size} primary bot(s): ${[...this.primaryBotIdByToken.values()].join(', ')}`);
  }

  private isGetUpdatesConflict(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const errObj = err as Record<string, unknown>;
    if (errObj.error_code === 409) return true;
    const msg = errObj.message;
    return typeof msg === 'string' && msg.includes('terminated by other getUpdates request');
  }

  async startBot(botConf: TelegramBotConfig): Promise<void> {
    if (!botConf.token) return;
    const primaryId = this.primaryBotIdByToken.get(botConf.token);
    if (primaryId && primaryId !== botConf.id) {
      console.warn(
        `[telegram:${botConf.id}] Same token already configured for "${primaryId}". Skipping to avoid polling conflict.`,
      );
      return;
    }
    if (this.bots.has(botConf.id)) await this.stopBot(botConf.id);

    const bot = new Bot(botConf.token);
    bot.catch(err => console.error(`[telegram:${botConf.id}] Error:`, err.message));

    const botMappings = buildBotMappings(this.ctx.config);
    const chatMap = botMappings.get(botConf.id) ?? new Map();
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const providerMod = this.ctx.modules.get<ProviderModule>('provider');

    const configMod = this.ctx.modules.get<ConfigModule>('config');
    registerHandlers(bot, chatMap, agentMod, this.ctx.config, providerMod, configMod, this.ctx.modules);
    this.bots.set(botConf.id, bot);

    if (chatMap.size === 0) {
      console.warn(
        `[telegram:${botConf.id}] Not starting: 0 chat mapping(s). Configure agents.telegram.chatIds to enable routing.`,
      );
      this.bots.delete(botConf.id);
      return;
    }

    console.log(`[telegram:${botConf.id}] Starting (${chatMap.size} chat mapping(s))`);

    // Prevent process crash if Telegram rejects polling (e.g. another instance is already polling).
    // `bot.start()` may reject asynchronously, so we attach a catch to avoid unhandled promise rejections.
    try {
      void bot
        .start({
          onStart: (info) => console.log(`[telegram:${botConf.id}] Running as @${info.username}`),
        })
        .catch((err) => {
          if (this.isGetUpdatesConflict(err)) {
            console.warn(
              `[telegram:${botConf.id}] Polling conflict (409). Another instance is probably running. Skipping start.`,
            );
            this.bots.delete(botConf.id);
            return;
          }

          console.error(
            `[telegram:${botConf.id}] Failed to start:`,
            err instanceof Error ? err.message : err,
          );
          this.bots.delete(botConf.id);
        });
    } catch (err) {
      console.error(`[telegram:${botConf.id}] Failed to start (sync):`, err);
      this.bots.delete(botConf.id);
    }
  }

  async stopBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (bot) {
      await bot.stop();
      this.bots.delete(botId);
      console.log(`[telegram:${botId}] Stopped`);
    }
  }

  async restartBot(botId: string): Promise<void> {
    this.computePrimaryBots();
    const botConf = this.ctx.config.telegram.bots.find(b => b.id === botId);
    if (!botConf) { console.warn(`[telegram] Bot "${botId}" not found in config`); return; }
    await this.stopBot(botId);
    if (botConf.enabled && botConf.token) await this.startBot(botConf);
  }

  async startAll(): Promise<void> {
    for (const botConf of this.ctx.config.telegram.bots) {
      if (botConf.enabled && botConf.token) await this.startBot(botConf);
    }
  }

  async stopAll(): Promise<void> {
    for (const botId of [...this.bots.keys()]) {
      await this.stopBot(botId);
    }
  }

  async restartAll(): Promise<void> {
    this.computePrimaryBots();
    await this.stopAll();
    await this.startAll();
  }

  /** Expose a bot instance for proactive messaging (e.g. scheduler notifications) */
  getBot(botId: string): Bot | undefined {
    return this.bots.get(botId);
  }

  // ── Status ────────────────────────────────────────────────

  getStatus(): BotStatus[] {
    return this.ctx.config.telegram.bots.map(b => ({
      id: b.id,
      enabled: b.enabled,
      hasToken: !!b.token,
      running: this.bots.has(b.id),
    }));
  }

  getBotStatus(botId: string): BotStatus | null {
    const conf = this.ctx.config.telegram.bots.find(b => b.id === botId);
    if (!conf) return null;
    return { id: conf.id, enabled: conf.enabled, hasToken: !!conf.token, running: this.bots.has(conf.id) };
  }

  /** Backward compat */
  isRunning(): boolean {
    return this.bots.size > 0;
  }

  async destroy(): Promise<void> {
    await this.stopAll();
  }
}
