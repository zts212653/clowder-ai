/**
 * F231 Phase C Task3: profile-update decision routes (user-auth approve / reject).
 *
 * Thin HTTP adapter over approveProfileUpdate — the locked critical section (per-target lock,
 * crash-recovery commit pipeline, optimistic lock) lives in the service. Cat-side propose lives
 * in callback-propose-profile-update-routes.ts.
 *
 * AC-C1: no afterContent override at approve time. The terminal schema reserves
 * ProfileUpdateApproveOverrides, but a correct override needs to be PERSISTED (so crash recovery
 * writes the edited content + matching provenance) — out of AC-C1 scope. operator edits = reject +
 * re-propose for now.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionMutex } from '../domains/cats/services/agents/invocation/SessionMutex.js';
import { clearL0Cache as defaultClearL0Cache } from '../domains/cats/services/agents/providers/l0-compiler.js';
import {
  type ApproveProfileUpdateResult,
  approveProfileUpdate as defaultApproveProfileUpdate,
} from '../domains/cats/services/profile/approveProfileUpdate.js';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const paramsSchema = z.object({ proposalId: z.string().min(1).max(200) });
const rejectBodySchema = z.object({ rejectionReason: z.string().trim().min(1).max(500).optional() }).strict();

export interface ProfileUpdateDecisionDeps {
  store: IProfileUpdateProposalStore;
  lock: SessionMutex;
  profileDir: string;
  socketManager: Pick<SocketManager, 'emitToUser'>;
  clearL0Cache?: (catId?: string) => void;
  approveProfileUpdate?: typeof defaultApproveProfileUpdate;
}

export function registerProfileUpdateDecisionRoutes(app: FastifyInstance, deps: ProfileUpdateDecisionDeps): void {
  const {
    store,
    lock,
    profileDir,
    socketManager,
    clearL0Cache = defaultClearL0Cache,
    approveProfileUpdate = defaultApproveProfileUpdate,
  } = deps;

  const clearCommittedPrimerCache = (result: ApproveProfileUpdateResult): void => {
    if (result.proposal?.writtenPath) {
      clearL0Cache(result.proposal.sourceCatId);
    }
  };

  app.get('/api/profile-updates/:proposalId', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid proposalId' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const proposal = await store.get(params.data.proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.createdBy !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }
    return { proposalId: proposal.proposalId, status: proposal.status };
  });

  app.post('/api/profile-updates/:proposalId/approve', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid proposalId' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const proposal = await store.get(params.data.proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.createdBy !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }

    const result = await approveProfileUpdate(proposal.proposalId, userId, { store, lock, profileDir });
    clearCommittedPrimerCache(result);
    if (result.ok) {
      socketManager.emitToUser(userId, 'proposal_updated', result.proposal);
      return {
        proposalId: result.proposal.proposalId,
        status: result.proposal.status,
        writtenPath: result.proposal.writtenPath,
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
      case 'stale_hash':
        reply.status(409);
        return { error: 'Primer changed since propose (optimistic lock); re-propose', status: 'stale' };
      case 'claim_lost':
        reply.status(409);
        return { error: 'Proposal status changed concurrently — retry approve', status: proposal.status };
      default:
        reply.status(500);
        return { error: result.error ?? 'Profile update write failed' };
    }
  });

  app.post('/api/profile-updates/:proposalId/reject', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid proposalId' };
    }
    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const proposal = await store.get(params.data.proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.createdBy !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }
    if (proposal.status === 'approved') {
      reply.status(409);
      return { error: 'Proposal already approved', status: 'approved' };
    }
    if (proposal.status === 'rejected') {
      return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
    }

    // markRejected is CAS pending→rejected; an `approving` (crash-recovery in-flight) proposal
    // returns null → 409 (cannot reject a commit-in-progress).
    const marked = await store.markRejected(proposal.proposalId, userId, body.data.rejectionReason);
    if (!marked) {
      reply.status(409);
      return { error: 'Proposal status changed concurrently — retry reject', status: proposal.status };
    }
    socketManager.emitToUser(userId, 'proposal_updated', marked);
    return { proposalId: marked.proposalId, status: marked.status };
  });
}
