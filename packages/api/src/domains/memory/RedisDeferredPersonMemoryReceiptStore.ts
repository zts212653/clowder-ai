import {
  type CatId,
  type DeferredPersonMemoryReceipt,
  deferredPersonMemoryReceiptIdSchema,
  deferredPersonMemoryReceiptSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  ClaimDeferredPersonMemoryReceiptResult,
  DeferredPersonMemoryReceiptStore,
  RearmDeferredPersonMemoryReceiptResult,
  StageDeferredPersonMemoryReceiptInput,
  StageDeferredPersonMemoryReceiptResult,
} from './DeferredPersonMemoryReceiptStore.js';
import {
  DeferredPersonMemoryReceiptTerminalStore,
  type DisposeDeferredPersonMemoryClaimInput,
  type ExpireDeferredPersonMemoryClaimInput,
} from './DeferredPersonMemoryReceiptTerminalStore.js';
import {
  DEFERRED_RECEIPT_BIND_PROCESSING_MESSAGE_LUA,
  DEFERRED_RECEIPT_BIND_PROCESSOR_INVOCATION_LUA,
  DEFERRED_RECEIPT_CLAIM_LUA,
  DEFERRED_RECEIPT_CONFIRM_LUA,
  DEFERRED_RECEIPT_REARM_LUA,
  DEFERRED_RECEIPT_RELEASE_LUA,
  DEFERRED_RECEIPT_STAGE_LUA,
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

export class RedisDeferredPersonMemoryReceiptStore implements DeferredPersonMemoryReceiptStore {
  readonly keys = DeferredPersonMemoryReceiptKeys;
  private readonly terminalStore: DeferredPersonMemoryReceiptTerminalStore;

  constructor(private readonly redis: RedisClient) {
    this.terminalStore = new DeferredPersonMemoryReceiptTerminalStore(redis, (ownerUserId, receiptId) =>
      this.get(ownerUserId, receiptId),
    );
  }

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
      if (!duplicate) return { outcome: 'conflict' };
      if (duplicate.state === 'awaiting_confirmation' && input.ready) {
        const confirmationBindingCompatible =
          sameDeferredWriteOpportunityBinding(duplicate, receipt) ||
          (duplicate.writeOpportunityLineage !== undefined && receipt.writeOpportunityLineage === undefined);
        if (!confirmationBindingCompatible) return { outcome: 'conflict' };
        const confirmed = deferredPersonMemoryReceiptSchema.parse({
          ...receipt,
          receiptId: duplicate.receiptId,
          createdAt: duplicate.createdAt,
          updatedAt: input.createdAt,
          ...(duplicate.writeOpportunityLineage ? { writeOpportunityLineage: duplicate.writeOpportunityLineage } : {}),
          ...(duplicate.writeOpportunityReceipt ? { writeOpportunityReceipt: duplicate.writeOpportunityReceipt } : {}),
        });
        const promoted = Number(
          await this.redis.eval(
            DEFERRED_RECEIPT_CONFIRM_LUA,
            2,
            this.keys.receipt(input.ownerUserId, duplicate.receiptId),
            this.keys.ready(input.ownerUserId),
            JSON.stringify(confirmed),
            duplicate.receiptId,
            input.dedupeHash,
            String(input.createdAt),
          ),
        );
        return promoted === 1 ? { outcome: 'confirmed', receipt: confirmed } : { outcome: 'conflict' };
      }
      if (!sameDeferredWriteOpportunityBinding(duplicate, receipt)) return { outcome: 'conflict' };
      return { outcome: 'deduped', receipt: duplicate };
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
    processorCatId: CatId;
    processingThreadId: string;
  }): Promise<ClaimDeferredPersonMemoryReceiptResult> {
    if (!input.processorCatId || !input.processingThreadId) return { outcome: 'not_available' };
    const current = await this.get(input.ownerUserId, input.receiptId);
    if (!current) return { outcome: 'not_available' };
    const {
      processingMessageId: _processingMessageId,
      processorInvocationId: _processorInvocationId,
      ...claimBase
    } = current;
    const claimed = deferredPersonMemoryReceiptSchema.parse({
      ...claimBase,
      state: 'claimed',
      claimId: input.claimId,
      claimUntil: input.now + input.leaseMs,
      processorCatId: input.processorCatId,
      processingThreadId: input.processingThreadId,
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

  async bindProcessingMessage(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    processorCatId: CatId;
    processingThreadId: string;
    processingMessageId: string;
    now: number;
  }) {
    const current = await this.get(input.ownerUserId, input.receiptId);
    if (!current) return { outcome: 'not_available' as const };
    const bound = deferredPersonMemoryReceiptSchema.parse({
      ...current,
      processingMessageId: input.processingMessageId,
      updatedAt: input.now,
    });
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_BIND_PROCESSING_MESSAGE_LUA,
        1,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        JSON.stringify(bound),
        input.claimId,
        input.processorCatId,
        input.processingThreadId,
        input.processingMessageId,
        String(input.now),
      ),
    );
    if (result === 'BOUND') return { outcome: 'bound' as const, receipt: bound };
    if (result === 'REPLAYED') return { outcome: 'replayed' as const, receipt: current };
    return { outcome: result === 'NOT_AVAILABLE' ? ('not_available' as const) : ('conflict' as const) };
  }

  async bindProcessorInvocation(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    processorCatId: CatId;
    processingThreadId: string;
    processingMessageId: string;
    processorInvocationId: string;
    now: number;
  }) {
    const current = await this.get(input.ownerUserId, input.receiptId);
    if (!current) return { outcome: 'not_available' as const };
    if (current.processingMessageId !== input.processingMessageId) return { outcome: 'conflict' as const };
    const bound = deferredPersonMemoryReceiptSchema.parse({
      ...current,
      processorInvocationId: input.processorInvocationId,
      updatedAt: input.now,
    });
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_BIND_PROCESSOR_INVOCATION_LUA,
        1,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        JSON.stringify(bound),
        input.claimId,
        input.processorCatId,
        input.processingThreadId,
        input.processingMessageId,
        input.processorInvocationId,
        String(input.now),
      ),
    );
    if (result === 'BOUND') return { outcome: 'bound' as const, receipt: bound };
    if (result === 'REPLAYED') return { outcome: 'replayed' as const, receipt: current };
    return { outcome: result === 'NOT_AVAILABLE' ? ('not_available' as const) : ('conflict' as const) };
  }

  async release(ownerUserId: string, receiptId: string, claimId: string, now: number): Promise<boolean> {
    const current = await this.get(ownerUserId, receiptId);
    if (!current || current.state !== 'claimed') return false;
    const {
      claimId: _claimId,
      claimUntil: _claimUntil,
      processorCatId: _processorCatId,
      processingThreadId: _processingThreadId,
      processingMessageId: _processingMessageId,
      processorInvocationId: _processorInvocationId,
      ...base
    } = current;
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
    processorCatId: CatId;
    processingThreadId: string;
    processorInvocationId: string;
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
      current.processorCatId !== input.processorCatId ||
      current.processingThreadId !== input.processingThreadId ||
      current.processorInvocationId !== input.processorInvocationId ||
      current.dedupeHash !== input.dedupeHash ||
      current.writeOpportunityLineage?.dedupeLineage !== input.writeOpportunityLineage.dedupeLineage ||
      current.writeOpportunityLineage.generation + 1 !== input.writeOpportunityLineage.generation
    ) {
      return { outcome: 'conflict' };
    }
    const {
      claimId: _claimId,
      claimUntil: _claimUntil,
      processorCatId: _processorCatId,
      processingThreadId: _processingThreadId,
      processingMessageId: _processingMessageId,
      processorInvocationId: _processorInvocationId,
      ...base
    } = current;
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
        input.processorInvocationId,
      ),
    );
    return result === 1 ? { outcome: 'rearmed', receipt: rearmed } : { outcome: 'conflict' };
  }

  async disposeClaim(input: DisposeDeferredPersonMemoryClaimInput) {
    return this.terminalStore.disposeClaim(input);
  }

  async expireClaim(input: ExpireDeferredPersonMemoryClaimInput) {
    return this.terminalStore.expireClaim(input);
  }

  async withdraw(ownerUserId: string, receiptId: string, decidedAt: number) {
    return this.terminalStore.withdraw(ownerUserId, receiptId, decidedAt);
  }

  async hardForget(ownerUserId: string, receiptId: string) {
    return this.terminalStore.hardForget(ownerUserId, receiptId);
  }
}
