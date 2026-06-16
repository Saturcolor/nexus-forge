/**
 * Dump user-uploaded chat images to disk so the agent can reference them by
 * absolute path in tool calls (e.g. skill_media-gen with input_image, OCR
 * pipelines, manual file edits, etc.).
 *
 * Why: chat-uploaded images arrive as `MessageImage { dataUrl: "data:image/...;base64,..." }`,
 * an in-memory blob. The agent sees them via the LLM vision channel but has no
 * filesystem path to pass to tools that consume images by path/URL. Without
 * this dump, the user use-case "edit this photo" requires the agent to either
 * download the image from somewhere or have the user re-upload via the formal
 * /api/upload endpoint — friction.
 *
 * Storage is content-stable per turn: filename = `<msgId>-<idx>.<ext>` so two
 * runs of the same turn dump the same paths (idempotent overwrites). No
 * cleanup is performed here — leave that to a cron / manual purge of files
 * older than N days.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MessageImage } from '@mastermind/shared';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

const DATA_URL_RE = /^data:([^;,]+)(?:;base64)?,(.+)$/s;

// Filename sanitizer for msgId — defense against path traversal even though
// our msgIds come from the server (nanoid). If a future code path forwards a
// client-provided ID, we want this to refuse rather than touch ../ paths.
const MSGID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Sniff the actual file format from the first few bytes — more reliable than
 * trusting the data-URL MIME (clients sometimes mislabel WebP as JPEG, or
 * arbitrary streams as octet-stream). Returns `null` if no signature matches,
 * letting the caller fall back to the declared MIME or refuse the dump.
 */
function sniffMagicBytes(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // GIF: "GIF87a" or "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  // WebP: "RIFF....WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  // HEIC/HEIF: ftyp box at offset 4 — "ftypheic", "ftypheix", "ftypmif1", "ftypmsf1"
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString('ascii');
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'heic';
    if (brand === 'avif') return 'avif';
  }
  return null;
}

/**
 * Dump each MessageImage to `<dir>/<msgId>-<idx>.<ext>`.
 *
 * Returns the array of absolute paths written (in the same order as the
 * input images). On parse / write errors for an individual image, that slot
 * is omitted from the returned array and a warning is logged. The function
 * does not throw — image dumping is best-effort: a parse failure must not
 * break the run.
 */
export async function dumpUserImages(
  images: MessageImage[],
  msgId: string,
  dir: string,
): Promise<string[]> {
  if (!images.length) return [];

  // Defense: refuse path traversal via crafted msgId. nanoid IDs match the
  // pattern by construction; this only kicks in if a future caller forwards
  // an attacker-controlled ID. Cheap and unambiguous.
  if (!MSGID_RE.test(msgId)) {
    console.warn(`[userImageDump] msgId=${msgId} contains forbidden chars, refusing dump`);
    return [];
  }

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    console.warn(
      `[userImageDump] cannot mkdir ${dir}: ${err instanceof Error ? err.message : err} ` +
      `— skipping dump entirely (agent won't see image paths this turn)`,
    );
    return [];
  }

  const written: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const m = DATA_URL_RE.exec(img.dataUrl);
    if (!m) {
      console.warn(`[userImageDump] msg=${msgId} idx=${i} not a data URL, skipping`);
      continue;
    }
    const declaredMime = (m[1] || img.mimeType || '').toLowerCase();
    const buf = Buffer.from(m[2], 'base64');

    // Resolve extension: prefer magic-byte sniffing (most reliable), fall back
    // to declared MIME → known table, and only as a last resort accept a non-
    // sniffable buffer if the declared MIME is in our whitelist. This avoids
    // the previous `bin` fallback which broke downstream tools that infer
    // content type from extension (e.g. media-gen sending to OpenRouter).
    const sniffed = sniffMagicBytes(buf);
    let ext: string | null = sniffed;
    if (!ext) {
      ext = MIME_TO_EXT[declaredMime] ?? null;
    }
    if (!ext) {
      console.warn(
        `[userImageDump] msg=${msgId} idx=${i} unknown image format ` +
        `(declared mime="${declaredMime}", first bytes=${buf.slice(0, 8).toString('hex')}), skipping`,
      );
      continue;
    }
    if (sniffed) {
      const declaredExt = MIME_TO_EXT[declaredMime];
      if (!declaredExt || declaredExt !== sniffed) {
        console.warn(
          `[userImageDump] msg=${msgId} idx=${i} declared mime="${declaredMime}" ` +
          `${declaredExt ? `maps to .${declaredExt}` : 'is unknown / non-image'} — ` +
          `magic bytes indicate .${sniffed}; writing .${sniffed}`,
        );
      }
    }

    const filePath = path.join(dir, `${msgId}-${i}.${ext}`);
    try {
      await fs.writeFile(filePath, buf);
      written.push(filePath);
      console.debug(
        `[userImageDump] wrote msg=${msgId} idx=${i} ext=${ext} bytes=${buf.length} path=${filePath} (declared mime=${declaredMime || 'none'})`,
      );
    } catch (err) {
      console.warn(
        `[userImageDump] write failed msg=${msgId} idx=${i} path=${filePath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return written;
}

/**
 * Build the markdown note appended to the user message text content when
 * images were successfully dumped to disk. Empty string when no paths.
 *
 * The note is placed AFTER the original user content so it doesn't pollute
 * the natural-language meaning of the message — it reads as a footer the
 * agent can scan when she decides to invoke an image-editing tool.
 */
export function buildUserImagesNote(paths: string[]): string {
  if (!paths.length) return '';
  const lines = ['', '', '---', '_System note — uploaded images saved to disk for tool use:_'];
  for (const p of paths) lines.push(`- \`${p}\``);
  lines.push(
    '_To SEE / read an image, call `inspect_image(path, question)` — including later turns, ' +
    'since you do not retain the raw image automatically. Pass these absolute paths to tools ' +
    'that accept an image path/URL (e.g. `skill_media-gen_generate_image(input_image: "...")` for edit mode)._',
  );
  return lines.join('\n');
}
