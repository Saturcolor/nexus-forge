/**
 * Vision via Mercury's /admin/vision/describe — converts images to text descriptions.
 *
 * Two consumers share the same Mercury client (`callMercuryVisionDescribe`):
 *   1. `resolveImagesAsText` — automatic vision *fallback* at run start: when the primary
 *      LLM model doesn't support vision (no mmproj loaded) AND the agent's provider has
 *      `visionFallbackEnabled`, the incoming images are pre-described into the prompt text.
 *   2. `inspect_image` tool (tools/vision.ts) — on-demand: lets the agent ASK a targeted
 *      question about an image already on disk (e.g. a user upload dumped to userImagesDir,
 *      or a file it produced). Works for ALL providers, including text-only ones with the
 *      auto-fallback turned off, and across turns once the native image bytes are gone.
 *
 * Requires:
 *   - a provider with statsUrl pointing at a Mercury instance
 *   - Mercury configured with openrouter_vision_model (e.g. google/gemini-flash-2.0-exp)
 *   - (fallback path only) provider.visionFallbackEnabled = true in mastermind.yml
 */

import type { MessageImage, ProviderConfig } from '@mastermind/shared';

const VISION_DESCRIBE_PATH = '/admin/vision/describe';
const VISION_TIMEOUT_MS = 60_000;

export const DEFAULT_VISION_PROMPT = 'Décris cette image en détail et précisément.';

/** Minimal config to reach Mercury's vision route — a subset of ProviderConfig. */
export interface VisionDescribeConfig {
  /** Mercury base URL (provider.statsUrl). */
  statsUrl: string;
  /** Bearer token (provider.statsApiKey || provider.apiKey). */
  statsApiKey?: string;
}

/**
 * Low-level call to Mercury /admin/vision/describe. `imageUrl` may be a `data:image/...;base64,...`
 * data URL or a public http(s) URL. Returns the trimmed description + the model Mercury used.
 * Throws on transport / non-2xx so callers can decide how to surface the failure.
 */
export async function callMercuryVisionDescribe(
  config: VisionDescribeConfig,
  imageUrl: string,
  prompt: string,
): Promise<{ description: string; model?: string }> {
  const baseUrl = config.statsUrl.replace(/\/$/, '');
  const url = `${baseUrl}${VISION_DESCRIBE_PATH}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.statsApiKey ? { Authorization: `Bearer ${config.statsApiKey}` } : {}),
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image_url: imageUrl, prompt: prompt.trim() || DEFAULT_VISION_PROMPT }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Mercury vision/describe ${resp.status}: ${err.slice(0, 300)}`);
  }

  const data = await resp.json() as { description?: string; model?: string };
  return { description: (data.description || '').trim(), model: data.model };
}

/**
 * Converts an array of images to a formatted text block by calling Mercury's vision route.
 * Returns an empty string if Mercury is not configured or all requests fail.
 */
export async function resolveImagesAsText(
  images: MessageImage[],
  provider: ProviderConfig,
  userPrompt: string,
): Promise<string> {
  if (!images.length || !provider.statsUrl) return '';

  const config: VisionDescribeConfig = {
    statsUrl: provider.statsUrl,
    statsApiKey: provider.statsApiKey || provider.apiKey,
  };

  const descriptions: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const label = images.length > 1 ? `Image ${i + 1}/${images.length}` : 'Image';

    try {
      const { description, model } = await callMercuryVisionDescribe(config, img.dataUrl, userPrompt);
      if (!description) {
        descriptions.push(`[${label} — description vide]`);
        continue;
      }

      const modelNote = model ? ` _(via ${model})_` : '';
      descriptions.push(`[${label} — description automatique${modelNote}]\n${description}`);
      console.log(`[visionFallback] ${label} described: ${description.length} chars, model=${model ?? '?'}`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[visionFallback] Failed to describe ${label}: ${msg}`);
      descriptions.push(`[${label} — erreur: ${msg}]`);
    }
  }

  return descriptions.join('\n\n');
}
