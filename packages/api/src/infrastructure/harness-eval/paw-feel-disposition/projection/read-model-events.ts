import { setImmediate } from 'node:timers/promises';
import type { PawFeelDispositionEvent } from '@cat-cafe/shared';
import type { IPawFeelDispositionEventLog } from '../event-log.js';
import { awaitPawFeelRead } from './bounded-reads.js';

export async function loadPawFeelEventMap(
  eventLog: IPawFeelDispositionEventLog,
  signalIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, PawFeelDispositionEvent[]>> {
  const result = new Map<string, PawFeelDispositionEvent[]>();
  for (let offset = 0; offset < signalIds.length; offset += 50) {
    signal?.throwIfAborted();
    const batch = signalIds.slice(offset, offset + 50);
    const batchMap = eventLog.readMany ? await awaitPawFeelRead(eventLog.readMany(batch, signal), signal) : undefined;
    const events = batchMap
      ? batch.map((id) => batchMap.get(id) ?? [])
      : await awaitPawFeelRead(
          Promise.all(batch.map((signalId) => eventLog.read(signalId, undefined, signal))),
          signal,
        );
    for (let index = 0; index < batch.length; index += 1) {
      const signalId = batch[index];
      const signalEvents = events[index];
      if (signalId && signalEvents) result.set(signalId, signalEvents);
    }
    await setImmediate();
  }
  signal?.throwIfAborted();
  return result;
}
