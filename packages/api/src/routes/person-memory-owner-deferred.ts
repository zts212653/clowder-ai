import { deferredPersonMemoryReceiptIdSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectDeferredPersonMemoryReceipt } from '../domains/memory/deferred-person-memory-owner-read.js';
import { authorizeOwnerBrowserAction } from './owner-memory-browser-auth.js';
import {
  executeOwnerDeferredAction,
  type PersonMemoryOwnerDeferredDeps,
} from './person-memory-owner-deferred-action.js';

export type { PersonMemoryOwnerDeferredDeps } from './person-memory-owner-deferred-action.js';

const querySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
const paramsSchema = z.object({ receiptId: deferredPersonMemoryReceiptIdSchema }).strict();
const actionSchema = z
  .object({
    action: z.enum(['withdraw', 'forget']),
    requestId: z
      .string()
      .min(32)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    expectedRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();

/** Mounted under the existing owner-session plugin, never the cat callback router. */
export function registerPersonMemoryOwnerDeferredRoutes(
  app: FastifyInstance,
  deps: PersonMemoryOwnerDeferredDeps,
): void {
  app.get('/api/memory/people/deferred', async (request, reply) => {
    if (!deps.deferredReceiptStore) return reply.code(503).send({ error: 'deferred_memory_unavailable' });
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const page = await deps.deferredReceiptStore.listOwnerPage(deps.ownerUserId, query.data);
      const entries = await Promise.all(
        page.entries.map(async (receipt) => {
          const entry = projectDeferredPersonMemoryReceipt(receipt);
          if (!receipt.proposalId || !deps.store) return entry;
          const proposal = await deps.store.getCandidateForOwner(deps.ownerUserId, receipt.proposalId);
          if (
            !proposal ||
            proposal.state === 'staged' ||
            proposal.publication.state === 'staged' ||
            proposal.publication.state === 'tombstoned'
          )
            return entry;
          return {
            ...entry,
            proposalSection:
              proposal.state === 'pending_approval' || proposal.state === 'partially_materialized'
                ? ('pending' as const)
                : ('history' as const),
          };
        }),
      );
      return { entries, nextCursor: page.nextCursor };
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Owner deferred memory read unavailable');
      return reply.code(503).send({ error: 'deferred_memory_unavailable' });
    }
  });

  app.post('/api/memory/people/deferred/:receiptId/actions', async (request, reply) => {
    if (!authorizeOwnerBrowserAction(request)) return reply.code(403).send({ error: 'invalid_action' });
    if (!deps.deferredReceiptStore) return reply.code(503).send({ error: 'deferred_memory_unavailable' });
    const params = paramsSchema.safeParse(request.params);
    const body = actionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const result = await executeOwnerDeferredAction(
        { ...deps, deferredReceiptStore: deps.deferredReceiptStore },
        request,
        params.data.receiptId,
        body.data,
      );
      return reply.code(result.status).send(result.body);
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Owner deferred memory result unknown');
      return reply.code(503).send({ error: 'deferred_memory_unavailable' });
    }
  });
}
