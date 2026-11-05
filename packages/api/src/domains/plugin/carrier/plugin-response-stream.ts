import { Readable } from 'node:stream';

export function pluginResponseStream(value: unknown): Readable | undefined {
  if (!value || typeof value !== 'object' || !('body' in value)) return undefined;
  return value.body instanceof Readable ? value.body : undefined;
}

/** The HTTP request ends with its response body, not with the handler's returned headers. */
export function retireWithResponse(value: unknown, signal: AbortSignal, retire: () => void): boolean {
  const body = pluginResponseStream(value);
  if (!body) return false;
  const finish = () => {
    retire();
    body.off('end', finish);
    body.off('close', finish);
    body.off('error', finish);
    signal.removeEventListener('abort', abort);
  };
  const abort = () => {
    body.destroy();
    finish();
  };
  body.once('end', finish);
  body.once('close', finish);
  body.once('error', finish);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted || body.destroyed || body.readableEnded) abort();
  return true;
}

/** Preserve backpressure and the exact activation fence across every streamed byte. */
export function fencePluginResponseStream<T>(value: T, signal: AbortSignal, current: () => Promise<void>): T {
  const source = pluginResponseStream(value);
  if (!source) return value;
  const body = Readable.from(
    (async function* () {
      try {
        for await (const chunk of source) {
          signal.throwIfAborted();
          await current();
          signal.throwIfAborted();
          if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new TypeError('Byte stream required');
          yield chunk;
        }
      } catch {
        // Package errors may contain credentials. Only this public transport failure crosses HTTP.
        throw new Error('Plugin response stream failed');
      } finally {
        source.destroy();
      }
    })(),
    { objectMode: false },
  );
  const abort = () => {
    source.destroy();
    body.destroy();
  };
  const sourceError = () => body.destroy(new Error('Plugin response stream failed'));
  source.on('error', sourceError);
  body.once('close', () => {
    source.off('error', sourceError);
    source.destroy();
    signal.removeEventListener('abort', abort);
  });
  // Prevent an abort/error before Fastify attaches its pipeline from becoming unhandled.
  body.on('error', () => {});
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return { ...value, body };
}
