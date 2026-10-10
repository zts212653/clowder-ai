import { isDeepStrictEqual } from 'node:util';
import { collectiveWorkInvocationV1Schema } from '@cat-cafe/shared';
import { CollectiveReconsiderationRefusalError } from '../../../../plugin/builtin-runtime/collective-work/collective-reconsideration-refusal.js';
import type { IInvocationRecordStore, UpdateInvocationInput } from '../../stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { CollectivePrivateWorkRefusalError } from './collective-private-refusal.js';
import { type InvocationQueue, type QueueEntry, queueEntryOwnerId } from './InvocationQueue.js';
import { requireRefusedReconsiderationCarrier } from './queue-reconsideration-refusal-disposition.js';
import { requireInvocationRecordUpdate } from './require-invocation-record-update.js';

export type PermanentCollectiveQueueRefusal = CollectivePrivateWorkRefusalError | CollectiveReconsiderationRefusalError;
export function isPermanentCollectiveQueueRefusal(error: unknown): error is PermanentCollectiveQueueRefusal {
  return error instanceof CollectivePrivateWorkRefusalError || error instanceof CollectiveReconsiderationRefusalError;
}

export function collectiveQueueRefusalError(refusal: PermanentCollectiveQueueRefusal): string {
  return `${refusal.code}:${refusal.reason}:${refusal.message}`;
}

/** The catch/backstop may already have committed this exact failure. A terminal
 * self-transition is rejected by real stores, so verify the durable evidence,
 * never merely a failed status or a mock store's permissive update result. */
export async function persistCollectiveRefusalRecord(input: {
  store: Partial<Pick<IInvocationRecordStore, 'get'>> & {
    update(invocationId: string, update: UpdateInvocationInput): unknown;
  };
  invocationId: string;
  entry: QueueEntry;
  refusal: PermanentCollectiveQueueRefusal;
}): Promise<void> {
  const error = collectiveQueueRefusalError(input.refusal);
  const get = input.store.get?.bind(input.store);
  if (!get) throw new Error('Collective refusal durable invocation reader is unavailable');
  const readExactRecord = async () => {
    const current = await get(input.invocationId);
    if (
      !current ||
      current.id !== input.invocationId ||
      current.threadId !== input.entry.threadId ||
      current.userId !== queueEntryOwnerId(input.entry) ||
      current.userMessageId !== input.entry.payload.messageId ||
      !isDeepStrictEqual(current.targetCats, input.entry.targets)
    )
      throw new Error('Collective refusal invocation identity is unavailable');
    return current;
  };
  const current = await readExactRecord();
  if (current.status === 'failed' && current.error === error) return;
  await requireInvocationRecordUpdate({
    store: input.store,
    invocationId: input.invocationId,
    update: { status: 'failed', error },
    writer: 'Collective permanent refusal',
  });
  const persisted = await readExactRecord();
  if (persisted.status !== 'failed' || persisted.error !== error)
    throw new Error('Collective refusal durable failure evidence did not commit');
}

/**
 * A proven Collective refusal cancels only its exact singleton source.
 * Durable failure evidence and canonical source cancellation precede pending
 * ledger retirement. Cancellation is the restart fence if retirement fails.
 * This is not an author's withdrawal or evidence of handled Work.
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
    entry.status !== 'claimed' ||
    entry.targets.length !== 1 ||
    !entry.payload.messageId ||
    entry.execution.ownerAuthProvenance !== 'unknown' ||
    entry.execution.actionSuccessorFence ||
    entry.execution.waitContinuationCarrier
  )
    throw new Error('Collective refusal requires one exact pre-provider claim');

  const requireCurrentClaim = async () => {
    const current = await queue.getDurableEntry(entry.threadId, entry.id);
    if (!isDeepStrictEqual(current, entry)) throw new Error('Collective refusal exact claim changed');
  };
  await requireCurrentClaim();

  const source = await messages.getById(entry.payload.messageId);
  if (
    !source ||
    source.threadId !== entry.threadId ||
    source.userId !== queueEntryOwnerId(entry) ||
    source.deliveryStatus !== 'queued' ||
    source.extra?.collectiveAuthorizationInvalid ||
    !isDeepStrictEqual(source.from, entry.from) ||
    source.lifecycle?.kind !== 'input' ||
    source.lifecycle.dispatchRefs?.some((ref) => entry.targets.includes(ref.targetId))
  )
    throw new Error('Collective refusal source/custody identity is unavailable');

  if (input.refusal instanceof CollectivePrivateWorkRefusalError) {
    if (
      entry.execution.executionScope !== 'collective-work' ||
      source.from?.kind !== 'system' ||
      source.from.service !== 'collective-work' ||
      !collectiveWorkInvocationV1Schema.safeParse(source.extra?.collectiveWorkInvocationV1).success
    )
      throw new Error('Private refusal has no exact private admission carrier');
  } else await requireRefusedReconsiderationCarrier({ entry, source, refusal: input.refusal, messages });

  // Do not publish terminal disappearance until both exact failure evidence and
  // canonical Message cancellation are durable. An unavailable writer retains
  // the existing source for retry rather than silently consuming it.
  await input.persistRefusal();
  await requireCurrentClaim();
  const canceled = await messages.markCanceled(source.id);
  if (canceled?.deliveryStatus !== 'canceled') {
    throw new Error('Collective refusal source cancellation did not commit');
  }
  return (await queue.commitClaimedWithdrawal(entry.threadId, entry.id)) !== null;
}
