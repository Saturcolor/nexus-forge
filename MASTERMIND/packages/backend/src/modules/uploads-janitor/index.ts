import fs from 'node:fs/promises';
import path from 'node:path';
import type { MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../agent/index.js';

/** Uploads older than this are removed on the next janitor pass. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** UTC hour at which the daily sweep runs. Offset from codebase-embed-cron (3 UTC). */
const SWEEP_HOUR_UTC = 4;

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
 * Sweep `<workspace>/uploads/<bucket>/` for every agent and remove buckets whose
 * mtime is older than {@link TTL_MS}. A "bucket" is the nanoid subdirectory created
 * by `routes/upload.ts` per drop — preserving the user's original filename inside.
 *
 * Loose files directly under `uploads/` (pre-bucket layout, or anything dropped
 * by hand) are also swept by mtime, for consistency.
 */
export async function runUploadsJanitor(ctx: MastermindContext): Promise<void> {
  const agentMod = ctx.modules.get<AgentModule>('agent');
  const agents = agentMod.listAgents();
  const cutoff = Date.now() - TTL_MS;
  let scanned = 0;
  let removed = 0;
  let bytesFreed = 0;

  for (const agent of agents) {
    const uploadsDir = path.join(agent.workspacePath, 'uploads');
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    } catch (e) {
      // Directory doesn't exist yet — no uploads for this agent. Skip.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      console.warn(`[uploads-janitor] readdir failed agent=${agent.identity.id} dir=${uploadsDir}: ${(e as Error).message}`);
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(uploadsDir, entry.name);
      scanned++;
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs > cutoff) continue;

        let freed = 0;
        if (entry.isDirectory()) {
          freed = await dirSize(fullPath);
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          freed = stat.size;
          await fs.rm(fullPath, { force: true });
        }
        removed++;
        bytesFreed += freed;
        console.log(`[uploads-janitor] removed agent=${agent.identity.id} path=${entry.name} ageDays=${((Date.now() - stat.mtimeMs) / 86_400_000).toFixed(1)} bytes=${freed}`);
      } catch (e) {
        console.warn(`[uploads-janitor] sweep failed agent=${agent.identity.id} path=${entry.name}: ${(e as Error).message}`);
      }
    }
  }

  console.log(`[uploads-janitor] sweep complete agents=${agents.length} scanned=${scanned} removed=${removed} freedMB=${(bytesFreed / 1_000_000).toFixed(2)}`);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(p);
    } else {
      try {
        const stat = await fs.stat(p);
        total += stat.size;
      } catch {
        /* file vanished mid-walk — ignore */
      }
    }
  }
  return total;
}

function rescheduleUploadsJanitor(ctx: MastermindContext): void {
  clearCronTimer();
  const delay = msUntilNextUtcHour(SWEEP_HOUR_UTC);
  console.log(`[uploads-janitor] next sweep in ${Math.round(delay / 60_000)} min (UTC hour ${SWEEP_HOUR_UTC})`);
  cronTimer = setTimeout(async () => {
    try {
      await runUploadsJanitor(ctx);
    } catch (e) {
      console.error('[uploads-janitor] sweep error:', e);
    } finally {
      rescheduleUploadsJanitor(ctx);
    }
  }, delay);
  if (typeof (cronTimer as { unref?: () => void }).unref === 'function') {
    (cronTimer as { unref?: () => void }).unref!();
  }
}

/**
 * Run one sweep immediately (catches anything that aged past TTL while the
 * server was down), then schedule the daily cron.
 */
export async function scheduleUploadsJanitor(ctx: MastermindContext): Promise<void> {
  try {
    await runUploadsJanitor(ctx);
  } catch (e) {
    console.error('[uploads-janitor] boot sweep failed:', e);
  }
  rescheduleUploadsJanitor(ctx);
}

export function cancelUploadsJanitor(): void {
  clearCronTimer();
}
