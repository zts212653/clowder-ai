import { messageFrom } from './message-from.js';
import type { StoredMessage } from './ports/MessageStore.js';
import type { Thread } from './ports/ThreadStore.js';
import { isTimelinePublished, SYSTEM_USER_IDS } from './visibility.js';

/** Read/source admission only. Native dispatch proves work delivery, never reply or execution authority. */
export function isReadableSchedulerWork(
  message: StoredMessage,
  ownerUserId: string,
  thread: Pick<Thread, 'id' | 'createdBy' | 'deletedAt'> | null | undefined,
  targetCatId?: string,
): boolean {
  const from = messageFrom(message);
  if (
    from.kind !== 'system' ||
    from.service !== 'scheduler' ||
    message.source?.connector !== 'scheduler' ||
    message.catId !== null ||
    !ownerUserId ||
    SYSTEM_USER_IDS.has(ownerUserId) ||
    message.userId !== ownerUserId ||
    thread?.id !== message.threadId ||
    thread.createdBy !== ownerUserId ||
    thread.deletedAt ||
    message.sourceParseFailure ||
    message.origin === 'briefing' ||
    message.extra?.scheduler?.hiddenTrigger === true ||
    message.deletedAt ||
    message.recall ||
    message._tombstone ||
    message.deliveryStatus === 'canceled' ||
    !isTimelinePublished(message) ||
    message.lifecycle?.kind !== 'input'
  )
    return false;
  return (
    message.lifecycle.dispatchRefs?.some(
      (ref) =>
        (ref.phase === 'dispatched' || ref.phase === 'settled') &&
        !!ref.statusMessageId &&
        message.mentions.some((catId) => catId === ref.targetId) &&
        (targetCatId === undefined || ref.targetId === targetCatId),
    ) ?? false
  );
}
