import { createHash } from 'node:crypto';
import {
  deferredPersonMemoryClerkDispositionInputSchema,
  deferredPersonMemoryReceiptIdSchema,
  type WriteOpportunityLineageV1,
  writeOpportunityGenerationId,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DeferredPersonMemoryReceiptStore } from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import { deferredPersonMemoryOwnerRevision } from '../domains/memory/deferred-person-memory-owner-read.js';
import { AsrPersonMemoryContractTrial } from '../domains/memory/people/AsrPersonMemoryContractTrial.js';
import { resolveWriteOpportunityDispositionBinding } from '../domains/memory/people/WriteOpportunityDispositionBinding.js';
import { WriteOpportunityTerminalConflictError } from '../domains/memory/people/WriteOpportunityTerminalLedger.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { type DeferredCaptureDeps, handleDeferredPersonMemoryCapture } from './person-memory-deferred-capture.js';
import { executeOwnerDeferredAction } from './person-memory-owner-deferred-action.js';
import { recordWriteOpportunityRouteError } from './write-opportunity-route-telemetry.js';

export interface CallbackDeferPersonMemoryDeps extends DeferredCaptureDeps {
  receiptStore: DeferredCaptureDeps['receiptStore'] & Pick<DeferredPersonMemoryReceiptStore, 'prepareOwnerForget'>;
}

const receiptActionSchema = z.object({ receiptId: deferredPersonMemoryReceiptIdSchema }).strict();

function isNextWriteOpportunityGeneration(
  lineage: WriteOpportunityLineageV1,
  record: { reflexId: string; reflexVersion: number; opportunityId: string; dedupeLineage: string; generation: number },
): boolean {
  return (
    lineage.reflexId === record.reflexId &&
    lineage.reflexVersion === record.reflexVersion &&
    lineage.dedupeLineage === record.dedupeLineage &&
    lineage.generation + 1 === record.generation &&
    record.opportunityId === writeOpportunityGenerationId(lineage.dedupeLineage, record.generation)
  );
}

async function disposeDeferredReceiptClaim(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CallbackDeferPersonMemoryDeps,
) {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return;
  const parsed = deferredPersonMemoryClerkDispositionInputSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
  }
  if (!(await deps.registry.isLatest(auth.invocationId))) return { status: 'stale_ignored' };

  const now = Date.now();
  const processingMessageId = auth.originTriggerMessageId ?? auth.a2aTriggerMessageId;
  if (!processingMessageId) return reply.code(409).send({ error: 'deferred_receipt_conflict' });
  const grant = await deps.receiptStore.bindProcessorInvocation({
    ownerUserId: auth.userId,
    receiptId: parsed.data.receiptId,
    claimId: parsed.data.claimId,
    processorCatId: auth.catId,
    processingThreadId: auth.threadId,
    processingMessageId,
    processorInvocationId: auth.invocationId,
    now,
  });
  if (grant.outcome !== 'bound' && grant.outcome !== 'replayed') {
    return reply.code(409).send({ error: 'deferred_receipt_conflict' });
  }
  const receipt = grant.receipt;

  const lineage = receipt.writeOpportunityLineage;
  if ((lineage !== undefined) !== (parsed.data.writeOpportunityRef !== undefined)) {
    return reply.code(409).send({ error: 'write_opportunity_ref_mismatch' });
  }
  if (lineage) {
    const binding = await resolveWriteOpportunityDispositionBinding({
      store: deps.writeOpportunityDeliveryStore,
      terminalLedger: deps.writeOpportunityTerminalLedger,
      ref: parsed.data.writeOpportunityRef,
      ownerUserId: auth.userId,
      invocationId: auth.invocationId,
      now,
    });
    if (binding.status !== 'resolved') {
      return reply.code(409).send({
        error: 'write_opportunity_ref_rejected',
        reason: binding.status === 'rejected' ? binding.reason : 'write_opportunity_ref_required',
      });
    }
    if (!isNextWriteOpportunityGeneration(lineage, binding.record)) {
      return reply.code(409).send({ error: 'write_opportunity_ref_mismatch' });
    }
    if (!deps.writeOpportunityTerminalLedger) {
      return reply.code(503).send({ error: 'write_opportunity_terminal_authority_unavailable' });
    }
    const disposition = new AsrPersonMemoryContractTrial().recordDeliveredDisposition(binding.record, {
      v: 1,
      opportunityId: binding.record.opportunityId,
      generation: binding.record.generation,
      recordedAt: now,
      disposition: 'abstain',
      reasonCode: 'insufficient_owner_evidence',
    });
    if (disposition.status === 'rejected') {
      return reply.code(409).send({ error: 'write_opportunity_disposition_rejected', reason: disposition.reason });
    }
    try {
      await deps.writeOpportunityTerminalLedger.recordTerminal({
        ownerUserId: auth.userId,
        dedupeLineage: binding.record.dedupeLineage,
        generation: binding.record.generation,
        outcome: 'abstain',
        recordedAt: now,
      });
    } catch (error) {
      request.log.warn({ err: error }, 'deferred receipt write-opportunity disposition rejected');
      if (error instanceof WriteOpportunityTerminalConflictError) {
        recordWriteOpportunityRouteError('already_disposed');
        return reply.code(409).send({ error: 'write_opportunity_generation_conflict' });
      }
      recordWriteOpportunityRouteError('terminal_ledger_unavailable');
      return reply.code(503).send({ error: 'write_opportunity_terminal_authority_unavailable' });
    }
  }

  const result = await deps.receiptStore.disposeClaim({
    ownerUserId: auth.userId,
    receiptId: parsed.data.receiptId,
    claimId: parsed.data.claimId,
    processorCatId: auth.catId,
    processingThreadId: auth.threadId,
    processorInvocationId: auth.invocationId,
    disposition: parsed.data.disposition,
    now,
  });
  if (result.outcome === 'not_available') return reply.code(404).send({ error: 'not_available' });
  if (result.outcome === 'conflict') return reply.code(409).send({ error: 'deferred_receipt_conflict' });
  return { receiptId: result.receipt.receiptId, status: result.outcome };
}

async function mutateDeferredReceipt(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CallbackDeferPersonMemoryDeps,
  action: 'withdraw' | 'forget',
) {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return;
  const parsed = receiptActionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
  const { receiptId } = parsed.data;
  try {
    const current = await deps.receiptStore.get(auth.userId, receiptId);
    const requestId = `deferred_callback_${createHash('sha256').update(`${auth.userId}\0${auth.invocationId}\0${action}\0${receiptId}`).digest('hex')}`;
    // Legacy callbacks have no client revision. Bind their internal command to the current
    // canonical snapshot; a retry of the same invocation resumes its original stored plan.
    const expectedRevision =
      current?.ownerForget?.requestId === requestId
        ? current.ownerForget.expectedRevision
        : current
          ? deferredPersonMemoryOwnerRevision(current)
          : `sha256:${'0'.repeat(64)}`;
    const result = await executeOwnerDeferredAction(
      {
        ownerUserId: auth.userId,
        deferredReceiptStore: deps.receiptStore,
        ...(deps.writeOpportunityDeliveryStore
          ? { writeOpportunityDeliveryStore: deps.writeOpportunityDeliveryStore }
          : {}),
        ...(deps.writeOpportunityTerminalLedger
          ? { writeOpportunityTerminalLedger: deps.writeOpportunityTerminalLedger }
          : {}),
      },
      request,
      receiptId,
      { action, requestId, expectedRevision, confirmed: true },
    );
    if (result.status !== 200) {
      if (action === 'withdraw' && result.body.error === 'proposal_bound') {
        return reply.code(409).send({ error: 'receipt_not_withdrawable' });
      }
      return reply.code(result.status).send(result.body);
    }
    if (action === 'withdraw') return { receiptId, status: 'withdrawn', replayed: result.body.outcome === 'replayed' };
    return { receiptId, status: result.body.outcome === 'replayed' ? 'already_absent' : 'purged' };
  } catch (error) {
    request.log.warn({ err: error }, '[F276] Callback deferred terminal result unknown');
    return reply.code(503).send({ error: 'write_opportunity_invalidation_unavailable' });
  }
}

export function registerCallbackDeferPersonMemoryRoutes(
  app: FastifyInstance,
  deps: CallbackDeferPersonMemoryDeps,
): void {
  app.post('/api/callbacks/defer-person-memory', (request, reply) =>
    handleDeferredPersonMemoryCapture(request, reply, deps),
  );
  app.post('/api/callbacks/person-memory/deferred/withdraw', (request, reply) =>
    mutateDeferredReceipt(request, reply, deps, 'withdraw'),
  );
  app.post('/api/callbacks/person-memory/deferred/forget', (request, reply) =>
    mutateDeferredReceipt(request, reply, deps, 'forget'),
  );
  app.post('/api/callbacks/person-memory/deferred/dispose', (request, reply) =>
    disposeDeferredReceiptClaim(request, reply, deps),
  );
}
