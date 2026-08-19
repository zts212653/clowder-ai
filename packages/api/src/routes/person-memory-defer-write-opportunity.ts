import { createHash } from 'node:crypto';
import type {
  DeferredWriteOpportunityReceiptV1,
  WriteOpportunityLineageV1,
  WriteOpportunityRefV1,
} from '@cat-cafe/shared';
import type { FastifyRequest } from 'fastify';
import { AsrPersonMemoryContractTrial } from '../domains/memory/people/AsrPersonMemoryContractTrial.js';
import type { WriteOpportunityDeliveryStore } from '../domains/memory/people/WriteOpportunityDeliveryStore.js';
import { resolveWriteOpportunityDispositionBinding } from '../domains/memory/people/WriteOpportunityDispositionBinding.js';
import type { WriteOpportunityTerminalLedger } from '../domains/memory/people/WriteOpportunityTerminalLedger.js';

export interface DeferWriteOpportunityDeps {
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
}

export function deferredPersonMemoryReceiptId(
  ownerUserId: string,
  requesterCatId: string,
  clientRequestId: string,
): string {
  const digest = createHash('sha256')
    .update(`${ownerUserId}\0${requesterCatId}\0${clientRequestId}`)
    .digest('hex')
    .slice(0, 32);
  return `deferred_person_${digest}`;
}

/** Validate a cat-supplied ref and mint the content-free Standing Reflex defer receipt. */
export async function resolveDeferredWriteOpportunity(
  deps: DeferWriteOpportunityDeps,
  ref: WriteOpportunityRefV1 | undefined,
  auth: { userId: string; invocationId: string },
  now: number,
  destinationReceiptId: string,
): Promise<
  | { status: 'absent' }
  | {
      status: 'resolved';
      lineage: WriteOpportunityLineageV1;
      receipt: DeferredWriteOpportunityReceiptV1;
    }
  | { status: 'rejected'; reason: string }
> {
  const binding = await resolveWriteOpportunityDispositionBinding({
    store: deps.writeOpportunityDeliveryStore,
    terminalLedger: deps.writeOpportunityTerminalLedger,
    ref,
    ownerUserId: auth.userId,
    invocationId: auth.invocationId,
    now,
  });
  if (binding.status !== 'resolved') return binding;
  const disposition = new AsrPersonMemoryContractTrial().recordDeliveredDisposition(binding.record, {
    v: 1,
    opportunityId: binding.record.opportunityId,
    generation: binding.record.generation,
    recordedAt: now,
    disposition: 'defer',
    destination: {
      receiptContract: 'StandingReflex.DeferredWriteOpportunityReceipt.v1',
      receiptId: destinationReceiptId,
    },
  });
  if (disposition.status === 'rejected' || !disposition.receipt) {
    return {
      status: 'rejected',
      reason: disposition.status === 'rejected' ? disposition.reason : 'invalid_disposition',
    };
  }
  return {
    status: 'resolved',
    lineage: {
      reflexId: binding.record.reflexId,
      reflexVersion: binding.record.reflexVersion,
      opportunityId: binding.record.opportunityId,
      dedupeLineage: binding.record.dedupeLineage,
      generation: binding.record.generation,
    },
    receipt: disposition.receipt,
  };
}

/** Invalidate both admission truth and late-callback evidence after an owner terminal action. */
export async function invalidateDeferredWriteOpportunity(
  deps: DeferWriteOpportunityDeps,
  request: FastifyRequest,
  ownerUserId: string,
  receipt: { writeOpportunityLineage?: WriteOpportunityLineageV1 },
  reason: 'source_corrected' | 'source_forgotten' | 'scope_revoked' | 'superseded',
): Promise<void> {
  const lineage = receipt.writeOpportunityLineage;
  if (!lineage) return;
  try {
    await deps.writeOpportunityTerminalLedger?.recordInvalidated({
      ownerUserId,
      dedupeLineage: lineage.dedupeLineage,
      reason,
      recordedAt: Date.now(),
    });
    await deps.writeOpportunityDeliveryStore?.purgeLineage(ownerUserId, lineage.dedupeLineage);
  } catch (error) {
    request.log.warn(
      { err: error, dedupeLineage: lineage.dedupeLineage, reason },
      'write opportunity lineage invalidation failed; lineage may remain presentable',
    );
  }
}
