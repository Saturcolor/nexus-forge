import type { MessageImage } from '@mastermind/shared';

const DATA_URL_B64 = /^data:[^;,]*(?:;base64)?,(.+)$/s;

/**
 * Max decoded (binary) size per attached image on `chat.send`.
 * A ~15 MiB file exceeds this after base64 decode → rejected with a clear `chat.error`
 * before `Buffer.from` allocates a second full copy in the dump path.
 */
export const MAX_USER_CHAT_IMAGE_DECODED_BYTES = 12 * 1024 * 1024;

/**
 * Total decoded bytes across all images in a single `chat.send`. Even if each
 * individual image fits MAX_USER_CHAT_IMAGE_DECODED_BYTES, the sum can still
 * push the JSON payload past the protocol-level WS cap — at which point the
 * frame is dropped with a generic "trop volumineux" message instead of an
 * informative "trop d'images". Cap the cumulative budget here so we can give
 * a precise error before the protocol layer kicks in.
 */
export const MAX_USER_CHAT_IMAGES_TOTAL_DECODED_BYTES = 24 * 1024 * 1024;

/** Upper bound on decoded bytes from a data-URL base64 payload (ignores padding edge cases). */
export function estimateDataUrlDecodedBytes(dataUrl: string): number | null {
  const m = DATA_URL_B64.exec(dataUrl);
  if (!m) return null;
  const b64 = m[1].replace(/\s/g, '');
  return Math.ceil((b64.length * 3) / 4);
}

export function validateChatSendImages(
  images: MessageImage[] | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!images?.length) return { ok: true };
  const maxMb = MAX_USER_CHAT_IMAGE_DECODED_BYTES / (1024 * 1024);
  const maxTotalMb = MAX_USER_CHAT_IMAGES_TOTAL_DECODED_BYTES / (1024 * 1024);
  let total = 0;
  for (let i = 0; i < images.length; i++) {
    const n = estimateDataUrlDecodedBytes(images[i].dataUrl);
    if (n == null) continue;
    if (n > MAX_USER_CHAT_IMAGE_DECODED_BYTES) {
      const approxMb = Math.ceil(n / (1024 * 1024));
      return {
        ok: false,
        error:
          `Image ${i + 1} trop volumineuse (environ ${approxMb} Mo une fois décodée, maximum ${maxMb} Mo). ` +
          'Compresse ou redimensionne l’image puis réessaie.',
      };
    }
    total += n;
    if (total > MAX_USER_CHAT_IMAGES_TOTAL_DECODED_BYTES) {
      const totalMb = Math.ceil(total / (1024 * 1024));
      return {
        ok: false,
        error:
          `Trop d’images jointes (cumul environ ${totalMb} Mo, maximum ${maxTotalMb} Mo). ` +
          'Envoie-les en plusieurs messages ou réduis la taille.',
      };
    }
  }
  return { ok: true };
}
