import { runIndexDirectory, runIncrementalUpdate } from '@mastermind/codebase-search/lib';
import type { MastermindContext } from '@mastermind/shared';
import type { ConfigModule } from '../config/index.js';
import {
  resolveCodebaseSearchDbPathByKey,
  resolveCodebaseSearchPath,
} from './paths.js';
import { buildCodebaseSearchConfigOverrides } from './overrides.js';

export type EmbedJob = {
  indexKey: string;
  sourcePath: string;
  dbPath: string;
};

/** Liste les paires (index, source → db) configurées pour l'embedding. */
export function listEmbedJobs(
  ctx: MastermindContext,
  resolvePath: (p: string) => string,
): EmbedJob[] {
  const cs = ctx.config.codebaseSearch;
  if (!cs?.enabled) return [];

  const jobs: EmbedJob[] = [];
  const sources = cs.embedSources ?? {};

  if (cs.defaultDbPath && sources.default) {
    const db = resolveCodebaseSearchPath(cs.defaultDbPath, resolvePath);
    const src = resolveCodebaseSearchPath(sources.default, resolvePath);
    jobs.push({ indexKey: 'default', sourcePath: src, dbPath: db });
  }

  for (const [key, dbRel] of Object.entries(cs.indices ?? {})) {
    const srcRel = sources[key];
    if (!srcRel) continue;
    const resolved = resolveCodebaseSearchDbPathByKey(ctx.config, resolvePath, key);
    if (!resolved) continue;
    jobs.push({
      indexKey: key,
      sourcePath: resolveCodebaseSearchPath(srcRel, resolvePath),
      dbPath: resolved.dbPath,
    });
  }

  return jobs;
}

function ensureLastRuns(ctx: MastermindContext): Record<string, { at: string; status: string; message?: string; progress?: { phase: string; done: number; total: number } }> {
  if (!ctx.config.codebaseSearch) return {};
  if (!ctx.config.codebaseSearch.lastEmbedRuns) {
    ctx.config.codebaseSearch.lastEmbedRuns = {};
  }
  return ctx.config.codebaseSearch.lastEmbedRuns;
}

/**
 * À appeler au démarrage du serveur : nettoie les statuts 'running' laissés par un arrêt
 * brutal (crash, SIGTERM) qui n'a pas eu le temps de mettre à jour l'état final.
 */
export function cleanupZombieEmbedRuns(ctx: MastermindContext): void {
  const runs = ctx.config.codebaseSearch?.lastEmbedRuns;
  if (!runs) return;
  let dirty = false;
  for (const key of Object.keys(runs)) {
    if (runs[key]?.status === 'running') {
      runs[key] = {
        at: runs[key]!.at,
        status: 'error',
        message: 'interrupted by server restart',
      };
      dirty = true;
      console.warn(`[codebase-embed] Cleaned up zombie run for index=${key}`);
    }
  }
  if (dirty) {
    const configMod = ctx.modules.get<ConfigModule>('config');
    try {
      configMod.save();
    } catch (e) {
      console.error('[codebase-embed] Failed to persist zombie cleanup:', e);
    }
  }
}

export async function runEmbedJob(
  ctx: MastermindContext,
  job: EmbedJob,
  reason: 'manual' | 'cron',
  mode: 'full' | 'incremental' = 'full',
): Promise<{ ok: boolean; message?: string }> {
  const configMod = ctx.modules.get<ConfigModule>('config');
  const cs = ctx.config.codebaseSearch;
  if (!cs?.enabled) return { ok: false, message: 'codebaseSearch disabled' };

  const configPath = cs.configPath
    ? resolveCodebaseSearchPath(cs.configPath, (p) => configMod.resolvePath(p))
    : undefined;
  // Cron: if embedCronCloudOnly is set, force cloud for this run
  // (frees the local GPU for other background jobs).
  const cronForceCloud = reason === 'cron' && cs.embedCronCloudOnly === true;
  const configOverrides = buildCodebaseSearchConfigOverrides(ctx.config, {
    forceCloudOverride: cronForceCloud,
  });

  const safeSave = () => {
    try {
      configMod.save();
    } catch (saveErr) {
      console.error('[codebase-embed] Failed to persist run state:', saveErr);
    }
  };

  const last = ensureLastRuns(ctx);
  last[job.indexKey] = { at: new Date().toISOString(), status: 'running', message: reason };
  safeSave();

  try {
    const fs = await import('node:fs');
    if (!fs.existsSync(job.sourcePath)) {
      throw new Error(`Source path does not exist: ${job.sourcePath}`);
    }

    const onProgress = (phase: string, done: number, total: number) => {
      // In-memory only — no disk save, picked up by GET /status polling
      last[job.indexKey] = {
        ...last[job.indexKey]!,
        status: 'running',
        progress: { phase, done, total },
      };
    };

    if (mode === 'incremental') {
      await runIncrementalUpdate({
        sourcePath: job.sourcePath,
        dbPath: job.dbPath,
        configPath,
        configOverrides,
        onProgress,
      });
    } else {
      await runIndexDirectory({
        sourcePath: job.sourcePath,
        dbPath: job.dbPath,
        configPath,
        configOverrides,
        onProgress,
      });
    }

    last[job.indexKey] = {
      at: new Date().toISOString(),
      status: 'ok',
      message: reason,
    };
    safeSave();
    console.log(`[codebase-embed] OK index=${job.indexKey} reason=${reason} chunks updated`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    last[job.indexKey] = {
      at: new Date().toISOString(),
      status: 'error',
      message: msg,
    };
    safeSave();
    console.error(`[codebase-embed] FAIL index=${job.indexKey}:`, msg);
    return { ok: false, message: msg };
  }
}

let embedLock = false;

export async function runAllEmbedJobs(
  ctx: MastermindContext,
  reason: 'manual' | 'cron',
  indexKey?: string,
  mode: 'full' | 'incremental' = 'full',
): Promise<{ results: Array<{ indexKey: string; ok: boolean; message?: string }> }> {
  if (embedLock) {
    return { results: [{ indexKey: '_', ok: false, message: 'Another embed job is already running' }] };
  }
  embedLock = true;
  try {
    const configMod = ctx.modules.get<ConfigModule>('config');
    const resolvePath = (p: string) => configMod.resolvePath(p);
    let jobs = listEmbedJobs(ctx, resolvePath);
    if (indexKey) {
      jobs = jobs.filter(j => j.indexKey === indexKey);
    }
    if (jobs.length === 0) {
      return { results: [{ indexKey: indexKey ?? '_', ok: false, message: 'No embed jobs (set embedSources + defaultDbPath/indices)' }] };
    }
    const results: Array<{ indexKey: string; ok: boolean; message?: string }> = [];
    for (const job of jobs) {
      const r = await runEmbedJob(ctx, job, reason, mode);
      results.push({ indexKey: job.indexKey, ok: r.ok, message: r.message });
    }
    return { results };
  } finally {
    embedLock = false;
  }
}
