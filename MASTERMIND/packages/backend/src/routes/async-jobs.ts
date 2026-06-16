import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { type MastermindContext, sanitizeReportFilenameBase, suggestSubagentReportBasename } from '@mastermind/shared';
import { safeFsSegment } from '../modules/agent/subagent-job-delivery.js';
import type { ConfigModule } from '../modules/config/index.js';
import { AsyncJobsModule, type JobStatus } from '../modules/async-jobs/index.js';
import type { SessionModule } from '../modules/session/index.js';

const VALID_STATUS: JobStatus[] = ['queued', 'running', 'done', 'error', 'cancelled'];

export function asyncJobsRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  /** GET / — list jobs, optional ?agentId= ?status=running,queued ?limit= */
  app.get('/', async (c) => {
    const mod = ctx.modules.get<AsyncJobsModule>('async-jobs');
    const agentId = c.req.query('agentId') ?? undefined;
    const statusRaw = c.req.query('status');
    const limitRaw = c.req.query('limit');
    const status = statusRaw
      ? (statusRaw.split(',').filter(s => VALID_STATUS.includes(s as JobStatus)) as JobStatus[])
      : undefined;
    const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 100;
    console.debug(`[route:async-jobs] list agent=${agentId ?? 'all'} status=${status?.join(',') ?? 'all'} limit=${limit}`);
    const jobs = await mod.list({
      ...(agentId ? { agentId } : {}),
      ...(status && status.length > 0 ? { status } : {}),
      limit,
    });
    console.debug(`[route:async-jobs] list result count=${jobs.length}`);
    return c.json(jobs);
  });

  /** GET /:id — single job detail */
  app.get('/:id', async (c) => {
    const mod = ctx.modules.get<AsyncJobsModule>('async-jobs');
    const jobId = c.req.param('id');
    console.debug(`[route:async-jobs] get job=${jobId}`);
    const job = await mod.get(jobId);
    if (!job) {
      console.warn(`[route:async-jobs] get job=${jobId} not found`);
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json(job);
  });

  /** POST /:id/cancel — cancel a queued or running job */
  app.post('/:id/cancel', async (c) => {
    const mod = ctx.modules.get<AsyncJobsModule>('async-jobs');
    const jobId = c.req.param('id');
    console.log(`[route:async-jobs] cancel requested job=${jobId}`);
    const result = await mod.cancel(jobId);
    if (!result.cancelled) {
      console.warn(`[route:async-jobs] cancel rejected job=${jobId} reason=${result.reason ?? 'unknown'}`);
      return c.json({ ok: false, reason: result.reason }, 400);
    }
    console.log(`[route:async-jobs] cancel ok job=${jobId}`);
    return c.json({ ok: true });
  });

  /**
   * POST /:id/export-report-to-shared — write sub-agent Markdown report under
   * `<resolved paths.sharedMemoryDir>/subagent-reports/<preset>/<baseName>.md`.
   * Body JSON optionnel : `{ "baseName": "mon-rapport" }` (sans .md) ; sinon dérivé du 1er titre `# …`.
   */
  app.post('/:id/export-report-to-shared', async (c) => {
    const mod = ctx.modules.get<AsyncJobsModule>('async-jobs');
    const configMod = ctx.modules.get<ConfigModule>('config');
    const jobId = c.req.param('id');
    const job = await mod.get(jobId);
    if (!job) {
      console.warn(`[route:async-jobs] export-report job=${jobId} not found`);
      return c.json({ error: 'Job introuvable.' }, 404);
    }
    if (job.kind !== 'sub_agent') {
      return c.json({ error: 'Seuls les runs sub-agent peuvent exporter le rapport Markdown.' }, 400);
    }
    const markdown = job.result?.trim();
    if (!markdown) {
      return c.json({ error: 'Aucun rapport Markdown sur ce run.' }, 400);
    }
    const body = await c.req.json().catch(() => ({})) as { baseName?: string };
    const rawBase = typeof body.baseName === 'string' ? body.baseName.trim() : '';
    const suggested = suggestSubagentReportBasename(markdown, jobId);
    const baseName = sanitizeReportFilenameBase(rawBase || suggested, jobId);

    const sharedRoot = configMod.resolvePath(ctx.config.paths.sharedMemoryDir);
    const preset = job.subAgentId ?? job.agentId ?? 'subagent';
    const dir = path.join(sharedRoot, 'subagent-reports', safeFsSegment(preset));
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${baseName}.md`);
      await fs.writeFile(filePath, markdown, 'utf8');
      console.log(`[route:async-jobs] export-report job=${jobId} path=${filePath}`);
      return c.json({ ok: true as const, path: filePath, baseName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[route:async-jobs] export-report job=${jobId} failed: ${msg}`);
      return c.json({ error: `Écriture impossible : ${msg}` }, 500);
    }
  });

  /**
   * GET /:id/audit — replay the messages produced by a sandbox_run job.
   * Returns the job metadata + all session messages with source='sandbox' created
   * between the job's started_at and completed_at (or now if still running).
   * Shell jobs return an empty messages array (nothing to replay — the result is in job.result).
   */
  app.get('/:id/audit', async (c) => {
    const mod = ctx.modules.get<AsyncJobsModule>('async-jobs');
    const jobId = c.req.param('id');
    console.debug(`[route:async-jobs] audit job=${jobId}`);
    const job = await mod.get(jobId);
    if (!job) {
      console.warn(`[route:async-jobs] audit job=${jobId} not found`);
      return c.json({ error: 'Not found' }, 404);
    }
    if (job.kind === 'sub_agent') {
      // Sub-agent runs : the transient sub-session lives at sessionId='sub-${jobId}',
      // and all its messages have source='subagent'. Note: when runSubAgent completes,
      // it overrides session_id on the job row to parent_session_id (so the row links
      // to where the user-visible delivery landed). The original sub-session id is
      // reconstructable from the job id.
      const subSessionId = `sub-${jobId}`;
      const sessionMod = ctx.modules.get<SessionModule>('session');
      const fromIso = job.startedAt ?? job.createdAt;
      const toIso = job.completedAt ?? new Date().toISOString();
      const messages = await sessionMod.listMessagesInTimeRange(subSessionId, 'subagent', fromIso, toIso);
      console.debug(`[route:async-jobs] audit job=${jobId} kind=sub_agent subSession=${subSessionId} messages=${messages.length}`);
      return c.json({ job, messages });
    }
    if (job.kind !== 'sandbox_run') {
      console.debug(`[route:async-jobs] audit job=${jobId} kind=${job.kind} no sandbox replay`);
      return c.json({ job, messages: [] });
    }
    if (!job.startedAt) {
      console.debug(`[route:async-jobs] audit job=${jobId} has no startedAt`);
      return c.json({ job, messages: [] });
    }
    const sessionMod = ctx.modules.get<SessionModule>('session');
    const fromIso = job.startedAt;
    const toIso = job.completedAt ?? new Date().toISOString();
    const messages = await sessionMod.listMessagesInTimeRange(job.sessionId, 'sandbox', fromIso, toIso);
    console.debug(`[route:async-jobs] audit job=${jobId} messages=${messages.length} from=${fromIso} to=${toIso}`);
    return c.json({ job, messages });
  });

  return app;
}
