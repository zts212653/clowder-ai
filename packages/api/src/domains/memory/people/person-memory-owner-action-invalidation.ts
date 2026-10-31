import { deferredPersonMemoryReceiptSchema, deliveredWriteOpportunityRecordV1Schema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DeferredPersonMemoryReceiptKeys } from '../deferred-person-memory-redis-contract.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { parsePerson, parseStoredCandidate } from './person-memory-records.js';
import type { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';
import { WriteOpportunityDeliveryKeys } from './RedisWriteOpportunityDeliveryStore.js';
import type { WriteOpportunityLineageInvalidationReason } from './WriteOpportunityTerminalLedger.js';
import {
  WRITE_OPPORTUNITY_INVALIDATED_FIELD,
  WriteOpportunityTerminalKeys,
} from './write-opportunity-terminal-redis-contract.js';

export interface PersonOwnerActionInvalidationInput {
  redis: RedisClient;
  plan: PersonMemoryRedisPlan;
  ownerUserId: string;
  personId: string;
  mode:
    | { kind: 'invalidate'; reason: WriteOpportunityLineageInvalidationReason; recordedAt: number }
    | { kind: 'purge' };
}

async function resolvePersonLineages(input: PersonOwnerActionInvalidationInput): Promise<Set<string>> {
  const { redis, plan, ownerUserId, personId } = input;
  const personCandidatesKey = PersonMemoryKeys.personCandidates(ownerUserId, personId);
  const targetCandidatesKey = PersonMemoryKeys.targetCandidates(ownerUserId, personId);
  const [personCandidateIds, targetCandidateIds] = await Promise.all([
    redis.smembers(personCandidatesKey),
    redis.smembers(targetCandidatesKey),
  ]);
  plan.expectSetMembers(personCandidatesKey, personCandidateIds);
  plan.expectSetMembers(targetCandidatesKey, targetCandidateIds);
  const lineages = new Set<string>();
  for (const candidateId of new Set([...personCandidateIds, ...targetCandidateIds])) {
    const key = PersonMemoryKeys.candidate(ownerUserId, candidateId);
    const raw = await redis.get(key);
    const candidate = parseStoredCandidate(raw);
    if (!raw || !candidate || candidate.ownerUserId !== ownerUserId || candidate.candidateId !== candidateId) {
      throw new Error('F276 owner action candidate closure is malformed');
    }
    plan.expect(key, raw);
    if (candidate.writeOpportunityLineage) lineages.add(candidate.writeOpportunityLineage.dedupeLineage);
  }
  await resolveDeferredReceiptLineages(input, lineages);
  return lineages;
}

async function resolveDeferredReceiptLineages(
  input: PersonOwnerActionInvalidationInput,
  lineages: Set<string>,
): Promise<void> {
  const { redis, plan, ownerUserId, personId } = input;
  const person = parsePerson(await redis.get(PersonMemoryKeys.person(ownerUserId, personId)));
  const bindings = [
    { kind: 'registered_person' as const, ref: personId },
    ...(person?.workspaceEntityLink?.state === 'linked'
      ? [{ kind: 'registered_entity' as const, ref: person.workspaceEntityLink.entityRef }]
      : []),
  ];
  for (const binding of bindings) {
    const bindingKey = DeferredPersonMemoryReceiptKeys.binding(ownerUserId, binding.kind, binding.ref);
    const receiptIds = await redis.smembers(bindingKey);
    plan.expectSetMembers(bindingKey, receiptIds);
    for (const receiptId of receiptIds) {
      const receiptKey = DeferredPersonMemoryReceiptKeys.receipt(ownerUserId, receiptId);
      const raw = await redis.get(receiptKey);
      if (!raw) throw new Error('F276 owner action deferred receipt closure is malformed');
      const receipt = deferredPersonMemoryReceiptSchema.parse(JSON.parse(raw));
      const exactBinding =
        receipt.ownerUserId === ownerUserId &&
        receipt.receiptId === receiptId &&
        receipt.registryBinding?.kind === binding.kind &&
        receipt.registryBinding.ref === binding.ref;
      if (!exactBinding) throw new Error('F276 owner action deferred binding closure is malformed');
      plan.expect(receiptKey, raw);
      if (receipt.writeOpportunityLineage) lineages.add(receipt.writeOpportunityLineage.dedupeLineage);
    }
  }
}

async function planTerminalLineage(input: PersonOwnerActionInvalidationInput, dedupeLineage: string): Promise<void> {
  const terminalKey = WriteOpportunityTerminalKeys.lineage(input.ownerUserId, dedupeLineage);
  if (input.mode.kind === 'purge') {
    input.plan.del(terminalKey, 'hash');
    return;
  }
  const currentInvalidation = (await input.redis.hget(terminalKey, WRITE_OPPORTUNITY_INVALIDATED_FIELD)) ?? '';
  input.plan.expectHashField(terminalKey, WRITE_OPPORTUNITY_INVALIDATED_FIELD, currentInvalidation);
  if (currentInvalidation) return;
  input.plan.hset(terminalKey, WRITE_OPPORTUNITY_INVALIDATED_FIELD, input.mode.reason);
  input.plan.hset(terminalKey, `${WRITE_OPPORTUNITY_INVALIDATED_FIELD}:at`, String(input.mode.recordedAt));
}

async function planDeliveredLineage(input: PersonOwnerActionInvalidationInput, dedupeLineage: string): Promise<void> {
  const { redis, plan, ownerUserId } = input;
  const lineageKey = WriteOpportunityDeliveryKeys.lineage(ownerUserId, dedupeLineage);
  const opportunityIds = await redis.smembers(lineageKey);
  plan.expectSetMembers(lineageKey, opportunityIds);
  for (const opportunityId of opportunityIds) {
    const deliveredKey = WriteOpportunityDeliveryKeys.delivered(ownerUserId, opportunityId);
    const raw = await redis.get(deliveredKey);
    plan.expect(deliveredKey, raw ?? '');
    if (!raw) continue;
    const record = deliveredWriteOpportunityRecordV1Schema.parse(JSON.parse(raw));
    const matchesLineage =
      record.ownerUserId === ownerUserId &&
      record.opportunityId === opportunityId &&
      record.dedupeLineage === dedupeLineage;
    if (!matchesLineage) throw new Error('F276 owner action delivery closure is malformed');
    plan.del(deliveredKey, 'string');
    plan.srem(WriteOpportunityDeliveryKeys.invocation(ownerUserId, record.invocationId), opportunityId);
  }
  plan.del(lineageKey, 'set');
}

/**
 * Snapshot and plan the complete F296 person-bound lineage closure. Set and
 * record CAS preconditions make a concurrent candidate/delivery fail the whole
 * owner action before any canonical mutation is applied.
 */
export async function planPersonOwnerActionInvalidation(input: PersonOwnerActionInvalidationInput): Promise<void> {
  const lineages = await resolvePersonLineages(input);
  for (const dedupeLineage of lineages) {
    await planTerminalLineage(input, dedupeLineage);
    await planDeliveredLineage(input, dedupeLineage);
  }
}
