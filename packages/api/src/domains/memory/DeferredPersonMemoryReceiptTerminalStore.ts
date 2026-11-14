import { type DeferredPersonMemoryReceipt, deferredPersonMemoryReceiptSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  DisposeDeferredPersonMemoryReceiptResult,
  HardForgetDeferredPersonMemoryReceiptResult,
  PrepareOwnerDeferredForgetInput,
  PrepareOwnerDeferredForgetResult,
  WithdrawDeferredPersonMemoryReceiptResult,
} from './DeferredPersonMemoryReceiptStore.js';
import { deferredPersonMemoryOwnerRevision } from './deferred-person-memory-owner-read.js';
import {
  DEFERRED_RECEIPT_DISPOSE_CLAIM_LUA,
  DEFERRED_RECEIPT_EXPIRE_CLAIM_LUA,
  DEFERRED_RECEIPT_FORGET_LUA,
  DEFERRED_RECEIPT_OWNER_FORGET_PREPARE_LUA,
  DEFERRED_RECEIPT_WITHDRAW_LUA,
  DeferredPersonMemoryReceiptKeys,
} from './deferred-person-memory-redis-contract.js';
import { deferredReceiptLineageMarker } from './people/person-memory-delta-lineage.js';

export interface DisposeDeferredPersonMemoryClaimInput {
  ownerUserId: string;
  receiptId: string;
  claimId: string;
  processorCatId: string;
  processingThreadId: string;
  processorInvocationId: string;
  disposition: 'awaiting_confirmation' | 'insufficient_evidence';
  now: number;
}

export interface ExpireDeferredPersonMemoryClaimInput {
  ownerUserId: string;
  receiptId: string;
  claimId: string;
  now: number;
}

function bindingKey(ownerUserId: string, binding: NonNullable<DeferredPersonMemoryReceipt['registryBinding']>): string {
  return DeferredPersonMemoryReceiptKeys.binding(ownerUserId, binding.kind, binding.ref);
}

function terminalReceipt(
  receipt: DeferredPersonMemoryReceipt,
  state: 'withdrawn' | 'not_actionable',
  updatedAt: number,
  resolution?: 'insufficient_evidence' | 'unresolved_after_clerk_attempt',
): DeferredPersonMemoryReceipt {
  return deferredPersonMemoryReceiptSchema.parse({
    receiptId: receipt.receiptId,
    ownerUserId: receipt.ownerUserId,
    requesterCatId: receipt.requesterCatId,
    dedupeHash: receipt.dedupeHash,
    ...(receipt.writeOpportunityLineage ? { writeOpportunityLineage: receipt.writeOpportunityLineage } : {}),
    state,
    ...(resolution ? { resolution } : {}),
    retention: receipt.retention,
    createdAt: receipt.createdAt,
    updatedAt,
  });
}

export class DeferredPersonMemoryReceiptTerminalStore {
  private readonly keys = DeferredPersonMemoryReceiptKeys;

  constructor(
    private readonly redis: RedisClient,
    private readonly getReceipt: (
      ownerUserId: string,
      receiptId: string,
    ) => Promise<DeferredPersonMemoryReceipt | null>,
  ) {}

  async disposeClaim(input: DisposeDeferredPersonMemoryClaimInput): Promise<DisposeDeferredPersonMemoryReceiptResult> {
    const current = await this.getReceipt(input.ownerUserId, input.receiptId);
    if (!current) return { outcome: 'not_available' };
    if (current.state !== 'claimed') return { outcome: 'conflict' };
    const terminal = input.disposition === 'insufficient_evidence';
    const next = terminal
      ? terminalReceipt(current, 'not_actionable', input.now, 'insufficient_evidence')
      : deferredPersonMemoryReceiptSchema.parse({
          ...current,
          state: 'awaiting_confirmation',
          claimId: undefined,
          claimUntil: undefined,
          processorCatId: undefined,
          processingThreadId: undefined,
          processingMessageId: undefined,
          processorInvocationId: undefined,
          updatedAt: input.now,
        });
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_DISPOSE_CLAIM_LUA,
        4,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        this.keys.ready(input.ownerUserId),
        this.keys.dedupe(input.ownerUserId, current.dedupeHash),
        current.registryBinding
          ? bindingKey(input.ownerUserId, current.registryBinding)
          : this.keys.receipt(input.ownerUserId, input.receiptId),
        JSON.stringify(next),
        input.receiptId,
        current.registryBinding ? '1' : '0',
        deferredReceiptLineageMarker(input.receiptId),
        input.claimId,
        input.processorCatId,
        input.processingThreadId,
        input.processorInvocationId,
        String(input.now),
        terminal ? '1' : '0',
      ),
    );
    if (result !== 'DISPOSED') return { outcome: result === 'NOT_AVAILABLE' ? 'not_available' : 'conflict' };
    return { outcome: terminal ? 'not_actionable' : 'awaiting_confirmation', receipt: next };
  }

  async expireClaim(input: ExpireDeferredPersonMemoryClaimInput): Promise<DisposeDeferredPersonMemoryReceiptResult> {
    const current = await this.getReceipt(input.ownerUserId, input.receiptId);
    if (!current) return { outcome: 'not_available' };
    if (current.state !== 'claimed') return { outcome: 'conflict' };
    const expired = terminalReceipt(current, 'not_actionable', input.now, 'unresolved_after_clerk_attempt');
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_EXPIRE_CLAIM_LUA,
        4,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        this.keys.ready(input.ownerUserId),
        this.keys.dedupe(input.ownerUserId, current.dedupeHash),
        current.registryBinding
          ? bindingKey(input.ownerUserId, current.registryBinding)
          : this.keys.receipt(input.ownerUserId, input.receiptId),
        JSON.stringify(expired),
        input.receiptId,
        current.registryBinding ? '1' : '0',
        deferredReceiptLineageMarker(input.receiptId),
        input.claimId,
        String(input.now),
      ),
    );
    if (result !== 'DISPOSED') return { outcome: result === 'NOT_AVAILABLE' ? 'not_available' : 'conflict' };
    return { outcome: 'not_actionable', receipt: expired };
  }

  async withdraw(
    ownerUserId: string,
    receiptId: string,
    decidedAt: number,
    expectedRevision?: string,
  ): Promise<WithdrawDeferredPersonMemoryReceiptResult> {
    const raw = await this.redis.get(this.keys.receipt(ownerUserId, receiptId));
    const current = raw ? deferredPersonMemoryReceiptSchema.parse(JSON.parse(raw)) : null;
    if (!current) return { outcome: 'not_available' };
    if (current.ownerUserId !== ownerUserId) return { outcome: 'not_available' };
    if (current.ownerForget) return { outcome: 'conflict' };
    if (current.state === 'withdrawn') return { outcome: 'replayed', receipt: current };
    if (expectedRevision && deferredPersonMemoryOwnerRevision(current) !== expectedRevision)
      return { outcome: 'stale_revision' };
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
        expectedRevision ? (raw ?? '') : '',
      ),
    );
    if (result === 'WITHDRAWN') return { outcome: 'withdrawn', receipt: withdrawn };
    if (result === 'REPLAYED') return { outcome: 'replayed', receipt: current };
    if (result === 'STALE_REVISION') return { outcome: 'stale_revision' };
    return { outcome: result === 'CONFLICT' ? 'conflict' : 'not_available' };
  }

  async hardForget(
    ownerUserId: string,
    receiptId: string,
    expectedRevision?: string,
    ownerForgetRequestId?: string,
  ): Promise<HardForgetDeferredPersonMemoryReceiptResult> {
    const raw = await this.redis.get(this.keys.receipt(ownerUserId, receiptId));
    const current = raw ? deferredPersonMemoryReceiptSchema.parse(JSON.parse(raw)) : null;
    if (!current) return { outcome: 'already_absent' };
    if (current.ownerUserId !== ownerUserId) return { outcome: 'already_absent' };
    if (current.state === 'proposed' && current.proposalId)
      return { outcome: 'proposal_bound', proposalId: current.proposalId };
    if (expectedRevision && deferredPersonMemoryOwnerRevision(current) !== expectedRevision)
      return { outcome: 'stale_revision' };
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
        expectedRevision ? (raw ?? '') : '',
        ownerForgetRequestId ?? '',
      ),
    );
    if (result.startsWith('PROPOSAL_BOUND:')) {
      return { outcome: 'proposal_bound', proposalId: result.slice('PROPOSAL_BOUND:'.length) };
    }
    if (result === 'CONFLICT') throw new Error('F276 deferred receipt purge preflight conflict');
    if (result === 'STALE_REVISION') return { outcome: 'stale_revision' };
    return { outcome: Number(result) === 1 ? 'purged' : 'already_absent' };
  }

  async prepareOwnerForget(input: PrepareOwnerDeferredForgetInput): Promise<PrepareOwnerDeferredForgetResult> {
    const raw = await this.redis.get(this.keys.receipt(input.ownerUserId, input.receiptId));
    const current = raw ? deferredPersonMemoryReceiptSchema.parse(JSON.parse(raw)) : null;
    if (!current || current.ownerUserId !== input.ownerUserId) return { outcome: 'already_absent' };
    if (current.state === 'proposed' && current.proposalId) {
      return { outcome: 'proposal_bound', proposalId: current.proposalId };
    }
    if (current.writeOpportunityLineage && !input.lineageInvalidationAvailable) {
      return { outcome: 'invalidation_unavailable' };
    }
    const pending = current.ownerForget;
    if (pending?.requestId === input.requestId) {
      if (pending.expectedRevision !== input.expectedRevision) return { outcome: 'idempotency_conflict' };
    } else if (deferredPersonMemoryOwnerRevision(current) !== input.expectedRevision) {
      // A fresh confirmation of this exact pending marker may finish its existing plan;
      // a different request carrying the old pre-reservation revision cannot join it.
      return { outcome: 'stale_revision' };
    }
    const prepared = pending
      ? current
      : deferredPersonMemoryReceiptSchema.parse({
          ...terminalReceipt(current, 'withdrawn', input.requestedAt),
          ownerForget: { requestId: input.requestId, expectedRevision: input.expectedRevision },
        });
    const operation = prepared.ownerForget;
    if (!operation) throw new Error('owner forget recovery plan is missing');
    const result = String(
      await this.redis.eval(
        DEFERRED_RECEIPT_OWNER_FORGET_PREPARE_LUA,
        5,
        this.keys.receipt(input.ownerUserId, input.receiptId),
        this.keys.owner(input.receiptId),
        this.keys.ready(input.ownerUserId),
        this.keys.dedupe(input.ownerUserId, current.dedupeHash),
        current.registryBinding
          ? bindingKey(input.ownerUserId, current.registryBinding)
          : this.keys.receipt(input.ownerUserId, input.receiptId),
        raw ?? '',
        JSON.stringify(prepared),
        input.receiptId,
        current.registryBinding ? '1' : '0',
        deferredReceiptLineageMarker(input.receiptId),
        operation.requestId,
        operation.expectedRevision,
        input.ownerUserId,
      ),
    );
    if (result.startsWith('PROPOSAL_BOUND:'))
      return { outcome: 'proposal_bound', proposalId: result.slice('PROPOSAL_BOUND:'.length) };
    if (result === 'ALREADY_ABSENT') return { outcome: 'already_absent' };
    if (result === 'STALE_REVISION') return { outcome: 'stale_revision' };
    if (result === 'CONFLICT') return { outcome: 'conflict' };
    for (const [prefix, outcome] of [
      ['PREPARED:', 'prepared'],
      ['REPLAYED:', 'replayed'],
    ] as const) {
      if (result.startsWith(prefix))
        return { outcome, receipt: deferredPersonMemoryReceiptSchema.parse(JSON.parse(result.slice(prefix.length))) };
    }
    throw new Error(`unexpected owner forget preparation result: ${result}`);
  }
}
