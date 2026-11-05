import { createCatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { appendRepeatKey } from './append-delivery-identity.js';
import type { InvocationQueue } from './InvocationQueue.js';
import { queueEntryId } from './queue-ledger/QueueLedger.js';
import { isOwnerRepeatableAppendTarget } from './queue-routing-recovery-policy.js';

/** Caller has authenticated the source owner. A new admission owns retries of this explicit new-input choice. */
export async function repeatUncertainAppend(
  queue: InvocationQueue,
  store: IMessageStore,
  source: StoredMessage,
  targetId: string,
) {
  const ref = source.lifecycle?.dispatchRefs?.find((candidate) => candidate.targetId === targetId);
  const failure = source.lifecycle?.appendFailures?.find(
    (candidate) =>
      candidate.targetId === targetId &&
      candidate.responseMessageId === ref?.statusMessageId &&
      candidate.acceptance === 'unknown',
  );
  if (!failure || (source.from?.kind !== 'user' && source.from?.kind !== 'agent')) return null;
  const idempotencyKey = appendRepeatKey(source.id, targetId, failure.invocationId);
  const entry = await queue.getDurableEntry(source.threadId, queueEntryId(source.id));
  const response = await store.getById(failure.responseMessageId);
  const retireRepeatedNativeTarget = async () => {
    if (!entry?.delivery.appendPendingByTarget?.[targetId]?.requiresCompletion || ref?.inputRead?.status !== 'read')
      return;
    // The explicit new admission now owns the next attempt. Preserve original History and retire only its old waiting target.
    const removed = await queue.reconcileQueuedMessageTargetsDurable(
      source.threadId,
      source.userId,
      entry.id,
      [],
      [targetId],
      {},
    );
    if (!['updated', 'replayed', 'not_found'].includes(removed.outcome))
      throw new Error('Repeated input could not retire its original waiting target');
  };
  const existing = await store.getByIdempotencyKey(source.userId, source.threadId, idempotencyKey);
  if (existing) {
    if (entry && isOwnerRepeatableAppendTarget(entry, source, targetId, response)) await retireRepeatedNativeTarget();
    return { message: existing, entryId: queueEntryId(existing.id), deduped: true };
  }
  if (!entry || !isOwnerRepeatableAppendTarget(entry, source, targetId, response)) return null;
  const from = { kind: 'user' as const, userId: source.userId };
  const result = await queue.send(
    store,
    {
      from,
      userId: source.userId,
      threadId: source.threadId,
      content: source.content,
      mentions: [createCatId(targetId)],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      idempotencyKey,
      ...(source.contentBlocks ? { contentBlocks: source.contentBlocks } : {}),
      ...(source.replyTo ? { replyTo: source.replyTo } : {}),
      ...(source.from.kind === 'agent' ? { replyTo: source.id } : {}),
      ...(source.visibility === 'whisper' ? { visibility: 'whisper', whisperTo: [createCatId(targetId)] } : {}),
      extra: { routingTargetSource: 'explicit' },
    },
    {
      from,
      userId: source.userId,
      threadId: source.threadId,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: source.content,
      targetCats: [targetId],
      exactTargets: true,
      intent: 'execute',
      autoExecute: true,
      messageDisposition: 'next_work',
    },
  );
  if (result.outcome !== 'enqueued') return null;
  await retireRepeatedNativeTarget();
  return { message: result.message, entryId: queueEntryId(result.message.id), deduped: result.deduped ?? false };
}
