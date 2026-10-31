import {
  deferredPersonMemoryClerkDispositionInputSchema,
  deferredPersonMemoryReceiptIdSchema,
  type WriteOpportunityLineageV1,
  writeOpportunityGenerationId,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AsrPersonMemoryContractTrial } from '../domains/memory/people/AsrPersonMemoryContractTrial.js';
import { resolveWriteOpportunityDispositionBinding } from '../domains/memory/people/WriteOpportunityDispositionBinding.js';
import { WriteOpportunityTerminalConflictError } from '../domains/memory/people/WriteOpportunityTerminalLedger.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { invalidateDeferredWriteOpportunity } from './person-memory-defer-write-opportunity.js';
import { type DeferredCaptureDeps, handleDeferredPersonMemoryCapture } from './person-memory-deferred-capture.js';
import { recordWriteOpportunityRouteError } from './write-opportunity-route-telemetry.js';

export interface CallbackDeferPersonMemoryDeps extends DeferredCaptureDeps {}

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

async function withdrawDeferredReceipt(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CallbackDeferPersonMemoryDeps,
) {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return;
  const parsed = receiptActionSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400);
    return { error: 'invalid_request', details: parsed.error.issues };
  }
  const current = await deps.receiptStore.get(auth.userId, parsed.data.receiptId);
  if (current?.writeOpportunityLineage) {
    try {
      await invalidateDeferredWriteOpportunity(deps, request, auth.userId, current, 'superseded');
    } catch {
      return reply.code(503).send({ error: 'write_opportunity_invalidation_unavailable' });
    }
  }
  const result = await deps.receiptStore.withdraw(auth.userId, parsed.data.receiptId, Date.now());
  switch (result.outcome) {
    case 'conflict':
      return reply.status(409).send({ error: 'receipt_not_withdrawable' });
    case 'not_available':
      return reply.status(404).send({ error: 'not_available' });
    case 'withdrawn':
    case 'replayed':
      return {
        receiptId: result.receipt.receiptId,
        status: 'withdrawn',
        replayed: result.outcome === 'replayed',
      };
  }
}

async function forgetDeferredReceipt(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CallbackDeferPersonMemoryDeps,
) {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return;
  const parsed = receiptActionSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400);
    return { error: 'invalid_request', details: parsed.error.issues };
  }
  // Always inspect the receipt before deleting it: a lineage-bearing receipt must fail closed
  // when either durable invalidation authority is unavailable.
  const beforeForget = await deps.receiptStore.get(auth.userId, parsed.data.receiptId);
  if (beforeForget?.writeOpportunityLineage) {
    try {
      await invalidateDeferredWriteOpportunity(deps, request, auth.userId, beforeForget, 'source_forgotten');
    } catch {
      return reply.code(503).send({ error: 'write_opportunity_invalidation_unavailable' });
    }
  }
  const result = await deps.receiptStore.hardForget(auth.userId, parsed.data.receiptId);
  if (result.outcome === 'proposal_bound') {
    reply.status(409);
    return { error: 'proposal_bound', proposalId: result.proposalId };
  }
  return { receiptId: parsed.data.receiptId, status: result.outcome };
}

export function registerCallbackDeferPersonMemoryRoutes(
  app: FastifyInstance,
  deps: CallbackDeferPersonMemoryDeps,
): void {
  app.post('/api/callbacks/defer-person-memory', (request, reply) =>
    handleDeferredPersonMemoryCapture(request, reply, deps),
  );
  app.post('/api/callbacks/person-memory/deferred/withdraw', (request, reply) =>
    withdrawDeferredReceipt(request, reply, deps),
  );
  app.post('/api/callbacks/person-memory/deferred/forget', (request, reply) =>
    forgetDeferredReceipt(request, reply, deps),
  );
  app.post('/api/callbacks/person-memory/deferred/dispose', (request, reply) =>
    disposeDeferredReceiptClaim(request, reply, deps),
  );
}
