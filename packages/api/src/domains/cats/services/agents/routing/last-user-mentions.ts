import type { CatId } from '@cat-cafe/shared';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../../stores/visibility.js';

const PAGE_SIZE = 50;

/**
 * The last Human choice lasts until another Human mention. Queued inputs count
 * immediately; A2A and system messages never change that choice. Read the
 * durable messages rather than maintaining a second routing preference ledger.
 *
 * Storage pagination follows publication time, but the choice follows input
 * authoring time: late delivery must not restore an older recipient. Therefore
 * every page can contain a newer choice, and no age/count cutoff is valid.
 */
export async function findLastUserMentions(store: IMessageStore, threadId: string): Promise<readonly CatId[]> {
  const visibility = { includeQueuedUserMessages: true, recipientProjection: true };
  let cursor: { time: number; id: string } | undefined;
  let latest: StoredMessage | undefined;
  for (;;) {
    const page = await (cursor
      ? store.getByThreadBefore(threadId, cursor.time, PAGE_SIZE, cursor.id, undefined, visibility)
      : store.getByThread(threadId, PAGE_SIZE, undefined, visibility));
    if (!page?.length) break;
    for (const message of page) {
      if (messageFrom(message).kind !== 'user' || !message.mentions?.length) continue;
      if (
        !latest ||
        message.timestamp > latest.timestamp ||
        (message.timestamp === latest.timestamp && message.id > latest.id)
      )
        latest = message;
    }
    const oldest = page[0];
    if (!oldest || page.length < PAGE_SIZE) break;
    const next = { time: getTimelineOrderTime(oldest), id: oldest.id };
    if (cursor?.time === next.time && cursor.id === next.id) break;
    cursor = next;
  }
  return latest?.mentions ?? [];
}
