import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { MastermindContext } from '@mastermind/shared';
import type { AgentModule } from '../modules/agent/index.js';

/** Hard upper bound on any single uploaded file (20 MB). Reject above this to keep workspace bounded. */
const MAX_FILE_SIZE = 20_000_000;

/** Max text file size for inline content extraction (500 KB) */
const MAX_INLINE_SIZE = 500_000;

/** Text-like extensions — content extracted and returned inline */
const TEXT_EXTS = new Set([
  '.txt', '.md', '.log', '.json', '.csv', '.tsv', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.js', '.ts', '.py', '.sh',
  '.bat', '.ps1', '.env', '.toml', '.ini', '.cfg', '.conf',
  '.sql', '.graphql', '.dockerfile', '.makefile',
]);

/**
 * Vision-capable image extensions — these are passed to the LLM as base64 data-URLs.
 * SVG/BMP/TIFF excluded: most vision models don't support them.
 */
const IMAGE_EXTS: Record<string, string> = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

function isTextFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTS.has(ext) || filename.toLowerCase() === 'makefile' || filename.toLowerCase() === 'dockerfile';
}

function imageMimeType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTS[ext] ?? null;
}

export function uploadRoutes(ctx: MastermindContext): Hono {
  const app = new Hono();

  /**
   * POST /api/upload/:agentId
   * Accepts multipart form data with one or more files.
   * Saves them to the agent workspace under `uploads/` and returns info + extracted text.
   */
  app.post('/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const agentMod = ctx.modules.get<AgentModule>('agent');
    const agentConfig = agentMod.getAgent(agentId);
    if (!agentConfig) {
      console.warn(`[route:upload] agent=${agentId} not found`);
      return c.json({ error: 'Agent not found' }, 404);
    }

    console.log(`[route:upload] start agent=${agentId}`);
    const formData = await c.req.formData();
    const uploadsDir = path.join(agentConfig.workspacePath, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });

    // Collect all File entries first so we can reject the whole request on any
    // oversize file BEFORE writing anything to disk — avoids partial-write
    // orphans when a batched request has one bad apple.
    const incoming: File[] = [];
    for (const [_key, value] of formData.entries()) {
      if (value instanceof File) incoming.push(value);
    }
    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        console.warn(`[route:upload] reject agent=${agentId} file="${file.name}" size=${file.size} > max=${MAX_FILE_SIZE}`);
        return c.json({ error: `File "${file.name}" is ${(file.size / 1_000_000).toFixed(1)} MB — max ${MAX_FILE_SIZE / 1_000_000} MB.` }, 413);
      }
    }

    const results: Array<{
      originalName: string;
      savedPath: string;
      relativePath: string;
      size: number;
      isText: boolean;
      content?: string;
    }> = [];

    for (const file of incoming) {
      // Preserve the original filename so the agent (and the user) can reason about it.
      // Defense in depth: `basename` strips any path component the browser sneaks in
      // (`../`, `C:\…`), then replace filesystem-unsafe characters. The nanoid subdir
      // gives uniqueness without colliding with sibling uploads.
      const rawName = path.basename(file.name) || 'file';
      const safeName = rawName.replace(/[\\/:*?"<>|\x00]/g, '_').replace(/^\.+/, '') || 'file';
      const bucket = nanoid(8);
      const bucketDir = path.join(uploadsDir, bucket);
      await fs.mkdir(bucketDir, { recursive: true });
      const savedPath = path.join(bucketDir, safeName);
      const relativePath = `uploads/${bucket}/${safeName}`;

      // Write file to disk
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(savedPath, buffer);
      console.debug(`[route:upload] saved agent=${agentId} original="${file.name}" safe=${safeName} bytes=${buffer.length}`);

      const result: (typeof results)[number] = {
        originalName: file.name,
        savedPath,
        relativePath,
        size: buffer.length,
        isText: isTextFile(file.name),
      };

      // Extract text content for text files
      if (result.isText && buffer.length <= MAX_INLINE_SIZE) {
        result.content = buffer.toString('utf-8');
        console.debug(`[route:upload] extracted inline text agent=${agentId} file=${safeName} chars=${result.content.length}`);
      } else if (result.isText) {
        console.debug(`[route:upload] skipped inline text agent=${agentId} file=${safeName} bytes=${buffer.length} max=${MAX_INLINE_SIZE}`);
      }

      results.push(result);
    }

    console.log(`[route:upload] agent=${agentId} files=${results.length} totalSize=${results.reduce((s, r) => s + r.size, 0)}`);
    return c.json({ ok: true, files: results });
  });

  return app;
}
