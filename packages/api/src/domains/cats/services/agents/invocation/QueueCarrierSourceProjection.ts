import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueEntry } from './InvocationQueue.js';
import { carrierEntryId, isQueuedCarrierTarget } from './QueuedMessageCustodyCarrierProjection.js';

/** The physical carrier is a projection of each source × target, not custody.entryId. */
export function queueSourceTargetState(
  message: StoredMessage,
  entryId: string,
  catId: string,
): 'unmanaged' | 'pending' | 'failed' | 'retired' | 'unknown' {
  const custody = message.queueCustody;
  if (!custody) return 'unmanaged';
  if (
    carrierEntryId(custody, catId) !== entryId ||
    custody.handledByCatIds.some((id) => id === catId) ||
    custody.withdrawnByCatIds?.some((id) => id === catId)
  )
    return 'retired';
  if (custody.failedByCatIds.some((id) => id === catId)) return 'failed';
  if (custody.pendingTargetCats.some((id) => id === catId)) return 'pending';
  return 'unknown';
}

export function queueCarrierMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [
    ...new Set(
      [entry.messageId, ...(entry.mergedMessageIds ?? [])].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
}

export async function readQueueCarrierMessages(
  entry: QueueEntry,
  store: Pick<IMessageStore, 'getById'>,
): Promise<StoredMessage[]> {
  return Promise.all(
    queueCarrierMessageIds(entry).map(async (id) => {
      const message = await store.getById(id);
      if (!message || message.userId !== entry.userId || message.threadId !== entry.threadId) {
        throw new Error(`Queue source unavailable or out of scope: ${entry.id}/${id}`);
      }
      return message;
    }),
  );
}

/** Remove only proven retired members; missing/unrecognized truth must stay visible. */
export function projectUnconsumedQueueCarrier(
  entry: QueueEntry,
  messages: readonly StoredMessage[],
): QueueEntry | null {
  if (messages.length === 0 || !Array.isArray(entry.targetCats)) return entry;
  const active = messages.filter((message) =>
    entry.targetCats.some((catId) => queueSourceTargetState(message, entry.id, catId) !== 'retired'),
  );
  const targets = entry.targetCats.filter((catId) =>
    active.some((message) => queueSourceTargetState(message, entry.id, catId) !== 'retired'),
  );
  const primary = active[0];
  if (!primary || targets.length === 0) return null;
  if (active.length === messages.length && targets.length === entry.targetCats.length) return entry;
  const targetSet = new Set(targets);
  const filterTargets = (ids: readonly string[] | undefined) => ids?.filter((id) => targetSet.has(id));
  const filterMap = <T>(values: Readonly<Record<string, T>> | undefined) =>
    values && Object.fromEntries(Object.entries(values).filter(([catId]) => targetSet.has(catId)));
  return {
    ...entry,
    messageId: primary.id,
    mergedMessageIds: active.slice(1).map((message) => message.id),
    ...(active.length !== messages.length ? { content: active.map((message) => message.content).join('\n') } : {}),
    ...(entry.a2aTriggerMessageId && !active.some((message) => message.id === entry.a2aTriggerMessageId)
      ? { a2aTriggerMessageId: primary.id }
      : {}),
    targetCats: targets,
    allTargetCats: filterTargets(entry.allTargetCats),
    queuedNotifiedByCatIds: filterTargets(entry.queuedNotifiedByCatIds),
    queuedAwakenedInvocationIdByCatId: filterMap(entry.queuedAwakenedInvocationIdByCatId),
    queuedAwakenedAtByCatId: filterMap(entry.queuedAwakenedAtByCatId),
    queuedSeenByCatIds: filterTargets(entry.queuedSeenByCatIds),
    queuedSeenInvocationIdByCatId: filterMap(entry.queuedSeenInvocationIdByCatId),
    queuedBodyExposures: entry.queuedBodyExposures?.filter((exposure) => targetSet.has(exposure.targetCatId)),
    queuedFailedByCatIds: filterTargets(entry.queuedFailedByCatIds),
    queuedFailureAtByCatId: filterMap(entry.queuedFailureAtByCatId),
    queuedFailureReasonByCatId: filterMap(entry.queuedFailureReasonByCatId),
    queuedAttemptIdByCatId: filterMap(entry.queuedAttemptIdByCatId),
    queuedHandledByCatIds: filterTargets(entry.queuedHandledByCatIds),
    steerRequestedByCatIds: filterTargets(entry.steerRequestedByCatIds),
    steeredInvocationIdByCatId: filterMap(entry.steeredInvocationIdByCatId),
  };
}

export function canSteerQueueSources(entry: QueueEntry, messages: readonly StoredMessage[], catId: string): boolean {
  return messages.every((message) => {
    const state = queueSourceTargetState(message, entry.id, catId);
    return (
      state === 'unmanaged' ||
      (state === 'pending' && !!message.queueCustody && isQueuedCarrierTarget(message.queueCustody, catId))
    );
  });
}
