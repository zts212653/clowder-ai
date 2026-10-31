import { isDeepStrictEqual } from 'node:util';
import type { LifecycleAppendFailure, LifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import { isLifecycleAppendFailure } from '@cat-cafe/shared';
import { assertQueueLedgerEntry, type QueueLedgerEntry } from '../agents/invocation/queue-ledger/QueueLedger.js';
import type { StoredMessage } from './ports/MessageStore.js';

export interface LifecycleAppendRecoveryInput {
  /** Exact admission snapshot taken before the provider call; never reconstructed from message prose. */
  entry: QueueLedgerEntry;
  failure: LifecycleAppendFailure;
  /** Read-only reconciliation of the original attempt, never a manual replay authorization. */
  checked?: { acceptance: 'not_accepted' | 'unknown'; at: number };
}

export type LifecycleAppendRecoveryResult =
  | { kind: 'applied' | 'replayed'; messages: StoredMessage[]; entry: QueueLedgerEntry }
  | { kind: 'already_received'; messages: StoredMessage[] }
  | { kind: 'conflict'; reason: string }
  | { kind: 'not_found' };

/** Prepare all three records before a single memory/Redis commit. */
export function prepareLifecycleAppendRecovery(
  source: StoredMessage,
  response: StoredMessage,
  currentEntry: QueueLedgerEntry | null,
  input: LifecycleAppendRecoveryInput,
):
  | {
      kind: 'prepared';
      lifecycles: readonly [LifecycleStoredMessageMetadata, LifecycleStoredMessageMetadata];
      entry: QueueLedgerEntry;
    }
  | LifecycleAppendRecoveryResult {
  const { entry: admitted, failure } = input;
  if (
    !isLifecycleAppendFailure(failure) ||
    (input.checked !== undefined && (!Number.isFinite(input.checked.at) || input.checked.at < failure.at))
  )
    return { kind: 'conflict', reason: 'invalid_outcome' };
  const outcome = input.checked
    ? { ...failure, acceptance: input.checked.acceptance, checkedAt: input.checked.at }
    : failure;
  const { targetId, invocationId, responseMessageId } = failure;
  if (
    source.id !== admitted.payload.messageId ||
    source.id !== admitted.payload.sourceRecordId ||
    source.threadId !== admitted.threadId ||
    response.threadId !== source.threadId ||
    response.id !== responseMessageId ||
    !admitted.targets.includes(targetId) ||
    !isDeepStrictEqual(admitted.from, source.from) ||
    source.recall ||
    source._tombstone ||
    source.deletedAt ||
    source.deliveryStatus === 'canceled'
  )
    return { kind: 'conflict', reason: 'source_changed' };
  const lifecycle = source.lifecycle;
  const receiver = response.lifecycle;
  if (
    !lifecycle ||
    lifecycle.kind === 'delivery_failure' ||
    receiver?.kind !== 'response' ||
    receiver.invocationId !== invocationId ||
    receiver.targetId !== targetId
  )
    return { kind: 'conflict', reason: 'receiver_changed' };
  const ref = lifecycle.dispatchRefs?.find((candidate) => candidate.targetId === targetId);
  const pending = currentEntry?.delivery.appendPendingByTarget?.[targetId];
  const incomplete = failure.acceptance === 'incomplete';
  if (
    ref?.statusMessageId === response.id &&
    (ref.appendAcceptance === 'accepted' ||
      (!incomplete && !pending?.requiresCompletion && ref.inputRead?.status === 'read'))
  )
    return { kind: 'already_received', messages: [source, response] };
  const previous = lifecycle.appendFailures?.find(
    (candidate) => candidate.targetId === targetId && candidate.invocationId === invocationId,
  );
  // The first Queue owner now survives the native call. A missing/retired
  // recipient is an ownership change, never permission to rebuild old work.
  if (!currentEntry || !currentEntry.targets.includes(targetId) || !['queued', 'claimed'].includes(currentEntry.status))
    return { kind: 'conflict', reason: 'queue_retired' };
  const recovery = currentEntry?.delivery.appendRecoveryByTarget?.[targetId];
  if (input.checked && (!previous || recovery?.invocationId !== invocationId))
    return { kind: 'conflict', reason: 'reconciliation_not_available' };
  if (input.checked && recovery?.checkedAt && currentEntry)
    return { kind: 'replayed', messages: [source, response], entry: currentEntry };
  if (
    previous &&
    currentEntry?.delivery.appendRecoveryByTarget?.[targetId]?.invocationId === invocationId &&
    !input.checked &&
    (failure.acceptance !== 'unknown' ? !ref : ref?.statusMessageId === response.id)
  )
    return { kind: 'replayed', messages: [source, response], entry: currentEntry };
  if (incomplete && (!pending?.requiresCompletion || pending.invocationId !== invocationId))
    return { kind: 'conflict', reason: 'completion_not_available' };
  const neverHandedOff =
    !ref && pending?.invocationId === invocationId && !pending.dispatchStarted && failure.acceptance === 'not_accepted';
  if (ref?.statusMessageId !== response.id && !neverHandedOff) return { kind: 'conflict', reason: 'delivery_changed' };

  if (
    currentEntry &&
    (currentEntry.id !== admitted.id ||
      !isDeepStrictEqual(currentEntry.from, admitted.from) ||
      !isDeepStrictEqual(currentEntry.owner, admitted.owner) ||
      !isDeepStrictEqual(currentEntry.payload, admitted.payload) ||
      !isDeepStrictEqual(currentEntry.execution, admitted.execution))
  )
    return { kind: 'conflict', reason: 'queue_identity_changed' };
  const restored = structuredClone(currentEntry);
  // An uncertain write is still the same unfinished native turn. Keep its
  // completion fence until that turn succeeds or its original run ends.
  if (restored.delivery.appendPendingByTarget && !(outcome.acceptance === 'unknown' && pending?.requiresCompletion)) {
    delete restored.delivery.appendPendingByTarget[targetId];
    if (!Object.keys(restored.delivery.appendPendingByTarget).length) delete restored.delivery.appendPendingByTarget;
  }
  restored.delivery.appendRecoveryByTarget = {
    ...restored.delivery.appendRecoveryByTarget,
    [targetId]: outcome,
  };
  const held = new Set(restored.delivery.routingHeldTargetIds ?? []);
  if (outcome.acceptance === 'unknown') held.add(targetId);
  else held.delete(targetId);
  if (held.size) restored.delivery.routingHeldTargetIds = [...held];
  else delete restored.delivery.routingHeldTargetIds;
  // Preserve another recipient's live claim while releasing only this failed target.
  const claims = currentEntry?.claimedTargetIds?.filter((id) => id !== targetId) ?? [];
  if (claims.length && currentEntry?.status === 'claimed') {
    restored.claimedTargetIds = claims;
  } else {
    restored.status = 'queued';
    delete restored.claimId;
    delete restored.claimedAt;
    delete restored.claimedTargetIds;
    delete restored.claimedFromTargetless;
    delete restored.processingStartedAt;
    delete restored.terminalAt;
  }
  assertQueueLedgerEntry(restored);
  const rejected = outcome.acceptance !== 'unknown';
  return {
    kind: 'prepared',
    entry: restored,
    lifecycles: [
      {
        ...lifecycle,
        appendFailures: previous
          ? lifecycle.appendFailures?.map((candidate) => (candidate === previous ? outcome : candidate))
          : [...(lifecycle.appendFailures ?? []), outcome],
        dispatchRefs: rejected
          ? lifecycle.dispatchRefs?.filter((candidate) => candidate.targetId !== targetId)
          : lifecycle.dispatchRefs,
      },
      rejected
        ? {
            ...receiver,
            inputEntryIds: receiver.inputEntryIds.filter((id) => id !== admitted.id),
            inputMessageIds: receiver.inputMessageIds.filter((id) => id !== source.id),
          }
        : receiver,
    ],
  };
}
