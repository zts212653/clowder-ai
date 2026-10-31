import { cursorFor, parseCursor } from '../cats/services/stores/cursor.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { toAbstractiveMessages } from './abstractive-summary-input.js';
import { isCurationMessageReadable } from './curation/curation-message-visibility.js';
import type { SummaryReadBatch } from './summary-input-batch.js';

/** Start at the first-enable boundary without paging through historical bodies. */
export async function readCurationBatch(
  store: Pick<IMessageStore, 'getById' | 'getByThreadBefore' | 'getByThreadAfter'>,
  ownerUserId: string,
  threadId: string,
  afterMessageId: string | null,
  limit: number,
  startedAt: number,
): Promise<SummaryReadBatch> {
  let cursor = afterMessageId;
  const previous = cursor ? await store.getById(parseCursor(cursor)!.id) : null;
  if (previous && previous.threadId !== threadId) return { messages: [], scannedMessages: [] };
  if (!cursor) {
    const baseline = await store.getByThreadBefore(threadId, startedAt, 1, undefined, ownerUserId);
    cursor = baseline.at(-1)?.id ?? null;
  }
  // Accounting covers all visible append rows; only admitted owner bodies reach Luna.
  const messages = await store.getByThreadAfter(threadId, cursor ?? undefined, limit, undefined, {
    unresolvedCursorPolicy: 'empty',
    includeQueuedCatMessages: true,
    includeRecalledUserMessages: true,
  });
  const readable = messages.filter(
    (message) => message.timestamp >= startedAt && isCurationMessageReadable(message, ownerUserId, threadId),
  );
  return {
    messages: await toAbstractiveMessages(readable, store),
    scanIncomplete: messages.length === limit,
    // Match the append-time estimate. No filtered body or source claim is retained.
    scannedMessages: messages.map((m) => ({
      id: m.id,
      cursor: cursorFor(m),
      tokenCount: Math.ceil(m.content.length / 4),
    })),
  };
}

export async function readCurationMessages(...args: Parameters<typeof readCurationBatch>) {
  return (await readCurationBatch(...args)).messages;
}
