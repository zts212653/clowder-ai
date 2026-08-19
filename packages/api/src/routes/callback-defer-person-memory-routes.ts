import { deferredPersonMemoryReceiptIdSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { invalidateDeferredWriteOpportunity } from './person-memory-defer-write-opportunity.js';
import { type DeferredCaptureDeps, handleDeferredPersonMemoryCapture } from './person-memory-deferred-capture.js';

export interface CallbackDeferPersonMemoryDeps extends DeferredCaptureDeps {}

const receiptActionSchema = z.object({ receiptId: deferredPersonMemoryReceiptIdSchema }).strict();

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
  const result = await deps.receiptStore.withdraw(auth.userId, parsed.data.receiptId, Date.now());
  if (result.outcome === 'withdrawn') {
    await invalidateDeferredWriteOpportunity(deps, request, auth.userId, result.receipt, 'superseded');
  }
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
  // Read lineage before hardForget deletes the receipt. Either store justifies the read: guarding
  // only on the ledger would skip delivery purge when the delivery store exists by itself.
  const beforeForget =
    deps.writeOpportunityTerminalLedger || deps.writeOpportunityDeliveryStore
      ? await deps.receiptStore.get(auth.userId, parsed.data.receiptId)
      : null;
  const result = await deps.receiptStore.hardForget(auth.userId, parsed.data.receiptId);
  if (result.outcome === 'proposal_bound') {
    reply.status(409);
    return { error: 'proposal_bound', proposalId: result.proposalId };
  }
  if (result.outcome === 'purged' && beforeForget) {
    await invalidateDeferredWriteOpportunity(deps, request, auth.userId, beforeForget, 'source_forgotten');
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
}
