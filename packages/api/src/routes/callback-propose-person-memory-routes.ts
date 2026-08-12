import {
  type ApprovalEnvelope,
  type CandidateInteractionDraft,
  type PersonIdentityDraft,
  type PersonMemorySourceBundleInput,
  validatePersonMemoryAssertionMatrix,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApprovalCardCommittedError, ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { DeferredPersonMemoryReceiptStore } from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import {
  type OwnerPrivateArtifactResolver,
  type PersonMemoryAssertionTargetResolution,
  PersonMemorySourceBundleResolver,
  type PersonMemorySourceResolution,
} from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import type {
  PersonMemoryStore,
  StagePersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
} from '../domains/memory/people/PersonMemoryStore.js';
import {
  DeferredPersonMemoryCommitConflictError,
  PersonMemoryDeltaConflictError,
} from '../domains/memory/people/person-memory-candidate-publication.js';
import { proposalPersonMemoryDeltaCoordinates } from '../domains/memory/people/person-memory-delta-lineage.js';
import { observePersonMemoryStage } from '../domains/memory/people/person-memory-telemetry.js';
import type { WorkspacePersonResolver } from '../domains/memory/people/WorkspacePersonResolver.js';
import { resolveWorkspacePersonAliasSet } from '../domains/memory/people/WorkspacePersonResolver.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { resolveDeferredProposalReceipt } from './person-memory-deferred-proposal.js';
import {
  assertionTargets,
  candidateIdForProposal,
  derivePersonDraft,
  makeCandidateInput,
  previewCandidateForProposal,
  validatePriorCandidate,
} from './person-memory-proposal-candidate.js';
import {
  type PersonMemoryProposalFailure,
  preflightPersonMemoryProposalCard,
  proposalPreflightFailure,
  proposalSchemaPreflight,
} from './person-memory-proposal-preflight.js';
import { publishPersonMemoryCandidate } from './person-memory-proposal-publication.js';
import {
  legacySourceBundle,
  type ProposePersonMemoryBody,
  proposePersonMemorySchema,
  requiredInteractionFields,
  resolvedBindingsAreMaterializable,
  resolveInteractionSourceEvidence,
  resolveProposalSourceMessageId,
} from './person-memory-proposal-source-contract.js';

export interface ProposePersonMemoryDeps {
  registry: InvocationRegistry;
  store: PersonMemoryStore;
  workspacePersonResolver: WorkspacePersonResolver;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  approvalIngress?: Pick<ApprovalIngress, 'publish'>;
  ownerPrivateArtifactResolver?: OwnerPrivateArtifactResolver;
  deferredReceiptStore?: Pick<DeferredPersonMemoryReceiptStore, 'get'>;
}

type PreparedProposal = {
  auth: NonNullable<ReturnType<typeof requireCallbackAuth>>;
  body: ProposePersonMemoryBody;
  originMessageId: string;
};

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

type ProposalStep<T> = { status: 'ok'; value: T } | { status: 'error'; failure: PersonMemoryProposalFailure };

function rejectProposal(reply: FastifyReply, failure: PersonMemoryProposalFailure): Record<string, unknown> {
  reply.status(failure.statusCode);
  return failure.payload;
}

type ResolvedProposalEvidence = {
  proposalSourceMessageId: string;
  publicSourceBundle: PersonMemorySourceBundleInput;
  sourceResolver: PersonMemorySourceBundleResolver;
  sourceResolution: Extract<PersonMemorySourceResolution, { status: 'resolved' }>;
  targets: PersonMemoryAssertionTargetResolution;
  interactionSourceEvidence: CandidateInteractionDraft['sourceEvidence'];
};

async function resolveProposalEvidence(
  prepared: PreparedProposal,
  deps: ProposePersonMemoryDeps,
): Promise<ProposalStep<ResolvedProposalEvidence>> {
  const { auth, body, originMessageId } = prepared;
  const proposalSourceMessageId = await resolveProposalSourceMessageId(deps.messageStore, body, auth, originMessageId);
  if (proposalSourceMessageId === null) {
    return {
      status: 'error',
      failure: proposalPreflightFailure('invalid_proposal_source', 'source', {
        code: 'source_not_eligible',
        message: '提案来源不符合 owner/private-memory 证据要求。',
        action: '改用同一 owner 仍可见的精确原始消息后重新提交。',
        path: 'sourceMessageId',
      }),
    };
  }
  const publicSourceBundle = body.sourceBundle ?? legacySourceBundle(body, proposalSourceMessageId);
  const matrixErrors = validatePersonMemoryAssertionMatrix({
    claims: body.claims.map((claim) => claim.payload),
    hasRelationship: body.relationship !== undefined,
    hasInteraction: body.interaction !== undefined,
    requiredInteractionFields: requiredInteractionFields(body.interaction),
    bindings: publicSourceBundle.assertionBindings,
  });
  if (matrixErrors.some((error) => error.startsWith('agent_inference'))) {
    return {
      status: 'error',
      failure: proposalPreflightFailure(
        'owner_confirmation_required',
        'materializability',
        {
          code: 'owner_confirmation_required',
          message: '当前内容仍是 agent inference，不能写入 owner-private memory。',
          action: '请 owner 直接确认要记录的事实，再使用 owner-confirmed evidence 重提。',
        },
        { draft: '我目前只能推断……如果你确认，请直接陈述要记录的事实。' },
      ),
    };
  }
  if (matrixErrors.length > 0) {
    return {
      status: 'error',
      failure: proposalPreflightFailure(
        'invalid_assertion_binding',
        'materializability',
        {
          code: 'assertion_not_materializable',
          message: '至少一条 assertion role 不能支持所声明的目标字段。',
          action: '修正 source role 与 target field 的绑定后重新提交。',
          path: 'sourceBundle.assertionBindings',
        },
        { details: matrixErrors },
      ),
    };
  }
  const candidateId = candidateIdForProposal(body, auth);
  const targets = assertionTargets(candidateId, body);
  const sourceResolver = new PersonMemorySourceBundleResolver({
    messageStore: deps.messageStore,
    ...(deps.ownerPrivateArtifactResolver ? { ownerPrivateArtifactResolver: deps.ownerPrivateArtifactResolver } : {}),
  });
  const sourceResolution = await sourceResolver.resolve(publicSourceBundle, { ownerUserId: auth.userId }, targets);
  if (sourceResolution.status === 'invalid') {
    const error = !body.sourceBundle && body.interaction ? 'invalid_interaction_source' : sourceResolution.error;
    return {
      status: 'error',
      failure: proposalPreflightFailure(error, 'source', {
        code: 'source_not_eligible',
        message: '至少一个证据来源无法通过 owner、隐私、可见性或 digest 校验。',
        action: '改用仍可见且属于当前 owner 的精确来源后重新提交。',
        path: 'sourceBundle.sources',
      }),
    };
  }
  if (proposalPersonMemoryDeltaCoordinates(sourceResolution.bundle).status === 'duplicate') {
    return {
      status: 'error',
      failure: { statusCode: 422, payload: { error: 'duplicate_source_coordinate' } },
    };
  }
  if (!(await resolvedBindingsAreMaterializable(sourceResolution.bundle, deps.messageStore))) {
    return {
      status: 'error',
      failure: proposalPreflightFailure('invalid_assertion_binding', 'materializability', {
        code: 'assertion_not_materializable',
        message: '转述或 transcript-accuracy 证据不能证明 interaction fact。',
        action: '改绑为 owner direct observation，或只把转述保留为 quoted third-party evidence。',
        path: 'sourceBundle.assertionBindings',
      }),
    };
  }
  const interactionSourceEvidence = body.sourceBundle
    ? []
    : await resolveInteractionSourceEvidence(deps.messageStore, body.interaction, auth);
  if (interactionSourceEvidence === null) {
    return {
      status: 'error',
      failure: proposalPreflightFailure('invalid_interaction_source', 'source', {
        code: 'source_not_eligible',
        message: '互动证据来源不再符合 owner/visibility 要求。',
        action: '重新选择仍可见的 owner 原始消息，并逐字段绑定后提交。',
        path: 'interaction.sources',
      }),
    };
  }
  return {
    status: 'ok',
    value: {
      proposalSourceMessageId,
      publicSourceBundle,
      sourceResolver,
      sourceResolution,
      targets,
      interactionSourceEvidence,
    },
  };
}

async function resolveProposalPerson(
  prepared: PreparedProposal,
  deps: ProposePersonMemoryDeps,
): Promise<ProposalStep<PersonIdentityDraft>> {
  const { body } = prepared;
  const resolution = await resolveWorkspacePersonAliasSet(deps.workspacePersonResolver, [
    body.person.displayName,
    ...body.person.privateAliases,
  ]);
  const derived = derivePersonDraft(body.person, resolution);
  if (derived.status === 'error') {
    return {
      status: 'error',
      failure: { statusCode: derived.statusCode, payload: { error: derived.error } },
    };
  }
  return { status: 'ok', value: derived.person };
}

async function resolvePriorCandidateForProposal(
  input: StagePersonMemoryCandidateInput,
  person: PersonIdentityDraft,
  sourceDigest: string,
  store: PersonMemoryStore,
): Promise<ProposalStep<StoredPersonMemoryCandidate | null>> {
  const validation = await validatePriorCandidate(input, person, sourceDigest, store);
  if (validation.status === 'error') {
    return {
      status: 'error',
      failure: { statusCode: validation.statusCode, payload: { error: validation.error } },
    };
  }
  if (!validation.deferredClaimRenewal) return { status: 'ok', value: validation.prior };
  if (!validation.prior || !input.deferredReceiptId) {
    return {
      status: 'error',
      failure: { statusCode: 409, payload: { error: 'deferred_receipt_transition_conflict' } },
    };
  }
  const renewed = await store.renewDeferredCandidateClaim({
    ownerUserId: input.ownerUserId,
    candidateId: input.candidateId,
    receiptId: input.deferredReceiptId,
    previousClaimId: validation.deferredClaimRenewal.previousClaimId,
    nextClaimId: validation.deferredClaimRenewal.nextClaimId,
    deltaFingerprint: validation.deferredClaimRenewal.deltaFingerprint,
    renewedAt: Date.now(),
  });
  if (renewed.outcome !== 'renewed' && renewed.outcome !== 'replayed') {
    return {
      status: 'error',
      failure: { statusCode: 409, payload: { error: 'deferred_receipt_transition_conflict' } },
    };
  }
  return { status: 'ok', value: renewed.candidate };
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
  reply: FastifyReply,
  deps: ProposePersonMemoryDeps,
  ingress: Pick<ApprovalIngress, 'publish'>,
) {
  const { auth, body } = prepared;
  if (!(await deps.registry.isLatest(auth.invocationId))) return { status: 'stale_ignored' };
  const evidence = await resolveProposalEvidence(prepared, deps);
  if (evidence.status === 'error') return rejectProposal(reply, evidence.failure);
  const person = await resolveProposalPerson(prepared, deps);
  if (person.status === 'error') return rejectProposal(reply, person.failure);
  const deferredReceipt = await resolveDeferredProposalReceipt({
    lineage: body.deferredReceipt,
    ownerUserId: auth.userId,
    requesterCatId: auth.catId,
    targetPersonId: body.targetPersonId,
    person: person.value,
    sourceBundle: evidence.value.sourceResolution.bundle,
    messageStore: deps.messageStore,
    receiptStore: deps.deferredReceiptStore,
  });
  if (deferredReceipt.status === 'error') return rejectProposal(reply, deferredReceipt.failure);
  const input = makeCandidateInput(
    { ...body, person: person.value },
    auth,
    prepared.originMessageId,
    evidence.value.interactionSourceEvidence,
    evidence.value.sourceResolution.bundle,
    deferredReceipt.value?.originMessageRef,
  );
  const priorResolution = await resolvePriorCandidateForProposal(
    input,
    person.value,
    evidence.value.sourceResolution.bundleDigest,
    deps.store,
  );
  if (priorResolution.status === 'error') return rejectProposal(reply, priorResolution.failure);
  const prior = priorResolution.value;
  const preview = prior ?? previewCandidateForProposal(input);
  const cardPreflight = preflightPersonMemoryProposalCard(preview);
  if (cardPreflight.status === 'blocked') {
    return rejectProposal(reply, {
      statusCode: 422,
      payload: { error: 'person_memory_preflight_failed', preflight: cardPreflight.preflight },
    });
  }
  let candidate: StoredPersonMemoryCandidate;
  try {
    candidate = prior ?? (await observePersonMemoryStage('stage', () => deps.store.stageCandidate(input)));
  } catch (error) {
    if (error instanceof PersonMemoryDeltaConflictError) {
      reply.status(409);
      return { error: 'delta_already_captured' };
    }
    throw error;
  }
  const revalidated = await evidence.value.sourceResolver.revalidate(
    evidence.value.publicSourceBundle,
    { ownerUserId: auth.userId },
    evidence.value.targets,
    evidence.value.sourceResolution.bundleDigest,
  );
  if (revalidated.status === 'invalid') {
    if (!prior) await deps.store.abortStaged(candidate.candidateId, revalidated.error);
    reply.status(409);
    return { error: 'source_drift' };
  }
  let envelope: ApprovalEnvelope;
  try {
    envelope = await observePersonMemoryStage('publish', () =>
      publishPersonMemoryCandidate(ingress, deps.store, candidate, cardPreflight.card),
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
    return handleProposal(prepared, reply, deps, ingress);
  });
}
