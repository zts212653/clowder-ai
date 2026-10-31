import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';

/** A saved message stays saved when another owner's write fails; the paged consumer will retry that source. */
export async function importStoredProjectMessage(
  message: StoredMessage,
  importMessage: ((message: StoredMessage) => Promise<void>) | undefined,
  onError: (error: unknown) => void,
) {
  if (!importMessage) return;
  try {
    await importMessage(message);
  } catch (error) {
    onError(error);
  }
}
