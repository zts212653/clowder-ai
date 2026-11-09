import { createCatId, isAppendRepeatSource } from '@cat-cafe/shared';
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
  // Re-read the canonical source, so an earlier projection cannot authorize a known-accepted input.
  const current = await store.getById(source.id);
  if (!current || current.threadId !== source.threadId || current.userId !== source.userId) return null;
  source = current;
  const ref = source.lifecycle?.dispatchRefs?.find((candidate) => candidate.targetId === targetId);
  const failure = source.lifecycle?.appendFailures?.find(
    (candidate) => candidate.targetId === targetId && candidate.responseMessageId === ref?.statusMessageId,
  );
  if (
    !failure ||
    !isAppendRepeatSource(source.from, ref, failure) ||
    (source.from?.kind === 'user' && source.from.userId !== source.userId)
  )
    return null;
  const idempotencyKey = appendRepeatKey(source.id, targetId, failure.invocationId);
  const existing = await store.getByIdempotencyKey(source.userId, source.threadId, idempotencyKey);
  if (existing) return { message: existing, entryId: queueEntryId(existing.id), deduped: true };
  const response = await store.getById(failure.responseMessageId);
  if (!isOwnerRepeatableAppendTarget(source, targetId, response)) return null;
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
      replyTo: source.replyTo ?? source.id,
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
  return { message: result.message, entryId: queueEntryId(result.message.id), deduped: result.deduped ?? false };
}
