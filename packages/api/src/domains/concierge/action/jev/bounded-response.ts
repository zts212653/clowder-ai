import { whileNotAborted } from '../../live/host/live-controlled-context.js';

export async function readBoundedJson(response: Response, signal: AbortSignal, maximum: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Bounded response unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await whileNotAborted(signal, reader.read());
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('Response exceeds its bound');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
