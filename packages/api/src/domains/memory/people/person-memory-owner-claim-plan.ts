import { type MaterializableClaimPayload, personClaimIdSchema, personClaimVersionSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { PersonMemoryKeys } from './person-memory-keys.js';
import type { ExecuteOwnerMemoryActionInput, OwnerMemoryActionCommand } from './person-memory-owner-action-contract.js';
import { addOwnerActionArtifact, ownerActionObjectIdHash } from './person-memory-owner-action-plan-support.js';
import { type OwnerActionReceipt, ownerActionReceiptSchema } from './person-memory-owner-action-receipt.js';
import { personClaimOwnerRevision } from './person-memory-owner-revision.js';
import { parseClaim } from './person-memory-records.js';
import type { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

type ClaimPlanResult = OwnerActionReceipt | 'not_available' | 'stale_revision';
type ParsedClaim = NonNullable<ReturnType<typeof parseClaim>>;

function newClaimId(input: ExecuteOwnerMemoryActionInput) {
  return personClaimIdSchema.parse(`person_claim_owner_action_${ownerActionObjectIdHash(input)}`);
}

async function assessmentPointerToken(
  redis: RedisClient,
  ownerUserId: string,
  personId: string,
  startClaimId: string,
): Promise<string> {
  let currentId: string | undefined = startClaimId;
  const seen = new Set<string>();
  for (let depth = 0; currentId && depth < 200; depth += 1) {
    if (seen.has(currentId)) throw new Error('F276 owner action claim ancestry cycle');
    seen.add(currentId);
    const current = parseClaim(await redis.get(PersonMemoryKeys.claim(ownerUserId, currentId)));
    if (!current || current.ownerUserId !== ownerUserId || current.personId !== personId) {
      throw new Error('F276 owner action claim ancestry is malformed');
    }
    if (current.materializedBy.kind === 'card_approval') return current.materializedBy.draftId;
    if (!current.supersedesClaimId) return current.claimId;
    currentId = current.supersedesClaimId;
  }
  throw new Error('F276 owner action claim ancestry exceeds limit');
}

async function currentClaimKeyFor(
  redis: RedisClient,
  ownerUserId: string,
  personId: string,
  claim: ParsedClaim,
  payload: MaterializableClaimPayload = claim.payload as MaterializableClaimPayload,
): Promise<string> {
  const predicate =
    payload.kind === 'reported_fact'
      ? payload.predicate
      : `assessment:${await assessmentPointerToken(redis, ownerUserId, personId, claim.claimId)}`;
  return PersonMemoryKeys.currentClaim(ownerUserId, personId, predicate);
}

async function correctionPointers(
  redis: RedisClient,
  input: ExecuteOwnerMemoryActionInput & { command: Extract<OwnerMemoryActionCommand, { action: 'correct_claim' }> },
  target: ParsedClaim,
): Promise<{ oldCurrentKey: string; newCurrentKey: string } | null> {
  const oldCurrentKey = await currentClaimKeyFor(redis, input.ownerUserId, input.command.personId, target);
  const newCurrentKey = await currentClaimKeyFor(
    redis,
    input.ownerUserId,
    input.command.personId,
    target,
    input.command.payload,
  );
  const currentAtOldKey = await redis.get(oldCurrentKey);
  const oldPointerMismatch =
    (target.status === 'current' && currentAtOldKey !== target.claimId) ||
    (target.status === 'retired' && currentAtOldKey === target.claimId);
  if (oldPointerMismatch) return null;
  const currentAtNewKey = oldCurrentKey === newCurrentKey ? currentAtOldKey : await redis.get(newCurrentKey);
  const newPointerOccupied =
    (target.status === 'retired' && Boolean(currentAtNewKey)) ||
    (target.status === 'current' && oldCurrentKey !== newCurrentKey && Boolean(currentAtNewKey));
  return newPointerOccupied ? null : { oldCurrentKey, newCurrentKey };
}

function planCorrectionTransition(input: {
  plan: PersonMemoryRedisPlan;
  target: ParsedClaim;
  targetKey: string;
  oldCurrentKey: string;
  newCurrentKey: string;
  recordedAt: number;
}): void {
  if (input.target.status === 'retired') {
    input.plan.expect(input.newCurrentKey, '');
    return;
  }
  input.plan.set(input.targetKey, JSON.stringify({ ...input.target, status: 'superseded', validTo: input.recordedAt }));
  input.plan.expect(input.oldCurrentKey, input.target.claimId);
  if (input.oldCurrentKey !== input.newCurrentKey) {
    input.plan.del(input.oldCurrentKey, 'string');
    input.plan.expect(input.newCurrentKey, '');
  }
}

export async function planCorrectOwnerClaim(
  redis: RedisClient,
  input: ExecuteOwnerMemoryActionInput & { command: Extract<OwnerMemoryActionCommand, { action: 'correct_claim' }> },
  plan: PersonMemoryRedisPlan,
  artifactSet: string,
): Promise<ClaimPlanResult> {
  const targetKey = PersonMemoryKeys.claim(input.ownerUserId, input.command.claimId);
  const targetRaw = await redis.get(targetKey);
  const target = parseClaim(targetRaw);
  if (!targetRaw || !target || target.ownerUserId !== input.ownerUserId || target.personId !== input.command.personId) {
    return 'not_available';
  }
  if (personClaimOwnerRevision(target) !== input.command.expectedRevision) return 'stale_revision';
  if (target.status !== 'current' && target.status !== 'retired') return 'not_available';
  const pointers = await correctionPointers(redis, input, target);
  if (!pointers) return 'stale_revision';
  const { oldCurrentKey, newCurrentKey } = pointers;

  const claimId = newClaimId(input);
  const claimKey = PersonMemoryKeys.claim(input.ownerUserId, claimId);
  const claim = personClaimVersionSchema.parse({
    claimId,
    personId: input.command.personId,
    ownerUserId: input.ownerUserId,
    payload: input.command.payload,
    status: 'current',
    recordedAt: input.evidence.issuedAt,
    sourceRefs: [],
    materializedBy: input.evidence,
    supersedesClaimId: target.claimId,
  });
  plan.expect(targetKey, targetRaw);
  plan.expect(claimKey, '');
  planCorrectionTransition({
    plan,
    target,
    targetKey,
    oldCurrentKey,
    newCurrentKey,
    recordedAt: input.evidence.issuedAt,
  });
  plan.set(claimKey, JSON.stringify(claim));
  plan.set(newCurrentKey, claimId);
  const claimsKey = PersonMemoryKeys.personClaims(input.ownerUserId, input.command.personId);
  plan.zadd(claimsKey, input.evidence.issuedAt, claimId);
  for (const key of [targetKey, claimKey, oldCurrentKey, newCurrentKey, claimsKey]) {
    addOwnerActionArtifact(plan, artifactSet, key);
  }
  return ownerActionReceiptSchema.parse({
    v: 1,
    ownerUserId: input.ownerUserId,
    requestId: input.command.requestId,
    requestDigest: input.requestDigest,
    action: input.command.action,
    itemId: claimId,
    revision: personClaimOwnerRevision(claim),
    completedAt: input.evidence.issuedAt,
  });
}

export async function planRetireOwnerClaim(
  redis: RedisClient,
  input: ExecuteOwnerMemoryActionInput & { command: Extract<OwnerMemoryActionCommand, { action: 'retire_claim' }> },
  plan: PersonMemoryRedisPlan,
  artifactSet: string,
): Promise<ClaimPlanResult> {
  const targetKey = PersonMemoryKeys.claim(input.ownerUserId, input.command.claimId);
  const targetRaw = await redis.get(targetKey);
  const target = parseClaim(targetRaw);
  if (!targetRaw || !target || target.ownerUserId !== input.ownerUserId || target.personId !== input.command.personId) {
    return 'not_available';
  }
  if (personClaimOwnerRevision(target) !== input.command.expectedRevision) return 'stale_revision';
  if (target.status !== 'current') return 'not_available';
  const currentKey = await currentClaimKeyFor(redis, input.ownerUserId, input.command.personId, target);
  if ((await redis.get(currentKey)) !== target.claimId) return 'stale_revision';
  const claimId = newClaimId(input);
  const claimKey = PersonMemoryKeys.claim(input.ownerUserId, claimId);
  const { typedProvenance: _typedProvenance, validTo: _validTo, ...targetBase } = target;
  const retired = personClaimVersionSchema.parse({
    ...targetBase,
    claimId,
    status: 'retired',
    recordedAt: input.evidence.issuedAt,
    validTo: input.evidence.issuedAt,
    sourceRefs: [],
    materializedBy: input.evidence,
    supersedesClaimId: target.claimId,
  });
  plan.expect(targetKey, targetRaw);
  plan.expect(claimKey, '');
  plan.expect(currentKey, target.claimId);
  plan.set(targetKey, JSON.stringify({ ...target, status: 'superseded', validTo: input.evidence.issuedAt }));
  plan.set(claimKey, JSON.stringify(retired));
  plan.del(currentKey, 'string');
  const claimsKey = PersonMemoryKeys.personClaims(input.ownerUserId, input.command.personId);
  plan.zadd(claimsKey, input.evidence.issuedAt, claimId);
  for (const key of [targetKey, claimKey, currentKey, claimsKey]) {
    addOwnerActionArtifact(plan, artifactSet, key);
  }
  return ownerActionReceiptSchema.parse({
    v: 1,
    ownerUserId: input.ownerUserId,
    requestId: input.command.requestId,
    requestDigest: input.requestDigest,
    action: input.command.action,
    itemId: claimId,
    revision: personClaimOwnerRevision(retired),
    completedAt: input.evidence.issuedAt,
  });
}
