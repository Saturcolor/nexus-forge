/**
 * Tool `submit_subagent_report` — handoff du markdown brut d'un sub-agent vers le parent.
 *
 * Flow :
 *   1. Sub-agent appelle ce tool avec son rapport Markdown complet.
 *   2. finalizeSubAgentJobDelivery persiste `result` + `caps_hit` + status='done' sur async_jobs
 *      (et optionnellement le Markdown sur disque si `paths.subagentReportsDir` est défini).
 *   3. Le markdown est stash dans `state.markdown` pour que `runSubAgent` (worker) le pick up
 *      en post-loop et déclenche une nouvelle run de l'agent parent en mode handler caché
 *      (source='proactive'), avec le markdown injecté dans la conversation parent. Le parent
 *      synthétise et appelle `send_to_user` pour notifier l'utilisateur.
 *
 * Pas de TL;DR extraction côté backend, pas de chat injection passive : le parent voit le
 * rapport brut et décide quoi en faire.
 */

import path from 'node:path';
import type { Pool } from 'pg';
import type { MastermindConfig, ToolDefinition } from '@mastermind/shared';
import type { SessionModule } from '../../session/index.js';
import type { WsManager } from '../../../ws.js';
import { finalizeSubAgentJobDelivery } from '../subagent-job-delivery.js';

/** Allowed values for `caps_hit` self-reported by the sub-agent via submit_subagent_report.
 *  Anything else → coerced to null (avoids garbage like "ok" landing in stats). */
const CAPS_HIT_WHITELIST = new Set(['iterations', 'tool_calls', 'tokens', 'timeout']);

/** Hard cap on persisted/stashed markdown. Aligned with what `finalizeSubAgentJobDelivery`
 *  writes to `async_jobs.result` so DB row and parent re-run injection see the SAME content
 *  byte-for-byte (no divergence if a sub-agent ever bypasses maxOutputTokens caps and produces
 *  >200k chars). */
const MARKDOWN_HARD_CAP = 200_000;
const MARKDOWN_TRUNCATION_MARKER = '\n\n*…[rapport tronqué — voir async_jobs.result via drill-down]*';

/** Définition LLM — injectée uniquement sur les runs `source=subagent` avec contexte job. */
export const SUBMIT_SUBAGENT_REPORT_DEF: ToolDefinition = {
  name: 'submit_subagent_report',
  description:
    'Submit your FINAL Markdown report (once). The full body is forwarded to the parent agent ' +
    'as the input of a new handler run — the parent will synthesize and notify the user. ' +
    'Structure your report freely (sections, code blocks, lists). No need for a TL;DR section: ' +
    'the parent reads the full thing. ' +
    'Optional `caps_hit` if the run stopped partial (timeout|iterations|tool_calls|tokens). ' +
    'Plain assistant text after this call is NOT seen by the parent.',
  parameters: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: 'Full Markdown report. Forwarded as-is to the parent agent.',
      },
      caps_hit: {
        type: 'string',
        description: 'Optional: why the run was partial — one of timeout|iterations|tool_calls|tokens. Omit when fully successful.',
      },
    },
    required: ['markdown'],
  },
};

export interface SubAgentDeliveryContext {
  jobId: string;
  parentSessionId: string;
  parentAgentId: string;
  parentVisibleSource: 'web' | 'telegram';
  presetId: string;
  runStartedAtMs: number;
}

/**
 * Mutable state shared between the sub-agent's tool dispatch loop and the worker post-loop.
 * `submit_subagent_report` flips `completed=true` and stashes `markdown`+`capsHit`; the worker
 * reads them to trigger the parent re-run.
 */
export interface SubAgentDeliveryState {
  completed: boolean;
  markdown?: string;
  capsHit?: string | null;
}

export interface SubmitSubagentReportExecOpts {
  subAgentDelivery?: SubAgentDeliveryContext;
  subAgentDeliveryState?: SubAgentDeliveryState;
  db?: Pool;
  sessionModule?: SessionModule;
  ws?: WsManager;
  mastermindConfig?: MastermindConfig;
  /** Same as codebase_search — resolves relative `paths.*` against the config file directory. */
  resolveConfigPath?: (p: string) => string;
}

export async function executeSubmitSubagentReport(
  args: Record<string, unknown>,
  opts: SubmitSubagentReportExecOpts,
): Promise<string> {
  const ctx = opts.subAgentDelivery;
  const state = opts.subAgentDeliveryState;
  const db = opts.db;
  if (!ctx || !state || !db) {
    return 'submit_subagent_report: unavailable (not running as a sub-agent job).';
  }
  if (state.completed) {
    return 'submit_subagent_report: already submitted for this run — do not call again.';
  }

  const markdown = String(args['markdown'] ?? '').trim();
  if (!markdown) {
    return 'submit_subagent_report: "markdown" is required (full report in Markdown).';
  }

  const capsArg = args['caps_hit'];
  const capsHitRaw =
    capsArg === null || capsArg === undefined || capsArg === ''
      ? null
      : String(capsArg).trim().toLowerCase() || null;
  // Whitelist coercion — only accept the canonical reasons. Anything else becomes null
  // (model said "ok"/"none"/random word → treat as success, not partial).
  const capsHit = capsHitRaw && CAPS_HIT_WHITELIST.has(capsHitRaw) ? capsHitRaw : null;
  if (capsHitRaw && capsHit === null) {
    console.warn(`[tool:submit_subagent_report] ${ctx.jobId} ignored unrecognised caps_hit="${capsHitRaw}" (allowed: ${[...CAPS_HIT_WHITELIST].join(',')})`);
  }

  const sessionModule = opts.sessionModule;
  const ws = opts.ws;
  if (!sessionModule || !ws) {
    return 'submit_subagent_report: internal error (session/ws missing).';
  }

  // Truncate ONCE here so DB persist and worker stash see the same bytes. Without this, the
  // DB UPDATE in finalize would `.slice(0, 200_000)` while `state.markdown` kept the full raw
  // value — the parent re-run injection would diverge from what `async_jobs.result` shows in
  // the drill-down UI.
  const persistedMarkdown = markdown.length > MARKDOWN_HARD_CAP
    ? markdown.slice(0, MARKDOWN_HARD_CAP) + MARKDOWN_TRUNCATION_MARKER
    : markdown;
  if (persistedMarkdown !== markdown) {
    console.warn(`[tool:submit_subagent_report] ${ctx.jobId} markdown ${markdown.length} chars > cap ${MARKDOWN_HARD_CAP} — truncated for DB + parent injection`);
  }

  const rawReports = opts.mastermindConfig?.paths.subagentReportsDir?.trim();
  let reportsRootResolved: string | undefined;
  if (rawReports) {
    if (opts.resolveConfigPath) {
      reportsRootResolved = opts.resolveConfigPath(rawReports);
    } else if (path.isAbsolute(rawReports)) {
      reportsRootResolved = rawReports;
    } else {
      console.warn(`[tool:submit_subagent_report] ${ctx.jobId} subagentReportsDir is relative but resolveConfigPath missing — skipping disk persist`);
    }
  }

  const { deliveryError } = await finalizeSubAgentJobDelivery({
    db,
    ws,
    jobId: ctx.jobId,
    parentSessionId: ctx.parentSessionId,
    presetId: ctx.presetId,
    finalMarkdown: persistedMarkdown,
    capsHit,
    ...(reportsRootResolved ? { reportsRootResolved } : {}),
  });

  if (deliveryError) {
    return `submit_subagent_report: persistence failed (${deliveryError}). The job was marked error or cancelled; fix and re-run if needed.`;
  }

  // Stash for the worker post-loop. Marker `completed=true` is what runSubAgent picks up to
  // trigger the parent re-run with this exact markdown.
  state.completed = true;
  state.markdown = persistedMarkdown;
  state.capsHit = capsHit;

  return (
    'submit_subagent_report: OK — report submitted. The parent agent will be triggered with ' +
    'your full markdown to synthesize and notify the user. End your turn now; any plain text ' +
    'after this call is discarded.'
  );
}
