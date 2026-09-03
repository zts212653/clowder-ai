/**
 * API route for external review recovery — settles stale external review
 * lease generations when GitHub HEAD has advanced.
 *
 * POST /api/callbacks/recover-external-review-verdict
 *
 * F167: stale-external-review-recovery
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExternalReviewRecoveryService } from '../domains/ball-custody/ExternalReviewRecoveryService.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';

const externalReviewRecoverySchema = z
  .object({
    actionLeaseRef: z.object({ leaseId: z.string().min(1), generation: z.number().int().positive() }).strict(),
    githubReviewUrl: z.string().url(),
  })
  .strict();

export interface CallbackExternalReviewRecoveryRouteDeps {
  externalReviewRecoveryService?: ExternalReviewRecoveryService;
  threadStore?: Pick<IThreadStore, 'get'>;
}

export function registerCallbackExternalReviewRecoveryRoutes(
  app: FastifyInstance,
  deps: CallbackExternalReviewRecoveryRouteDeps,
): void {
  app.post('/api/callbacks/recover-external-review-verdict', async (request, reply) => {
    if (!deps.externalReviewRecoveryService) {
      reply.status(503);
      return { error: 'External review recovery service not configured' };
    }
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = externalReviewRecoverySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const deletedThreadGuard = await getDeletedCallbackThreadGuard(deps.threadStore, record.threadId);
    if (deletedThreadGuard) {
      reply.status(deletedThreadGuard.statusCode);
      return deletedThreadGuard.body;
    }

    const result = await deps.externalReviewRecoveryService.recover({
      leaseId: parsed.data.actionLeaseRef.leaseId,
      generation: parsed.data.actionLeaseRef.generation,
      githubReviewUrl: parsed.data.githubReviewUrl,
      now: Date.now(),
      principal: { catId: record.catId, threadId: record.threadId, tenantScope: record.userId },
    });
    if (result.outcome !== 'committed') {
      reply.status(result.outcome === 'insufficient' ? 422 : 409);
    }
    return result;
  });
}
