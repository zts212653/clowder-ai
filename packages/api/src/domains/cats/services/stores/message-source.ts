import type { ConnectorSource } from '@cat-cafe/shared';
import type { StoredMessage } from './ports/MessageStore.js';

/** Display provenance only; the canonical sender remains StoredMessage.from. */
export function storedMessageSource(
  message: Pick<StoredMessage, 'from' | 'extra' | 'source'>,
): ConnectorSource | undefined {
  return message.from?.kind === 'plugin' ? message.extra?.pluginMessage?.presentation : message.source;
}
