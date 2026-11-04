import { Readable } from 'node:stream';

/** An HTTP/result envelope may own streams even though its root is not iterable. */
export function retainResponseReadables(value: unknown, retire: () => void): boolean {
  const streams = new Set<Readable>();
  const visited = new Set<object>();
  const collect = (item: unknown): void => {
    if (!item || typeof item !== 'object' || visited.has(item)) return;
    visited.add(item);
    if (item instanceof Readable) {
      streams.add(item);
      return;
    }
    // Only codec envelopes contain remote streams; never enumerate byte buffers or native objects.
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return;
    for (const child of Object.values(item)) collect(child);
  };
  collect(value);
  if (streams.size === 0) return false;
  let open = [...streams].filter((stream) => !stream.closed).length;
  if (open === 0) retire();
  for (const stream of streams) {
    if (!stream.closed)
      stream.once('close', () => {
        if (--open === 0) retire();
      });
  }
  return true;
}
