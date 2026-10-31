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

import type { TasteProposal } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApprovalPublicationNotAnchoredError,
  requireAnchoredPublication,
} from '../domains/approval-hub/requireAnchoredPublication.js';
import { SessionMutex } from '../domains/cats/services/agents/invocation/SessionMutex.js';
import {
  approveTasteProposal as defaultApproveTasteProposal,
  type TasteApprovalCoordinator,
  type VignetteWriterFn,
} from '../domains/taste/services/approveTasteProposal.js';
import { tasteDecisionSnapshot } from '../domains/taste/services/taste-decision-snapshot.js';
import type { ITasteProposalStore } from '../domains/taste/stores/ports/TasteProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveSessionUserId, resolveStrictUserId } from '../utils/request-identity.js';
import { authorizeOwnerBrowserAction } from './owner-memory-browser-auth.js';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
const rejectBodySchema = z.object({ rejectionReason: z.string().trim().min(1).max(500).optional() }).strict();

export interface TasteDecisionDeps {
  tasteProposalStore: ITasteProposalStore;
  socketManager: Pick<SocketManager, 'emitToUser'>;
  writeVignette: VignetteWriterFn;
  approvalCoordinator?: TasteApprovalCoordinator;
  approveTasteProposal?: typeof defaultApproveTasteProposal;
}

export function registerTasteProposalDecisionRoutes(app: FastifyInstance, deps: TasteDecisionDeps): void {
  const {
    tasteProposalStore,
    socketManager,
    writeVignette,
    approvalCoordinator = { lock: new SessionMutex(), lockKey: () => 'taste-vignette-writer' },
    approveTasteProposal = defaultApproveTasteProposal,
  } = deps;

  // GET /api/taste-proposals/:id
  app.get('/api/taste-proposals/:id', async (request, reply) => {
    const resolved = await resolveOwnedTasteProposal(request, reply, tasteProposalStore, false);
    return resolved ? { proposalId: resolved.proposal.id, status: resolved.proposal.status } : undefined;
  });

  // Read-only input to the F317 Host confirmation candidate. Never decides a proposal.
  app.get('/api/taste-proposals/:id/decision-preview', async (request, reply) => {
    const resolved = await resolveOwnedTasteProposal(request, reply, tasteProposalStore, false);
    if (!resolved) return;
    let preview: ReturnType<typeof tasteDecisionSnapshot>;
    try {
      preview = tasteDecisionSnapshot(resolved.proposal);
    } catch {
      preview = null;
    }
    if (!preview) {
      reply.status(409);
      return { error: 'Proposal is not an anchored pending decision', code: 'candidate_unavailable' };
    }
    return preview;
  });

  // POST /api/taste-proposals/:id/approve
  app.post('/api/taste-proposals/:id/approve', async (request, reply) => {
    const resolved = await resolveOwnedTasteProposal(request, reply, tasteProposalStore, true);
    if (!resolved) return;
    if (!(await requireAnchored(tasteProposalStore, resolved.proposal.id, reply))) return;
    const result = await approveTasteProposal(resolved.proposal.id, resolved.userId, {
      store: tasteProposalStore,
      lock: approvalCoordinator.lock,
      lockKey: approvalCoordinator.lockKey,
      writeVignette,
    });
    if (result.ok) {
      socketManager.emitToUser(resolved.userId, 'proposal_updated', result.proposal);
      return {
        proposalId: result.proposal.id,
        status: result.proposal.status,
        vignettePath: result.proposal.vignettePath,
        recovered: result.recovered,
      };
    }
    return projectFailedApproval(result, reply);
  });

  // POST /api/taste-proposals/:id/reject
  app.post('/api/taste-proposals/:id/reject', async (request, reply) => {
    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }
    const resolved = await resolveOwnedTasteProposal(request, reply, tasteProposalStore, true);
    if (!resolved) return;
    if (!(await requireAnchored(tasteProposalStore, resolved.proposal.id, reply))) return;
    const rejected = await tasteProposalStore.markRejected(
      resolved.proposal.id,
      body.data.rejectionReason ?? 'No reason provided',
      resolved.userId,
    );
    if (!rejected) {
      reply.status(409);
      return { error: 'Proposal is not in pending state', status: resolved.proposal.status };
    }

    socketManager.emitToUser(resolved.userId, 'proposal_updated', rejected);
    return {
      proposalId: rejected.id,
      status: rejected.status,
    };
  });
}

async function resolveOwnedTasteProposal(
  request: FastifyRequest,
  reply: FastifyReply,
  store: ITasteProposalStore,
  requireBrowserAction: boolean,
): Promise<{ proposal: TasteProposal; userId: string } | null> {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    reply.status(400).send({ error: 'Invalid proposal id' });
    return null;
  }
  const proposal = await store.get(params.data.id);
  if (!proposal) {
    reply.status(404).send({ error: 'Proposal not found' });
    return null;
  }
  const userId = proposal.correctionTarget ? resolveSessionUserId(request) : resolveStrictUserId(request);
  if (!userId) {
    reply.status(401).send({ error: proposal.correctionTarget ? 'Session required' : 'Identity required' });
    return null;
  }
  if (proposal.correctionTarget && requireBrowserAction && !authorizeOwnerBrowserAction(request)) {
    reply.status(403).send({ error: 'Browser owner action required' });
    return null;
  }
  if (proposal.userId !== userId) {
    reply.status(403).send({ error: 'Proposal does not belong to the current user' });
    return null;
  }
  return { proposal, userId };
}

async function requireAnchored(store: ITasteProposalStore, proposalId: string, reply: FastifyReply): Promise<boolean> {
  try {
    await requireAnchoredPublication(store, proposalId);
    return true;
  } catch (error) {
    if (!(error instanceof ApprovalPublicationNotAnchoredError)) throw error;
    reply.status(error.statusCode).send({ error: error.message, code: error.code });
    return false;
  }
}

function projectFailedApproval(
  result: Exclude<Awaited<ReturnType<typeof defaultApproveTasteProposal>>, { ok: true }>,
  reply: FastifyReply,
) {
  if (result.reason === 'not_found') return reply.status(404).send({ error: 'Proposal not found' });
  if (result.reason === 'rejected') {
    return reply.status(409).send({ error: 'Proposal already rejected', status: 'rejected' });
  }
  if (result.reason === 'claim_lost') {
    return reply.status(409).send({ error: result.error ?? 'Proposal status changed concurrently — retry approve' });
  }
  if (result.reason === 'write_conflict') {
    return reply.status(409).send({ error: result.error ?? 'Taste source changed before correction approval' });
  }
  return reply.status(500).send({ error: 'Vignette write failed', detail: result.error ?? 'Unknown writer error' });
}
