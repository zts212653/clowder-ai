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

import type { ProfileUpdateProposal } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAnchoredPublication } from '../domains/approval-hub/requireAnchoredPublication.js';
import type { SessionMutex } from '../domains/cats/services/agents/invocation/SessionMutex.js';
import { clearL0Cache as defaultClearL0Cache } from '../domains/cats/services/agents/providers/l0-compiler.js';
import {
  type ApproveProfileUpdateResult,
  approveProfileUpdate as defaultApproveProfileUpdate,
} from '../domains/cats/services/profile/approveProfileUpdate.js';
import type { FileProfileRepository } from '../domains/cats/services/profile/ProfileRepository.js';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { profileUpdateApproved, profileUpdateRejected } from '../infrastructure/telemetry/instruments.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const paramsSchema = z.object({ proposalId: z.string().min(1).max(200) });
const rejectBodySchema = z.object({ rejectionReason: z.string().trim().min(1).max(500).optional() }).strict();

export interface ProfileUpdateDecisionDeps {
  store: IProfileUpdateProposalStore;
  lock: SessionMutex;
  repository: FileProfileRepository;
  socketManager: Pick<SocketManager, 'emitToUser'>;
  clearL0Cache?: (catId?: string, userId?: string) => void;
  approveProfileUpdate?: typeof defaultApproveProfileUpdate;
}

interface OwnedProfileUpdate {
  proposal: ProfileUpdateProposal;
  userId: string;
}

function resolveProfileUpdateId(request: FastifyRequest, reply: FastifyReply): string | null {
  const params = paramsSchema.safeParse(request.params);
  if (params.success) return params.data.proposalId;
  reply.status(400).send({ error: 'Invalid proposalId' });
  return null;
}

async function resolveOwnedProfileUpdate(
  request: FastifyRequest,
  reply: FastifyReply,
  store: IProfileUpdateProposalStore,
  proposalId: string,
): Promise<OwnedProfileUpdate | null> {
  const userId = resolveStrictUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'Identity required (X-Cat-Cafe-User header or userId query)' });
    return null;
  }
  const proposal = await store.get(proposalId);
  if (!proposal) {
    reply.status(404).send({ error: 'Proposal not found' });
    return null;
  }
  if (proposal.createdBy !== userId) {
    reply.status(403).send({ error: 'Proposal does not belong to the current user' });
    return null;
  }
  return { proposal, userId };
}

export function registerProfileUpdateDecisionRoutes(app: FastifyInstance, deps: ProfileUpdateDecisionDeps): void {
  const {
    store,
    lock,
    repository,
    socketManager,
    clearL0Cache = defaultClearL0Cache,
    approveProfileUpdate = defaultApproveProfileUpdate,
  } = deps;

  const clearCommittedPrimerCache = (result: ApproveProfileUpdateResult): void => {
    if (result.proposal?.writtenPath) {
      clearL0Cache(result.proposal.sourceCatId, result.proposal.createdBy);
    }
  };

  app.get('/api/profile-updates/:proposalId', async (request, reply) => {
    const proposalId = resolveProfileUpdateId(request, reply);
    if (!proposalId) return;
    const owned = await resolveOwnedProfileUpdate(request, reply, store, proposalId);
    if (!owned) return;
    const { proposal } = owned;
    return { proposalId: proposal.proposalId, status: proposal.status };
  });

  app.post('/api/profile-updates/:proposalId/approve', async (request, reply) => {
    const proposalId = resolveProfileUpdateId(request, reply);
    if (!proposalId) return;
    const owned = await resolveOwnedProfileUpdate(request, reply, store, proposalId);
    if (!owned) return;
    const { proposal, userId } = owned;
    await requireAnchoredPublication(store, proposal.proposalId);

    const result = await approveProfileUpdate(proposal.proposalId, userId, { store, lock, repository });
    clearCommittedPrimerCache(result);
    if (result.ok) {
      // F231 AC-C3 eval counter (KD-10)
      profileUpdateApproved.add(1, { 'agent.id': result.proposal.sourceCatId });
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
    const proposalId = resolveProfileUpdateId(request, reply);
    if (!proposalId) return;
    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }
    const owned = await resolveOwnedProfileUpdate(request, reply, store, proposalId);
    if (!owned) return;
    const { proposal, userId } = owned;
    if (proposal.status === 'approved') {
      reply.status(409);
      return { error: 'Proposal already approved', status: 'approved' };
    }
    if (proposal.status === 'rejected') {
      return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
    }
    await requireAnchoredPublication(store, proposal.proposalId);

    // markRejected is CAS pending→rejected; an `approving` (crash-recovery in-flight) proposal
    // returns null → 409 (cannot reject a commit-in-progress).
    const marked = await store.markRejected(proposal.proposalId, userId, body.data.rejectionReason);
    if (!marked) {
      reply.status(409);
      return { error: 'Proposal status changed concurrently — retry reject', status: proposal.status };
    }
    // F231 AC-C3 eval counter (KD-10)
    profileUpdateRejected.add(1, { 'agent.id': marked.sourceCatId });
    socketManager.emitToUser(userId, 'proposal_updated', marked);
    return { proposalId: marked.proposalId, status: marked.status };
  });
}
