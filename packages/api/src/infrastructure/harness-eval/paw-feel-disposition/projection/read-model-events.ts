import type { PawFeelDispositionEvent } from '@cat-cafe/shared';
import type { IPawFeelDispositionEventLog } from '../event-log.js';

export async function loadPawFeelEventMap(
  eventLog: IPawFeelDispositionEventLog,
  signalIds: readonly string[],
): Promise<Map<string, PawFeelDispositionEvent[]>> {
  if (eventLog.readMany) return eventLog.readMany(signalIds);
  const result = new Map<string, PawFeelDispositionEvent[]>();
  for (let offset = 0; offset < signalIds.length; offset += 50) {
    const batch = signalIds.slice(offset, offset + 50);
    const events = await Promise.all(batch.map((signalId) => eventLog.read(signalId)));
    for (let index = 0; index < batch.length; index += 1) {
      const signalId = batch[index];
      const signalEvents = events[index];
      if (signalId && signalEvents) result.set(signalId, signalEvents);
    }
  }
  return result;
}
