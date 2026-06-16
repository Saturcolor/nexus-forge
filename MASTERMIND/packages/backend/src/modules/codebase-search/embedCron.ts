import type { MastermindContext } from '@mastermind/shared';
import { runAllEmbedJobs, listEmbedJobs } from './embedRunner.js';
import type { ConfigModule } from '../config/index.js';

let cronTimer: ReturnType<typeof setTimeout> | null = null;

function clearCronTimer(): void {
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
  }
}

function msUntilNextUtcHour(hourUtc: number): number {
  const h = Math.min(23, Math.max(0, Math.floor(hourUtc)));
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Annule le prochain run planifié (sans en programmer un nouveau).
 */
export function cancelCodebaseEmbedCron(): void {
  clearCronTimer();
}

/**
 * Replanifie le cron à partir de la config actuelle de `ctx` (annule l'ancien timer).
 * À appeler après PUT /api/config (codebaseSearch) ou POST /api/config/reload.
 */
export function rescheduleCodebaseEmbedCron(ctx: MastermindContext): void {
  clearCronTimer();
  const cs = ctx.config.codebaseSearch;
  if (!cs?.enabled || !cs.embedCronEnabled) {
    console.log('[codebase-embed-cron] Cron disabled or codebaseSearch off — not scheduling');
    return;
  }
  const hour = cs.embedCronHourUtc ?? 3;
  const delay = msUntilNextUtcHour(hour);
  console.log(`[codebase-embed-cron] Next run in ${Math.round(delay / 60_000)} min (UTC hour ${hour})`);
  cronTimer = setTimeout(async () => {
    try {
      const live = ctx.config.codebaseSearch;
      if (live?.enabled && live.embedCronEnabled) {
        const mode = live.embedCronMode ?? 'full';
        await runAllEmbedJobs(ctx, 'cron', undefined, mode);
      } else {
        console.log('[codebase-embed-cron] Skipped run (disabled before fire)');
      }
    } catch (e) {
      console.error('[codebase-embed-cron]', e);
    } finally {
      rescheduleCodebaseEmbedCron(ctx);
    }
  }, delay);
  if (typeof (cronTimer as { unref?: () => void }).unref === 'function') {
    (cronTimer as { unref?: () => void }).unref!();
  }
}

/**
 * Checks whether the scheduled cron run for today was missed (server was down during the window).
 * If so, triggers the embedding jobs immediately to catch up.
 */
async function catchUpMissedCron(ctx: MastermindContext): Promise<void> {
  const cs = ctx.config.codebaseSearch;
  if (!cs?.enabled || !cs.embedCronEnabled) return;

  const hourUtc = cs.embedCronHourUtc ?? 3;
  const now = new Date();
  const scheduledToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(hourUtc), 0, 0, 0),
  );

  // Only catch up if the scheduled window has already passed today
  if (now.getTime() <= scheduledToday.getTime()) return;

  const configMod = ctx.modules.get<ConfigModule>('config');
  const resolvePath = (p: string) => configMod.resolvePath(p);
  const jobs = listEmbedJobs(ctx, resolvePath);
  const lastRuns = cs.lastEmbedRuns ?? {};

  const anyMissed = jobs.some((job) => {
    const last = lastRuns[job.indexKey];
    if (!last) return true; // never ran
    const lastAt = new Date(last.at);
    return lastAt.getTime() < scheduledToday.getTime();
  });

  if (anyMissed) {
    console.log(`[codebase-embed-cron] Catching up missed run (server was down during scheduled window at ${hourUtc}h UTC)`);
    try {
      const mode = cs.embedCronMode ?? 'full';
      await runAllEmbedJobs(ctx, 'cron', undefined, mode);
    } catch (e) {
      console.error('[codebase-embed-cron] Catch-up run failed:', e);
    }
  }
}

/** Alias : premier démarrage = catch-up check + même logique que reschedule. */
export async function scheduleCodebaseEmbedCron(ctx: MastermindContext): Promise<void> {
  await catchUpMissedCron(ctx);
  rescheduleCodebaseEmbedCron(ctx);
}
