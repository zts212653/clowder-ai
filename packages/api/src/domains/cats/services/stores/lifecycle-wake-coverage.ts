import { isDeepStrictEqual } from 'node:util';
import type { QueueLedgerEntry } from '../agents/invocation/queue-ledger/QueueLedger.js';
import { prepareLifecycleAppendAdmission, type StoredMessage } from './ports/MessageStore.js';
import { isTimelinePublished, resolveDeliveryTimelineScore } from './visibility.js';

export interface LifecycleWakeCoverageInput {
  threadId: string;
  userId: string;
  targetId: string;
  invocationId: string;
  responseMessageId: string;
  entries: readonly { entryId: string; messageId: string }[];
  at: number;
}

export type LifecycleWakeCoverageResult =
  | { kind: 'applied' | 'replayed'; messages: StoredMessage[]; entries: (QueueLedgerEntry | null)[] }
  | { kind: 'conflict'; reason: string }
  | { kind: 'not_found' };

/** These owners admit an exact carrier, not arbitrary public History read by another invocation. */
export function ordinaryWakeCoverageEligible(entry: QueueLedgerEntry, targetId: string): boolean {
  return (
    entry.kind === 'message_wake' &&
    entry.targets.includes(targetId) &&
    ['queued', 'claimed'].includes(entry.status) &&
    (entry.status !== 'claimed' ||
      (entry.claimedTargetIds !== undefined && !entry.claimedTargetIds.includes(targetId))) &&
    entry.sourceCategory !== 'scheduled' &&
    !entry.execution.liveSessionId &&
    !entry.execution.actionSuccessorFence &&
    !entry.execution.waitContinuationCarrier &&
    !entry.execution.executionScope &&
    !entry.execution.cloudDispatchProvenance &&
    !entry.execution.requiresExactCloudDispatchProvenance &&
    !entry.delivery.routingHeldTargetIds?.includes(targetId) &&
    !entry.delivery.appendPendingByTarget?.[targetId] &&
    !entry.delivery.appendRecoveryByTarget?.[targetId]
  );
}

/** Prepare History and every exact Queue target before either store mutates. */
export function prepareLifecycleWakeCoverage(
  sources: readonly StoredMessage[],
  response: StoredMessage,
  entries: readonly (QueueLedgerEntry | null)[],
  input: LifecycleWakeCoverageInput,
):
  | { kind: 'prepared'; messages: StoredMessage[]; entries: (QueueLedgerEntry | null)[]; replayed: boolean }
  | LifecycleWakeCoverageResult {
  if (
    !Number.isFinite(input.at) ||
    input.entries.length === 0 ||
    sources.length !== input.entries.length ||
    entries.length !== input.entries.length ||
    new Set(input.entries.map((item) => item.entryId)).size !== input.entries.length ||
    new Set(input.entries.map((item) => item.messageId)).size !== input.entries.length ||
    response.id !== input.responseMessageId ||
    response.threadId !== input.threadId ||
    response.userId !== input.userId ||
    response.lifecycle?.kind !== 'response' ||
    response.lifecycle.status !== 'processing' ||
    response.lifecycle.invocationId !== input.invocationId ||
    response.lifecycle.targetId !== input.targetId ||
    response.from?.kind !== 'agent' ||
    response.from.catId !== input.targetId ||
    response.recall ||
    response._tombstone ||
    response.deletedAt
  )
    return { kind: 'conflict', reason: 'receiver_changed' };
  let receiver = structuredClone(response);
  const updatedSources: StoredMessage[] = [];
  const remainingEntries: (QueueLedgerEntry | null)[] = [];
  let replayed = true;
  for (let index = 0; index < input.entries.length; index++) {
    const candidate = input.entries[index]!;
    const source = sources[index]!;
    const entry = entries[index];
    if (
      source.id !== candidate.messageId ||
      source.userId !== input.userId ||
      source.threadId !== input.threadId ||
      source.visibility === 'whisper' ||
      !isTimelinePublished(source) ||
      source.recall ||
      source._tombstone ||
      source.deletedAt
    )
      return { kind: 'conflict', reason: 'source_changed' };
    const existing = source.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === input.targetId);
    if (!entry?.targets.includes(input.targetId)) {
      if (
        existing?.statusMessageId !== response.id ||
        receiver.lifecycle?.kind !== 'response' ||
        !receiver.lifecycle.inputEntryIds.includes(candidate.entryId)
      )
        return { kind: 'conflict', reason: 'queue_changed' };
      updatedSources.push(structuredClone(source));
      remainingEntries.push(entry ?? null);
      continue;
    }
    if (
      entry.id !== candidate.entryId ||
      entry.threadId !== input.threadId ||
      entry.owner.kind !== 'user' ||
      entry.owner.userId !== input.userId ||
      entry.payload.messageId !== source.id ||
      !isDeepStrictEqual(entry.from, source.from) ||
      !ordinaryWakeCoverageEligible(entry, input.targetId)
    )
      return { kind: 'conflict', reason: 'owner_not_bindable' };
    const prepared = prepareLifecycleAppendAdmission([source, receiver], {
      threadId: input.threadId,
      entryId: candidate.entryId,
      inputMessageIds: [source.id],
      runs: [
        {
          targetId: input.targetId,
          invocationId: input.invocationId,
          responseMessageId: response.id,
          dispatchedAt: input.at,
        },
      ],
    });
    if (prepared.kind !== 'prepared') return { kind: 'conflict', reason: 'lifecycle_changed' };
    updatedSources.push({
      ...source,
      lifecycle: prepared.lifecycles[0],
      ...(source.deliveryStatus === 'queued'
        ? {
            deliveryStatus: 'delivered' as const,
            deliveredAt: input.at,
            timelineOrderAt: resolveDeliveryTimelineScore(source, input.at),
          }
        : {}),
    });
    receiver = { ...receiver, lifecycle: prepared.lifecycles[1] };
    if (source.from?.kind === 'agent') {
      const receipts = receiver.extra?.coveredA2AFailureReturns ?? [];
      if (!receipts.some((receipt) => receipt.triggerMessageId === source.id)) {
        receiver.extra = {
          ...receiver.extra,
          coveredA2AFailureReturns: [
            ...receipts,
            {
              triggerMessageId: source.id,
              callerCatId: source.from.catId,
              ownerAuthProvenance: entry.execution.ownerAuthProvenance,
              isFailureReport: entry.sourceCategory === 'a2a_failure',
            },
          ],
        };
      }
    }
    const remaining = structuredClone(entry);
    remaining.targets = remaining.targets.filter((target) => target !== input.targetId);
    remainingEntries.push(remaining.targets.length ? remaining : null);
    replayed = false;
  }
  return { kind: 'prepared', messages: [...updatedSources, receiver], entries: remainingEntries, replayed };
}
