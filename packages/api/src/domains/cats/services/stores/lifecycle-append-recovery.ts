import { isDeepStrictEqual } from 'node:util';
import type { LifecycleAppendFailure, LifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import { isLifecycleAppendFailure } from '@cat-cafe/shared';
import { assertQueueLedgerEntry, type QueueLedgerEntry } from '../agents/invocation/queue-ledger/QueueLedger.js';
import type { StoredMessage } from './ports/MessageStore.js';

export interface LifecycleAppendRecoveryInput {
  /** Available only to the live handoff. A restart never reconstructs authority from History prose. */
  entry?: QueueLedgerEntry;
  sourceMessageId?: string;
  threadId?: string;
  failure: LifecycleAppendFailure;
  /** Re-evaluated immediately before the atomic commit, after asynchronous reads. */
  canResume?: () => boolean;
  checked?: { acceptance: 'not_accepted' | 'unknown'; at: number };
}

export type LifecycleAppendRecoveryResult =
  | { kind: 'applied' | 'replayed'; messages: StoredMessage[]; entry: QueueLedgerEntry | null; resumed: boolean }
  | { kind: 'already_received'; messages: StoredMessage[] }
  | { kind: 'conflict'; reason: string }
  | { kind: 'not_found' };

function clearLegacyAppend(entry: QueueLedgerEntry, targetId: string): void {
  for (const key of ['appendPendingByTarget', 'appendRecoveryByTarget'] as const) {
    if (!entry.delivery[key]) continue;
    delete entry.delivery[key][targetId];
    if (!Object.keys(entry.delivery[key]).length) delete entry.delivery[key];
  }
  if (entry.delivery.routingHeldTargetIds) {
    entry.delivery.routingHeldTargetIds = entry.delivery.routingHeldTargetIds.filter((id) => id !== targetId);
    if (!entry.delivery.routingHeldTargetIds.length) delete entry.delivery.routingHeldTargetIds;
  }
}

/** History owns the outcome. Only a live, uncanceled, definite rejection may admit fresh pending work. */
export function prepareLifecycleAppendRecovery(
  source: StoredMessage,
  response: StoredMessage,
  currentEntry: QueueLedgerEntry | null,
  input: LifecycleAppendRecoveryInput,
):
  | {
      kind: 'prepared';
      lifecycles: readonly [LifecycleStoredMessageMetadata, LifecycleStoredMessageMetadata];
      entry: QueueLedgerEntry | null;
      resumed: boolean;
    }
  | LifecycleAppendRecoveryResult {
  const { entry: admitted, failure } = input;
  if (
    !isLifecycleAppendFailure(failure) ||
    (input.checked !== undefined && (!Number.isFinite(input.checked.at) || input.checked.at < failure.at))
  )
    return { kind: 'conflict', reason: 'invalid_outcome' };
  const { targetId, invocationId, responseMessageId } = failure;
  if (
    source.id !== (input.sourceMessageId ?? admitted?.payload.messageId) ||
    source.threadId !== (input.threadId ?? admitted?.threadId) ||
    response.threadId !== source.threadId ||
    response.userId !== source.userId ||
    response.id !== responseMessageId ||
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
  const previous = lifecycle.appendFailures?.find(
    (candidate) =>
      candidate.targetId === targetId &&
      candidate.invocationId === invocationId &&
      candidate.responseMessageId === responseMessageId,
  );
  // A replay must not recreate a retry that was already dispatched, stopped, or withdrawn.
  if (previous && ref?.statusMessageId !== responseMessageId)
    return {
      kind: 'replayed',
      messages: [source, response],
      entry: currentEntry,
      resumed: previous.acceptance === 'not_accepted' && !ref && Boolean(currentEntry?.targets.includes(targetId)),
    };
  if (ref?.statusMessageId !== responseMessageId) return { kind: 'conflict', reason: 'delivery_changed' };
  const delivery = ref.appendDelivery;
  if (
    ref.appendAcceptance === 'accepted' ||
    (!delivery?.requiresCompletion && failure.acceptance !== 'incomplete' && ref.inputRead?.status === 'read')
  )
    return { kind: 'already_received', messages: [source, response] };
  // Exact completion/refusal outranks an earlier or racing inconclusive probe.
  let outcome =
    previous?.acceptance === 'incomplete'
      ? previous
      : failure.acceptance === 'incomplete'
        ? failure
        : previous?.acceptance === 'not_accepted'
          ? previous
          : failure.acceptance === 'not_accepted' && !input.checked
            ? failure
            : input.checked
              ? { ...failure, acceptance: input.checked.acceptance, checkedAt: input.checked.at }
              : previous?.checkedAt !== undefined
                ? previous
                : failure;
  if (outcome.acceptance === 'not_accepted' && ref.inputRead?.status === 'read')
    outcome = { ...outcome, acceptance: 'unknown' };
  const resumed = outcome.acceptance === 'not_accepted' && Boolean(admitted && input.canResume?.());
  if (
    resumed &&
    (!admitted ||
      admitted.payload.sourceRecordId !== source.id ||
      !admitted.targets.includes(targetId) ||
      !isDeepStrictEqual(admitted.from, source.from))
  )
    return { kind: 'conflict', reason: 'admission_changed' };
  if (
    admitted &&
    currentEntry &&
    (currentEntry.id !== admitted.id ||
      !isDeepStrictEqual(currentEntry.owner, admitted.owner) ||
      !isDeepStrictEqual(currentEntry.payload, admitted.payload) ||
      !isDeepStrictEqual(currentEntry.execution, admitted.execution))
  )
    return { kind: 'conflict', reason: 'queue_identity_changed' };

  let entry = currentEntry ? structuredClone(currentEntry) : resumed ? structuredClone(admitted!) : null;
  if (entry) {
    if (!currentEntry) entry.targets = [];
    clearLegacyAppend(entry, targetId);
    entry.targets = resumed
      ? [...new Set([...entry.targets, targetId])]
      : entry.targets.filter((id) => id !== targetId);
    if (resumed) {
      const originalIntent = admitted?.delivery.authorIntentByTarget?.[targetId];
      entry.delivery.authorIntentByTarget = {
        ...entry.delivery.authorIntentByTarget,
        [targetId]: {
          requested: 'next_work',
          ...(originalIntent?.carrierCapability ? { carrierCapability: originalIntent.carrierCapability } : {}),
        },
      };
    } else if (entry.delivery.authorIntentByTarget) delete entry.delivery.authorIntentByTarget[targetId];
    const claims = currentEntry?.claimedTargetIds?.filter((id) => id !== targetId) ?? [];
    if (currentEntry?.status === 'claimed' && claims.length) entry.claimedTargetIds = claims;
    else {
      entry.status = 'queued';
      delete entry.claimId;
      delete entry.claimedAt;
      delete entry.claimedTargetIds;
      delete entry.claimedFromTargetless;
      delete entry.processingStartedAt;
      delete entry.terminalAt;
    }
    if (entry.targets.length) assertQueueLedgerEntry(entry);
    else entry = null;
  }
  return {
    kind: 'prepared',
    entry,
    resumed,
    lifecycles: [
      {
        ...lifecycle,
        appendFailures: previous
          ? lifecycle.appendFailures?.map((item) => (item === previous ? outcome : item))
          : [...(lifecycle.appendFailures ?? []), outcome],
        dispatchRefs: resumed
          ? lifecycle.dispatchRefs?.filter((item) => item.targetId !== targetId)
          : lifecycle.dispatchRefs?.map((item) =>
              item === ref && delivery ? { ...item, appendDelivery: delivery } : item,
            ),
      },
      resumed
        ? {
            ...receiver,
            inputEntryIds: receiver.inputEntryIds.filter((id) => id !== admitted!.id),
            inputMessageIds: receiver.inputMessageIds.filter((id) => id !== source.id),
          }
        : receiver,
    ],
  };
}
