import type { InteractionEvent, PersonClaimVersion, PersonIdentity, PersonRelationship } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { personAggregateOwnerRevision } from './person-memory-owner-revision.js';
import { parseClaim, parseEvent, parseRelationship } from './person-memory-records.js';

const RELEASE_HARD_FORGET_FENCE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export async function releaseOwnedForgetFence(redis: RedisClient, fenceKey: string, requestId: string): Promise<void> {
  await redis.eval(RELEASE_HARD_FORGET_FENCE_LUA, 1, fenceKey, requestId);
}

async function readCanonicalPersonSnapshot(
  redis: RedisClient,
  ownerUserId: string,
  person: PersonIdentity,
): Promise<{
  claims: PersonClaimVersion[];
  relationships: PersonRelationship[];
  events: InteractionEvent[];
} | null> {
  const [claimIds, relationshipIds, eventIds] = await Promise.all([
    redis.zrange(PersonMemoryKeys.personClaims(ownerUserId, person.personId), 0, -1),
    redis.zrange(PersonMemoryKeys.personRelationships(ownerUserId, person.personId), 0, -1),
    redis.zrange(PersonMemoryKeys.personEvents(ownerUserId, person.personId), 0, -1),
  ]);
  const [claimRaws, relationshipRaws, eventRaws] = await Promise.all([
    claimIds.length > 0
      ? redis.mget(...claimIds.map((id) => PersonMemoryKeys.claim(ownerUserId, id)))
      : Promise.resolve([]),
    relationshipIds.length > 0
      ? redis.mget(...relationshipIds.map((id) => PersonMemoryKeys.relationship(ownerUserId, id)))
      : Promise.resolve([]),
    eventIds.length > 0
      ? redis.mget(...eventIds.map((id) => PersonMemoryKeys.event(ownerUserId, id)))
      : Promise.resolve([]),
  ]);
  const claims = claimRaws.map(parseClaim);
  const relationships = relationshipRaws.map(parseRelationship);
  const events = eventRaws.map(parseEvent);
  if (
    claims.some((item) => item === null) ||
    relationships.some((item) => item === null) ||
    events.some((item) => item === null)
  ) {
    return null;
  }
  const validClaims = claims as PersonClaimVersion[];
  const validRelationships = relationships as PersonRelationship[];
  const validEvents = events as InteractionEvent[];
  const relationshipSet = new Set(validRelationships.map((item) => item.relationshipId));
  const foreignCanonical =
    validClaims.some((item) => item.ownerUserId !== ownerUserId || item.personId !== person.personId) ||
    validRelationships.some((item) => item.ownerUserId !== ownerUserId || item.personId !== person.personId) ||
    validEvents.some((item) => item.ownerUserId !== ownerUserId || !relationshipSet.has(item.relationshipId));
  return foreignCanonical ? null : { claims: validClaims, relationships: validRelationships, events: validEvents };
}

export async function validateOwnerForgetRevision(input: {
  redis: RedisClient;
  ownerUserId: string;
  personId: string;
  person: PersonIdentity | null;
  expectedPersonRevision: string;
  fenceKey: string;
  requestId: string;
}): Promise<'not_available' | 'stale_revision' | 'mutation_unavailable' | null> {
  const { redis, ownerUserId, personId, person, fenceKey, requestId } = input;
  if (!person || person.ownerUserId !== ownerUserId || person.personId !== personId) {
    await releaseOwnedForgetFence(redis, fenceKey, requestId);
    return 'not_available';
  }
  const snapshot = await readCanonicalPersonSnapshot(redis, ownerUserId, person);
  if (!snapshot) {
    await releaseOwnedForgetFence(redis, fenceKey, requestId);
    return 'mutation_unavailable';
  }
  if (personAggregateOwnerRevision({ person, ...snapshot }) === input.expectedPersonRevision) return null;
  await releaseOwnedForgetFence(redis, fenceKey, requestId);
  return 'stale_revision';
}
