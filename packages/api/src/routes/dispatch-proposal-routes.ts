/**
 * F246 Phase B: Dispatch Proposal approve/reject endpoints.
 *
 * POST /api/dispatch-proposals/:proposalId/approve
 * POST /api/dispatch-proposals/:proposalId/reject
 *
 * operator-only: ownerUserId must match the authenticated user.
 * CAS guard: only pending → terminal transitions succeed (409 on re-attempt).
 *
 * On approve: delivers the cross-post message and records deliveredMessageId.
 * On reject: discards the proposal (no message delivery).
 */

import type { DispatchProposal } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { IDispatchProposalStore } from '../domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { resolveUserId } from '../utils/request-identity.js';

/**
 * deliverMessage: posts the held message to the target thread, returns messageId.
 * notifyUpdate: emits proposal_updated socket event to the owner.
 * Both are wired in index.ts where messageStore + socketManager are available.
 */
export interface DispatchProposalRoutesOptions {
  store: IDispatchProposalStore;
  deliverMessage: (proposal: DispatchProposal) => Promise<string>;
  notifyUpdate: (proposal: DispatchProposal) => void;
}

export const dispatchProposalRoutes: FastifyPluginAsync<DispatchProposalRoutesOptions> = async (app, opts) => {
  const { store } = opts;

  // POST /api/dispatch-proposals/:proposalId/approve
  app.post<{ Params: { proposalId: string } }>(
    '/api/dispatch-proposals/:proposalId/approve',
    async (request, reply) => {
      const userId = resolveUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }

      const { proposalId } = request.params;
      const proposal = await store.get(proposalId);
      if (!proposal) {
        reply.status(404);
        return { error: 'Proposal not found' };
      }

      if (proposal.ownerUserId !== userId) {
        reply.status(403);
        return { error: 'Not authorized — only the proposal owner can approve' };
      }

      // CAS first — claim the transition before any side effects (R2 P1-2 fix).
      // If reject wins the race, we return 409 without ever delivering.
      const updated = await store.approve(proposalId, userId);
      if (!updated) {
        reply.status(409);
        return { error: 'Proposal is no longer pending (already decided)' };
      }

      // CAS succeeded — safe to deliver (reject cannot interfere, state is terminal).
      // Wrap in try-catch: if delivery fails, revert to pending so user can retry
      // (Cloud P1-2 fix: prevents stuck proposals on transient delivery failures).
      let deliveredMessageId: string;
      try {
        deliveredMessageId = await opts.deliverMessage(updated);
      } catch (deliveryErr) {
        // Rollback: approved → pending so the user can retry approval
        await store.revertToPending(proposalId);
        request.log.error({ err: deliveryErr, proposalId }, 'Delivery failed after CAS approve — reverted to pending');
        reply.status(502);
        return { error: 'Delivery failed — proposal reverted to pending, please retry' };
      }

      // Record the real messageId (best-effort, already in terminal approved state).
      await store.recordDelivery(proposalId, deliveredMessageId);

      const finalProposal = { ...updated, deliveredMessageId };
      opts.notifyUpdate(finalProposal);
      return { proposal: finalProposal };
    },
  );

  // POST /api/dispatch-proposals/:proposalId/reject
  app.post<{ Params: { proposalId: string } }>('/api/dispatch-proposals/:proposalId/reject', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { proposalId } = request.params;
    const proposal = await store.get(proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }

    if (proposal.ownerUserId !== userId) {
      reply.status(403);
      return { error: 'Not authorized — only the proposal owner can reject' };
    }

    const updated = await store.reject(proposalId, userId);
    if (!updated) {
      reply.status(409);
      return { error: 'Proposal is no longer pending (already decided)' };
    }

    opts.notifyUpdate(updated);
    return { proposal: updated };
  });
};
