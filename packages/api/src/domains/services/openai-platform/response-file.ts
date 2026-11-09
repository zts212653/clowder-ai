import { createHash } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';

export async function abortable<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new Error('Platform request interrupted'));
    signal.addEventListener('abort', cancelled, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
    if (signal.aborted) cancelled();
  });
}

/** Hold a boundary tail so even a credential split across chunks never reaches disk. */
export async function savePlatformResponse(
  response: Response,
  path: string,
  options: {
    signal: AbortSignal;
    maxBytes: number;
    credentials: readonly string[];
  },
): Promise<{ bytes: number; sha256: string }> {
  const partial = `${path}.partial`;
  const file = await open(partial, 'wx', 0o600);
  const reader = response.body?.getReader();
  const secrets = options.credentials.filter(Boolean).map((key) => Buffer.from(key));
  const keep = Math.max(0, ...secrets.map((key) => key.length - 1));
  const hash = createHash('sha256');
  let tail = Buffer.alloc(0);
  let size = 0;
  try {
    while (reader) {
      const next = await abortable(options.signal, reader.read());
      if (next.done) break;
      size += next.value.byteLength;
      if (size > options.maxBytes) throw new Error('Platform response exceeds limit');
      const pending = Buffer.concat([tail, next.value]);
      if (secrets.some((key) => pending.includes(key))) throw new Error('Platform response contains a credential');
      const end = Math.max(0, pending.length - keep);
      const safe = pending.subarray(0, end);
      await file.writeFile(safe);
      hash.update(safe);
      tail = Buffer.from(pending.subarray(end));
    }
    options.signal.throwIfAborted();
    await file.writeFile(tail);
    hash.update(tail);
    await file.close();
    await rename(partial, path);
    return { bytes: size, sha256: hash.digest('hex') };
  } catch (error) {
    await file.close();
    await rm(partial, { force: true });
    throw error;
  } finally {
    void reader?.cancel().catch(() => {});
  }
}

function extractUsage(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  if ('usage' in value) return value.usage ?? null;
  if ('response' in value) return extractUsage(value.response);
  return null;
}

/** Preserve the response file; this is only a bounded metadata projection. */
export async function readPlatformUsage(path: string, contentType: string): Promise<unknown> {
  if (!/json|text\/event-stream/i.test(contentType)) return null;
  const content = await readFile(path, 'utf8');
  let usage: unknown = null;
  try {
    if (/text\/event-stream/i.test(contentType)) {
      for (const line of content.split('\n')) {
        if (!line.startsWith('data:') || line.length > 1024 * 1024) continue;
        try {
          usage = extractUsage(JSON.parse(line.slice(5))) ?? usage;
        } catch {
          /* SSE comments and [DONE] are not JSON. */
        }
      }
    } else usage = extractUsage(JSON.parse(content));
    if (Buffer.byteLength(JSON.stringify(usage)) > 64 * 1024) return null;
    return usage;
  } catch {
    return null;
  }
}
