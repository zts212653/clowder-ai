import { isDeepStrictEqual } from 'node:util';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';
import { queueCarrierMessageIds, readQueueCarrierMessages } from './QueueCarrierSourceProjection.js';
import {
  activeCarrierEntryIds,
  carrierEntryId,
  isQueuedCarrierTarget,
} from './QueuedMessageCustodyCarrierProjection.js';
import { buildQueueEntry } from './QueuedMessageCustodyStartupQueueEntry.js';

export type OwnedQueueProgress =
  | 'started'
  | 'owned_deferred_busy'
  | 'owned_deferred_paused'
  | 'owned_deferred_suppressed'
  | 'already_processing'
  | 'terminal_owned';

export interface PersistedCarrierCoordinates {
  sourceMessageId: string;
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  expectedEntryId?: string;
}

export type PersistedCarrierResult =
  | { state: OwnedQueueProgress; entryId: string }
  | { state: 'unavailable' | 'conflict'; reason: string };

export interface PersistedCarrierDeps {
  messages: Pick<IMessageStore, 'getById' | 'getByThreadAfter'>;
  queue: Pick<InvocationQueue, 'getEntrySnapshot' | 'restoreDurableEntry'>;
  progress: (entry: QueueEntry, targetCatId: string) => Promise<OwnedQueueProgress>;
}

/** The store's exhaustive raw timeline is the membership source; recent UI history is insufficient. */
async function readCompleteCarrier(
  deps: PersistedCarrierDeps,
  input: PersistedCarrierCoordinates,
  entryId: string,
): Promise<StoredMessage[]> {
  const timeline = await deps.messages.getByThreadAfter(input.threadId, undefined, undefined, input.ownerUserId, {
    includeQueuedCatMessages: true,
    includeQueuedUserMessages: true,
  });
  const members = timeline
    .filter((message) => activeCarrierEntryIds(message).includes(entryId))
    .map((message) => structuredClone(message));
  if (members.some((message) => message.queueCustody?.ownerUserId !== input.ownerUserId)) {
    throw new Error('Queue carrier member owner does not match');
  }
  const live = deps.queue.getEntrySnapshot(input.threadId, input.ownerUserId, entryId);
  const required = new Set([input.sourceMessageId, ...(live ? queueCarrierMessageIds(live) : [])]);
  if ([...required].some((id) => !members.some((message) => message.id === id))) {
    throw new Error('Complete Queue carrier membership is unavailable');
  }
  const current = await readQueueCarrierMessages(buildQueueEntry(members, entryId), deps.messages);
  if (current.some((message, index) => !isDeepStrictEqual(message.queueCustody, members[index]?.queueCustody))) {
    throw new Error('Queue carrier changed while reading complete membership');
  }
  return current;
}

/** Compare every durable scheduling/exposure field, normalizing only absent empty projections. */
function projection(entry: QueueEntry) {
  return {
    id: entry.id,
    threadId: entry.threadId,
    userId: entry.userId,
    ownerAuthProvenance: entry.ownerAuthProvenance,
    executionScope: entry.executionScope,
    messageId: entry.messageId,
    mergedMessageIds: entry.mergedMessageIds,
    content: entry.content,
    source: entry.source,
    sourceCategory: entry.sourceCategory,
    callerCatId: entry.callerCatId,
    a2aParentInvocationId: entry.a2aParentInvocationId,
    a2aTriggerMessageId: entry.a2aTriggerMessageId,
    targetCats: entry.targetCats,
    allTargetCats: entry.allTargetCats ?? entry.targetCats,
    authorIntentByCatId: entry.authorIntentByCatId ?? {},
    intent: entry.intent,
    createdAt: entry.createdAt,
    priority: entry.priority,
    position: entry.position,
    autoExecute: entry.autoExecute,
    notified: entry.queuedNotifiedByCatIds ?? [],
    awakened: entry.queuedAwakenedInvocationIdByCatId ?? {},
    awakenedAt: entry.queuedAwakenedAtByCatId ?? {},
    seen: entry.queuedSeenByCatIds ?? [],
    seenInvocations: entry.queuedSeenInvocationIdByCatId ?? {},
    exposures: entry.queuedBodyExposures ?? [],
    failed: entry.queuedFailedByCatIds ?? [],
    attempts: entry.queuedAttemptIdByCatId ?? {},
    handled: entry.queuedHandledByCatIds ?? [],
    steer: entry.steerRequestedByCatIds ?? [],
    steered: entry.steeredInvocationIdByCatId ?? {},
    prestartRetirement: entry.prestartRetirement,
    waitContinuationCarrier: entry.waitContinuationCarrier,
    actionSuccessorFence: entry.actionSuccessorFence,
  };
}

/** Confirm durable custody and request normal Dispatch progress without transferring or replaying its owner. */
export async function ensurePersistedCarrierOwnedAndScheduled(
  deps: PersistedCarrierDeps,
  input: PersistedCarrierCoordinates,
): Promise<PersistedCarrierResult> {
  try {
    const source = await deps.messages.getById(input.sourceMessageId);
    const custody = source?.queueCustody;
    if (!source || !custody) return { state: 'unavailable', reason: 'Queue custody is unavailable' };
    const entryId = carrierEntryId(custody, input.targetCatId);
    if (
      !entryId ||
      source.threadId !== input.threadId ||
      source.userId !== input.ownerUserId ||
      custody.ownerUserId !== input.ownerUserId ||
      !custody.allTargetCats.some((cat) => cat === input.targetCatId) ||
      (input.expectedEntryId && input.expectedEntryId !== entryId)
    ) {
      return { state: 'conflict', reason: 'Queue custody coordinates do not match' };
    }
    if (
      custody.status === 'terminal' ||
      custody.handledByCatIds.some((cat) => cat === input.targetCatId) ||
      custody.withdrawnByCatIds?.some((cat) => cat === input.targetCatId) ||
      custody.failedByCatIds.some((cat) => cat === input.targetCatId)
    ) {
      return { state: 'terminal_owned', entryId };
    }
    if (!custody.pendingTargetCats.some((cat) => cat === input.targetCatId)) {
      return { state: 'conflict', reason: 'Queue target has no current owner' };
    }
    // An accepted child or processing carrier belongs to Dispatch recovery, never a fresh admission.
    if (
      !isQueuedCarrierTarget(custody, input.targetCatId) ||
      custody.awakenedInvocationIdByCatId?.[input.targetCatId]
    ) {
      return { state: 'already_processing', entryId };
    }
    const members = await readCompleteCarrier(deps, input, entryId);
    const expected = buildQueueEntry(members, entryId);
    const live = deps.queue.getEntrySnapshot(input.threadId, input.ownerUserId, entryId);
    if (live && !isDeepStrictEqual(projection(live), projection(expected))) {
      return { state: 'conflict', reason: 'Live Queue projection disagrees with complete durable custody' };
    }
    if (live?.status === 'processing') return { state: 'already_processing', entryId };
    if (expected.status !== 'queued') return { state: 'already_processing', entryId };
    // restoreDurableEntry rejects a same-id row in another scope. No substitute entry is minted.
    try {
      deps.queue.restoreDurableEntry(expected);
    } catch (error) {
      return { state: 'conflict', reason: error instanceof Error ? error.message : String(error) };
    }
    return { state: await deps.progress(expected, input.targetCatId), entryId };
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}
