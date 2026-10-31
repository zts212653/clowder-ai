import { setImmediate } from 'node:timers/promises';
import { awaitStoreRead } from '../../../../domains/cats/services/stores/ports/StoreReadOptions.js';

/** Global counts require every current signal, but never require thousands of
 * simultaneous owner/artifact reads or an uninterrupted chain of microtasks. */
export async function mapPawFeelReads<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const output: R[] = [];
  for (let offset = 0; offset < items.length; offset += 16) {
    signal?.throwIfAborted();
    output.push(...(await awaitStoreRead(Promise.all(items.slice(offset, offset + 16).map(read)), { signal })));
    await setImmediate();
  }
  signal?.throwIfAborted();
  return output;
}

export function awaitPawFeelRead<T>(pending: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  return awaitStoreRead(Promise.resolve(pending), { signal });
}
