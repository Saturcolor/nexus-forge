/** Parse SSE stream from OpenAI-compatible API */
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<{ data: string }> {
  const reader = response.body?.getReader();
  if (!reader) {
    console.error('[stream] No response body — stream aborted before start');
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.debug(`[stream] SSE reader done after ${eventCount} events${buffer.length > 0 ? ` (leftover buffer: ${buffer.length} chars)` : ''}`);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            console.debug(`[stream] SSE [DONE] received after ${eventCount} events`);
            return;
          }
          eventCount++;
          yield { data };
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't log aborts as errors — they're expected during cancellation
    if (msg !== 'The operation was aborted' && !msg.includes('abort')) {
      console.warn(`[stream] SSE read error after ${eventCount} events: ${msg}`);
    } else {
      console.debug(`[stream] SSE aborted after ${eventCount} events`);
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
}
