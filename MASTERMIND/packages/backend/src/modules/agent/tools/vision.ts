/**
 * `inspect_image` tool — lets an agent look at / read an image already on disk by asking a
 * targeted question, answered by Mercury's vision model.
 *
 * Why this exists: incoming chat images are dumped to disk (userImageDump.ts) and the agent
 * is handed their absolute paths. Native multimodal models see the bytes only on the turn the
 * image arrives; on later turns (and on text-only providers, or when the auto vision-fallback
 * is off) the agent has nothing but a path it cannot open. read_file is text-only → garbage on
 * a binary. This tool closes that gap: read the file, base64 it, ask Mercury → get a description.
 *
 * Path safety is shared with the file tools via `safePath` (same allowlist: workspace + the
 * Environment roots, which include userImagesDir). No new filesystem reach is granted.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { safePath } from './files.js';
import { callMercuryVisionDescribe, DEFAULT_VISION_PROMPT, type VisionDescribeConfig } from '../visionFallback.js';

/** Extensions Mercury's vision route can ingest (mapped to the MIME we declare in the data URL). */
const SUPPORTED_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** On-the-wire base64 inflates ~33%; cap the raw file so we don't blow Mercury/OpenRouter limits. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface InspectImageContext {
  visionConfig: VisionDescribeConfig;
  /** Workspace dir — base for relative paths (same as the file tools' cwd). */
  workspacePath: string;
  /** Allow absolute paths outside the allowlist (agent systemAccess). */
  systemAccess: boolean;
  /** Environment roots absolute paths may live under (workspace, shared, userImagesDir, …). */
  allowedPathRoots: string[];
}

/**
 * Resolve + validate the image path, read it, and ask Mercury's vision model `question`.
 * Returns a formatted description string, or a soft-error string (never throws) so the tool
 * loop surfaces the problem to the agent instead of aborting the run.
 */
export async function executeInspectImage(
  args: Record<string, unknown>,
  ctx: InspectImageContext,
): Promise<string> {
  const rawPath = String(args['path'] ?? '').trim();
  if (!rawPath) return 'inspect_image: `path` is required (absolute path or workspace-relative).';
  const question = String(args['question'] ?? '').trim();

  let abs: string;
  try {
    abs = safePath(rawPath, ctx.workspacePath, ctx.systemAccess, ctx.allowedPathRoots);
  } catch (err) {
    console.warn(`[tool:inspect_image] path denied input="${rawPath}": ${err instanceof Error ? err.message : err}`);
    return `inspect_image: ${err instanceof Error ? err.message : String(err)}`;
  }

  const ext = path.extname(abs).toLowerCase();
  const mime = SUPPORTED_MIME[ext];
  if (!mime) {
    return `inspect_image: unsupported format "${ext || '(none)'}" — supported: ${Object.keys(SUPPORTED_MIME).join(', ')}.`;
  }

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return `inspect_image: file not found: ${abs}`;
  }
  if (!stat.isFile()) return `inspect_image: not a file: ${abs}`;
  if (stat.size > MAX_IMAGE_BYTES) {
    return `inspect_image: image too large (${stat.size} bytes, max ${MAX_IMAGE_BYTES}).`;
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch (err) {
    // stat succeeded but the read failed — TOCTOU race (file deleted/renamed) or a permission
    // change. Honour the "never throws" contract: degrade to a soft-error string.
    return `inspect_image: failed to read file: ${abs} — ${err instanceof Error ? err.message : String(err)}`;
  }
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const prompt = question || DEFAULT_VISION_PROMPT;
  console.log(`[tool:inspect_image] path=${abs} bytes=${stat.size} mime=${mime} questionLen=${question.length}`);

  try {
    const { description, model } = await callMercuryVisionDescribe(ctx.visionConfig, dataUrl, prompt);
    if (!description) return `inspect_image: vision model returned an empty description for ${path.basename(abs)}.`;
    const modelNote = model ? ` _(via ${model})_` : '';
    console.log(`[tool:inspect_image] described ${path.basename(abs)}: ${description.length} chars, model=${model ?? '?'}`);
    return `[inspect_image — ${path.basename(abs)}${modelNote}]\n${description}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tool:inspect_image] vision call failed path=${abs}: ${msg}`);
    return `inspect_image: vision call failed — ${msg}`;
  }
}
