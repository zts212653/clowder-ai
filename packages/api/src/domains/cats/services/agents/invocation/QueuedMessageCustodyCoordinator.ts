import type { CatId, QueueReminderAttempt, QueueTargetOutcome } from '@cat-cafe/shared';
import type { IMessageStore, QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueBodyExposure, QueueTargetCarrierBinding } from '../../stores/ports/queued-message-custody.js';
import {
  markReminderAttemptDelivered,
  markReminderAttemptMissed,
  markReminderAttemptSeen,
  requestReminderAttempt,
} from '../../stores/ports/queued-message-receipt.js';
import type { QueueEntry } from './InvocationQueue.js';
import { normalizeOwnerAuthProvenance } from './owner-auth-provenance.js';

interface CoordinatorDeps {
  messageStore: IMessageStore;
  now?: () => number;
}

export interface QueueCustodyCompletionResult {
  handledTargetCats: string[];
  pendingTargetCats: string[];
  fullyConsumed: boolean;
}

export interface QueueCustodyMessageCompletionResult extends QueueCustodyCompletionResult {
  messageId: string;
}

export interface QueueCustodySettlementResult {
  perMessage: QueueCustodyMessageCompletionResult[];
}

function catIds(values: readonly string[] | undefined): CatId[] {
  return [...(values ?? [])] as CatId[];
}

/**
 * Rehydrate one immutable cross-thread Queue carrier from its durable message
 * custody. This is shared by startup recovery and exact action replay so both
 * paths preserve the original entryId/message bundle instead of minting a
 * second carrier.
 */
export function createCrossThreadQueueEntryFromCustody(
  messages: readonly StoredMessage[],
  entryId: string,
): QueueEntry {
  const ordered = [...messages].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  const groupPrimary = ordered[0];
  if (!groupPrimary) {
    throw new Error('active cross-thread queue custody group is missing its primary projection');
  }
  const members = ordered.flatMap((message) => {
    const custody = message.queueCustody;
    if (
      !custody?.carrierByTargetCatId ||
      custody.status !== 'queued' ||
      message.threadId !== groupPrimary.threadId ||
      message.userId !== groupPrimary.userId
    ) {
      throw new Error(`invalid queued message custody group for carrier ${entryId}`);
    }
    const ownsPendingTarget = custody.pendingTargetCats.some(
      (catId) => custody.carrierByTargetCatId?.[catId]?.entryId === entryId,
    );
    return ownsPendingTarget ? [{ message, custody }] : [];
  });
  const primary = members[0]?.message;
  const custodies = members.map((member) => member.custody);
  if (!primary || custodies.length === 0) {
    throw new Error(`active queue custody group has no target for carrier ${entryId}`);
  }
  const allTargets = [
    ...new Set(
      custodies.flatMap((custody) =>
        custody.allTargetCats.filter((catId) => custody.carrierByTargetCatId?.[catId]?.entryId === entryId),
      ),
    ),
  ];
  const pendingTargets = [
    ...new Set(
      custodies.flatMap((custody) =>
        custody.pendingTargetCats.filter((catId) => custody.carrierByTargetCatId?.[catId]?.entryId === entryId),
      ),
    ),
  ];
  if (pendingTargets.length === 0) throw new Error(`active queue custody group has no target for carrier ${entryId}`);
  const targetSet = new Set<string>(allTargets);
  const mergeTargets = (select: (custody: QueuedMessageCustody) => readonly CatId[]): CatId[] =>
    [...new Set(custodies.flatMap((custody) => select(custody).filter((catId) => targetSet.has(catId))))] as CatId[];
  const mergeMap = <T>(select: (custody: QueuedMessageCustody) => Readonly<Record<string, T>> | undefined) => {
    const merged: Record<string, T> = {};
    for (const custody of custodies) {
      for (const [catId, value] of Object.entries(select(custody) ?? {})) {
        if (!targetSet.has(catId)) continue;
        const current = merged[catId];
        if (current !== undefined && JSON.stringify(current) !== JSON.stringify(value)) {
          throw new Error(`divergent Queue carrier evidence for ${entryId}/${catId}`);
        }
        merged[catId] = value;
      }
    }
    return merged;
  };
  let bodyExposures: QueueBodyExposure[] = [];
  for (const custody of custodies) {
    bodyExposures = mergeBodyExposures(
      bodyExposures,
      custody.bodyExposures?.filter((exposure) => targetSet.has(exposure.targetCatId)),
    );
  }
  const bindings = custodies.flatMap((custody) =>
    allTargets.flatMap((catId) => {
      const binding = custody.carrierByTargetCatId?.[catId];
      return binding?.entryId === entryId ? [binding] : [];
    }),
  );
  const binding = bindings[0];
  if (!binding || bindings.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(binding))) {
    throw new Error(`divergent target bindings for Queue carrier ${entryId}`);
  }
  const custody = custodies[0];
  if (!custody) {
    throw new Error(`active cross-thread queue custody group is empty for carrier ${entryId}`);
  }
  if (
    custodies.some(
      (candidate) =>
        candidate.intent !== custody.intent ||
        normalizeOwnerAuthProvenance(candidate.ownerAuthProvenance) !==
          normalizeOwnerAuthProvenance(custody.ownerAuthProvenance) ||
        candidate.priority !== custody.priority ||
        candidate.position !== custody.position,
    )
  ) {
    throw new Error(`divergent Queue carrier scheduling projection for ${entryId}`);
  }
  const awakenedInvocationIdByCatId = mergeMap((candidate) => candidate.awakenedInvocationIdByCatId);
  const awakenedAtByCatId = mergeMap((candidate) => candidate.awakenedAtByCatId);
  const seenInvocationIdByCatId = mergeMap((candidate) => candidate.seenInvocationIdByCatId);
  const steeredInvocationIdByCatId = mergeMap((candidate) => candidate.steeredInvocationIdByCatId);
  return {
    ownerAuthProvenance: normalizeOwnerAuthProvenance(custody.ownerAuthProvenance),
    id: entryId,
    threadId: primary.threadId,
    userId: primary.userId,
    content: members.map(({ message }) => message.content).join('\n'),
    messageId: primary.id,
    mergedMessageIds: members.slice(1).map(({ message }) => message.id),
    source: binding.source,
    ...(binding.sourceCategory ? { sourceCategory: binding.sourceCategory } : {}),
    ...(binding.callerCatId ? { callerCatId: binding.callerCatId } : {}),
    ...(binding.a2aParentInvocationId ? { a2aParentInvocationId: binding.a2aParentInvocationId } : {}),
    ...(binding.a2aTriggerMessageId ? { a2aTriggerMessageId: binding.a2aTriggerMessageId } : {}),
    targetCats: pendingTargets,
    allTargetCats: allTargets,
    intent: custody.intent,
    status: 'queued',
    createdAt: binding.createdAt,
    autoExecute: binding.autoExecute,
    priority: custody.priority,
    ...(custody.position !== undefined ? { position: custody.position } : {}),
    queuedNotifiedByCatIds: mergeTargets((candidate) => candidate.notifiedByCatIds),
    ...(Object.keys(awakenedInvocationIdByCatId).length > 0
      ? { queuedAwakenedInvocationIdByCatId: awakenedInvocationIdByCatId }
      : {}),
    ...(Object.keys(awakenedAtByCatId).length > 0 ? { queuedAwakenedAtByCatId: awakenedAtByCatId } : {}),
    queuedSeenByCatIds: mergeTargets((candidate) => candidate.seenByCatIds),
    queuedSeenInvocationIdByCatId: seenInvocationIdByCatId,
    queuedBodyExposures: bodyExposures,
    queuedFailedByCatIds: mergeTargets((candidate) => candidate.failedByCatIds),
    queuedHandledByCatIds: mergeTargets((candidate) => candidate.handledByCatIds),
    steerRequestedByCatIds: mergeTargets((candidate) => candidate.steerRequestedByCatIds ?? []),
    steeredInvocationIdByCatId,
  };
}

function mergeBodyExposures(
  current: readonly QueueBodyExposure[] | undefined,
  incoming: readonly QueueBodyExposure[] | undefined,
): QueueBodyExposure[] {
  const merged = (current ?? []).map((exposure) => ({ ...exposure }));
  const byKey = new Map(merged.map((exposure) => [`${exposure.targetCatId}\u0000${exposure.invocationId}`, exposure]));
  for (const exposure of incoming ?? []) {
    const key = `${exposure.targetCatId}\u0000${exposure.invocationId}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.seenAt !== exposure.seenAt) throw new Error('queue body exposure timestamp is immutable');
      continue;
    }
    const copy = { ...exposure };
    merged.push(copy);
    byKey.set(key, copy);
  }
  return merged;
}

export function createInitialQueuedMessageCustody(entry: QueueEntry): QueuedMessageCustody {
  const allTargetCats = catIds(entry.allTargetCats ?? entry.targetCats);
  return {
    version: 1,
    entryId: entry.id,
    revision: 1,
    ownerAuthProvenance: entry.ownerAuthProvenance,
    intent: entry.intent,
    status: 'queued',
    allTargetCats,
    pendingTargetCats: catIds(entry.targetCats),
    notifiedByCatIds: catIds(entry.queuedNotifiedByCatIds),
    ...(entry.queuedAwakenedInvocationIdByCatId && Object.keys(entry.queuedAwakenedInvocationIdByCatId).length > 0
      ? { awakenedInvocationIdByCatId: { ...entry.queuedAwakenedInvocationIdByCatId } }
      : {}),
    ...(entry.queuedAwakenedAtByCatId && Object.keys(entry.queuedAwakenedAtByCatId).length > 0
      ? { awakenedAtByCatId: { ...entry.queuedAwakenedAtByCatId } }
      : {}),
    seenByCatIds: catIds(entry.queuedSeenByCatIds),
    seenInvocationIdByCatId: { ...(entry.queuedSeenInvocationIdByCatId ?? {}) },
    ...(entry.queuedBodyExposures?.length
      ? { bodyExposures: entry.queuedBodyExposures.map((exposure) => ({ ...exposure })) }
      : {}),
    failedByCatIds: catIds(entry.queuedFailedByCatIds),
    handledByCatIds: catIds(entry.queuedHandledByCatIds),
    ...(entry.steerRequestedByCatIds?.length ? { steerRequestedByCatIds: catIds(entry.steerRequestedByCatIds) } : {}),
    ...(entry.steeredInvocationIdByCatId && Object.keys(entry.steeredInvocationIdByCatId).length > 0
      ? { steeredInvocationIdByCatId: { ...entry.steeredInvocationIdByCatId } }
      : {}),
    priority: entry.priority,
    ...(entry.position !== undefined ? { position: entry.position } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };
}

export function createInitialCrossThreadQueuedMessageCustody(
  messageId: string,
  entries: readonly QueueEntry[],
  options: {
    requestedTargetCats?: readonly CatId[];
    createdAt?: number;
  } = {},
): QueuedMessageCustody {
  const intent = entries[0]?.intent;
  const threadId = entries[0]?.threadId;
  const userId = entries[0]?.userId;
  const ownerAuthProvenance = normalizeOwnerAuthProvenance(entries[0]?.ownerAuthProvenance);
  const carrierByTargetCatId: Record<string, QueueTargetCarrierBinding> = {};
  const carrierStateByTargetCatId: NonNullable<QueuedMessageCustody['carrierStateByTargetCatId']> = {};
  const carrierTargetCats: CatId[] = [];

  for (const entry of entries) {
    if (
      entry.intent !== intent ||
      entry.threadId !== threadId ||
      entry.userId !== userId ||
      normalizeOwnerAuthProvenance(entry.ownerAuthProvenance) !== ownerAuthProvenance ||
      entry.source !== 'agent' ||
      entry.sourceCategory !== 'a2a'
    ) {
      throw new Error('cross-thread Queue carriers must share one A2A message identity');
    }
    for (const targetCatId of entry.targetCats) {
      if (carrierByTargetCatId[targetCatId]) {
        throw new Error(`cross-thread Queue target has multiple carriers: ${targetCatId}`);
      }
      carrierTargetCats.push(targetCatId as CatId);
      carrierByTargetCatId[targetCatId] = {
        entryId: entry.id,
        source: 'agent',
        sourceCategory: 'a2a',
        ...(entry.callerCatId ? { callerCatId: entry.callerCatId } : {}),
        ...(entry.a2aParentInvocationId ? { a2aParentInvocationId: entry.a2aParentInvocationId } : {}),
        a2aTriggerMessageId: entry.a2aTriggerMessageId ?? messageId,
        autoExecute: true,
        createdAt: entry.createdAt,
      };
      carrierStateByTargetCatId[targetCatId] = {
        status: entry.status,
        ...(entry.processingStartedAt !== undefined ? { processingStartedAt: entry.processingStartedAt } : {}),
      };
    }
  }

  const allTargetCats = [...new Set(options.requestedTargetCats ?? carrierTargetCats)] as CatId[];
  if (allTargetCats.length === 0) throw new Error('cross-thread Queue custody requires at least one target');
  if (carrierTargetCats.some((catId) => !allTargetCats.includes(catId))) {
    throw new Error('cross-thread Queue carrier target must belong to requested targets');
  }
  const failedTargetCats = allTargetCats.filter((catId) => !carrierByTargetCatId[catId]);
  const createdAt = options.createdAt ?? Math.min(...entries.map((entry) => entry.createdAt));
  if (!Number.isFinite(createdAt)) throw new Error('cross-thread Queue custody requires a finite createdAt');
  return {
    version: 1,
    entryId: `cross-thread:${messageId}`,
    revision: 1,
    ownerAuthProvenance,
    receiptScope: 'cross_thread_delivery',
    carrierByTargetCatId,
    ...(Object.keys(carrierStateByTargetCatId).length > 0 ? { carrierStateByTargetCatId } : {}),
    intent: intent ?? 'execute',
    status: carrierTargetCats.length > 0 ? 'queued' : 'terminal',
    allTargetCats,
    pendingTargetCats: [...carrierTargetCats],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: failedTargetCats,
    handledByCatIds: [],
    priority: 'normal',
    createdAt,
    updatedAt: createdAt,
  };
}

function activeCustodyFromEntry(entry: QueueEntry, current: QueuedMessageCustody, now: number): QueuedMessageCustody {
  if (normalizeOwnerAuthProvenance(current.ownerAuthProvenance) !== entry.ownerAuthProvenance) {
    throw new Error(`Queue entry ${entry.id} owner authentication provenance is immutable`);
  }
  if (current.carrierByTargetCatId) {
    const ownedTargets = current.allTargetCats.filter(
      (catId) => current.carrierByTargetCatId?.[catId]?.entryId === entry.id,
    );
    if (ownedTargets.length === 0 || entry.targetCats.some((catId) => !ownedTargets.includes(catId as CatId))) {
      throw new Error(`Queue entry ${entry.id} does not own this message custody`);
    }
    const owned = new Set<string>(ownedTargets);
    const mergeTargetSet = (existing: readonly CatId[], incoming: readonly string[] | undefined): CatId[] => {
      const next = new Set(existing.filter((catId) => !owned.has(catId)));
      for (const catId of incoming ?? []) {
        if (owned.has(catId)) next.add(catId as CatId);
      }
      return current.allTargetCats.filter((catId) => next.has(catId));
    };
    const mergeTargetMap = <T>(
      existing: Readonly<Record<string, T>> | undefined,
      incoming: Readonly<Record<string, T>> | undefined,
    ): Record<string, T> => {
      const next = { ...(existing ?? {}) };
      for (const catId of owned) delete next[catId];
      for (const [catId, value] of Object.entries(incoming ?? {})) {
        if (owned.has(catId)) next[catId] = value;
      }
      return next;
    };
    const bodyExposures = mergeBodyExposures(current.bodyExposures, entry.queuedBodyExposures);
    const carrierStateByTargetCatId = { ...(current.carrierStateByTargetCatId ?? {}) };
    for (const catId of ownedTargets) {
      carrierStateByTargetCatId[catId] = {
        status: entry.status,
        ...(entry.status === 'processing' && entry.processingStartedAt !== undefined
          ? { processingStartedAt: entry.processingStartedAt }
          : {}),
      };
    }
    const status = Object.values(carrierStateByTargetCatId).some((state) => state.status === 'processing')
      ? 'processing'
      : 'queued';
    const seenInvocationIdByCatId = mergeTargetMap(
      current.seenInvocationIdByCatId,
      entry.queuedSeenInvocationIdByCatId,
    );
    const awakenedInvocationIdByCatId = mergeTargetMap(
      current.awakenedInvocationIdByCatId,
      entry.queuedAwakenedInvocationIdByCatId,
    );
    const awakenedAtByCatId = mergeTargetMap(current.awakenedAtByCatId, entry.queuedAwakenedAtByCatId);
    const steeredInvocationIdByCatId = mergeTargetMap(
      current.steeredInvocationIdByCatId,
      entry.steeredInvocationIdByCatId,
    );
    const steerRequestedByCatIds = mergeTargetSet(current.steerRequestedByCatIds ?? [], entry.steerRequestedByCatIds);
    const {
      awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
      awakenedAtByCatId: _awakenedAtByCatId,
      ...stableCurrent
    } = current;
    return {
      ...stableCurrent,
      revision: current.revision + 1,
      status,
      carrierStateByTargetCatId,
      pendingTargetCats: mergeTargetSet(current.pendingTargetCats, entry.targetCats),
      notifiedByCatIds: mergeTargetSet(current.notifiedByCatIds, entry.queuedNotifiedByCatIds),
      ...(Object.keys(awakenedInvocationIdByCatId).length > 0 ? { awakenedInvocationIdByCatId } : {}),
      ...(Object.keys(awakenedAtByCatId).length > 0 ? { awakenedAtByCatId } : {}),
      seenByCatIds: mergeTargetSet(current.seenByCatIds, entry.queuedSeenByCatIds),
      seenInvocationIdByCatId,
      ...(bodyExposures.length > 0 ? { bodyExposures } : {}),
      failedByCatIds: mergeTargetSet(current.failedByCatIds, entry.queuedFailedByCatIds),
      handledByCatIds: mergeTargetSet(current.handledByCatIds, entry.queuedHandledByCatIds),
      ...(steerRequestedByCatIds.length > 0 ? { steerRequestedByCatIds } : {}),
      ...(Object.keys(steeredInvocationIdByCatId).length > 0 ? { steeredInvocationIdByCatId } : {}),
      updatedAt: now,
    };
  }

  const {
    position: _position,
    processingStartedAt: _processingStartedAt,
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    steerRequestedByCatIds: _steerRequestedByCatIds,
    steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
    ...stableCurrent
  } = current;
  const bodyExposures = mergeBodyExposures(current.bodyExposures, entry.queuedBodyExposures);
  return {
    ...stableCurrent,
    revision: current.revision + 1,
    status: entry.status,
    pendingTargetCats: catIds(entry.targetCats),
    notifiedByCatIds: catIds(entry.queuedNotifiedByCatIds),
    ...(entry.queuedAwakenedInvocationIdByCatId && Object.keys(entry.queuedAwakenedInvocationIdByCatId).length > 0
      ? { awakenedInvocationIdByCatId: { ...entry.queuedAwakenedInvocationIdByCatId } }
      : {}),
    ...(entry.queuedAwakenedAtByCatId && Object.keys(entry.queuedAwakenedAtByCatId).length > 0
      ? { awakenedAtByCatId: { ...entry.queuedAwakenedAtByCatId } }
      : {}),
    seenByCatIds: catIds(entry.queuedSeenByCatIds),
    seenInvocationIdByCatId: { ...(entry.queuedSeenInvocationIdByCatId ?? {}) },
    ...(bodyExposures.length > 0 ? { bodyExposures } : {}),
    failedByCatIds: catIds(entry.queuedFailedByCatIds),
    handledByCatIds: catIds(entry.queuedHandledByCatIds),
    ...(entry.steerRequestedByCatIds?.length ? { steerRequestedByCatIds: catIds(entry.steerRequestedByCatIds) } : {}),
    ...(entry.steeredInvocationIdByCatId && Object.keys(entry.steeredInvocationIdByCatId).length > 0
      ? { steeredInvocationIdByCatId: { ...entry.steeredInvocationIdByCatId } }
      : {}),
    priority: entry.priority,
    ...(entry.position !== undefined ? { position: entry.position } : {}),
    ...(entry.status === 'processing' && entry.processingStartedAt !== undefined
      ? { processingStartedAt: entry.processingStartedAt }
      : {}),
    updatedAt: now,
  };
}

function comparableCustody(custody: QueuedMessageCustody): Omit<QueuedMessageCustody, 'revision' | 'updatedAt'> {
  const { revision: _revision, updatedAt: _updatedAt, ...comparable } = custody;
  return comparable;
}

function sameProjection(left: QueuedMessageCustody, right: QueuedMessageCustody): boolean {
  return JSON.stringify(comparableCustody(left)) === JSON.stringify(comparableCustody(right));
}

function targetOutcome(
  catId: string,
  invocationId: string,
  handledAt: number,
  outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>,
): QueueTargetOutcome {
  const supplied = outcomeByCatId?.[catId];
  if (supplied && supplied.invocationId !== invocationId) {
    throw new Error(`queue target outcome invocation mismatch for ${catId}`);
  }
  return supplied
    ? { ...supplied, handledAt: Math.max(supplied.handledAt, handledAt) }
    : {
        invocationId,
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId },
        handledAt,
      };
}

function buildSuccessfulTargetTransition(input: {
  current: QueuedMessageCustody;
  successfulTargetCats: readonly string[];
  invocationId: string;
  deliveredAt: number;
  updatedAt: number;
  outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>;
}): { next: QueuedMessageCustody; completion: QueueCustodyCompletionResult } {
  const successful = new Set(input.successfulTargetCats);
  const handledTargetCats = input.current.pendingTargetCats.filter(
    (catId) => successful.has(catId) && input.current.seenInvocationIdByCatId[catId] === input.invocationId,
  );
  const pendingTargetCats = input.current.pendingTargetCats.filter((catId) => !handledTargetCats.includes(catId));
  const completion = {
    handledTargetCats,
    pendingTargetCats,
    fullyConsumed: pendingTargetCats.length === 0,
  };
  if (handledTargetCats.length === 0) return { next: input.current, completion };

  const handled = new Set(input.current.handledByCatIds);
  const seenInvocationIdByCatId = { ...input.current.seenInvocationIdByCatId };
  const awakenedInvocationIdByCatId = { ...(input.current.awakenedInvocationIdByCatId ?? {}) };
  const awakenedAtByCatId = { ...(input.current.awakenedAtByCatId ?? {}) };
  const steeredInvocationIdByCatId = { ...(input.current.steeredInvocationIdByCatId ?? {}) };
  const carrierStateByTargetCatId = { ...(input.current.carrierStateByTargetCatId ?? {}) };
  const targetOutcomeByCatId = { ...(input.current.targetOutcomeByCatId ?? {}) };
  for (const catId of handledTargetCats) {
    handled.add(catId);
    delete awakenedInvocationIdByCatId[catId];
    delete awakenedAtByCatId[catId];
    delete seenInvocationIdByCatId[catId];
    delete steeredInvocationIdByCatId[catId];
    delete carrierStateByTargetCatId[catId];
    const exposure = input.current.bodyExposures?.find(
      (candidate) => candidate.targetCatId === catId && candidate.invocationId === input.invocationId,
    );
    const handledAt = exposure ? Math.max(input.deliveredAt, exposure.seenAt + 1) : input.deliveredAt;
    targetOutcomeByCatId[catId] = targetOutcome(catId, input.invocationId, handledAt, input.outcomeByCatId);
  }

  const remainingSteerRequests = (input.current.steerRequestedByCatIds ?? []).filter(
    (catId) => !handledTargetCats.includes(catId),
  );
  const {
    processingStartedAt: _processingStartedAt,
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    steerRequestedByCatIds: _steerRequestedByCatIds,
    steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
    carrierStateByTargetCatId: _carrierStateByTargetCatId,
    ...stableCurrent
  } = input.current;
  return {
    completion,
    next: {
      ...stableCurrent,
      revision: input.current.revision + 1,
      status: completion.fullyConsumed ? 'terminal' : 'queued',
      pendingTargetCats,
      notifiedByCatIds: input.current.notifiedByCatIds.filter((catId) => !handledTargetCats.includes(catId)),
      ...(Object.keys(awakenedInvocationIdByCatId).length > 0 ? { awakenedInvocationIdByCatId } : {}),
      ...(Object.keys(awakenedAtByCatId).length > 0 ? { awakenedAtByCatId } : {}),
      seenInvocationIdByCatId,
      ...(Object.keys(carrierStateByTargetCatId).length > 0 ? { carrierStateByTargetCatId } : {}),
      ...(remainingSteerRequests.length > 0 ? { steerRequestedByCatIds: remainingSteerRequests } : {}),
      ...(Object.keys(steeredInvocationIdByCatId).length > 0 ? { steeredInvocationIdByCatId } : {}),
      failedByCatIds: input.current.failedByCatIds.filter((catId) => !handledTargetCats.includes(catId)),
      handledByCatIds: [...handled],
      targetOutcomeByCatId,
      updatedAt: input.updatedAt,
    },
  };
}

export class QueuedMessageCustodyCoordinator {
  private readonly messageStore: IMessageStore;
  private readonly now: () => number;
  private readonly entryLocks = new Map<string, Promise<void>>();

  constructor(deps: CoordinatorDeps) {
    this.messageStore = deps.messageStore;
    this.now = deps.now ?? Date.now;
  }

  async persistEntry(entry: QueueEntry): Promise<void> {
    await this.withEntryLock(entry.id, async () => {
      for (const messageId of this.messageIds(entry)) {
        await this.transition(messageId, (current) => activeCustodyFromEntry(entry, current, this.now()));
      }
    });
  }

  /**
   * Preserve durable custody for the Queue entry that starts an invocation while
   * preventing that trigger from masquerading as a work-period read receipt.
   */
  async markPrimaryTrigger(entry: QueueEntry): Promise<boolean> {
    return this.withEntryLock(entry.id, async () => {
      let changed = false;
      for (const messageId of this.messageIds(entry)) {
        const messageChanged = await this.transition(messageId, (current) =>
          current.receiptScope === 'primary_trigger'
            ? current
            : {
                ...current,
                revision: current.revision + 1,
                receiptScope: 'primary_trigger',
                updatedAt: this.now(),
              },
        );
        if (messageChanged) changed = true;
      }
      return changed;
    });
  }

  async commitSuccessfulTargets(
    entry: QueueEntry,
    successfulTargetCats: readonly string[],
    invocationId: string,
    deliveredAt: number,
    outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>,
  ): Promise<QueueCustodySettlementResult> {
    return this.withEntryLock(entry.id, async () => {
      const perMessage: QueueCustodyMessageCompletionResult[] = [];
      for (const messageId of this.messageIds(entry)) {
        const result = await this.commitMessageSuccessfulTargets(
          messageId,
          successfulTargetCats,
          invocationId,
          deliveredAt,
          outcomeByCatId,
        );
        perMessage.push({ messageId, ...result });
      }
      return { perMessage };
    });
  }

  /**
   * Settle only the Queue source messages named by durable response evidence.
   * One operational carrier may contain sources with intentionally different
   * target projections, so source-response settlement must never assume the
   * complete carrier shares one completion result.
   */
  async commitSuccessfulTargetsForMessages(
    entry: QueueEntry,
    messageIds: readonly string[],
    successfulTargetCats: readonly string[],
    invocationId: string,
    deliveredAt: number,
    outcomeByMessageId: Readonly<Record<string, Readonly<Record<string, QueueTargetOutcome>>>>,
  ): Promise<QueueCustodySettlementResult> {
    const carrierMessageIds = new Set(this.messageIds(entry));
    const selectedMessageIds = [...new Set(messageIds)];
    if (selectedMessageIds.length === 0 || selectedMessageIds.some((messageId) => !carrierMessageIds.has(messageId))) {
      throw new Error('source response settlement must select messages from the exact Queue carrier');
    }
    return this.withEntryLock(entry.id, async () => {
      const perMessage: QueueCustodyMessageCompletionResult[] = [];
      for (const messageId of selectedMessageIds) {
        const result = await this.commitMessageSuccessfulTargets(
          messageId,
          successfulTargetCats,
          invocationId,
          deliveredAt,
          outcomeByMessageId[messageId],
        );
        perMessage.push({ messageId, ...result });
      }
      return { perMessage };
    });
  }

  private async commitMessageSuccessfulTargets(
    messageId: string,
    successfulTargetCats: readonly string[],
    invocationId: string,
    deliveredAt: number,
    outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>,
  ): Promise<QueueCustodyCompletionResult> {
    let completion: QueueCustodyCompletionResult = {
      handledTargetCats: [],
      pendingTargetCats: [],
      fullyConsumed: false,
    };
    await this.transition(
      messageId,
      (current) => {
        const transition = buildSuccessfulTargetTransition({
          current,
          successfulTargetCats,
          invocationId,
          deliveredAt,
          updatedAt: this.now(),
          outcomeByCatId,
        });
        completion = transition.completion;
        return transition.next;
      },
      deliveredAt,
    );
    return completion;
  }

  async requestReminder(
    entry: QueueEntry,
    targetCatId: string,
    invocationId: string,
    reminderId: string,
  ): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) =>
      requestReminderAttempt(current, {
        id: reminderId,
        targetCatId,
        invocationId,
        requestedAt: now,
      }),
    );
  }

  async findReminderAttempt(
    entry: QueueEntry,
    targetCatId: string,
    invocationId: string,
  ): Promise<QueueReminderAttempt | undefined> {
    for (const messageId of this.messageIds(entry)) {
      const message = await this.messageStore.getById(messageId);
      const attempt = message?.queueCustody?.reminderAttempts?.find(
        (candidate) => candidate.targetCatId === targetCatId && candidate.invocationId === invocationId,
      );
      if (attempt) return { ...attempt };
    }
    return undefined;
  }

  async markReminderDelivered(entry: QueueEntry, targetCatId: string, invocationId: string): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) =>
      markReminderAttemptDelivered(current, targetCatId, invocationId, now),
    );
  }

  async markReminderSeen(entry: QueueEntry, targetCatId: string, invocationId: string): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) =>
      markReminderAttemptSeen(current, targetCatId, invocationId, now),
    );
  }

  async markReminderMissed(entry: QueueEntry, invocationId: string): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) => markReminderAttemptMissed(current, invocationId, now));
  }

  private async mutateReminder(
    entry: QueueEntry,
    mutate: (current: QueuedMessageCustody, now: number) => QueuedMessageCustody,
  ): Promise<boolean> {
    return this.withEntryLock(entry.id, async () => {
      let changed = false;
      for (const messageId of this.messageIds(entry)) {
        changed =
          (await this.transition(messageId, (current) => {
            const now = this.now();
            const mutated = mutate(current, now);
            if (mutated === current) return current;
            return { ...mutated, revision: current.revision + 1, updatedAt: now };
          })) || changed;
      }
      return changed;
    });
  }

  private async transition(
    messageId: string,
    buildNext: (current: QueuedMessageCustody) => QueuedMessageCustody,
    deliveredAt?: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const message = await this.messageStore.getById(messageId);
      const current = message?.queueCustody;
      if (!current || current.status === 'terminal') return false;
      const next = buildNext(current);
      if (sameProjection(current, next)) return false;
      const result = await this.messageStore.transitionQueueCustody(messageId, {
        expectedRevision: current.revision,
        next,
        ...(next.status === 'terminal' ? { deliveredAt } : {}),
      });
      if (result.kind === 'updated') return true;
      if (result.kind === 'not_found') return false;
    }
    throw new Error(`queue custody CAS retries exhausted for message ${messageId}`);
  }

  private messageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
    return [entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean);
  }

  private async withEntryLock<T>(entryId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.entryLocks.get(entryId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.entryLocks.set(entryId, settled);
    try {
      return await run;
    } finally {
      if (this.entryLocks.get(entryId) === settled) this.entryLocks.delete(entryId);
    }
  }
}
