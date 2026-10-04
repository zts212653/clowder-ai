import { CollectiveReconsiderationRefusalError } from '../../../../plugin/builtin-runtime/collective-work/collective-reconsideration-refusal.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { CollectivePrivateWorkRefusalError } from './collective-private-refusal.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';
import { requireRefusedReconsiderationCarrier } from './queue-reconsideration-refusal-disposition.js';

export type PermanentCollectiveQueueRefusal = CollectivePrivateWorkRefusalError | CollectiveReconsiderationRefusalError;
export function isPermanentCollectiveQueueRefusal(error: unknown): error is PermanentCollectiveQueueRefusal {
  return error instanceof CollectivePrivateWorkRefusalError || error instanceof CollectiveReconsiderationRefusalError;
}

export function collectiveQueueRefusalError(refusal: PermanentCollectiveQueueRefusal): string {
  return `${refusal.code}:${refusal.reason}:${refusal.message}`;
}

/**
 * A proven Collective refusal cancels only its exact singleton source.
 * The Message cancellation atomically clears actionable custody and remains a
 * restart fence. It neither withdraws an author's request nor records handled Work.
 */
export async function retireRefusedCollectiveQueueCarrier(input: {
  entry: QueueEntry;
  queue: InvocationQueue;
  messages: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'markCanceled'>;
  refusal: PermanentCollectiveQueueRefusal;
  persistRefusal(): Promise<void>;
}): Promise<boolean> {
  const { entry, queue, messages } = input;
  if (
    entry.status !== 'processing' ||
    entry.targetCats.length !== 1 ||
    !entry.messageId ||
    entry.mergedMessageIds.length !== 0 ||
    entry.exactSteerBatch
  )
    throw new Error('Collective refusal requires one exact processing carrier');

  const source = await messages.getById(entry.messageId);
  if (
    !source ||
    source.threadId !== entry.threadId ||
    source.userId !== entry.userId ||
    source.deliveryStatus !== 'queued' ||
    source.queueCustody?.entryId !== entry.id ||
    source.queueCustody.executionScope !== entry.executionScope ||
    source.queueCustody.allTargetCats.length !== 1 ||
    source.queueCustody.allTargetCats[0] !== entry.targetCats[0]
  )
    throw new Error('Collective refusal source/custody identity is unavailable');

  if (input.refusal instanceof CollectivePrivateWorkRefusalError) {
    if (entry.executionScope !== 'collective-work' || !source.extra?.collectiveWorkInvocationV1)
      throw new Error('Private refusal has no exact private admission carrier');
  } else await requireRefusedReconsiderationCarrier({ entry, source, refusal: input.refusal, messages });

  // Do not publish terminal disappearance until both exact failure evidence and
  // canonical Message cancellation are durable. An unavailable writer retains
  // the existing source for retry rather than silently consuming it.
  await input.persistRefusal();
  const canceled = await messages.markCanceled(source.id);
  if (canceled?.deliveryStatus !== 'canceled' || canceled.queueCustody !== undefined) {
    throw new Error('Collective refusal source cancellation did not commit');
  }
  return queue.removeEntrySnapshotIfUnchanged(entry);
}
