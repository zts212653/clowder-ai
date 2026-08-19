import {
  type DeferredPersonMemoryReceipt,
  deferredPersonMemoryReceiptIdSchema,
  deferredPersonMemoryReceiptSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  ClaimDeferredPersonMemoryReceiptResult,
  DeferredPersonMemoryReceiptStore,
  HardForgetDeferredPersonMemoryReceiptResult,
  RearmDeferredPersonMemoryReceiptResult,
  StageDeferredPersonMemoryReceiptInput,
  StageDeferredPersonMemoryReceiptResult,
  WithdrawDeferredPersonMemoryReceiptResult,
} from './DeferredPersonMemoryReceiptStore.js';
import {
  DEFERRED_RECEIPT_CLAIM_LUA,
  DEFERRED_RECEIPT_FORGET_LUA,
  DEFERRED_RECEIPT_REARM_LUA,
  DEFERRED_RECEIPT_RELEASE_LUA,
  DEFERRED_RECEIPT_STAGE_LUA,
  DEFERRED_RECEIPT_WITHDRAW_LUA,
  DeferredPersonMemoryReceiptKeys,
} from './deferred-person-memory-redis-contract.js';
import { sameDeferredWriteOpportunityBinding } from './deferred-write-opportunity-binding.js';
import {
  deferredReceiptLineageMarker,
  parsePersonMemoryDeltaLineageMarker,
} from './people/person-memory-delta-lineage.js';

export { DeferredPersonMemoryReceiptKeys } from './deferred-person-memory-redis-contract.js';

function bindingKey(ownerUserId: string, binding: NonNullable<DeferredPersonMemoryReceipt['registryBinding']>): string {
  return DeferredPersonMemoryReceiptKeys.binding(ownerUserId, binding.kind, binding.ref);
}

function parseReceipt(raw: string | null): DeferredPersonMemoryReceipt | null {
  if (!raw) return null;
  const parsed = deferredPersonMemoryReceiptSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

function actionableReceipt(input: StageDeferredPersonMemoryReceiptInput): DeferredPersonMemoryReceipt {
  return deferredPersonMemoryReceiptSchema.parse({
    receiptId: input.receiptId,
    ownerUserId: input.ownerUserId,
    requesterCatId: input.requesterCatId,
    invocationId: input.invocationId,
    originMessageRef: input.originMessageRef,
    subject: input.subject,
    normalizedSubject: input.normalizedSubject,
    registryBinding: input.registryBinding,
    sourceCoordinates: input.sourceCoordinates,
    sourceBundleDigest: input.sourceBundleDigest,
    dedupeHash: input.dedupeHash,
    ...(input.writeOpportunityLineage ? { writeOpportunityLineage: input.writeOpportunityLineage } : {}),
    ...(input.writeOpportunityReceipt ? { writeOpportunityReceipt: input.writeOpportunityReceipt } : {}),
    state: input.ready ? 'deferred' : 'awaiting_confirmation',
    retention: 'owner_controlled_no_ttl',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function terminalReceipt(
  receipt: DeferredPersonMemoryReceipt,
  state: 'proposed' | 'withdrawn',
  updatedAt: number,
  proposalId?: string,
): DeferredPersonMemoryReceipt {
  return deferredPersonMemoryReceiptSchema.parse({
    receiptId: receipt.receiptId,
    ownerUserId: receipt.ownerUserId,
    requesterCatId: receipt.requesterCatId,
    dedupeHash: receipt.dedupeHash,
    // Survivor field, deliberately carried across the terminal payload purge: retaining the lineage
    // after the receipt reaches proposed/withdrawn is exactly what proves a deferred opportunity
    // landed on the same F276 destination (SR:126-127, SR:174-176). It is IDs only.
    ...(receipt.writeOpportunityLineage ? { writeOpportunityLineage: receipt.writeOpportunityLineage } : {}),
    state,
    ...(proposalId ? { proposalId } : {}),
    retention: receipt.retention,
    createdAt: receipt.createdAt,
    updatedAt,
  });
}

export class RedisDeferredPersonMemoryReceiptStore implements DeferredPersonMemoryReceiptStore {
  readonly keys = DeferredPersonMemoryReceiptKeys;

  constructor(private readonly redis: RedisClient) {}

  async stage(input: StageDeferredPersonMemoryReceiptInput): Promise<StageDeferredPersonMemoryReceiptResult> {
    deferredPersonMemoryReceiptIdSchema.parse(input.receiptId);
    const receipt = actionableReceipt(input);
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_STAGE_LUA,
        5,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        this.keys.owner(input.receiptId),
        this.keys.dedupe(input.ownerUserId, input.dedupeHash),
        this.keys.ready(input.ownerUserId),
        bindingKey(input.ownerUserId, input.registryBinding),
        JSON.stringify(receipt),
        input.ownerUserId,
        deferredReceiptLineageMarker(input.receiptId),
        String(input.createdAt),
        input.ready ? '1' : '0',
        input.receiptId,
      ),
    );
    if (result === 'CREATED') return { outcome: 'created', receipt };
    if (result === 'EXISTS') {
      const existing = await this.get(input.ownerUserId, input.receiptId);
      if (
        existing?.dedupeHash === input.dedupeHash &&
        existing.invocationId === input.invocationId &&
        sameDeferredWriteOpportunityBinding(existing, receipt)
      ) {
        return { outcome: 'replayed', receipt: existing };
      }
      return { outcome: 'conflict' };
    }
    if (result.startsWith('DEDUPED:')) {
      const rawMarker = result.slice('DEDUPED:'.length);
      const marker = parsePersonMemoryDeltaLineageMarker(rawMarker);
      if (marker?.kind === 'proposal') return { outcome: 'already_proposed', proposalId: marker.id };
      const duplicateId = marker?.kind === 'receipt' ? marker.id : rawMarker;
      const duplicate = await this.get(input.ownerUserId, duplicateId);
      return duplicate && sameDeferredWriteOpportunityBinding(duplicate, receipt)
        ? { outcome: 'deduped', receipt: duplicate }
        : { outcome: 'conflict' };
    }
    return { outcome: 'conflict' };
  }

  async get(ownerUserId: string, receiptId: string): Promise<DeferredPersonMemoryReceipt | null> {
    return parseReceipt(await this.redis.get(this.keys.receipt(ownerUserId, receiptId)));
  }

  async listReady(ownerUserId: string, limit: number, now = Date.now()): Promise<DeferredPersonMemoryReceipt[]> {
    const bounded = Math.max(0, Math.min(50, limit));
    if (bounded === 0) return [];
    const ids = await this.redis.zrange(this.keys.ready(ownerUserId), 0, Math.max(0, bounded * 3 - 1));
    const receipts = await Promise.all(
      ids.map(async (receiptId) => {
        const owner = await this.redis.get(this.keys.owner(receiptId));
        return owner === ownerUserId ? this.get(ownerUserId, receiptId) : null;
      }),
    );
    return receipts
      .filter(
        (receipt): receipt is DeferredPersonMemoryReceipt =>
          receipt?.state === 'deferred' ||
          (receipt?.state === 'claimed' && (receipt.claimUntil ?? Number.POSITIVE_INFINITY) <= now),
      )
      .slice(0, bounded);
  }

  async claim(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    now: number;
    leaseMs: number;
  }): Promise<ClaimDeferredPersonMemoryReceiptResult> {
    const current = await this.get(input.ownerUserId, input.receiptId);
    if (!current) return { outcome: 'not_available' };
    const claimed = deferredPersonMemoryReceiptSchema.parse({
      ...current,
      state: 'claimed',
      claimId: input.claimId,
      claimUntil: input.now + input.leaseMs,
      updatedAt: input.now,
    });
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_CLAIM_LUA,
        1,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        JSON.stringify(claimed),
        input.claimId,
        String(input.now),
      ),
    );
    if (result === 'CLAIMED') return { outcome: 'claimed', receipt: claimed };
    return { outcome: result === 'CLAIMED_ELSEWHERE' ? 'claimed_elsewhere' : 'not_available' };
  }

  async release(ownerUserId: string, receiptId: string, claimId: string, now: number): Promise<boolean> {
    const current = await this.get(ownerUserId, receiptId);
    if (!current || current.state !== 'claimed') return false;
    const { claimId: _claimId, claimUntil: _claimUntil, ...base } = current;
    const released = deferredPersonMemoryReceiptSchema.parse({ ...base, state: 'deferred', updatedAt: now });
    return (
      Number(
        await this.redis.eval(
          DEFERRED_RECEIPT_RELEASE_LUA,
          1,
          this.keys.receipt(ownerUserId, receiptId),
          JSON.stringify(released),
          claimId,
        ),
      ) === 1
    );
  }

  async rearmWriteOpportunity(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    requesterCatId: string;
    dedupeHash: string;
    writeOpportunityLineage: NonNullable<DeferredPersonMemoryReceipt['writeOpportunityLineage']>;
    writeOpportunityReceipt: NonNullable<DeferredPersonMemoryReceipt['writeOpportunityReceipt']>;
    now: number;
  }): Promise<RearmDeferredPersonMemoryReceiptResult> {
    const current = await this.get(input.ownerUserId, input.receiptId);
    if (!current) return { outcome: 'not_available' };
    if (
      current.state !== 'claimed' ||
      current.claimId !== input.claimId ||
      current.claimUntil === undefined ||
      current.claimUntil <= input.now ||
      current.requesterCatId !== input.requesterCatId ||
      current.dedupeHash !== input.dedupeHash ||
      current.writeOpportunityLineage?.dedupeLineage !== input.writeOpportunityLineage.dedupeLineage ||
      current.writeOpportunityLineage.generation + 1 !== input.writeOpportunityLineage.generation
    ) {
      return { outcome: 'conflict' };
    }
    const { claimId: _claimId, claimUntil: _claimUntil, ...base } = current;
    const rearmed = deferredPersonMemoryReceiptSchema.parse({
      ...base,
      state: 'deferred',
      writeOpportunityLineage: input.writeOpportunityLineage,
      writeOpportunityReceipt: input.writeOpportunityReceipt,
      updatedAt: input.now,
    });
    const result = Number(
      await this.redis.eval(
        DEFERRED_RECEIPT_REARM_LUA,
        1,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        JSON.stringify(rearmed),
        input.claimId,
        input.now,
      ),
    );
    return result === 1 ? { outcome: 'rearmed', receipt: rearmed } : { outcome: 'conflict' };
  }

  async withdraw(
    ownerUserId: string,
    receiptId: string,
    decidedAt: number,
  ): Promise<WithdrawDeferredPersonMemoryReceiptResult> {
    const current = await this.get(ownerUserId, receiptId);
    if (!current) return { outcome: 'not_available' };
    const withdrawn = terminalReceipt(current, 'withdrawn', decidedAt);
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_WITHDRAW_LUA,
        4,
        this.keys.receipt(ownerUserId, receiptId),
        this.keys.ready(ownerUserId),
        this.keys.dedupe(ownerUserId, current.dedupeHash),
        current.registryBinding
          ? bindingKey(ownerUserId, current.registryBinding)
          : this.keys.receipt(ownerUserId, receiptId),
        JSON.stringify(withdrawn),
        receiptId,
        current.registryBinding ? '1' : '0',
        deferredReceiptLineageMarker(receiptId),
      ),
    );
    if (result === 'WITHDRAWN') return { outcome: 'withdrawn', receipt: withdrawn };
    if (result === 'REPLAYED') return { outcome: 'replayed', receipt: current };
    return { outcome: result === 'CONFLICT' ? 'conflict' : 'not_available' };
  }

  async hardForget(ownerUserId: string, receiptId: string): Promise<HardForgetDeferredPersonMemoryReceiptResult> {
    const current = await this.get(ownerUserId, receiptId);
    if (!current) return { outcome: 'already_absent' };
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_FORGET_LUA,
        6,
        this.keys.receipt(ownerUserId, receiptId),
        this.keys.owner(receiptId),
        this.keys.ready(ownerUserId),
        this.keys.dedupe(ownerUserId, current.dedupeHash),
        current.proposalId
          ? this.keys.proposal(ownerUserId, current.proposalId)
          : this.keys.receipt(ownerUserId, receiptId),
        current.registryBinding
          ? bindingKey(ownerUserId, current.registryBinding)
          : this.keys.receipt(ownerUserId, receiptId),
        receiptId,
        current.registryBinding ? '1' : '0',
        current.proposalId ? '1' : '0',
        deferredReceiptLineageMarker(receiptId),
      ),
    );
    if (result.startsWith('PROPOSAL_BOUND:')) {
      return { outcome: 'proposal_bound', proposalId: result.slice('PROPOSAL_BOUND:'.length) };
    }
    if (result === 'CONFLICT') throw new Error('F276 deferred receipt purge preflight conflict');
    return { outcome: Number(result) === 1 ? 'purged' : 'already_absent' };
  }
}
