import { Readable } from 'node:stream';

export function authorizedAttachmentStream(source: Readable, authorize: () => Promise<void>, signal: AbortSignal) {
  const body = Readable.from(
    (async function* () {
      try {
        signal.throwIfAborted();
        for await (const chunk of source) {
          signal.throwIfAborted();
          await authorize();
          signal.throwIfAborted();
          yield chunk;
        }
      } finally {
        signal.removeEventListener('abort', abort);
        source.destroy();
      }
    })(),
  );
  // Cancellation is cleanup, including when authority was revoked before a consumer attached.
  // Destroy both buffers without emitting an error on an unconsumed underlying stream.
  function abort() {
    source.destroy();
    body.destroy();
  }
  signal.addEventListener('abort', abort, { once: true });
  body.once('close', () => {
    signal.removeEventListener('abort', abort);
    source.destroy();
  });
  if (signal.aborted) abort();
  return body;
}
