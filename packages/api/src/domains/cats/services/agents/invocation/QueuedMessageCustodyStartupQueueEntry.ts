import type { CatId } from '@cat-cafe/shared';
import {
  waitContinuationCarrierFromStoredMessage,
  waitContinuationCarriersMatch,
} from '../../../../ball-custody/wait-continuation-carrier.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueEntry } from './InvocationQueue.js';
import { normalizeOwnerAuthProvenance } from './owner-auth-provenance.js';
import {
  activeCarrierEntryIds,
  isQueuedCarrierTarget,
  queuedCarrierEntryIds,
} from './QueuedMessageCustodyCarrierProjection.js';
import {
  createCrossThreadQueueEntryFromCustody,
  isManagedHoldWakeMessage,
  projectQueuedAttemptIds,
} from './QueuedMessageCustodyCoordinator.js';
import { sameActiveProjection } from './QueuedMessageCustodyStartupProjectionHelpers.js';
import type { StartupCustodyDeps } from './QueuedMessageCustodyStartupTypes.js';

export function groupActiveMessages(messages: StoredMessage[]): Map<string, StoredMessage[]> {
  const groups = new Map<string, StoredMessage[]>();
  for (const message of messages) {
    const custody = message.queueCustody;
    if (!custody) continue;
    for (const entryId of queuedCarrierEntryIds(message)) {
      const group = groups.get(entryId) ?? [];
      group.push(message);
      groups.set(entryId, group);
    }
  }
  return groups;
}

export async function hasUnresolvedQueuedCarrierMember(
  deps: StartupCustodyDeps,
  entryId: string,
  messages: readonly StoredMessage[],
  unresolvedQueuedMessageIds: ReadonlySet<string>,
): Promise<boolean> {
  if (unresolvedQueuedMessageIds.size === 0) return false;
  const primary = messages[0];
  if (!primary) return false;
  try {
    const threadMessages = await deps.messageStore.getByThreadAfter(
      primary.threadId,
      undefined,
      undefined,
      primary.queueCustody?.ownerUserId,
      {
        includeQueuedCatMessages: true,
        includeQueuedUserMessages: true,
      },
    );
    return threadMessages.some(
      (message) => unresolvedQueuedMessageIds.has(message.id) && activeCarrierEntryIds(message).includes(entryId),
    );
  } catch (error) {
    deps.log.warn(
      `[queue-custody-startup] cannot inspect unresolved source membership for Queue group ${entryId}; ` +
        `preserving it without provider recovery: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }
}

export function buildQueueEntry(messages: StoredMessage[], entryId: string): QueueEntry {
  messages.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const primary = messages[0];
  const custody = primary?.queueCustody;
  if (!primary || !custody || custody.pendingTargetCats.length === 0) {
    throw new Error('active queue custody group is missing its primary projection');
  }
  if (custody.carrierByTargetCatId) {
    return createCrossThreadQueueEntryFromCustody(messages, entryId, { queuedTargetsOnly: true });
  }
  for (const sibling of messages.slice(1)) {
    const siblingCustody = sibling.queueCustody;
    if (
      !siblingCustody ||
      sibling.threadId !== primary.threadId ||
      sibling.userId !== primary.userId ||
      !sameActiveProjection(custody, siblingCustody)
    ) {
      throw new Error(`divergent queued message custody group: ${custody.entryId}`);
    }
  }
  const pendingTargets = custody.pendingTargetCats.filter((catId) => isQueuedCarrierTarget(custody, catId));
  if (pendingTargets.length === 0) {
    throw new Error(`active queue custody group has no target for carrier ${entryId}`);
  }
  const allTargets = [...custody.allTargetCats];
  const waitContinuationCarrier = waitContinuationCarrierFromStoredMessage(primary);
  const managedHoldWake = isManagedHoldWakeMessage(primary);
  for (const sibling of messages.slice(1)) {
    if (!waitContinuationCarriersMatch(waitContinuationCarrierFromStoredMessage(sibling), waitContinuationCarrier)) {
      throw new Error(`divergent wait continuation carriers for Queue entry ${entryId}`);
    }
  }
  const targetSet = new Set<string>(allTargets);
  const filterTargets = (values: readonly CatId[]): CatId[] => values.filter((catId) => targetSet.has(catId));
  const filterInvocationMap = (values: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(values).filter(([catId]) => targetSet.has(catId)));
  const filterTimestampMap = (values: Readonly<Record<string, number>>): Record<string, number> =>
    Object.fromEntries(Object.entries(values).filter(([catId]) => targetSet.has(catId)));
  const queuedAttemptIdByCatId = projectQueuedAttemptIds(custody, pendingTargets);
  return {
    id: entryId,
    threadId: primary.threadId,
    userId: custody.ownerUserId ?? primary.userId,
    ownerAuthProvenance: normalizeOwnerAuthProvenance(custody.ownerAuthProvenance),
    content: messages.map((message) => message.content).join('\n'),
    messageId: primary.id,
    mergedMessageIds: messages.slice(1).map((message) => message.id),
    source: waitContinuationCarrier || managedHoldWake ? 'connector' : 'user',
    ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
    targetCats: pendingTargets,
    allTargetCats: allTargets,
    ...(custody.authorIntentByCatId ? { authorIntentByCatId: structuredClone(custody.authorIntentByCatId) } : {}),
    queuedNotifiedByCatIds: filterTargets(custody.notifiedByCatIds),
    queuedAwakenedInvocationIdByCatId: filterInvocationMap(custody.awakenedInvocationIdByCatId ?? {}),
    queuedAwakenedAtByCatId: filterTimestampMap(custody.awakenedAtByCatId ?? {}),
    queuedSeenByCatIds: filterTargets(custody.seenByCatIds),
    queuedSeenInvocationIdByCatId: filterInvocationMap(custody.seenInvocationIdByCatId),
    queuedBodyExposures: (custody.bodyExposures ?? [])
      .filter((exposure) => targetSet.has(exposure.targetCatId))
      .map((exposure) => ({ ...exposure })),
    queuedFailedByCatIds: filterTargets(custody.failedByCatIds),
    ...(Object.keys(queuedAttemptIdByCatId).length > 0 ? { queuedAttemptIdByCatId } : {}),
    queuedHandledByCatIds: filterTargets(custody.handledByCatIds),
    steerRequestedByCatIds: filterTargets(custody.steerRequestedByCatIds ?? []),
    steeredInvocationIdByCatId: filterInvocationMap(custody.steeredInvocationIdByCatId ?? {}),
    ...(custody.prestartRetirement
      ? {
          prestartRetirement: {
            ...custody.prestartRetirement,
            entryIds: [...custody.prestartRetirement.entryIds],
          },
        }
      : {}),
    intent: custody.intent,
    status: custody.prestartRetirement ? 'processing' : 'queued',
    ...(custody.prestartRetirement
      ? { processingStartedAt: custody.processingStartedAt ?? custody.prestartRetirement.startedAt }
      : {}),
    createdAt: custody.createdAt,
    autoExecute: false,
    priority: custody.priority,
    ...(managedHoldWake ? { sourceCategory: 'scheduled' as const } : {}),
    ...(custody.position !== undefined ? { position: custody.position } : {}),
  };
}
