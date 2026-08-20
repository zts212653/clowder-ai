import {
  type PersonIdentity,
  type PersonMemoryDeletionReceipt,
  type PersonMemorySuppressionToken,
  personMemoryDeletionReceiptSchema,
  personMemorySuppressionTokenSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DeferredPersonMemoryReceiptKeys } from '../RedisDeferredPersonMemoryReceiptStore.js';
import type { HardForgetPersonInput } from './PersonMemoryStore.js';
import { loadDeferredReceiptForgetClosure, planDeferredReceiptForgetClosure } from './person-memory-deferred-forget.js';
import {
  type PersonMemoryCandidateSnapshot,
  planPersonMemoryDispositionPurge,
} from './person-memory-disposition-forget.js';
import { BEGIN_HARD_FORGET_LUA, FINISH_HARD_FORGET_LUA } from './person-memory-forget-lua.js';
import { normalizePrivateAlias, PersonMemoryKeys } from './person-memory-keys.js';
import { parsePerson, parseStoredCandidate } from './person-memory-records.js';
import { type CanonicalRedisValueType, PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

const HARD_FORGET_FENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const ARTIFACT_TYPE_BY_PREFIX: ReadonlyArray<readonly [string, CanonicalRedisValueType]> = [
  ['person-memory:person-candidates:', 'set'],
  ['person-memory:target-candidates:', 'set'],
  ['person-memory:person-artifacts:', 'set'],
  ['person-memory:alias:', 'set'],
  ['person-memory:suppression-subject:', 'set'],
  ['person-memory:candidate-decisions:', 'set'],
  ['person-memory:pending:', 'zset'],
  ['person-memory:person-claims:', 'zset'],
  ['person-memory:person-relationships:', 'zset'],
  ['person-memory:person-events:', 'zset'],
  ['person-memory:relationship-events:', 'zset'],
  ['person-memory:candidate:', 'string'],
  ['person-memory:candidate-owner:', 'string'],
  ['person-memory:decision:', 'string'],
  ['person-memory:undo:', 'string'],
  ['person-memory:candidate-person:', 'string'],
  ['person-memory:person:', 'string'],
  ['person-memory:workspace-entity-person:', 'string'],
  ['person-memory:claim:', 'string'],
  ['person-memory:current-claim:', 'string'],
  ['person-memory:relationship:', 'string'],
  ['person-memory:primary-relationship:', 'string'],
  ['person-memory:event:', 'string'],
  ['person-memory:correction:', 'string'],
  ['person-memory:amendment:', 'string'],
  ['person-memory:redaction:', 'string'],
  ['person-memory:suppression:', 'string'],
  ['person-memory:disposition-lineage:', 'string'],
  ['person-memory:disposition-lineage-handle:', 'string'],
  ['person-memory:disposition-receipt:', 'string'],
  ['person-memory:deferred-dedupe:', 'string'],
];

function canonicalArtifactType(key: string): CanonicalRedisValueType {
  const match = ARTIFACT_TYPE_BY_PREFIX.find(([prefix]) => key.startsWith(prefix));
  if (!match) throw new Error(`F276 hard-forget artifact has no canonical Redis type: ${key}`);
  return match[1];
}

function logicalArtifactKey(key: string, keyPrefix: string): string {
  return keyPrefix && key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key;
}

async function existingForgetReceipt(
  redis: RedisClient,
  input: HardForgetPersonInput,
): Promise<PersonMemoryDeletionReceipt | null> {
  const raw = await redis.get(PersonMemoryKeys.forgetReceipt(input.ownerUserId, input.requestId));
  return raw ? personMemoryDeletionReceiptSchema.parse(JSON.parse(raw)) : null;
}

function deletionReceipt(
  input: HardForgetPersonInput,
  verdict: 'purged' | 'already_absent',
  counts: Record<string, number>,
): PersonMemoryDeletionReceipt {
  return personMemoryDeletionReceiptSchema.parse({
    requestId: input.requestId,
    ownerUserId: input.ownerUserId,
    completedAt: input.requestedAt,
    purgedSurfaceCounts: counts,
    verdict,
  });
}

async function planOwnedReverseRemoval(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  ownerUserId: string,
  person: PersonIdentity | null,
): Promise<string | null> {
  if (!person?.workspaceEntityLink) return null;
  const reverseKey = PersonMemoryKeys.workspaceEntityPerson(ownerUserId, person.workspaceEntityLink.entityRef);
  if ((await redis.get(reverseKey)) === person.personId) {
    plan.expect(reverseKey, person.personId);
    plan.del(reverseKey, 'string');
  }
  return reverseKey;
}

async function loadSuppressionTokens(
  redis: RedisClient,
  ownerUserId: string,
  candidateIds: string[],
): Promise<Array<PersonMemorySuppressionToken | null>> {
  return Promise.all(
    candidateIds.map(async (candidateId) => {
      const raw = await redis.get(PersonMemoryKeys.suppression(ownerUserId, candidateId));
      if (!raw) return null;
      return personMemorySuppressionTokenSchema.parse(JSON.parse(raw));
    }),
  );
}

function planCandidatePurge(
  plan: PersonMemoryRedisPlan,
  ownerUserId: string,
  candidateId: string,
  candidateRaw: string,
  suppression: PersonMemorySuppressionToken | null,
): void {
  plan.expect(PersonMemoryKeys.candidate(ownerUserId, candidateId), candidateRaw);
  plan.zrem(PersonMemoryKeys.pending(ownerUserId), candidateId);
  plan.del(PersonMemoryKeys.candidate(ownerUserId, candidateId), 'string');
  plan.del(PersonMemoryKeys.candidateOwner(candidateId), 'string');
  plan.del(PersonMemoryKeys.candidatePerson(ownerUserId, candidateId), 'string');
  plan.del(PersonMemoryKeys.suppression(ownerUserId, candidateId), 'string');
  for (const subjectRef of suppression?.subjectRefs ?? []) {
    plan.srem(PersonMemoryKeys.suppressionSubject(ownerUserId, subjectRef), candidateId);
  }
}

async function loadCandidateSnapshots(
  redis: RedisClient,
  ownerUserId: string,
  candidateIds: string[],
): Promise<Map<string, PersonMemoryCandidateSnapshot>> {
  const snapshots = new Map<string, PersonMemoryCandidateSnapshot>();
  for (const candidateId of candidateIds) {
    const raw = await redis.get(PersonMemoryKeys.candidate(ownerUserId, candidateId));
    const candidate = parseStoredCandidate(raw);
    if (!raw || !candidate || candidate.ownerUserId !== ownerUserId || candidate.candidateId !== candidateId) {
      throw new Error('F276 hard-forget candidate closure is malformed');
    }
    snapshots.set(candidateId, { candidate, raw });
  }
  return snapshots;
}

function parseFinishResult(finish: string): PersonMemoryDeletionReceipt {
  if (finish.startsWith('PURGED:')) {
    return personMemoryDeletionReceiptSchema.parse(JSON.parse(finish.slice(7)));
  }
  if (finish.startsWith('RECEIPT:')) {
    return personMemoryDeletionReceiptSchema.parse(JSON.parse(finish.slice(8)));
  }
  throw new Error(`unexpected F276 forget result: ${finish}`);
}

export async function hardForgetPerson(
  redis: RedisClient,
  input: HardForgetPersonInput,
): Promise<PersonMemoryDeletionReceipt> {
  const prior = await existingForgetReceipt(redis, input);
  if (prior) return prior;
  const fenceKey = PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId);
  const receiptKey = PersonMemoryKeys.forgetReceipt(input.ownerUserId, input.requestId);
  const personKey = PersonMemoryKeys.person(input.ownerUserId, input.personId);
  const artifactSet = PersonMemoryKeys.personArtifacts(input.ownerUserId, input.personId);
  const registeredPersonBindingKey = DeferredPersonMemoryReceiptKeys.binding(
    input.ownerUserId,
    'registered_person',
    input.personId,
  );
  const begin = String(
    await redis.eval(
      BEGIN_HARD_FORGET_LUA,
      5,
      fenceKey,
      receiptKey,
      personKey,
      artifactSet,
      registeredPersonBindingKey,
      input.requestId,
      String(HARD_FORGET_FENCE_TTL_MS),
    ),
  );
  if (begin.startsWith('RECEIPT:')) {
    return personMemoryDeletionReceiptSchema.parse(JSON.parse(begin.slice(8)));
  }
  if (begin === 'CONFLICT') throw new Error('person forget already in progress');
  if (begin === 'ABSENT') {
    const receipt = deletionReceipt(input, 'already_absent', {});
    await redis.set(receiptKey, JSON.stringify(receipt), 'NX');
    return (await existingForgetReceipt(redis, input)) ?? receipt;
  }

  const person = parsePerson(await redis.get(personKey));
  const artifactKeys = await redis.smembers(artifactSet);
  const [materializedCandidateIds, targetCandidateIds] = await Promise.all([
    redis.smembers(PersonMemoryKeys.personCandidates(input.ownerUserId, input.personId)),
    redis.smembers(PersonMemoryKeys.targetCandidates(input.ownerUserId, input.personId)),
  ]);
  const candidateIds = [...new Set([...materializedCandidateIds, ...targetCandidateIds])];
  const [suppressionTokens, candidateSnapshots] = await Promise.all([
    loadSuppressionTokens(redis, input.ownerUserId, candidateIds),
    loadCandidateSnapshots(redis, input.ownerUserId, candidateIds),
  ]);
  const deferredReceiptClosure = await loadDeferredReceiptForgetClosure(
    redis,
    input.ownerUserId,
    input.personId,
    person,
    candidateSnapshots,
  );
  const plan = new PersonMemoryRedisPlan([fenceKey, receiptKey]);
  plan.expectSetMembers(artifactSet, artifactKeys);
  const reverseKey = await planOwnedReverseRemoval(redis, plan, input.ownerUserId, person);
  await planPersonMemoryDispositionPurge({
    redis,
    plan,
    ownerUserId: input.ownerUserId,
    personId: input.personId,
    artifactKeys,
    candidates: candidateSnapshots,
  });
  const keyPrefix = redis.options.keyPrefix ?? '';
  for (const storedArtifactKey of artifactKeys) {
    const artifactKey = logicalArtifactKey(storedArtifactKey, keyPrefix);
    if (artifactKey !== reverseKey) plan.del(artifactKey, canonicalArtifactType(artifactKey));
  }
  plan.del(personKey, 'string');
  plan.del(artifactSet, 'set');
  plan.del(PersonMemoryKeys.personCandidates(input.ownerUserId, input.personId), 'set');
  plan.del(PersonMemoryKeys.targetCandidates(input.ownerUserId, input.personId), 'set');
  for (const alias of person?.privateAliases ?? []) {
    plan.srem(PersonMemoryKeys.alias(input.ownerUserId, normalizePrivateAlias(alias)), input.personId);
  }
  for (const [index, candidateId] of candidateIds.entries()) {
    const candidateRaw = candidateSnapshots.get(candidateId)?.raw;
    if (!candidateRaw) throw new Error('F276 hard-forget candidate snapshot disappeared');
    planCandidatePurge(plan, input.ownerUserId, candidateId, candidateRaw, suppressionTokens[index]);
  }
  planDeferredReceiptForgetClosure(plan, input.ownerUserId, deferredReceiptClosure);
  const receipt = deletionReceipt(input, 'purged', {
    artifacts: new Set([...artifactKeys, personKey, artifactSet]).size,
    aliases: person?.privateAliases.length ?? 0,
    candidates: candidateIds.length,
    deferredReceipts: deferredReceiptClosure.snapshots.size,
  });
  const finish = String(
    await redis.eval(
      FINISH_HARD_FORGET_LUA,
      plan.keys.length,
      ...plan.keys,
      input.requestId,
      JSON.stringify(receipt),
      plan.serialize(),
    ),
  );
  return parseFinishResult(finish);
}
