import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

/** One independent observer cannot suppress another observer's terminal event. */
export function attachManagedCommandWaitLifecycleEvents(
  messages: Pick<IMessageStore, 'onTimelineChanged'>,
  onMessage: (message: StoredMessage) => Promise<unknown>,
  log: { warn(context: { err: unknown }, message: string): void },
): () => void {
  const prior = messages.onTimelineChanged;
  const listener = async (message: StoredMessage) => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => prior?.(message)),
      Promise.resolve().then(() => onMessage(message)),
    ]);
    for (const result of results)
      if (result.status === 'rejected') log.warn({ err: result.reason }, 'Managed wait lifecycle observer failed');
  };
  messages.onTimelineChanged = listener;
  return () => {
    if (messages.onTimelineChanged === listener) messages.onTimelineChanged = prior;
  };
}
