import type { ApprovalEnvelope } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApprovalCardCommittedError, ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { DeferredPersonMemoryReceiptStore } from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import type { OwnerPrivateArtifactResolver } from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import type { PersonMemoryStore, StoredPersonMemoryCandidate } from '../domains/memory/people/PersonMemoryStore.js';
import { DeferredPersonMemoryCommitConflictError } from '../domains/memory/people/person-memory-candidate-publication.js';
import { observePersonMemoryStage } from '../domains/memory/people/person-memory-telemetry.js';
import type { WorkspacePersonResolver } from '../domains/memory/people/WorkspacePersonResolver.js';
import type { WriteOpportunityDeliveryStore } from '../domains/memory/people/WriteOpportunityDeliveryStore.js';
import type { WriteOpportunityTerminalLedger } from '../domains/memory/people/WriteOpportunityTerminalLedger.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import {
  type PreparedPersonMemoryProposal,
  resolveProposalEvidence,
  resolveProposalPerson,
} from './person-memory-proposal-evidence.js';
import { prepareProposalCandidate } from './person-memory-proposal-execution.js';
import { type PersonMemoryProposalFailure, proposalSchemaPreflight } from './person-memory-proposal-preflight.js';
import { publishPersonMemoryCandidate } from './person-memory-proposal-publication.js';
import { proposePersonMemorySchema } from './person-memory-proposal-source-contract.js';
import {
  closeProposalOpportunity,
  prepareProposalOpportunityBinding,
} from './person-memory-proposal-write-opportunity.js';

export interface ProposePersonMemoryDeps {
  registry: InvocationRegistry;
  store: PersonMemoryStore;
  workspacePersonResolver: WorkspacePersonResolver;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  approvalIngress?: Pick<ApprovalIngress, 'publish'>;
  ownerPrivateArtifactResolver?: OwnerPrivateArtifactResolver;
  deferredReceiptStore?: Pick<DeferredPersonMemoryReceiptStore, 'get'>;
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
}

type PreparedProposal = PreparedPersonMemoryProposal;

function prepareProposal(request: FastifyRequest, reply: FastifyReply): PreparedProposal | null {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return null;
  const body = proposePersonMemorySchema.safeParse(request.body);
  if (!body.success) {
    const knownPreflight = proposalSchemaPreflight(body.error.issues);
    if (knownPreflight) {
      reply.status(422).send({ error: 'person_memory_preflight_failed', preflight: knownPreflight });
      return null;
    }
    reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
    return null;
  }
  const originMessageId = auth.originTriggerMessageId ?? auth.a2aTriggerMessageId;
  if (!originMessageId) {
    reply.status(400).send({ error: 'Exact source message is required for an approval proposal' });
    return null;
  }
  return { auth, body: body.data, originMessageId };
}

function rejectProposal(reply: FastifyReply, failure: PersonMemoryProposalFailure): Record<string, unknown> {
  reply.status(failure.statusCode);
  return failure.payload;
}

function emitReplacementUpdate(
  candidate: StoredPersonMemoryCandidate,
  ownerUserId: string,
  socketManager: SocketManager,
): void {
  if (!candidate.replacesProposalId) return;
  socketManager.emitToUser(ownerUserId, 'proposal_updated', {
    proposalId: candidate.replacesProposalId,
    sourceFeatureId: 'F276',
    status: 'withdrawn',
    replacedByProposalId: candidate.candidateId,
  });
}

async function handleProposal(
  prepared: PreparedProposal,
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ProposePersonMemoryDeps,
  ingress: Pick<ApprovalIngress, 'publish'>,
) {
  const { auth } = prepared;
  if (!(await deps.registry.isLatest(auth.invocationId))) return { status: 'stale_ignored' };
  const opportunityBinding = await prepareProposalOpportunityBinding(prepared, deps, reply);
  if (!opportunityBinding) return;
  const evidence = await resolveProposalEvidence(prepared, deps);
  if (evidence.status === 'error') return rejectProposal(reply, evidence.failure);
  const person = await resolveProposalPerson(prepared, deps);
  if (person.status === 'error') return rejectProposal(reply, person.failure);
  const execution = await prepareProposalCandidate(prepared, person.value, evidence.value, opportunityBinding, deps);
  if (execution.status === 'error') return rejectProposal(reply, execution.failure);
  const { candidate, prior, card } = execution.value;
  if (
    await closeProposalOpportunity({
      binding: opportunityBinding,
      candidate,
      prior,
      auth,
      request,
      reply,
      store: deps.store,
    })
  ) {
    return;
  }
  let envelope: ApprovalEnvelope;
  try {
    envelope = await observePersonMemoryStage('publish', () =>
      publishPersonMemoryCandidate(ingress, deps.store, candidate, card),
    );
  } catch (error) {
    if (error instanceof ApprovalCardCommittedError && error.cause instanceof DeferredPersonMemoryCommitConflictError) {
      reply.status(409);
      return { error: 'deferred_receipt_transition_conflict' };
    }
    throw error;
  }
  emitReplacementUpdate(candidate, auth.userId, deps.socketManager);
  return {
    candidateId: candidate.candidateId,
    status: candidate.state === 'staged' ? 'pending_approval' : candidate.state,
    messageId: envelope.approvalCardRef.messageId,
    ...(candidate.replacesProposalId ? { replacesProposalId: candidate.replacesProposalId } : {}),
    ...(prior ? { deduped: true } : {}),
  };
}

export function registerCallbackProposePersonMemoryRoutes(app: FastifyInstance, deps: ProposePersonMemoryDeps): void {
  const ingress =
    deps.approvalIngress ??
    new ApprovalIngress({
      messageStore: deps.messageStore,
      socketManager: deps.socketManager,
    });
  app.post('/api/callbacks/propose-person-memory', async (request, reply) => {
    const prepared = prepareProposal(request, reply);
    if (!prepared) return;
    return handleProposal(prepared, request, reply, deps, ingress);
  });
}
