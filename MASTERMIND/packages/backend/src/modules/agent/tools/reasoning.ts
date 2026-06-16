/**
 * Extended reasoning — sends a precise question to a powerful reasoning model via Mercury's
 * /admin/reasoning/ask endpoint.
 *
 * Used by the `extended_reasoning` tool when an agent needs deep analysis beyond its own
 * reasoning capabilities (complex algorithms, subtle bugs, architecture decisions, etc.).
 * Requires:
 *   - provider.statsUrl pointing at a Mercury instance
 *   - Mercury configured with openrouter_reasoning_model
 */

const REASONING_ASK_PATH = '/admin/reasoning/ask';
const REASONING_TIMEOUT_MS = 120_000;

export interface ReasoningConfig {
  statsUrl: string;
  statsApiKey?: string;
  maxInputChars?: number;
}

/**
 * Sends a prompt to the external reasoning model via Mercury and returns the formatted answer.
 * Truncates the prompt if it exceeds maxInputChars.
 */
export async function callReasoningModel(
  prompt: string,
  config: ReasoningConfig,
): Promise<string> {
  const maxChars = config.maxInputChars ?? 8000;
  const truncated = prompt.length > maxChars
    ? prompt.slice(0, maxChars) + '\n[prompt tronqué — limite atteinte]'
    : prompt;

  const baseUrl = config.statsUrl.replace(/\/$/, '');
  const url = `${baseUrl}${REASONING_ASK_PATH}`;
  const token = config.statsApiKey;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  console.debug(`[tool:reasoning] sending prompt len=${truncated.length} to ${url}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: truncated }),
    signal: AbortSignal.timeout(REASONING_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Mercury reasoning/ask ${resp.status}: ${err.slice(0, 300)}`);
  }

  const data = await resp.json() as { answer?: string; model?: string };
  const answer = (data.answer || '').trim();
  if (!answer) throw new Error('Réponse vide du modèle de raisonnement.');

  const modelNote = data.model ? ` _(via ${data.model})_` : '';
  console.log(`[reasoning] answer received: ${answer.length} chars, model=${data.model ?? '?'}`);
  return `[Raisonnement étendu${modelNote}]\n${answer}`;
}
