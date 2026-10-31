import { Readable } from 'node:stream';
import type { MediaByteRange } from '@cat-cafe/shared';

export { type MediaByteRange, parseMediaByteRange } from '@cat-cafe/shared';

/** Relay only requested bytes from an already authorized, immutable owner snapshot. */
export function streamMediaByteRange(source: Readable, range: MediaByteRange): Readable {
  const response = Readable.from(
    (async function* () {
      let offset = 0;
      try {
        for await (const chunk of source) {
          if (!Buffer.isBuffer(chunk)) throw new TypeError('media owner stream must yield buffers');
          const next = offset + chunk.length;
          if (next > range.start && offset <= range.end) {
            yield chunk.subarray(Math.max(0, range.start - offset), Math.min(chunk.length, range.end - offset + 1));
          }
          if (next > range.end) break;
          offset = next;
        }
      } finally {
        source.destroy();
      }
    })(),
  );
  // A client can disconnect before the generator starts, so its finally block
  // alone cannot release the owner snapshot in that case.
  response.once('close', () => source.destroy());
  return response;
}
