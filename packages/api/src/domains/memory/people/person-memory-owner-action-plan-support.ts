import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { PersonMemoryKeys } from './person-memory-keys.js';
import type { ExecuteOwnerMemoryActionInput } from './person-memory-owner-action-contract.js';
import { planPersonOwnerActionInvalidation } from './person-memory-owner-action-invalidation.js';
import type { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

export function ownerActionObjectIdHash(input: ExecuteOwnerMemoryActionInput): string {
  return createHash('sha256')
    .update(input.ownerUserId)
    .update('\0')
    .update(input.command.personId)
    .update('\0')
    .update(input.command.action)
    .update('\0')
    .update(input.command.requestId)
    .digest('hex')
    .slice(0, 40);
}

export function addOwnerActionArtifact(plan: PersonMemoryRedisPlan, artifactSet: string, artifactKey: string): void {
  plan.sadd(artifactSet, artifactKey);
}

export async function planCommonOwnerAction(input: {
  redis: RedisClient;
  plan: PersonMemoryRedisPlan;
  ownerUserId: string;
  personId: string;
  personRaw: string;
  receiptKey: string;
  artifactSet: string;
  recordedAt: number;
  invalidationReason: 'source_corrected' | 'source_forgotten';
}): Promise<void> {
  const personKey = PersonMemoryKeys.person(input.ownerUserId, input.personId);
  input.plan.expect(personKey, input.personRaw);
  input.plan.fence(PersonMemoryKeys.forgetFence(input.ownerUserId, input.personId));
  const generationKey = PersonMemoryKeys.ownerActionGeneration(input.ownerUserId, input.personId);
  const generationRaw = await input.redis.get(generationKey);
  if (generationRaw !== null && !/^\d+$/.test(generationRaw)) {
    throw new Error('F276 owner action generation is malformed');
  }
  const generation = generationRaw === null ? 0 : Number(generationRaw);
  if (!Number.isSafeInteger(generation) || generation < 0 || generation === Number.MAX_SAFE_INTEGER) {
    throw new Error('F276 owner action generation is out of range');
  }
  input.plan.expect(generationKey, generationRaw ?? '');
  input.plan.set(generationKey, String(generation + 1));
  addOwnerActionArtifact(input.plan, input.artifactSet, generationKey);
  addOwnerActionArtifact(input.plan, input.artifactSet, input.receiptKey);
  await planPersonOwnerActionInvalidation({
    redis: input.redis,
    plan: input.plan,
    ownerUserId: input.ownerUserId,
    personId: input.personId,
    mode: { kind: 'invalidate', reason: input.invalidationReason, recordedAt: input.recordedAt },
  });
}
