import type { IMessageStore, StoredMessage } from './ports/MessageStore.js';

/** Canonical CAS owns publication; notifications only invalidate derived indexes. */
export function notifyMessageTimelineChange(
  store: Pick<IMessageStore, 'onTimelineChanged'>,
  message: StoredMessage,
): void {
  try {
    void Promise.resolve(store.onTimelineChanged?.(message)).catch(() => {});
  } catch {
    /* derived notification is fail-open */
  }
}
