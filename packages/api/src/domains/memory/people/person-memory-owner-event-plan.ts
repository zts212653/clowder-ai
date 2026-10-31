import { interactionEventIdSchema, interactionEventSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { PersonMemoryKeys } from './person-memory-keys.js';
import type { ExecuteOwnerMemoryActionInput, OwnerMemoryActionCommand } from './person-memory-owner-action-contract.js';
import { addOwnerActionArtifact, ownerActionObjectIdHash } from './person-memory-owner-action-plan-support.js';
import { type OwnerActionReceipt, ownerActionReceiptSchema } from './person-memory-owner-action-receipt.js';
import { personInteractionOwnerRevision } from './person-memory-owner-revision.js';
import { parseEvent, parseRelationship } from './person-memory-records.js';
import type { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

export async function planAmendOwnerEvent(
  redis: RedisClient,
  input: ExecuteOwnerMemoryActionInput & { command: Extract<OwnerMemoryActionCommand, { action: 'amend_event' }> },
  plan: PersonMemoryRedisPlan,
  artifactSet: string,
): Promise<OwnerActionReceipt | 'not_available' | 'stale_revision'> {
  const targetKey = PersonMemoryKeys.event(input.ownerUserId, input.command.eventId);
  const targetRaw = await redis.get(targetKey);
  const target = parseEvent(targetRaw);
  if (!targetRaw || !target || target.ownerUserId !== input.ownerUserId) {
    return 'not_available';
  }
  if (personInteractionOwnerRevision(target) !== input.command.expectedRevision) return 'stale_revision';
  if (target.status !== 'active') return 'not_available';
  const relationshipKey = PersonMemoryKeys.relationship(input.ownerUserId, target.relationshipId);
  const relationshipRaw = await redis.get(relationshipKey);
  const relationship = parseRelationship(relationshipRaw);
  if (
    !relationshipRaw ||
    !relationship ||
    relationship.ownerUserId !== input.ownerUserId ||
    relationship.personId !== input.command.personId
  ) {
    return 'not_available';
  }
  const eventsKey = PersonMemoryKeys.personEvents(input.ownerUserId, input.command.personId);
  const eventIds = await redis.zrange(eventsKey, 0, -1);
  const eventRaws = await Promise.all(
    eventIds.map((eventId) => redis.get(PersonMemoryKeys.event(input.ownerUserId, eventId))),
  );
  const events = eventRaws.map(parseEvent);
  if (events.some((event) => !event || event.ownerUserId !== input.ownerUserId)) {
    throw new Error('F276 owner action event index is malformed');
  }
  if (events.some((event) => event?.amendsEventId === target.eventId)) return 'stale_revision';
  const successorKey = PersonMemoryKeys.eventSuccessor(input.ownerUserId, target.eventId);
  if (await redis.get(successorKey)) return 'stale_revision';

  const eventId = interactionEventIdSchema.parse(`person_event_owner_action_${ownerActionObjectIdHash(input)}`);
  const eventKey = PersonMemoryKeys.event(input.ownerUserId, eventId);
  const event = interactionEventSchema.parse({
    eventId,
    relationshipId: target.relationshipId,
    ownerUserId: input.ownerUserId,
    ...input.command.payload,
    recordedAt: input.evidence.issuedAt,
    sourceRefs: [],
    materializedBy: input.evidence,
    amendsEventId: target.eventId,
    status: 'active',
  });
  plan.expect(targetKey, targetRaw);
  plan.expect(relationshipKey, relationshipRaw);
  plan.expectZRange(eventsKey, eventIds);
  plan.expect(successorKey, '');
  plan.expect(eventKey, '');
  plan.set(targetKey, JSON.stringify({ ...target, status: 'superseded' }));
  plan.set(eventKey, JSON.stringify(event));
  plan.set(successorKey, eventId);
  plan.zadd(eventsKey, input.evidence.issuedAt, eventId);
  const relationshipEventsKey = PersonMemoryKeys.relationshipEvents(input.ownerUserId, target.relationshipId);
  plan.zadd(relationshipEventsKey, input.evidence.issuedAt, eventId);
  for (const key of [targetKey, eventKey, successorKey, eventsKey, relationshipEventsKey]) {
    addOwnerActionArtifact(plan, artifactSet, key);
  }
  return ownerActionReceiptSchema.parse({
    v: 1,
    ownerUserId: input.ownerUserId,
    requestId: input.command.requestId,
    requestDigest: input.requestDigest,
    action: input.command.action,
    itemId: eventId,
    revision: personInteractionOwnerRevision(event),
    completedAt: input.evidence.issuedAt,
  });
}
