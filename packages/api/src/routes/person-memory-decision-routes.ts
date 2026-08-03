import {
  candidateClaimDraftIdSchema,
  captureCandidateIdSchema,
  validateHumanDispositionFeedbackForProducer,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  PersonMemoryRejectResult,
  PersonMemoryStore,
  StoredPersonMemoryCandidate,
} from '../domains/memory/people/PersonMemoryStore.js';
import { projectPersonMemoryProposalStatus } from '../domains/memory/people/person-memory-proposal-status.js';
import {
  observePersonMemoryStage,
  type PersonMemoryTelemetryOutcome,
} from '../domains/memory/people/person-memory-telemetry.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const paramsSchema = z.object({ proposalId: captureCandidateIdSchema }).strict();
const decisionIdSchema = z.string().trim().min(1).max(200);
const approveSchema = z
  .object({
    selectedDraftIds: z.array(candidateClaimDraftIdSchema).min(1).max(3),
    decisionId: decisionIdSchema,
  })
  .strict();
const simpleDecisionSchema = z.object({ decisionId: decisionIdSchema }).strict();
const rejectSchema = z
  .object({
    decisionId: decisionIdSchema,
    feedback: z.unknown().optional(),
  })
  .strict();
const undoSchema = z
  .object({
    decisionId: decisionIdSchema,
    requestId: z.string().trim().min(1).max(200),
  })
  .strict();

export interface PersonMemoryDecisionDeps {
  store: PersonMemoryStore;
  socketManager: Pick<SocketManager, 'emitToUser'>;
}

interface OwnedCandidate {
  ownerUserId: string;
  candidate: StoredPersonMemoryCandidate;
}

function decisionOutcome(outcome: string): PersonMemoryTelemetryOutcome {
  if (outcome === 'applied') return 'success';
  if (outcome === 'replayed') return 'replayed';
  if (outcome === 'not_available') return 'not_available';
  if (outcome === 'conflict') return 'conflict';
  return 'error';
}

async function ownedCandidate(
  request: FastifyRequest,
  reply: FastifyReply,
  store: PersonMemoryStore,
): Promise<OwnedCandidate | null> {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    reply.status(400).send({ error: 'invalid_proposal_id' });
    return null;
  }
  const ownerUserId = resolveStrictUserId(request);
  if (!ownerUserId) {
    reply.status(401).send({ error: 'identity_required' });
    return null;
  }
  const candidate = await store.getCandidateForOwner(ownerUserId, params.data.proposalId);
  if (!candidate) {
    reply.status(404).send({ error: 'not_available' });
    return null;
  }
  return { ownerUserId, candidate };
}

function emitStatus(
  deps: PersonMemoryDecisionDeps,
  candidate: StoredPersonMemoryCandidate,
  status: string,
  receipts?: {
    decisionReceipt?: Record<string, unknown>;
    undoReceipt?: Record<string, unknown>;
  },
): void {
  const approvalCardMessageId =
    candidate.publication.state === 'anchored' ? candidate.publication.envelope.approvalCardRef.messageId : undefined;
  deps.socketManager.emitToUser(candidate.ownerUserId, 'proposal_updated', {
    proposalId: candidate.candidateId,
    sourceFeatureId: 'F276',
    status,
    publicationState: candidate.publication.state,
    ...(approvalCardMessageId ? { approvalCardMessageId } : {}),
    ...(receipts?.decisionReceipt ? { decisionReceipt: receipts.decisionReceipt } : {}),
    ...(receipts?.undoReceipt ? { undoReceipt: receipts.undoReceipt } : {}),
  });
}

function rejectErrorResponse(result: PersonMemoryRejectResult, reply: FastifyReply): { error: string } | null {
  const errors: Partial<Record<PersonMemoryRejectResult['outcome'], { status: number; error: string }>> = {
    not_available: { status: 404, error: 'not_available' },
    conflict: { status: 409, error: 'decision_conflict' },
    legacy_disposition_unmigrated: { status: 409, error: 'legacy_disposition_unmigrated' },
    invariant_failure: { status: 500, error: 'disposition_invariant_failure' },
  };
  const error = errors[result.outcome];
  if (!error) return null;
  reply.status(error.status);
  return { error: error.error };
}

export function registerPersonMemoryDecisionRoutes(app: FastifyInstance, deps: PersonMemoryDecisionDeps): void {
  app.get('/api/person-memory-proposals/:proposalId', async (request, reply) => {
    const owned = await ownedCandidate(request, reply, deps.store);
    if (!owned) return;
    return projectPersonMemoryProposalStatus(owned.candidate);
  });

  app.post('/api/person-memory-proposals/:proposalId/approve', async (request, reply) => {
    const body = approveSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'invalid_request', details: body.error.issues };
    }
    const owned = await ownedCandidate(request, reply, deps.store);
    if (!owned) return;
    if (owned.candidate.publication.state !== 'anchored') {
      reply.status(409);
      return { error: 'proposal_not_anchored' };
    }
    const result = await observePersonMemoryStage(
      'materialize',
      () =>
        deps.store.approveDrafts({
          ownerUserId: owned.ownerUserId,
          candidateId: owned.candidate.candidateId,
          selectedDraftIds: body.data.selectedDraftIds,
          decisionId: body.data.decisionId,
          authorizedAt: Date.now(),
        }),
      (value) => decisionOutcome(value.outcome),
    );
    if (result.outcome === 'not_available') {
      reply.status(404);
      return { error: 'not_available' };
    }
    if (result.outcome === 'conflict') {
      reply.status(409);
      return { error: 'decision_conflict' };
    }
    emitStatus(deps, owned.candidate, result.receipt.state, {
      decisionReceipt: result.receipt as unknown as Record<string, unknown>,
    });
    return {
      proposalId: owned.candidate.candidateId,
      status: result.receipt.state,
      ...result.receipt,
      ...(result.outcome === 'replayed' ? { deduped: true } : {}),
    };
  });

  app.post('/api/person-memory-proposals/:proposalId/undo', async (request, reply) => {
    const body = undoSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'invalid_request', details: body.error.issues };
    }
    const owned = await ownedCandidate(request, reply, deps.store);
    if (!owned) return;
    const result = await observePersonMemoryStage(
      'undo',
      () =>
        deps.store.undoDecision({
          ownerUserId: owned.ownerUserId,
          candidateId: owned.candidate.candidateId,
          decisionId: body.data.decisionId,
          requestId: body.data.requestId,
          undoneAt: Date.now(),
        }),
      (value) => decisionOutcome(value.outcome),
    );
    if (result.outcome === 'not_available') {
      reply.status(404);
      return { error: 'not_available' };
    }
    if (result.outcome === 'conflict') {
      reply.status(409);
      return { error: 'undo_conflict' };
    }
    if (!('receipt' in result)) throw new Error('F276 undo result missing receipt');
    emitStatus(deps, owned.candidate, result.receipt.candidateState, {
      undoReceipt: result.receipt as unknown as Record<string, unknown>,
    });
    return {
      proposalId: owned.candidate.candidateId,
      status: result.receipt.candidateState,
      ...result.receipt,
      ...(result.outcome === 'replayed' ? { deduped: true } : {}),
    };
  });

  app.post('/api/person-memory-proposals/:proposalId/not-now', async (request, reply) => {
    const body = simpleDecisionSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'invalid_request', details: body.error.issues };
    }
    const owned = await ownedCandidate(request, reply, deps.store);
    if (!owned) return;
    const updated = await observePersonMemoryStage('decision', () =>
      deps.store.markNotNow(owned.ownerUserId, owned.candidate.candidateId, Date.now()),
    );
    emitStatus(deps, owned.candidate, updated.state);
    return { proposalId: updated.candidateId, status: updated.state };
  });

  app.post('/api/person-memory-proposals/:proposalId/reject', async (request, reply) => {
    const body = rejectSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'invalid_request', details: body.error.issues };
    }
    const validatedFeedback = validateHumanDispositionFeedbackForProducer('F276', body.data.feedback);
    if (!validatedFeedback.success) {
      reply.status(400);
      return { error: 'invalid_feedback', reason: validatedFeedback.reason };
    }
    const owned = await ownedCandidate(request, reply, deps.store);
    if (!owned) return;
    const result = await observePersonMemoryStage(
      'decision',
      () =>
        deps.store.rejectCandidate({
          ownerUserId: owned.ownerUserId,
          candidateId: owned.candidate.candidateId,
          decisionId: body.data.decisionId,
          feedback: validatedFeedback.data,
          decidedAt: Date.now(),
        }),
      (value) => decisionOutcome(value.outcome),
    );
    const errorResponse = rejectErrorResponse(result, reply);
    if (errorResponse) return errorResponse;
    if (!('candidate' in result)) {
      reply.status(500);
      return { error: 'unexpected_decision_outcome' };
    }
    if (result.outcome === 'applied') emitStatus(deps, result.candidate, result.candidate.state);
    return {
      proposalId: result.candidate.candidateId,
      status: result.candidate.state,
      ...(result.outcome === 'replayed' ? { deduped: true } : {}),
    };
  });

  app.post('/api/person-memory-proposals/:proposalId/withdraw', async (request, reply) => {
    const body = simpleDecisionSchema.safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'invalid_request', details: body.error.issues };
    }
    const owned = await ownedCandidate(request, reply, deps.store);
    if (!owned) return;
    if (owned.candidate.state === 'withdrawn') {
      return { proposalId: owned.candidate.candidateId, status: 'withdrawn', deduped: true };
    }
    if (owned.candidate.state !== 'pending_approval' && owned.candidate.state !== 'not_now') {
      reply.status(409);
      return { error: 'decision_conflict' };
    }
    const updated = await observePersonMemoryStage('decision', () =>
      deps.store.withdrawCandidate(owned.ownerUserId, owned.candidate.candidateId, Date.now()),
    );
    emitStatus(deps, updated, updated.state);
    return { proposalId: updated.candidateId, status: updated.state };
  });
}
