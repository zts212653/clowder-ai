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
  response?: StoredMessage | null,
): boolean {
  const failure = entry.delivery.appendRecoveryByTarget?.[targetCatId];
  const ref = source.lifecycle?.dispatchRefs?.find((candidate) => candidate.targetId === targetCatId);
  const eligible = Boolean(
    entry.owner.kind === 'user' &&
      entry.owner.userId === source.userId &&
      entry.threadId === source.threadId &&
      entry.payload.messageId === source.id &&
      (source.visibility !== 'whisper' || source.whisperTo?.some((catId) => catId === targetCatId)) &&
      !source.deletedAt &&
      !source.recall &&
      !source._tombstone &&
      source.deliveryStatus !== 'canceled' &&
      entry.targets.includes(targetCatId) &&
      !entry.execution.executionScope &&
      !entry.execution.liveSessionId &&
      failure?.acceptance === 'unknown' &&
      ref?.statusMessageId === failure.responseMessageId &&
      ref.appendAcceptance !== 'accepted',
  );
  if (!eligible) return false;
  const pending = entry.delivery.appendPendingByTarget?.[targetCatId];
  if (pending?.requiresCompletion && ref?.inputRead?.status === 'read') {
    // Native still owns its completion receipt. Only an ended exact receiver enables an explicit new input.
    return (
      (source.from?.kind === 'user' || source.from?.kind === 'agent') &&
      pending.invocationId === failure?.invocationId &&
      pending.responseMessageId === ref.statusMessageId &&
      response?.id === ref.statusMessageId &&
      response.userId === source.userId &&
      response.threadId === source.threadId &&
      response.lifecycle?.kind === 'response' &&
      response.lifecycle.invocationId === failure?.invocationId &&
      response.lifecycle.targetId === targetCatId &&
      ['failed', 'interrupted', 'canceled'].includes(response.lifecycle.status)
    );
  }
  return (
    source.from?.kind === 'user' && !pending && failure?.checkedAt !== undefined && ref?.inputRead?.status !== 'read'
  );
}
