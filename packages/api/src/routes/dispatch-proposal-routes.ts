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
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { DispatchActionApprovalResult } from '../domains/approval-hub/DispatchActionApprovalService.js';
import {
  type DispatchRolloutState,
  getDefaultDispatchRolloutState,
  isLegacyDispatchProposal,
} from '../domains/approval-hub/dispatch-rollout-state.js';
import {
  ApprovalPublicationNotAnchoredError,
  requireAnchoredPublication,
} from '../domains/approval-hub/requireAnchoredPublication.js';
import type { IDispatchProposalStore } from '../domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import type { DispatchRecoveryResult } from '../domains/ball-custody/ActionSuccessorRecoverySweep.js';
import type { ActionSuccessorLease } from '../domains/ball-custody/action-successor-state-machine.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/owner-auth-provenance.js';
import { resolveStrictUserId, resolveUserId } from '../utils/request-identity.js';

/**
 * deliverMessage: posts the held message to the target thread, returns messageId.
 * notifyUpdate: emits proposal_updated socket event to the owner.
 * Both are wired in index.ts where messageStore + socketManager are available.
 *
 * rolloutState: F246 Phase J rollout gate (defaults to 'shadow').
 * In 'required'/'frozen' mode, legacy proposals cannot be approved (AC-J8).
 */
export interface DispatchProposalRoutesOptions {
  store: IDispatchProposalStore;
  deliverMessage: (proposal: DispatchProposal, ownerAuthProvenance: OwnerAuthProvenance) => Promise<string>;
  notifyUpdate: (proposal: DispatchProposal) => void;
  /** F246 Workstream 2: atomically promote a validated proposal into F167 custody. */
  approveAction?: (
    proposal: DispatchProposal,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance,
  ) => Promise<DispatchActionApprovalResult>;
  /** Deliver/recover the exact approved lease generation through existing F167 recovery. */
  recoverApprovedAction?: (lease: ActionSuccessorLease) => Promise<DispatchRecoveryResult>;
  /** F246 Phase J: rollout state override. Defaults to 'shadow' (legacy allowed). */
  rolloutState?: DispatchRolloutState;
}

interface ActionApprovalHttpResult {
  statusCode: 200 | 202 | 409 | 503;
  body: Record<string, unknown>;
}

async function approveProposedDispatch(
  proposal: DispatchProposal,
  userId: string,
  ownerAuthProvenance: OwnerAuthProvenance,
  opts: DispatchProposalRoutesOptions,
  log: FastifyBaseLogger,
): Promise<ActionApprovalHttpResult> {
  if (!opts.approveAction || !opts.recoverApprovedAction) {
    return {
      statusCode: 503,
      body: {
        error: 'Action approval custody is unavailable; proposal remains pending',
        code: 'ACTION_APPROVAL_UNAVAILABLE',
      },
    };
  }
  let promoted: DispatchActionApprovalResult;
  try {
    promoted = await opts.approveAction(proposal, userId, ownerAuthProvenance);
  } catch (err) {
    log.error({ err, proposalId: proposal.proposalId }, 'Action lease claim failed; proposal remains pending');
    return {
      statusCode: 503,
      body: {
        error: 'Action lease claim failed; proposal remains pending',
        code: 'ACTION_LEASE_CLAIM_FAILED',
      },
    };
  }
  if (!promoted.approved) {
    return {
      statusCode: 409,
      body: {
        error: `Action custody was not admitted: ${promoted.outcome}`,
        code: 'ACTION_CUSTODY_NOT_ADMITTED',
        outcome: promoted.outcome,
      },
    };
  }

  const { value } = promoted;
  opts.notifyUpdate(value.proposal);
  let delivery: DispatchRecoveryResult = { outcome: 'pending' };
  try {
    delivery = await opts.recoverApprovedAction(value.actionLease);
  } catch (err) {
    log.error(
      { err, proposalId: proposal.proposalId, leaseId: value.actionLease.leaseId },
      'Approved action carrier delivery deferred to recovery',
    );
  }
  if (delivery.outcome !== 'delivered') {
    return {
      statusCode: 202,
      body: {
        proposal: value.proposal,
        actionLease: value.actionLease,
        actionFence: value.actionFence,
        approvalOutcome: value.outcome,
        deliveryState: 'pending',
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      proposal: {
        ...value.proposal,
        deliveredMessageId: delivery.deliveredMessageId,
      },
      actionLease: value.actionLease,
      actionFence: value.actionFence,
      approvalOutcome: value.outcome,
      deliveryState: 'delivered',
    },
  };
}

export const dispatchProposalRoutes: FastifyPluginAsync<DispatchProposalRoutesOptions> = async (app, opts) => {
  const { store } = opts;
  const rolloutState = opts.rolloutState ?? getDefaultDispatchRolloutState();

  // POST /api/dispatch-proposals/:proposalId/approve
  app.post<{ Params: { proposalId: string } }>(
    '/api/dispatch-proposals/:proposalId/approve',
    async (request, reply) => {
      const userId = resolveUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }
      const ownerAuthProvenance: OwnerAuthProvenance =
        resolveStrictUserId(request) === userId ? 'strict' : 'compatibility_fallback';

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

      // Phase J pre-CAS guards — specific error messages before hitting the CAS.
      // The CAS itself is still the authoritative guard (these are UX improvements).

      // AC-J4: Superseded proposals get a specific error with successor reference.
      if (proposal.status === 'superseded') {
        reply.status(409);
        return {
          error: `Proposal has been superseded by ${proposal.supersededBy ?? 'a newer proposal'}`,
          code: 'PROPOSAL_SUPERSEDED',
          supersededBy: proposal.supersededBy,
        };
      }

      // AC-J8: Legacy proposals cannot be approved in required/frozen rollout mode.
      // In shadow mode, legacy approval is allowed (backward compat).
      if (rolloutState !== 'shadow' && isLegacyDispatchProposal(proposal)) {
        reply.status(409);
        return {
          error:
            'Legacy proposal cannot be approved — reject and resubmit through the new dispatch ingress (re-attest)',
          code: 'LEGACY_PROPOSAL_NOT_APPROVABLE',
          guidance: 'reject_and_reattest',
        };
      }

      // F246 Phase I (INV-I5): anchored publication guard — staged/tombstoned cannot enter CAS.
      try {
        await requireAnchoredPublication(store, proposalId);
      } catch (err) {
        if (err instanceof ApprovalPublicationNotAnchoredError) {
          reply.status(err.statusCode);
          return { error: err.message, code: err.code };
        }
        throw err;
      }

      if (proposal.proposedAction) {
        const result = await approveProposedDispatch(proposal, userId, ownerAuthProvenance, opts, request.log);
        reply.status(result.statusCode);
        return result.body;
      }

      // CAS first — claim the transition before any side effects (R2 P1-2 fix).
      // If reject wins the race, we return 409 without ever delivering.
      const updated = await store.approve(proposalId, userId, ownerAuthProvenance);
      if (!updated) {
        reply.status(409);
        return { error: 'Proposal is no longer pending (already decided)' };
      }

      // CAS succeeded — safe to deliver (reject cannot interfere, state is terminal).
      // Wrap in try-catch: if delivery fails, revert to pending so user can retry
      // (Cloud P1-2 fix: prevents stuck proposals on transient delivery failures).
      let deliveredMessageId: string;
      try {
        deliveredMessageId = await opts.deliverMessage(updated, ownerAuthProvenance);
      } catch (deliveryErr) {
        // Rollback: approved → pending so the user can retry approval.
        // Phase J (INV-J5): revertToPending returns null if a successor holds the lineage
        // (proposal was superseded instead of reverted — no retry possible).
        const reverted = await store.revertToPending(proposalId);
        if (reverted) {
          request.log.error(
            { err: deliveryErr, proposalId },
            'Delivery failed after CAS approve — reverted to pending',
          );
          reply.status(502);
          return { error: 'Delivery failed — proposal reverted to pending, please retry' };
        }
        // Revert returned null — re-fetch to distinguish superseded vs other state.
        // (Sol R2 #5: null can mean "not approved" OR "superseded", don't assume.)
        const current = await store.get(proposalId);
        if (current?.status === 'superseded') {
          request.log.error(
            { err: deliveryErr, proposalId },
            'Delivery failed after CAS approve — proposal superseded (successor exists), not retryable',
          );
          reply.status(409);
          return {
            error: 'Delivery failed and proposal has been superseded — submit a new dispatch',
            code: 'PROPOSAL_SUPERSEDED',
          };
        }
        // Unexpected state (concurrent revert or state change) — generic error.
        request.log.error(
          { err: deliveryErr, proposalId, currentStatus: current?.status },
          'Delivery failed after CAS approve — revert failed, state changed concurrently',
        );
        reply.status(502);
        return { error: 'Delivery failed — proposal state changed, please check and retry' };
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

    // AC-J4: Superseded proposals get a specific error with successor reference.
    if (proposal.status === 'superseded') {
      reply.status(409);
      return {
        error: `Proposal has been superseded by ${proposal.supersededBy ?? 'a newer proposal'}`,
        code: 'PROPOSAL_SUPERSEDED',
        supersededBy: proposal.supersededBy,
      };
    }

    // Note: NO legacy guard on reject — legacy proposals CAN be rejected (KD-17).
    // The re-attest path is: reject legacy → resubmit through new ingress.

    // F246 Phase I (INV-I5): anchored publication guard.
    try {
      await requireAnchoredPublication(store, proposalId);
    } catch (err) {
      if (err instanceof ApprovalPublicationNotAnchoredError) {
        reply.status(err.statusCode);
        return { error: err.message, code: err.code };
      }
      throw err;
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
