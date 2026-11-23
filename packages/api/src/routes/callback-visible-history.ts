import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../domains/cats/services/stores/visibility.js';

export async function filterCallbackMessages(
  messages: readonly StoredMessage[],
  include: (message: StoredMessage) => boolean | Promise<boolean>,
): Promise<StoredMessage[]> {
  const visible = await Promise.all(messages.map(include));
  return messages.filter((_, index) => visible[index]);
}

/** Raw timeline and publication indexes can place the same neighbor on both sides. */
export function mergeCallbackMessageWindow(input: {
  before: readonly StoredMessage[];
  anchor: StoredMessage;
  after: readonly StoredMessage[];
  includeAnchor: boolean;
}): StoredMessage[] {
  const messages = new Map<string, StoredMessage>();
  for (const message of [...input.before, ...input.after]) {
    if (message.id !== input.anchor.id) messages.set(message.id, message);
  }
  if (input.includeAnchor) messages.set(input.anchor.id, input.anchor);
  return [...messages.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

/** Hidden diagnostics do not consume a caller's before/after window. Original scan cursors still advance. */
export async function readCallbackMessageWindow(input: {
  store: Pick<IMessageStore, 'getByThreadBeforeBounded' | 'getByThreadAfter'>;
  threadId: string;
  userId: string;
  anchor: StoredMessage;
  direction: 'before' | 'after';
  count: number;
  include: (message: StoredMessage) => boolean | Promise<boolean>;
}): Promise<StoredMessage[]> {
  const found: StoredMessage[] = [];
  let anchor = input.anchor;
  let before = { timestamp: getTimelineOrderTime(anchor), id: anchor.id };
  const pageSize = Math.max(input.count * 2, 50);
  while (found.length < input.count) {
    const remaining = input.count - found.length;
    // Redis resolves this ID to its index position, including legacy rows whose
    // hydrated delivery time differs from their original timeline score.
    const bounded =
      input.direction === 'before'
        ? await input.store.getByThreadBeforeBounded(
            input.threadId,
            before.timestamp,
            pageSize,
            before.id,
            input.userId,
            pageSize,
            { includeQueuedCatMessages: true },
          )
        : undefined;
    const page =
      bounded?.messages ??
      (await input.store.getByThreadAfter(input.threadId, anchor.id, pageSize, input.userId, {
        includeQueuedCatMessages: true,
      }));
    const visible = await filterCallbackMessages(page, input.include);
    if (input.direction === 'before') found.unshift(...visible.slice(-remaining));
    else found.push(...visible.slice(0, remaining));
    if (bounded) {
      // A scanned batch may contain only invisible rows. Keep its raw cursor,
      // rather than treating an empty visible page as the end of history.
      if (bounded.exhausted || !bounded.nextCursor || bounded.nextCursor.id === before.id) break;
      before = bounded.nextCursor;
    } else {
      const next = page.at(-1);
      if (!next || next.id === anchor.id || page.length < pageSize) break;
      anchor = next;
    }
  }
  return found;
}
