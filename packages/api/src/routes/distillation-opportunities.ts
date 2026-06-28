/**
 * F208 Phase E AC-E2: Distillation Opportunity Routes
 *
 * Query, dismiss, and convert distillation opportunities that were
 * auto-created by the DistillationCheckpoint service on feat-phase-close
 * and review-complete events.
 *
 * Scope enforcement (gpt52 R2 P1):
 *   - Owner/operator: sees all, can act on any opportunity
 *   - Cat (via X-Cat-Cafe-User): only sees/acts on opportunities targeting them
 *
 * Endpoints:
 *   GET  /api/dossier/distillation-opportunities        — list pending
 *   POST /api/dossier/distillation-opportunities/:id/dismiss   — dismiss
 *   POST /api/dossier/distillation-opportunities/:id/convert   — mark converted
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { IOpportunityStore } from '../infrastructure/distillation/DistillationCheckpoint.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

export interface DistillationOpportunityRoutesOptions {
  opportunityStore: IOpportunityStore;
}

/**
 * Check if userId is the configured owner (operator).
 * Uses requireConfiguredOwner so single-user mode (no DEFAULT_OWNER_USER_ID)
 * does NOT collapse scope — cats still only see their own opportunities.
 */
function isOwnerOrCvo(userId: string): boolean {
  return resolveOwnerGate(userId, { requireConfiguredOwner: true }) === null;
}

export const distillationOpportunityRoutes: FastifyPluginAsync<DistillationOpportunityRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const store = opts.opportunityStore;

  // ─── GET /api/dossier/distillation-opportunities ── list pending ───
  app.get('/api/dossier/distillation-opportunities', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Authentication required' };
    }

    const opportunities = await store.listPending();

    // Scope: owner/operator sees all; cats only see their own
    if (isOwnerOrCvo(userId)) {
      return { opportunities };
    }
    return { opportunities: opportunities.filter((o) => o.targetCatId === userId) };
  });

  // ─── POST /api/dossier/distillation-opportunities/:id/dismiss ──────
  app.post('/api/dossier/distillation-opportunities/:id/dismiss', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { id } = request.params as { id: string };

    // Scope: must be target cat or owner
    const opportunity = (await store.listPending()).find((o) => o.opportunityId === id);
    if (!opportunity) {
      reply.status(404);
      return { error: 'Opportunity not found or already processed' };
    }
    if (!isOwnerOrCvo(userId) && opportunity.targetCatId !== userId) {
      reply.status(403);
      return { error: 'Only the target cat or owner can dismiss this opportunity' };
    }

    const dismissed = await store.dismiss(id);
    if (!dismissed) {
      reply.status(404);
      return { error: 'Opportunity not found or already processed' };
    }
    return { success: true };
  });

  // ─── POST /api/dossier/distillation-opportunities/:id/convert ──────
  app.post('/api/dossier/distillation-opportunities/:id/convert', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { id } = request.params as { id: string };
    const body = request.body as { proposalId?: string } | null;
    if (!body?.proposalId || typeof body.proposalId !== 'string') {
      reply.status(400);
      return { error: 'proposalId is required' };
    }

    // Scope: must be target cat or owner
    const opportunity = (await store.listPending()).find((o) => o.opportunityId === id);
    if (!opportunity) {
      reply.status(404);
      return { error: 'Opportunity not found or already processed' };
    }
    if (!isOwnerOrCvo(userId) && opportunity.targetCatId !== userId) {
      reply.status(403);
      return { error: 'Only the target cat or owner can convert this opportunity' };
    }

    const converted = await store.markConverted(id, body.proposalId);
    if (!converted) {
      reply.status(404);
      return { error: 'Opportunity not found or already processed' };
    }
    return { success: true };
  });
};
