import {
  asrPersonMemoryDynamicSceneEntryV1Schema,
  writeOpportunityGenerationId,
  writeOpportunityPresentationRetryCarrierV1Schema,
  writeOpportunityReentryCarrierV1Schema,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { BoundAsrPersonMemoryScene } from './AsrPersonMemoryOpportunityPromptService.js';
import { eligibleOwnerMessage } from './PersonMemorySourceBundleResolver.js';

function sameOpportunityBody(original: Record<string, unknown>, reentered: Record<string, unknown>): boolean {
  const { opportunityId: _oldId, generation: _oldGeneration, eligibleAt: _oldEligibleAt, ...oldBody } = original;
  const { opportunityId: _newId, generation: _newGeneration, eligibleAt: _newEligibleAt, ...newBody } = reentered;
  return JSON.stringify(oldBody) === JSON.stringify(newBody);
}

/**
 * Resolve one scheduler-written re-entry carrier against its live owner source.
 *
 * The scheduler message is transport only. Authority comes from re-reading the exact live owner
 * message and proving that it still carries the original generation from which the server minted
 * this generation+1 scene. Any edit/delete/scope drift therefore removes the opportunity.
 */
export async function bindAsrPersonMemoryReentryFromSchedulerMessage(input: {
  triggerMessage: StoredMessage;
  ownerUserId: string;
  threadId: string;
  messageStore: Pick<IMessageStore, 'getById'>;
}): Promise<readonly BoundAsrPersonMemoryScene[]> {
  const carrier = writeOpportunityReentryCarrierV1Schema.safeParse(input.triggerMessage.extra?.writeOpportunityReentry);
  if (
    !carrier.success ||
    input.triggerMessage.userId !== 'scheduler' ||
    input.triggerMessage.catId !== null ||
    input.triggerMessage.threadId !== input.threadId ||
    input.triggerMessage.deletedAt !== undefined ||
    input.triggerMessage._tombstone ||
    input.triggerMessage.extra?.scheduler?.hiddenTrigger !== true ||
    carrier.data.sourceMessageRef.threadId !== input.threadId
  ) {
    return [];
  }

  const source = await input.messageStore.getById(carrier.data.sourceMessageRef.messageId);
  if (
    !eligibleOwnerMessage(source, { ownerUserId: input.ownerUserId }) ||
    source.threadId !== carrier.data.sourceMessageRef.threadId
  ) {
    return [];
  }
  const original = (source.extra?.dynamicSceneEntries ?? [])
    .map((candidate) => asrPersonMemoryDynamicSceneEntryV1Schema.safeParse(candidate))
    .find(
      (candidate) => candidate.success && candidate.data.opportunity.opportunityId === carrier.data.sourceOpportunityId,
    );
  if (!original?.success) return [];

  const previous = original.data.opportunity;
  const next = carrier.data.scene.opportunity;
  if (
    previous.scope.ownerUserId !== input.ownerUserId ||
    previous.scope.threadId !== input.threadId ||
    previous.generation !== 1 ||
    previous.opportunityId !== writeOpportunityGenerationId(previous.dedupeLineage, 1) ||
    next.scope.ownerUserId !== input.ownerUserId ||
    next.scope.threadId !== input.threadId ||
    next.consumer.catId !== previous.consumer.catId ||
    next.generation !== carrier.data.priorGeneration + 1 ||
    next.opportunityId !== writeOpportunityGenerationId(previous.dedupeLineage, next.generation) ||
    next.dedupeLineage !== previous.dedupeLineage ||
    !sameOpportunityBody(previous, next)
  ) {
    return [];
  }

  return [
    {
      scene: carrier.data.scene,
      source: {
        kind: 'message',
        threadId: source.threadId,
        sourceMessageId: source.id,
        authorUserId: source.userId,
        authorRole: 'owner',
        visibility: 'verified_live_owner_message',
      },
    },
  ];
}

/**
 * Re-bind one unchanged generation after F296 could not present it on the original carrier.
 * The trigger contains only durable refs; authority and scene content are re-read from the exact
 * live owner message, so deleting/editing the original or changing its consumer fails closed.
 */
export async function bindAsrPersonMemoryPresentationRetryFromSchedulerMessage(input: {
  triggerMessage: StoredMessage;
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  messageStore: Pick<IMessageStore, 'getById'>;
}): Promise<readonly BoundAsrPersonMemoryScene[]> {
  const carrier = writeOpportunityPresentationRetryCarrierV1Schema.safeParse(
    input.triggerMessage.extra?.writeOpportunityPresentationRetry,
  );
  if (
    !carrier.success ||
    input.triggerMessage.userId !== 'scheduler' ||
    input.triggerMessage.catId !== null ||
    input.triggerMessage.threadId !== input.threadId ||
    input.triggerMessage.deletedAt !== undefined ||
    input.triggerMessage._tombstone ||
    input.triggerMessage.extra?.scheduler?.hiddenTrigger !== true ||
    carrier.data.sourceMessageRef.threadId !== input.threadId
  ) {
    return [];
  }

  const source = await input.messageStore.getById(carrier.data.sourceMessageRef.messageId);
  const meetingArtifact = source?.extra?.meetingArtifact;
  if (
    !eligibleOwnerMessage(source, { ownerUserId: input.ownerUserId }) ||
    source.threadId !== carrier.data.sourceMessageRef.threadId ||
    meetingArtifact?.trust !== 'untrusted_external' ||
    meetingArtifact.instructionPolicy !== 'data_only'
  ) {
    return [];
  }
  const original = (source.extra?.dynamicSceneEntries ?? [])
    .map((candidate) => asrPersonMemoryDynamicSceneEntryV1Schema.safeParse(candidate))
    .find(
      (candidate) => candidate.success && candidate.data.opportunity.opportunityId === carrier.data.sourceOpportunityId,
    );
  if (
    !original?.success ||
    original.data.opportunity.scope.ownerUserId !== input.ownerUserId ||
    original.data.opportunity.scope.threadId !== input.threadId ||
    original.data.opportunity.consumer.catId !== input.targetCatId ||
    original.data.opportunity.generation !== 1 ||
    original.data.opportunity.opportunityId !==
      writeOpportunityGenerationId(original.data.opportunity.dedupeLineage, 1) ||
    original.data.opportunity.sourceCoordinates.some(
      (coordinate) =>
        coordinate.artifactId !== meetingArtifact.intakeId || coordinate.sourceHandle !== meetingArtifact.sourceHandle,
    )
  ) {
    return [];
  }

  return [
    {
      scene: original.data,
      source: {
        kind: 'message',
        threadId: source.threadId,
        sourceMessageId: source.id,
        authorUserId: source.userId,
        authorRole: 'owner',
        visibility: 'verified_live_owner_message',
      },
    },
  ];
}
