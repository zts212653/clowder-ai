import {
  type InteractionEvent,
  interactionEventSchema,
  type PersonClaimVersion,
  personClaimVersionSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  AmendPersonInteractionInput,
  CorrectPersonClaimInput,
  PersonMemoryAmendmentResult,
  PersonMemoryCorrectionResult,
  RetirePersonClaimInput,
} from './PersonMemoryStore.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { AMEND_EVENT_LUA, CORRECT_CLAIM_LUA, RETIRE_CLAIM_LUA } from './person-memory-lifecycle-lua.js';
import {
  amendmentEventId,
  correctionClaimId,
  parseClaim,
  parseEvent,
  parseRelationship,
  retirementClaimId,
} from './person-memory-records.js';

function parseCorrectionResult(raw: unknown): PersonMemoryCorrectionResult {
  const value = String(raw);
  if (value === 'CONFLICT') return { outcome: 'conflict' };
  if (value === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (value.startsWith('APPLIED:')) {
    return { outcome: 'applied', claim: personClaimVersionSchema.parse(JSON.parse(value.slice(8))) };
  }
  if (value.startsWith('REPLAYED:')) {
    return { outcome: 'replayed', claim: personClaimVersionSchema.parse(JSON.parse(value.slice(9))) };
  }
  throw new Error(`unexpected F276 correction result: ${value}`);
}

export async function correctPersonClaim(
  redis: RedisClient,
  input: CorrectPersonClaimInput,
): Promise<PersonMemoryCorrectionResult> {
  const expectedKey = PersonMemoryKeys.claim(input.ownerUserId, input.expectedCurrentClaimId);
  const expected = parseClaim(await redis.get(expectedKey));
  if (!expected || expected.personId !== input.personId || expected.status !== 'current') {
    return { outcome: 'not_available' };
  }
  const predicate =
    expected.payload.kind === 'reported_fact' ? expected.payload.predicate : `assessment:${expected.claimId}`;
  const currentKey = PersonMemoryKeys.currentClaim(input.ownerUserId, input.personId, predicate);
  const newClaimId = correctionClaimId(input.personId, input.requestId);
  const newClaim: PersonClaimVersion = {
    claimId: newClaimId,
    personId: input.personId,
    ownerUserId: input.ownerUserId,
    payload: input.payload,
    status: 'current',
    recordedAt: input.correctedAt,
    sourceRefs: [input.sourceMessageRef],
    materializedBy: {
      kind: 'anchored_correction',
      sourceMessageRef: input.sourceMessageRef,
      existingTruthRef: expected.claimId,
      authorizedAt: input.correctedAt,
    },
    supersedesClaimId: expected.claimId,
  };
  const superseded: PersonClaimVersion = {
    ...expected,
    status: 'superseded',
    validTo: input.correctedAt,
  };
  const raw = await redis.eval(
    CORRECT_CLAIM_LUA,
    7,
    currentKey,
    expectedKey,
    PersonMemoryKeys.claim(input.ownerUserId, newClaimId),
    PersonMemoryKeys.personClaims(input.ownerUserId, input.personId),
    PersonMemoryKeys.correction(input.ownerUserId, input.requestId),
    PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId),
    PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
    expected.claimId,
    JSON.stringify(superseded),
    JSON.stringify(newClaim),
    newClaimId,
    String(input.correctedAt),
  );
  return parseCorrectionResult(raw);
}

export async function retirePersonClaim(
  redis: RedisClient,
  input: RetirePersonClaimInput,
): Promise<PersonMemoryCorrectionResult> {
  const expectedKey = PersonMemoryKeys.claim(input.ownerUserId, input.expectedCurrentClaimId);
  const expected = parseClaim(await redis.get(expectedKey));
  if (!expected || expected.personId !== input.personId || expected.status !== 'current') {
    return { outcome: 'not_available' };
  }
  const predicate =
    expected.payload.kind === 'reported_fact' ? expected.payload.predicate : `assessment:${expected.claimId}`;
  const currentKey = PersonMemoryKeys.currentClaim(input.ownerUserId, input.personId, predicate);
  const retiredClaimId = retirementClaimId(input.personId, input.requestId);
  const retired: PersonClaimVersion = {
    ...expected,
    claimId: retiredClaimId,
    status: 'retired',
    recordedAt: input.retiredAt,
    sourceRefs: [input.sourceMessageRef],
    materializedBy: {
      kind: 'anchored_correction',
      sourceMessageRef: input.sourceMessageRef,
      existingTruthRef: expected.claimId,
      authorizedAt: input.retiredAt,
    },
    supersedesClaimId: expected.claimId,
  };
  const superseded: PersonClaimVersion = {
    ...expected,
    status: 'superseded',
    validTo: input.retiredAt,
  };
  const raw = await redis.eval(
    RETIRE_CLAIM_LUA,
    7,
    currentKey,
    expectedKey,
    PersonMemoryKeys.claim(input.ownerUserId, retiredClaimId),
    PersonMemoryKeys.personClaims(input.ownerUserId, input.personId),
    PersonMemoryKeys.correction(input.ownerUserId, input.requestId),
    PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId),
    PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
    expected.claimId,
    JSON.stringify(superseded),
    JSON.stringify(retired),
    retiredClaimId,
    String(input.retiredAt),
  );
  return parseCorrectionResult(raw);
}

function parseAmendmentResult(raw: unknown): PersonMemoryAmendmentResult {
  const value = String(raw);
  if (value === 'CONFLICT') return { outcome: 'conflict' };
  if (value === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (value.startsWith('APPLIED:')) {
    return { outcome: 'applied', event: interactionEventSchema.parse(JSON.parse(value.slice(8))) };
  }
  if (value.startsWith('REPLAYED:')) {
    return { outcome: 'replayed', event: interactionEventSchema.parse(JSON.parse(value.slice(9))) };
  }
  throw new Error(`unexpected F276 amendment result: ${value}`);
}

export async function amendPersonInteraction(
  redis: RedisClient,
  input: AmendPersonInteractionInput,
): Promise<PersonMemoryAmendmentResult> {
  const amendmentKey = PersonMemoryKeys.amendment(input.ownerUserId, input.requestId);
  const priorAmendment = await redis.get(amendmentKey);
  if (priorAmendment) {
    return { outcome: 'replayed', event: interactionEventSchema.parse(JSON.parse(priorAmendment)) };
  }
  const originalKey = PersonMemoryKeys.event(input.ownerUserId, input.expectedEventId);
  const originalRaw = await redis.get(originalKey);
  const original = parseEvent(originalRaw);
  if (!originalRaw || !original || original.status !== 'active') return { outcome: 'not_available' };
  const relationshipKey = PersonMemoryKeys.relationship(input.ownerUserId, original.relationshipId);
  const relationshipRaw = await redis.get(relationshipKey);
  const relationship = parseRelationship(relationshipRaw);
  if (
    !relationshipRaw ||
    !relationship ||
    relationship.ownerUserId !== input.ownerUserId ||
    relationship.personId !== input.personId
  ) {
    return { outcome: 'not_available' };
  }
  const successorKey = PersonMemoryKeys.eventSuccessor(input.ownerUserId, original.eventId);
  if (await redis.get(successorKey)) return { outcome: 'not_available' };
  const eventsKey = PersonMemoryKeys.personEvents(input.ownerUserId, input.personId);
  const eventIds = await redis.zrange(eventsKey, 0, -1);
  const eventRaws = await Promise.all(
    eventIds.map((eventId) => redis.get(PersonMemoryKeys.event(input.ownerUserId, eventId))),
  );
  const events = eventRaws.map(parseEvent);
  if (events.some((event) => !event || event.ownerUserId !== input.ownerUserId)) {
    throw new Error('F276 interaction event index is malformed');
  }
  if (events.some((event) => event?.amendsEventId === original.eventId)) {
    return { outcome: 'not_available' };
  }
  const eventId = amendmentEventId(input.personId, input.requestId);
  const event: InteractionEvent = {
    eventId,
    relationshipId: original.relationshipId,
    ownerUserId: input.ownerUserId,
    ...input.payload,
    recordedAt: input.amendedAt,
    sourceRefs: [input.sourceMessageRef],
    materializedBy: {
      kind: 'anchored_correction',
      sourceMessageRef: input.sourceMessageRef,
      existingTruthRef: original.eventId,
      authorizedAt: input.amendedAt,
    },
    amendsEventId: original.eventId,
    status: 'active',
  };
  const superseded: InteractionEvent = { ...original, status: 'superseded' };
  const raw = await redis.eval(
    AMEND_EVENT_LUA,
    9,
    originalKey,
    PersonMemoryKeys.event(input.ownerUserId, eventId),
    eventsKey,
    PersonMemoryKeys.relationshipEvents(input.ownerUserId, original.relationshipId),
    amendmentKey,
    PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId),
    PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
    successorKey,
    relationshipKey,
    originalRaw,
    relationshipRaw,
    JSON.stringify(superseded),
    JSON.stringify(event),
    String(input.amendedAt),
    eventId,
  );
  return parseAmendmentResult(raw);
}

export { redactPersonMemoryItem } from './person-memory-redaction.js';
