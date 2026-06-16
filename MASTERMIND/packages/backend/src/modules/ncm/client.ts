/**
 * Lightweight HTTP client for NCM Telegram voice endpoints.
 *
 * Used by the Telegram bridge to transcribe voice messages (STT)
 * and synthesize agent responses (TTS) via NCM → Mercury.
 */

export class NcmClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Check if NCM is reachable (fast, 2s timeout). */
  async isAvailable(): Promise<boolean> {
    const startedAt = Date.now();
    try {
      console.debug(`[ncm] availability check baseUrl=${this.baseUrl}`);
      const res = await fetch(`${this.baseUrl}/api/ncm/version`, {
        signal: AbortSignal.timeout(2000),
      });
      console.debug(`[ncm] availability result ok=${res.ok} status=${res.status} ms=${Date.now() - startedAt}`);
      return res.ok;
    } catch (err) {
      console.warn(`[ncm] availability failed ms=${Date.now() - startedAt}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * Transcribe audio bytes → text via NCM Telegram STT endpoint.
   * Returns the transcript text, or throws on failure.
   */
  async transcribe(audioBuffer: Buffer, agentId: string, filename = 'voice.ogg'): Promise<{ text: string; sttMs: number }> {
    const startedAt = Date.now();
    console.log(`[ncm] STT start agent=${agentId} file=${filename} bytes=${audioBuffer.length}`);
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), filename);
    formData.append('agent_id', agentId);

    const res = await fetch(`${this.baseUrl}/api/ncm/telegram/stt`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ncm] STT failed agent=${agentId} status=${res.status} ms=${Date.now() - startedAt} body="${body.slice(0, 300)}"`);
      throw new Error(`NCM STT failed (${res.status}): ${body}`);
    }

    const json = await res.json().catch(() => null) as { text?: unknown; stt_ms?: unknown } | null;
    if (typeof json?.text !== 'string') {
      console.warn(`[ncm] STT malformed body agent=${agentId} status=${res.status} ms=${Date.now() - startedAt} textType=${typeof json?.text}`);
      throw new Error(`NCM STT returned 200 with malformed body (missing/invalid "text")`);
    }
    const text = json.text;
    const sttMs = typeof json.stt_ms === 'number' ? json.stt_ms : 0;
    console.log(`[ncm] STT done agent=${agentId} textLen=${text.length} sttMs=${sttMs} totalMs=${Date.now() - startedAt}`);
    return { text, sttMs };
  }

  /**
   * Synthesize text → OGG/OPUS audio bytes via NCM Telegram TTS endpoint.
   * Returns raw audio buffer suitable for ctx.replyWithVoice().
   */
  async synthesize(text: string, agentId: string, sessionId?: string): Promise<Buffer> {
    const startedAt = Date.now();
    console.log(`[ncm] TTS start agent=${agentId} session=${sessionId ?? 'none'} textLen=${text.length}`);
    const res = await fetch(`${this.baseUrl}/api/ncm/telegram/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, agent_id: agentId, session_id: sessionId ?? '' }),
      // 180s: TTS can take ~70ms/char on CPU-only hardware; 4000-char cap × ~70ms ≈ 280s
      // worst case. 180s covers ~95th percentile for typical agent replies (<1500 chars)
      // without hanging too long on slow inference.
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ncm] TTS failed agent=${agentId} session=${sessionId ?? 'none'} status=${res.status} ms=${Date.now() - startedAt} body="${body.slice(0, 300)}"`);
      throw new Error(`NCM TTS failed (${res.status}): ${body}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[ncm] TTS done agent=${agentId} session=${sessionId ?? 'none'} bytes=${buffer.length} ms=${Date.now() - startedAt}`);
    return buffer;
  }
}
