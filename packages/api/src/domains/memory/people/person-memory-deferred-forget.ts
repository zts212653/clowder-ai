import {
  type DeferredPersonMemoryReceipt,
  deferredPersonMemoryReceiptSchema,
  type PersonIdentity,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DeferredPersonMemoryReceiptKeys } from '../deferred-person-memory-redis-contract.js';
import { deferredReceiptLineageMarker, personMemoryProposalLineageMarker } from './person-memory-delta-lineage.js';
import type { PersonMemoryCandidateSnapshot } from './person-memory-disposition-forget.js';
import type { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

export type DeferredReceiptSnapshot = { receipt: DeferredPersonMemoryReceipt; raw: string };

export interface DeferredReceiptForgetClosure {
  memberships: Map<string, string[]>;
  snapshots: Map<string, DeferredReceiptSnapshot>;
}

function bindingKey(ownerUserId: string, receipt: DeferredPersonMemoryReceipt): string | null {
  const binding = receipt.registryBinding;
  return binding ? DeferredPersonMemoryReceiptKeys.binding(ownerUserId, binding.kind, binding.ref) : null;
}

async function loadMemberships(
  redis: RedisClient,
  ownerUserId: string,
  personId: string,
  person: PersonIdentity | null,
): Promise<Map<string, string[]>> {
  const keys = [DeferredPersonMemoryReceiptKeys.binding(ownerUserId, 'registered_person', personId)];
  if (person?.workspaceEntityLink?.state === 'linked') {
    keys.push(
      DeferredPersonMemoryReceiptKeys.binding(ownerUserId, 'registered_entity', person.workspaceEntityLink.entityRef),
    );
  }
  return new Map(await Promise.all(keys.map(async (key) => [key, await redis.smembers(key)] as const)));
}

async function loadSnapshots(
  redis: RedisClient,
  ownerUserId: string,
  candidates: Map<string, PersonMemoryCandidateSnapshot>,
  bindingReceiptIds: ReadonlySet<string>,
): Promise<Map<string, DeferredReceiptSnapshot>> {
  const receiptIds = new Set([
    ...[...candidates.values()].flatMap(({ candidate }) => candidate.deferredReceiptId ?? []),
    ...bindingReceiptIds,
  ]);
  const snapshots = new Map<string, DeferredReceiptSnapshot>();
  for (const receiptId of receiptIds) {
    const raw = await redis.get(DeferredPersonMemoryReceiptKeys.receipt(ownerUserId, receiptId));
    if (!raw) continue;
    const receipt = deferredPersonMemoryReceiptSchema.parse(JSON.parse(raw));
    if (receipt.ownerUserId !== ownerUserId || receipt.receiptId !== receiptId) {
      throw new Error('F276 hard-forget deferred receipt closure is malformed');
    }
    snapshots.set(receiptId, { receipt, raw });
  }
  return snapshots;
}

export function loadDeferredReceiptSnapshotsForCandidates(
  redis: RedisClient,
  ownerUserId: string,
  candidates: Map<string, PersonMemoryCandidateSnapshot>,
): Promise<Map<string, DeferredReceiptSnapshot>> {
  return loadSnapshots(redis, ownerUserId, candidates, new Set());
}

function validateMemberships(
  ownerUserId: string,
  memberships: Map<string, string[]>,
  snapshots: Map<string, DeferredReceiptSnapshot>,
): void {
  for (const [expectedBindingKey, receiptIds] of memberships) {
    for (const receiptId of receiptIds) {
      const snapshot = snapshots.get(receiptId);
      if (!snapshot || bindingKey(ownerUserId, snapshot.receipt) !== expectedBindingKey) {
        throw new Error('F276 hard-forget deferred binding closure is malformed');
      }
    }
  }
}

export async function loadDeferredReceiptForgetClosure(
  redis: RedisClient,
  ownerUserId: string,
  personId: string,
  person: PersonIdentity | null,
  candidates: Map<string, PersonMemoryCandidateSnapshot>,
): Promise<DeferredReceiptForgetClosure> {
  const memberships = await loadMemberships(redis, ownerUserId, personId, person);
  const snapshots = await loadSnapshots(redis, ownerUserId, candidates, new Set([...memberships.values()].flat()));
  validateMemberships(ownerUserId, memberships, snapshots);
  return { memberships, snapshots };
}

export function planDeferredReceiptForgetClosure(
  plan: PersonMemoryRedisPlan,
  ownerUserId: string,
  closure: DeferredReceiptForgetClosure,
): void {
  for (const [expectedBindingKey, receiptIds] of closure.memberships) {
    plan.expectSetMembers(expectedBindingKey, receiptIds);
  }
  planDeferredReceiptSnapshots(plan, ownerUserId, closure.snapshots);
  for (const expectedBindingKey of closure.memberships.keys()) plan.del(expectedBindingKey, 'set');
}

export function planDeferredReceiptSnapshots(
  plan: PersonMemoryRedisPlan,
  ownerUserId: string,
  snapshots: Map<string, DeferredReceiptSnapshot>,
): void {
  for (const [receiptId, { receipt, raw }] of snapshots) {
    const receiptKey = DeferredPersonMemoryReceiptKeys.receipt(ownerUserId, receiptId);
    const ownerKey = DeferredPersonMemoryReceiptKeys.owner(receiptId);
    const dedupeKey = DeferredPersonMemoryReceiptKeys.dedupe(ownerUserId, receipt.dedupeHash);
    plan.expect(receiptKey, raw);
    plan.expect(ownerKey, ownerUserId);
    plan.expect(
      dedupeKey,
      receipt.proposalId
        ? personMemoryProposalLineageMarker(receipt.proposalId)
        : deferredReceiptLineageMarker(receiptId),
    );
    plan.zrem(DeferredPersonMemoryReceiptKeys.ready(ownerUserId), receiptId);
    plan.del(receiptKey, 'string');
    plan.del(ownerKey, 'string');
    plan.del(dedupeKey, 'string');
    const receiptBindingKey = bindingKey(ownerUserId, receipt);
    if (receiptBindingKey) plan.srem(receiptBindingKey, receiptId);
    if (receipt.proposalId) {
      const proposalKey = DeferredPersonMemoryReceiptKeys.proposal(ownerUserId, receipt.proposalId);
      plan.expect(proposalKey, receiptId);
      plan.del(proposalKey, 'string');
    }
  }
}
