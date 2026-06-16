import { Bot } from 'grammy';

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.catch((err) => {
    console.error('[telegram] Bot error:', err.message);
  });

  return bot;
}
