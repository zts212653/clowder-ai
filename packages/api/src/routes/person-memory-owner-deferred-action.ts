import type { DeferredPersonMemoryReceipt } from '@cat-cafe/shared';
import type { FastifyRequest } from 'fastify';
import type {
  DeferredPersonMemoryReceiptStore,
  PrepareOwnerDeferredForgetResult,
  WithdrawDeferredPersonMemoryReceiptResult,
} from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import { deferredPersonMemoryOwnerRevision } from '../domains/memory/deferred-person-memory-owner-read.js';
import type { PersonMemoryStore } from '../domains/memory/people/PersonMemoryStore.js';
import {
  type DeferWriteOpportunityDeps,
  invalidateDeferredWriteOpportunity,
} from './person-memory-defer-write-opportunity.js';

export interface PersonMemoryOwnerDeferredDeps extends DeferWriteOpportunityDeps {
  ownerUserId: string;
  store: PersonMemoryStore | null;
  deferredReceiptStore?: DeferredPersonMemoryReceiptStore;
}
export interface OwnerDeferredCommand {
  action: 'withdraw' | 'forget';
  requestId: string;
  expectedRevision: string;
  confirmed: true;
}
interface ActionReply {
  status: number;
  body: Record<string, string | undefined>;
}
export interface OwnerDeferredActionDeps extends DeferWriteOpportunityDeps {
  ownerUserId: string;
  deferredReceiptStore: Pick<
    DeferredPersonMemoryReceiptStore,
    'get' | 'withdraw' | 'prepareOwnerForget' | 'hardForget'
  >;
}

function lineageAuthorityAvailable(deps: DeferWriteOpportunityDeps): boolean {
  return !!deps.writeOpportunityTerminalLedger && !!deps.writeOpportunityDeliveryStore;
}

function assertLineageAuthority(deps: DeferWriteOpportunityDeps, receipt: DeferredPersonMemoryReceipt): void {
  if (receipt.writeOpportunityLineage && !lineageAuthorityAvailable(deps)) {
    throw new Error('write opportunity durable invalidation authority unavailable');
  }
}

function preparationFailure(
  result: Exclude<PrepareOwnerDeferredForgetResult, { receipt: DeferredPersonMemoryReceipt }>,
): ActionReply {
  switch (result.outcome) {
    case 'already_absent':
      return { status: 200, body: { action: 'forget', outcome: 'replayed' } };
    case 'proposal_bound':
      return { status: 409, body: { error: 'proposal_bound', proposalId: result.proposalId } };
    case 'stale_revision':
      return { status: 409, body: { error: 'stale_revision' } };
    case 'idempotency_conflict':
      return { status: 409, body: { error: 'idempotency_conflict' } };
    case 'conflict':
      return { status: 409, body: { error: 'conflict' } };
    case 'invalidation_unavailable':
      return { status: 503, body: { error: 'write_opportunity_invalidation_unavailable' } };
  }
}

async function forgetOwnerReceipt(
  deps: OwnerDeferredActionDeps,
  request: FastifyRequest,
  receiptId: string,
  command: OwnerDeferredCommand,
): Promise<ActionReply> {
  const prepared = await deps.deferredReceiptStore.prepareOwnerForget({
    ownerUserId: deps.ownerUserId,
    receiptId,
    requestId: command.requestId,
    expectedRevision: command.expectedRevision,
    requestedAt: Date.now(),
    lineageInvalidationAvailable: lineageAuthorityAvailable(deps),
  });
  if (!('receipt' in prepared)) return preparationFailure(prepared);
  const operation = prepared.receipt.ownerForget;
  if (!operation) throw new Error('owner forget recovery plan is missing');
  // From this point the exact-target erasure is committed, with recovery in the canonical
  // receipt. Any failure is an unknown result (503), never a side-effect-free rejection.
  await invalidateDeferredWriteOpportunity(deps, request, deps.ownerUserId, prepared.receipt, 'source_forgotten');
  const result = await deps.deferredReceiptStore.hardForget(
    deps.ownerUserId,
    receiptId,
    deferredPersonMemoryOwnerRevision(prepared.receipt),
    operation.requestId,
  );
  if (result.outcome !== 'purged' && result.outcome !== 'already_absent') {
    throw new Error('owner forget finalization remains unresolved');
  }
  return { status: 200, body: { action: 'forget', outcome: result.outcome === 'purged' ? 'applied' : 'replayed' } };
}

function withdrawalFailure(
  result: Exclude<WithdrawDeferredPersonMemoryReceiptResult, { receipt: DeferredPersonMemoryReceipt }>,
): ActionReply {
  switch (result.outcome) {
    case 'stale_revision':
      return { status: 409, body: { error: 'stale_revision' } };
    case 'conflict':
      return { status: 409, body: { error: 'receipt_not_withdrawable' } };
    case 'not_available':
      return { status: 404, body: { error: 'not_available' } };
  }
}

async function withdrawOwnerReceipt(
  deps: OwnerDeferredActionDeps,
  request: FastifyRequest,
  receiptId: string,
  command: OwnerDeferredCommand,
): Promise<ActionReply> {
  const current = await deps.deferredReceiptStore.get(deps.ownerUserId, receiptId);
  if (!current || current.ownerUserId !== deps.ownerUserId) return { status: 404, body: { error: 'not_available' } };
  if (current.state === 'proposed')
    return { status: 409, body: { error: 'proposal_bound', proposalId: current.proposalId } };
  if (current.ownerForget || current.state === 'not_actionable')
    return { status: 409, body: { error: 'receipt_not_withdrawable' } };
  assertLineageAuthority(deps, current);
  const result = await deps.deferredReceiptStore.withdraw(
    deps.ownerUserId,
    receiptId,
    Date.now(),
    command.expectedRevision,
  );
  if (!('receipt' in result)) return withdrawalFailure(result);
  // The successful terminal receipt retains lineage across failure/restart, so invalidation
  // can be retried after refresh using the original request and revision.
  assertLineageAuthority(deps, result.receipt);
  await invalidateDeferredWriteOpportunity(deps, request, deps.ownerUserId, result.receipt, 'superseded');
  return {
    status: 200,
    body: { action: 'withdraw', outcome: result.outcome === 'withdrawn' ? 'applied' : 'replayed' },
  };
}

/** Each caller validates its own owner authority; browser and callback authentication stay separate. */
export function executeOwnerDeferredAction(
  deps: OwnerDeferredActionDeps,
  request: FastifyRequest,
  receiptId: string,
  command: OwnerDeferredCommand,
): Promise<ActionReply> {
  return command.action === 'forget'
    ? forgetOwnerReceipt(deps, request, receiptId, command)
    : withdrawOwnerReceipt(deps, request, receiptId, command);
}
