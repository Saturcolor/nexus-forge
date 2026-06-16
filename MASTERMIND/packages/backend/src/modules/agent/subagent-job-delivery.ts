/**
 * Finalisation d'un job async `sub_agent` côté DB : persiste le markdown brut, set caps_hit,
 * lie le row à la session parente, broadcast async_jobs.updated. C'est tout.
 *
 * La livraison effective vers l'utilisateur est désormais pilotée par une **re-run de l'agent
 * parent** (déclenchée par `runSubAgent` post-loop dans async-jobs/index.ts) qui injecte le
 * markdown brut dans la conversation parent et appelle `send_to_user` pour notifier l'user.
 * Plus de TL;DR extraction, plus de deliverToChat passif. Voir submit_subagent_report.ts.
 * Optionnel : après succès DB, écriture disque sous `paths.subagentReportsDir` si configuré.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { WsServerMessage } from '@mastermind/shared';
import type { WsManager } from '../../ws.js';

/** Single path segment for preset / job id — avoids directory traversal and illegal chars. */
export function safeFsSegment(id: string): string {
  const s = id.replace(/[/\\<>:"|?*\x00-\x1f]/g, '_').replace(/\.\./g, '_').trim();
  return s.slice(0, 200) || 'unknown';
}

async function writeSubAgentReportToDisk(opts: {
  root: string;
  presetId: string;
  jobId: string;
  markdown: string;
}): Promise<void> {
  const dir = path.join(opts.root, safeFsSegment(opts.presetId));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeFsSegment(opts.jobId)}.md`);
  await fs.writeFile(file, opts.markdown, 'utf8');
}

export function formatSubAgentDuration(ms: number): string {
  if (ms < 0) return '0s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export interface FinalizeSubAgentJobOpts {
  db: Pool;
  ws: WsManager;
  jobId: string;
  parentSessionId: string;
  presetId: string;
  finalMarkdown: string;
  capsHit: string | null;
  /** Absolute root from config; when set, writes `<root>/<preset>/<jobId>.md` after DB success. */
  reportsRootResolved?: string;
}

/**
 * Persiste le markdown + caps_hit et marque le job done. Idempotent : si le job est déjà
 * `done` (re-call accidental) ou déjà `error` (tentative précédente échouée), short-circuit
 * sans écraser. Renvoie une erreur DB éventuelle pour que le tool puisse la surfacer au LLM.
 */
export async function finalizeSubAgentJobDelivery(opts: FinalizeSubAgentJobOpts): Promise<{ deliveryError: string | null }> {
  const { db, ws, jobId, parentSessionId, presetId, finalMarkdown, capsHit, reportsRootResolved } = opts;

  const row = await db.query<{ status: string; error: string | null }>(
    `SELECT status, error FROM async_jobs WHERE id = $1`,
    [jobId],
  );
  const status = row.rows[0]?.status;
  if (status === 'done') {
    return { deliveryError: null };
  }
  if (status === 'error') {
    const preserved = row.rows[0]?.error?.trim() || 'Job already in error state';
    console.warn(`[subagent-delivery] ${jobId} skip retry — job already errored: ${preserved.slice(0, 200)}`);
    return { deliveryError: preserved };
  }
  if (status === 'cancelled') {
    // Race window: cancel() flipped the row to 'cancelled' + aborted the agentMod run, but
    // the abort signal hadn't reached the sub-agent's tool dispatch loop yet — submit fired
    // before the agent saw the abort. Don't overwrite cancelled→done; the user's intent was
    // to cancel. Treat as delivery error so submit's caller short-circuits without setting
    // state.completed (which would trigger a parent re-run).
    console.warn(`[subagent-delivery] ${jobId} skip persist — job already cancelled (race with submit)`);
    return { deliveryError: 'job cancelled before submit' };
  }

  // Le caller (submit_subagent_report) a déjà cappé `finalMarkdown` à MARKDOWN_HARD_CAP
  // et appendé MARKDOWN_TRUNCATION_MARKER si dépassement. Re-slicer ici amputerait ce
  // marqueur (cap + marker > 200_000) — on persiste tel quel.
  let deliveryError: string | null = null;
  try {
    await db.query(
      `UPDATE async_jobs
         SET result = $1, caps_hit = $2, session_id = $3, status = 'done', completed_at = NOW()
         WHERE id = $4`,
      [finalMarkdown, capsHit, parentSessionId, jobId],
    );
  } catch (err) {
    deliveryError = err instanceof Error ? err.message : String(err);
    console.error(`[subagent-delivery] ${jobId} DB persist failed: ${deliveryError}`);
    // Best-effort flag the job as error so the worker post-loop knows not to re-trigger.
    await db.query(
      `UPDATE async_jobs SET status = 'error', error = $1, completed_at = NOW() WHERE id = $2`,
      [`persistence failed: ${deliveryError}`, jobId],
    ).catch(() => { /* swallow — already failing */ });
  }

  if (!deliveryError && reportsRootResolved?.trim()) {
    try {
      await writeSubAgentReportToDisk({
        root: reportsRootResolved.trim(),
        presetId,
        jobId,
        markdown: finalMarkdown,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[subagent-delivery] ${jobId} disk write failed: ${msg}`);
    }
  }

  ws.broadcastAll({
    type: 'async_job.completed',
    jobId,
    agentId: presetId,
    durationMs: 0,
    outputCount: 0,
  } satisfies WsServerMessage);
  ws.broadcastAll({ type: 'async_jobs.updated' } satisfies WsServerMessage);

  return { deliveryError };
}
