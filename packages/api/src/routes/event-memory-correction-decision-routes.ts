import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApprovalPublicationNotAnchoredError,
  requireAnchoredPublication,
} from '../domains/approval-hub/requireAnchoredPublication.js';
import type { EventMemoryCorrectionProposalStore } from '../domains/memory/event/EventMemoryCorrectionProposalStore.js';
import type { EventMemoryLifecycleService } from '../domains/memory/event/EventMemoryLifecycleService.js';
import { toEventMemoryCorrectionProposalView } from '../domains/memory/event/event-memory-correction-proposal-view.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { authorizeOwnerBrowserAction, ownerMemoryActionHttpStatus } from './owner-memory-browser-auth.js';

const paramsSchema = z.object({ proposalId: z.string().trim().min(1).max(200) });
const rejectBodySchema = z.object({ rejectionReason: z.string().trim().min(1).max(500).optional() }).strict();

export interface EventMemoryCorrectionDecisionDeps {
  store: EventMemoryCorrectionProposalStore;
  lifecycle: Pick<EventMemoryLifecycleService, 'applyApprovedCorrection'>;
  socketManager: Pick<SocketManager, 'emitToUser'>;
}

export function registerEventMemoryCorrectionDecisionRoutes(
  app: FastifyInstance,
  deps: EventMemoryCorrectionDecisionDeps,
): void {
  app.get('/api/event-memory-corrections/:proposalId', async (request, reply) => {
    const resolved = await resolveOwnedProposal(request, reply, deps.store, false);
    if (!resolved) return;
    return { proposal: toEventMemoryCorrectionProposalView(resolved.proposal) };
  });

  app.post('/api/event-memory-corrections/:proposalId/approve', async (request, reply) => {
    const resolved = await resolveOwnedProposal(request, reply, deps.store, true);
    if (!resolved) return;
    const claimed = await prepareApproval(resolved, deps.store, reply);
    if (!claimed) return;
    return applyAndFinalizeCorrection(claimed, resolved.userId, deps, reply);
  });

  app.post('/api/event-memory-corrections/:proposalId/reject', async (request, reply) => {
    const resolved = await resolveOwnedProposal(request, reply, deps.store, true);
    if (!resolved) return;
    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
    if (!(await requireAnchored(deps.store, resolved.proposal.proposalId, reply))) return;
    const rejected = await deps.store.markRejected(
      resolved.proposal.proposalId,
      resolved.userId,
      body.data.rejectionReason ?? 'No reason provided',
    );
    if (!rejected) return reply.status(409).send({ error: 'Proposal is not pending' });
    deps.socketManager.emitToUser(resolved.userId, 'proposal_updated', rejected);
    return { proposalId: rejected.proposalId, status: rejected.status };
  });
}

async function prepareApproval(
  resolved: NonNullable<Awaited<ReturnType<typeof resolveOwnedProposal>>>,
  store: EventMemoryCorrectionProposalStore,
  reply: FastifyReply,
) {
  const { proposal, userId } = resolved;
  if (proposal.status === 'approved') {
    reply.send({ proposalId: proposal.proposalId, status: proposal.status, appliedRevision: proposal.appliedRevision });
    return null;
  }
  if (proposal.status === 'rejected') {
    reply.status(409).send({ error: 'Proposal already rejected', status: proposal.status });
    return null;
  }
  if (!(await requireAnchored(store, proposal.proposalId, reply))) return null;
  const claimed =
    proposal.status === 'pending'
      ? await store.claimForApproval(proposal.proposalId, userId)
      : proposal.approvedBy === userId
        ? proposal
        : null;
  if (!claimed) reply.status(409).send({ error: 'Proposal status changed concurrently' });
  return claimed;
}

async function applyAndFinalizeCorrection(
  claimed: NonNullable<Awaited<ReturnType<typeof prepareApproval>>>,
  userId: string,
  deps: EventMemoryCorrectionDecisionDeps,
  reply: FastifyReply,
) {
  const applied = await deps.lifecycle.applyApprovedCorrection({
    ownerUserId: userId,
    eventId: claimed.eventId,
    expectedRevision: claimed.expectedRevision,
    patch: claimed.suggestedPatch,
    requestId: `event-correction-proposal:${claimed.proposalId}`,
  });
  if ('error' in applied || !applied.revision) {
    await deps.store.rollbackClaim(claimed.proposalId);
    const error = 'error' in applied ? applied.error : 'mutation_unavailable';
    return reply.status(ownerMemoryActionHttpStatus(error)).send({ error });
  }
  const finalized = await deps.store.finalizeApproval(claimed.proposalId, userId, applied.revision);
  if (!finalized) return recoverFinalizedProposal(claimed.proposalId, deps.store, reply);
  deps.socketManager.emitToUser(userId, 'proposal_updated', finalized);
  return {
    proposalId: finalized.proposalId,
    status: finalized.status,
    appliedRevision: finalized.appliedRevision,
    replayed: applied.outcome === 'replayed',
  };
}

async function recoverFinalizedProposal(
  proposalId: string,
  store: EventMemoryCorrectionProposalStore,
  reply: FastifyReply,
) {
  const recovered = await store.get(proposalId);
  if (recovered?.status === 'approved') {
    return {
      proposalId: recovered.proposalId,
      status: recovered.status,
      appliedRevision: recovered.appliedRevision,
      recovered: true,
    };
  }
  return reply.status(409).send({ error: 'Proposal finalization lost its approval fence' });
}

async function resolveOwnedProposal(
  request: FastifyRequest,
  reply: FastifyReply,
  store: EventMemoryCorrectionProposalStore,
  requireBrowserAction: boolean,
) {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    reply.status(400).send({ error: 'Invalid proposal id' });
    return null;
  }
  if (requireBrowserAction && !authorizeOwnerBrowserAction(request)) {
    reply.status(403).send({ error: 'invalid_action' });
    return null;
  }
  const userId = resolveSessionUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'Identity required' });
    return null;
  }
  const proposal = await store.get(params.data.proposalId);
  if (!proposal) {
    reply.status(404).send({ error: 'Proposal not found' });
    return null;
  }
  if (proposal.ownerUserId !== userId) {
    reply.status(403).send({ error: 'Proposal does not belong to the current user' });
    return null;
  }
  return { proposal, userId };
}

async function requireAnchored(
  store: EventMemoryCorrectionProposalStore,
  proposalId: string,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    await requireAnchoredPublication(store, proposalId);
    return true;
  } catch (error) {
    if (!(error instanceof ApprovalPublicationNotAnchoredError)) throw error;
    reply.status(error.statusCode).send({ error: error.message, code: error.code });
    return false;
  }
}
