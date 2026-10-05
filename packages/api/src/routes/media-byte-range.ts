import { Readable } from 'node:stream';

export interface MediaByteRange {
  readonly start: number;
  readonly end: number;
}

/** One satisfiable HTTP byte range. Multi-range requests are deliberately unsupported. */
export function parseMediaByteRange(value: string, length: number): MediaByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const first = Number(match[1] || match[2]);
  const end = suffix || !match[2] ? length - 1 : Math.min(Number(match[2]), length - 1);
  const start = suffix ? Math.max(0, length - first) : first;
  return Number.isSafeInteger(first) &&
    Number.isSafeInteger(end) &&
    (!suffix || first > 0) &&
    start <= end &&
    start < length
    ? { start, end }
    : null;
}

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
