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

/** A repeat is a new user input; it never changes the original uncertain delivery. */
export function isOwnerRepeatableAppendTarget(
  entry: QueueLedgerEntry,
  source: StoredMessage,
  targetCatId: string,
): boolean {
  const failure = entry.delivery.appendRecoveryByTarget?.[targetCatId];
  const ref = source.lifecycle?.dispatchRefs?.find((candidate) => candidate.targetId === targetCatId);
  return Boolean(
    entry.owner.kind === 'user' &&
      source.from?.kind === 'user' &&
      entry.owner.userId === source.userId &&
      entry.threadId === source.threadId &&
      entry.payload.messageId === source.id &&
      (source.visibility !== 'whisper' || source.whisperTo?.some((catId) => catId === targetCatId)) &&
      !source.deletedAt &&
      !source.recall &&
      !source._tombstone &&
      source.deliveryStatus !== 'canceled' &&
      entry.targets.includes(targetCatId) &&
      !entry.delivery.appendPendingByTarget?.[targetCatId] &&
      !entry.execution.executionScope &&
      !entry.execution.liveSessionId &&
      failure?.acceptance === 'unknown' &&
      failure.checkedAt !== undefined &&
      ref?.statusMessageId === failure.responseMessageId &&
      ref.appendAcceptance !== 'accepted' &&
      ref.inputRead?.status !== 'read',
  );
}
