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
  PersonMemoryRedactionResult,
  RedactPersonMemoryItemInput,
  RetirePersonClaimInput,
} from './PersonMemoryStore.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import {
  AMEND_EVENT_LUA,
  CORRECT_CLAIM_LUA,
  REDACT_ITEM_LUA,
  RETIRE_CLAIM_LUA,
} from './person-memory-lifecycle-lua.js';
import {
  amendmentEventId,
  correctionClaimId,
  parseClaim,
  parseEvent,
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
  const original = parseEvent(await redis.get(PersonMemoryKeys.event(input.ownerUserId, input.expectedEventId)));
  if (!original) return { outcome: 'not_available' };
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
  const raw = await redis.eval(
    AMEND_EVENT_LUA,
    7,
    PersonMemoryKeys.event(input.ownerUserId, original.eventId),
    PersonMemoryKeys.event(input.ownerUserId, eventId),
    PersonMemoryKeys.personEvents(input.ownerUserId, input.personId),
    PersonMemoryKeys.relationshipEvents(input.ownerUserId, original.relationshipId),
    PersonMemoryKeys.amendment(input.ownerUserId, input.requestId),
    PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId),
    PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
    JSON.stringify(event),
    String(input.amendedAt),
    eventId,
  );
  return parseAmendmentResult(raw);
}

function redactionResult(raw: unknown): PersonMemoryRedactionResult {
  const value = String(raw);
  if (value === 'CONFLICT') return { outcome: 'conflict' };
  if (value === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (value.startsWith('APPLIED:')) {
    return { outcome: 'applied', item: JSON.parse(value.slice(8)) as RedactPersonMemoryItemInput['item'] };
  }
  if (value.startsWith('REPLAYED:')) {
    return { outcome: 'replayed', item: JSON.parse(value.slice(9)) as RedactPersonMemoryItemInput['item'] };
  }
  throw new Error(`unexpected F276 redaction result: ${value}`);
}

export async function redactPersonMemoryItem(
  redis: RedisClient,
  input: RedactPersonMemoryItemInput,
): Promise<PersonMemoryRedactionResult> {
  const artifactSet = PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId);
  const resultJson = JSON.stringify(input.item);
  if (input.item.kind === 'claim') {
    const claimKey = PersonMemoryKeys.claim(input.ownerUserId, input.item.id);
    const claim = parseClaim(await redis.get(claimKey));
    if (!claim || claim.personId !== input.personId) return { outcome: 'not_available' };
    const predicate = claim.payload.kind === 'reported_fact' ? claim.payload.predicate : `assessment:${claim.claimId}`;
    const { typedProvenance: _typedProvenance, ...claimWithoutTypedProvenance } = claim;
    const redacted: PersonClaimVersion = {
      ...claimWithoutTypedProvenance,
      payload: { kind: 'redacted' },
      status: 'redacted',
      validTo: input.redactedAt,
      sourceRefs: [],
    };
    return redactionResult(
      await redis.eval(
        REDACT_ITEM_LUA,
        5,
        claimKey,
        PersonMemoryKeys.redaction(input.ownerUserId, input.requestId),
        artifactSet,
        PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
        PersonMemoryKeys.currentClaim(input.ownerUserId, input.personId, predicate),
        JSON.stringify(redacted),
        resultJson,
        'clear_current',
        claim.claimId,
      ),
    );
  }

  const eventKey = PersonMemoryKeys.event(input.ownerUserId, input.item.id);
  const event = parseEvent(await redis.get(eventKey));
  if (!event) return { outcome: 'not_available' };
  const redacted: InteractionEvent = {
    eventId: event.eventId,
    relationshipId: event.relationshipId,
    ownerUserId: event.ownerUserId,
    recordedAt: event.recordedAt,
    eventKind: event.eventKind,
    headline: '[redacted]',
    sourceRefs: [],
    materializedBy: event.materializedBy,
    ...(event.amendsEventId ? { amendsEventId: event.amendsEventId } : {}),
    status: 'redacted',
  };
  return redactionResult(
    await redis.eval(
      REDACT_ITEM_LUA,
      5,
      eventKey,
      PersonMemoryKeys.redaction(input.ownerUserId, input.requestId),
      artifactSet,
      PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
      eventKey,
      JSON.stringify(redacted),
      resultJson,
      'keep_current',
      event.eventId,
    ),
  );
}
