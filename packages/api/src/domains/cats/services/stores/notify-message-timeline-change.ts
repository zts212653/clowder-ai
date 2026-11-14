import type { IMessageStore, StoredMessage } from './ports/MessageStore.js';

/** Canonical CAS owns publication. Notifications are hints and can never reverse a committed transition. */
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
