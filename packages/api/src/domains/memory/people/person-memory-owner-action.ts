import { personMemoryDeletionReceiptSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ownerActionRequestDigest, verifyOwnerMemoryActionEvidence } from './OwnerMemoryActionEvidenceIssuer.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import type {
  ExecuteOwnerMemoryActionInput,
  OwnerMemoryActionCommand,
  OwnerMemoryActionExecutionResult,
  OwnerMemoryActionReplayResult,
} from './person-memory-owner-action-contract.js';
import { EXECUTE_OWNER_MEMORY_ACTION_LUA } from './person-memory-owner-action-lua.js';
import { planCommonOwnerAction } from './person-memory-owner-action-plan-support.js';
import {
  type OwnerActionReceipt,
  parseOwnerActionReceipt,
  projectOwnerActionReceipt,
} from './person-memory-owner-action-receipt.js';
import { planCorrectOwnerClaim, planRetireOwnerClaim } from './person-memory-owner-claim-plan.js';
import { planAmendOwnerEvent } from './person-memory-owner-event-plan.js';
import { personClaimOwnerRevision, personInteractionOwnerRevision } from './person-memory-owner-revision.js';
import { parseClaim, parseEvent, parsePerson } from './person-memory-records.js';
import { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

async function targetRevisionStillCurrent(redis: RedisClient, input: ExecuteOwnerMemoryActionInput): Promise<boolean> {
  if (input.command.action === 'correct_claim' || input.command.action === 'retire_claim') {
    const claim = parseClaim(await redis.get(PersonMemoryKeys.claim(input.ownerUserId, input.command.claimId)));
    return claim !== null && personClaimOwnerRevision(claim) === input.command.expectedRevision;
  }
  if (input.command.action === 'amend_event') {
    const event = parseEvent(await redis.get(PersonMemoryKeys.event(input.ownerUserId, input.command.eventId)));
    return event !== null && personInteractionOwnerRevision(event) === input.command.expectedRevision;
  }
  return false;
}

function parseLuaResult(
  raw: unknown,
):
  | { outcome: 'applied' | 'replayed'; receipt: OwnerActionReceipt }
  | { outcome: 'idempotency_conflict' | 'not_available' | 'conflict' | 'mutation_unavailable' } {
  const value = String(raw);
  if (value.startsWith('APPLIED:')) {
    return { outcome: 'applied', receipt: parseOwnerActionReceipt(value.slice(8)) };
  }
  if (value.startsWith('REPLAYED:')) {
    return { outcome: 'replayed', receipt: parseOwnerActionReceipt(value.slice(9)) };
  }
  if (value === 'IDEMPOTENCY_CONFLICT') return { outcome: 'idempotency_conflict' };
  if (value === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (value === 'CONFLICT') return { outcome: 'conflict' };
  return { outcome: 'mutation_unavailable' };
}

export async function resolveOwnerActionReplay(
  redis: RedisClient,
  input: { ownerUserId: string; command: OwnerMemoryActionCommand; requestDigest: string },
): Promise<OwnerMemoryActionReplayResult> {
  const raw = await redis.get(PersonMemoryKeys.ownerActionReceipt(input.ownerUserId, input.command.requestId));
  if (raw) {
    const receipt = parseOwnerActionReceipt(raw);
    if (receipt.requestDigest !== input.requestDigest || receipt.action !== input.command.action) {
      return { outcome: 'idempotency_conflict' };
    }
    return { outcome: 'replayed', result: projectOwnerActionReceipt(receipt, 'replayed') };
  }
  const deletionRaw = await redis.get(PersonMemoryKeys.forgetReceipt(input.ownerUserId, input.command.requestId));
  if (deletionRaw) {
    if (input.command.action !== 'hard_forget_person') return { outcome: 'idempotency_conflict' };
    const receipt = personMemoryDeletionReceiptSchema.parse(JSON.parse(deletionRaw));
    return {
      outcome: 'replayed',
      result: { action: input.command.action, outcome: 'replayed', receipt },
    };
  }
  return { outcome: 'none' };
}

async function planAction(
  redis: RedisClient,
  input: ExecuteOwnerMemoryActionInput,
  plan: PersonMemoryRedisPlan,
  artifactSet: string,
) {
  if (input.command.action === 'correct_claim') {
    return planCorrectOwnerClaim(
      redis,
      input as ExecuteOwnerMemoryActionInput & {
        command: Extract<OwnerMemoryActionCommand, { action: 'correct_claim' }>;
      },
      plan,
      artifactSet,
    );
  }
  if (input.command.action === 'retire_claim') {
    return planRetireOwnerClaim(
      redis,
      input as ExecuteOwnerMemoryActionInput & {
        command: Extract<OwnerMemoryActionCommand, { action: 'retire_claim' }>;
      },
      plan,
      artifactSet,
    );
  }
  return planAmendOwnerEvent(
    redis,
    input as ExecuteOwnerMemoryActionInput & {
      command: Extract<OwnerMemoryActionCommand, { action: 'amend_event' }>;
    },
    plan,
    artifactSet,
  );
}

export async function executeOwnerMemoryAction(
  redis: RedisClient,
  input: ExecuteOwnerMemoryActionInput,
): Promise<OwnerMemoryActionExecutionResult> {
  const expectedRequestDigest = ownerActionRequestDigest(input.ownerUserId, input.command);
  if (
    input.requestDigest !== expectedRequestDigest ||
    !verifyOwnerMemoryActionEvidence({
      evidence: input.evidence,
      ownerUserId: input.ownerUserId,
      command: input.command,
      requireLiveIssuerCapability: true,
    })
  ) {
    return { action: input.command.action, outcome: 'mutation_unavailable' };
  }
  const replay = await resolveOwnerActionReplay(redis, {
    ownerUserId: input.ownerUserId,
    command: input.command,
    requestDigest: input.requestDigest,
  });
  if (replay.outcome === 'idempotency_conflict') {
    return { action: input.command.action, outcome: 'idempotency_conflict' };
  }
  if (replay.outcome === 'replayed') return replay.result;
  if (input.command.action === 'hard_forget_person') {
    const { hardForgetPersonOwnerAction } = await import('./person-memory-owner-forget-action.js');
    return hardForgetPersonOwnerAction(
      redis,
      input as ExecuteOwnerMemoryActionInput & {
        command: Extract<OwnerMemoryActionCommand, { action: 'hard_forget_person' }>;
      },
    );
  }

  const personRaw = await redis.get(PersonMemoryKeys.person(input.ownerUserId, input.command.personId));
  const person = parsePerson(personRaw);
  if (!personRaw || !person || person.ownerUserId !== input.ownerUserId || person.personId !== input.command.personId) {
    return { action: input.command.action, outcome: 'not_available' };
  }
  const receiptKey = PersonMemoryKeys.ownerActionReceipt(input.ownerUserId, input.command.requestId);
  const artifactSet = PersonMemoryKeys.personArtifacts(input.ownerUserId, input.command.personId);
  const plan = new PersonMemoryRedisPlan([
    receiptKey,
    PersonMemoryKeys.forgetFence(input.ownerUserId, input.command.personId),
  ]);
  const planned = await planAction(redis, input, plan, artifactSet);
  if (planned === 'not_available' || planned === 'stale_revision') {
    return { action: input.command.action, outcome: planned };
  }
  await planCommonOwnerAction({
    redis,
    plan,
    ownerUserId: input.ownerUserId,
    personId: input.command.personId,
    personRaw,
    receiptKey,
    artifactSet,
    recordedAt: input.evidence.issuedAt,
    invalidationReason: input.command.action === 'retire_claim' ? 'source_forgotten' : 'source_corrected',
  });
  const parsed = parseLuaResult(
    await redis.eval(
      EXECUTE_OWNER_MEMORY_ACTION_LUA,
      plan.keys.length,
      ...plan.keys,
      input.requestDigest,
      JSON.stringify(planned),
      plan.serialize(),
    ),
  );
  if (parsed.outcome === 'applied' || parsed.outcome === 'replayed') {
    return projectOwnerActionReceipt(parsed.receipt, parsed.outcome);
  }
  if (parsed.outcome === 'conflict') {
    return {
      action: input.command.action,
      outcome: (await targetRevisionStillCurrent(redis, input)) ? 'mutation_unavailable' : 'stale_revision',
    };
  }
  return { action: input.command.action, outcome: parsed.outcome };
}
