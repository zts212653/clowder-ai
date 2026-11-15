import type { InteractionEvent, PersonClaimVersion } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { PersonMemoryRedactionResult, RedactPersonMemoryItemInput } from './PersonMemoryStore.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { REDACT_ITEM_LUA } from './person-memory-lifecycle-lua.js';
import { personClaimOwnerRevision, personInteractionOwnerRevision } from './person-memory-owner-revision.js';
import { parseClaim, parseEvent, parseRelationship } from './person-memory-records.js';

function redactionResult(raw: unknown): PersonMemoryRedactionResult {
  const value = String(raw);
  if (value === 'CONFLICT') return { outcome: 'conflict' };
  if (value === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  for (const [prefix, outcome] of [
    ['APPLIED:', 'applied'],
    ['REPLAYED:', 'replayed'],
  ] as const) {
    if (value.startsWith(prefix)) {
      return { outcome, item: JSON.parse(value.slice(prefix.length)) as RedactPersonMemoryItemInput['item'] };
    }
  }
  throw new Error(`unexpected F276 redaction result: ${value}`);
}

interface RedactionTarget {
  raw: string;
  key: string;
  currentKey: string;
  relationshipKey: string;
  relationshipRaw: string;
  redacted: PersonClaimVersion | InteractionEvent;
  revision: string;
  clearCurrent: boolean;
}

async function claimTarget(redis: RedisClient, input: RedactPersonMemoryItemInput): Promise<RedactionTarget | null> {
  const key = PersonMemoryKeys.claim(input.ownerUserId, input.item.id);
  const raw = await redis.get(key);
  const claim = parseClaim(raw);
  if (!raw || !claim || claim.personId !== input.personId || claim.ownerUserId !== input.ownerUserId) return null;
  const { typedProvenance: _typedProvenance, ...base } = claim;
  const predicate = claim.payload.kind === 'reported_fact' ? claim.payload.predicate : `assessment:${claim.claimId}`;
  return {
    raw,
    key,
    currentKey: PersonMemoryKeys.currentClaim(input.ownerUserId, input.personId, predicate),
    relationshipKey: key,
    relationshipRaw: '',
    clearCurrent: true,
    revision: personClaimOwnerRevision(claim),
    redacted: { ...base, payload: { kind: 'redacted' }, status: 'redacted', validTo: input.redactedAt, sourceRefs: [] },
  };
}

async function eventTarget(redis: RedisClient, input: RedactPersonMemoryItemInput): Promise<RedactionTarget | null> {
  const key = PersonMemoryKeys.event(input.ownerUserId, input.item.id);
  const raw = await redis.get(key);
  const event = parseEvent(raw);
  if (!raw || !event || event.ownerUserId !== input.ownerUserId) return null;
  const relationshipKey = PersonMemoryKeys.relationship(input.ownerUserId, event.relationshipId);
  const relationshipRaw = (await redis.get(relationshipKey)) ?? '';
  const relationship = parseRelationship(relationshipRaw);
  if (!relationship || relationship.personId !== input.personId || relationship.ownerUserId !== input.ownerUserId)
    return null;
  return {
    raw,
    key,
    currentKey: key,
    relationshipKey,
    relationshipRaw,
    clearCurrent: false,
    revision: personInteractionOwnerRevision(event),
    redacted: {
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
    },
  };
}

/** Reuse the original destructive lifecycle transition and durable request receipt. */
export async function redactPersonMemoryItem(
  redis: RedisClient,
  input: RedactPersonMemoryItemInput,
): Promise<PersonMemoryRedactionResult> {
  const artifactSet = PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId);
  const receiptKey = PersonMemoryKeys.redaction(input.ownerUserId, input.requestId);
  const resultJson = JSON.stringify(input.item);
  const target = input.item.kind === 'claim' ? await claimTarget(redis, input) : await eventTarget(redis, input);
  if (!target) return { outcome: 'not_available' };
  // Recover a committed exact-target request before comparing its now-redacted target revision.
  const prior = await redis.get(receiptKey);
  if (prior) return prior === resultJson ? { outcome: 'replayed', item: input.item } : { outcome: 'conflict' };
  if (input.expectedRevision && input.expectedRevision !== target.revision) return { outcome: 'stale_revision' };
  return redactionResult(
    await redis.eval(
      REDACT_ITEM_LUA,
      6,
      target.key,
      receiptKey,
      artifactSet,
      PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId),
      target.currentKey,
      target.relationshipKey,
      JSON.stringify(target.redacted),
      resultJson,
      target.clearCurrent ? 'clear_current' : 'keep_current',
      input.item.id,
      target.raw,
      target.relationshipRaw,
    ),
  );
}
