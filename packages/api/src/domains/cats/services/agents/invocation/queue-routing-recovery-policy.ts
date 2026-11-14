import { isAppendRepeatSource } from '@cat-cafe/shared';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueLedgerEntry } from './queue-ledger/QueueLedger.js';

/** A durable policy hold is valid only when the owner can recover this exact source and target. */
export function isOwnerRecoverableRoutingTarget(
  entry: QueueLedgerEntry,
  source: StoredMessage | null | undefined,
  targetCatId: string,
): boolean {
  const dispatch = source?.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === targetCatId);
  return Boolean(
    source &&
      entry.owner.kind === 'user' &&
      source.id === entry.payload.messageId &&
      source.threadId === entry.threadId &&
      source.userId === entry.owner.userId &&
      !source.deletedAt &&
      !source.recall &&
      !source._tombstone &&
      source.deliveryStatus !== 'canceled' &&
      source.visibility !== 'whisper' &&
      entry.targets.includes(targetCatId) &&
      !dispatch &&
      entry.kind !== 'private_input' &&
      !(entry.from.kind === 'agent' && entry.sourceCategory === 'continuation') &&
      !entry.execution.liveSessionId &&
      !entry.execution.executionScope,
  );
}

/** History facts offer a new owner-authenticated input, never authority to replay an old run. */
export function isOwnerRepeatableAppendTarget(
  source: StoredMessage,
  targetCatId: string,
  response?: StoredMessage | null,
): boolean {
  const ref = source.lifecycle?.dispatchRefs?.find((item) => item.targetId === targetCatId);
  const failure = source.lifecycle?.appendFailures?.find(
    (item) => item.targetId === targetCatId && item.responseMessageId === ref?.statusMessageId,
  );
  if (
    !isAppendRepeatSource(source.from, ref, failure) ||
    (source.from?.kind === 'user' && source.from.userId !== source.userId) ||
    !ref ||
    !failure ||
    ref.appendAcceptance === 'accepted' ||
    source.deletedAt ||
    source.recall ||
    source._tombstone ||
    source.deliveryStatus === 'canceled' ||
    (source.visibility === 'whisper' && !source.whisperTo?.some((id) => id === targetCatId))
  )
    return false;
  if (
    response &&
    (response.threadId !== source.threadId ||
      response.userId !== source.userId ||
      response.lifecycle?.kind !== 'response' ||
      response.lifecycle.invocationId !== failure.invocationId ||
      response.lifecycle.targetId !== targetCatId)
  )
    return false;
  if (failure.acceptance === 'incomplete') return ref.appendDelivery?.requiresCompletion === true;
  if (ref.inputRead?.status === 'read' || ref.appendAcceptance === 'written') return false;
  return failure.acceptance === 'not_accepted' || failure.checkedAt !== undefined;
}
