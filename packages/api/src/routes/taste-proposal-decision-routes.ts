/**
 * F221 Phase B: taste proposal decision routes (user-auth approve / reject).
 *
 * POST /api/taste-proposals/:id/approve — operator approves: claim → write vignette → finalize
 * POST /api/taste-proposals/:id/reject  — operator rejects: mark rejected with reason
 * GET  /api/taste-proposals/:id         — Read proposal status
 *
 * Approve delegates to the locked checkpoint service (claim → write → checkpoint → finalize).
 * The vignette writer remains injected for testability.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApprovalPublicationNotAnchoredError,
  requireAnchoredPublication,
} from '../domains/approval-hub/requireAnchoredPublication.js';
import { SessionMutex } from '../domains/cats/services/agents/invocation/SessionMutex.js';
import {
  approveTasteProposal as defaultApproveTasteProposal,
  type VignetteWriterFn,
} from '../domains/taste/services/approveTasteProposal.js';
import type { ITasteProposalStore } from '../domains/taste/stores/ports/TasteProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
const rejectBodySchema = z.object({ rejectionReason: z.string().trim().min(1).max(500).optional() }).strict();

export interface TasteDecisionDeps {
  tasteProposalStore: ITasteProposalStore;
  socketManager: Pick<SocketManager, 'emitToUser'>;
  writeVignette: VignetteWriterFn;
  approvalLock?: SessionMutex;
  approvalLockKey?: () => string;
  approveTasteProposal?: typeof defaultApproveTasteProposal;
}

export function registerTasteProposalDecisionRoutes(app: FastifyInstance, deps: TasteDecisionDeps): void {
  const {
    tasteProposalStore,
    socketManager,
    writeVignette,
    approvalLock = new SessionMutex(),
    approvalLockKey = () => 'taste-vignette-writer',
    approveTasteProposal = defaultApproveTasteProposal,
  } = deps;

  // GET /api/taste-proposals/:id
  app.get('/api/taste-proposals/:id', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid proposal id' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const proposal = await tasteProposalStore.get(params.data.id);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.userId !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }
    return { proposalId: proposal.id, status: proposal.status };
  });

  // POST /api/taste-proposals/:id/approve
  app.post('/api/taste-proposals/:id/approve', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid proposal id' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const proposal = await tasteProposalStore.get(params.data.id);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.userId !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }

    // F246 Phase I (INV-I5): anchored publication guard before business CAS.
    try {
      await requireAnchoredPublication(tasteProposalStore, params.data.id);
    } catch (err) {
      if (err instanceof ApprovalPublicationNotAnchoredError) {
        reply.status(err.statusCode);
        return { error: err.message, code: err.code };
      }
      throw err;
    }

    const result = await approveTasteProposal(params.data.id, userId, {
      store: tasteProposalStore,
      lock: approvalLock,
      lockKey: approvalLockKey,
      writeVignette,
    });
    if (result.ok) {
      socketManager.emitToUser(userId, 'proposal_updated', result.proposal);
      return {
        proposalId: result.proposal.id,
        status: result.proposal.status,
        vignettePath: result.proposal.vignettePath,
        recovered: result.recovered,
      };
    }
    switch (result.reason) {
      case 'not_found':
        reply.status(404);
        return { error: 'Proposal not found' };
      case 'rejected':
        reply.status(409);
        return { error: 'Proposal already rejected', status: 'rejected' };
      case 'claim_lost':
        reply.status(409);
        return { error: result.error ?? 'Proposal status changed concurrently — retry approve' };
      default:
        reply.status(500);
        return { error: 'Vignette write failed', detail: result.error ?? 'Unknown writer error' };
    }
  });

  // POST /api/taste-proposals/:id/reject
  app.post('/api/taste-proposals/:id/reject', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid proposal id' };
    }
    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const proposal = await tasteProposalStore.get(params.data.id);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.userId !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }

    // F246 Phase I (INV-I5): anchored publication guard.
    try {
      await requireAnchoredPublication(tasteProposalStore, params.data.id);
    } catch (err) {
      if (err instanceof ApprovalPublicationNotAnchoredError) {
        reply.status(err.statusCode);
        return { error: err.message, code: err.code };
      }
      throw err;
    }

    const rejected = await tasteProposalStore.markRejected(
      params.data.id,
      body.data.rejectionReason ?? 'No reason provided',
      userId,
    );
    if (!rejected) {
      reply.status(409);
      return { error: 'Proposal is not in pending state', status: proposal.status };
    }

    socketManager.emitToUser(userId, 'proposal_updated', rejected);
    return {
      proposalId: rejected.id,
      status: rejected.status,
    };
  });
}
