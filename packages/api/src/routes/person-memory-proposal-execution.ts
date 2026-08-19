import type { RichPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { DeferredPersonMemoryReceiptStore } from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import type {
  PersonMemoryStore,
  StagePersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
} from '../domains/memory/people/PersonMemoryStore.js';
import { PersonMemoryDeltaConflictError } from '../domains/memory/people/person-memory-candidate-publication.js';
import { observePersonMemoryStage } from '../domains/memory/people/person-memory-telemetry.js';
import { resolveDeferredProposalReceipt } from './person-memory-deferred-proposal.js';
import {
  makeCandidateInput,
  previewCandidateForProposal,
  validatePriorCandidate,
} from './person-memory-proposal-candidate.js';
import type { PreparedPersonMemoryProposal, ResolvedProposalEvidence } from './person-memory-proposal-evidence.js';
import type { PersonMemoryProposalFailure } from './person-memory-proposal-preflight.js';
import { preflightPersonMemoryProposalCard } from './person-memory-proposal-preflight.js';
import type { ProposalOpportunityBinding } from './person-memory-proposal-write-opportunity.js';

type ExecutionStep<T> = { status: 'ok'; value: T } | { status: 'error'; failure: PersonMemoryProposalFailure };

export interface PreparedProposalCandidate {
  candidate: StoredPersonMemoryCandidate;
  prior: StoredPersonMemoryCandidate | null;
  card: RichPersonMemoryProposalCardBlock;
}

export interface ProposalCandidateExecutionDeps {
  store: PersonMemoryStore;
  messageStore: IMessageStore;
  deferredReceiptStore?: Pick<DeferredPersonMemoryReceiptStore, 'get'>;
}

async function resolvePriorCandidate(
  input: StagePersonMemoryCandidateInput,
  person: Parameters<typeof validatePriorCandidate>[1],
  sourceDigest: string,
  store: PersonMemoryStore,
): Promise<ExecutionStep<StoredPersonMemoryCandidate | null>> {
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
  return renewed.outcome === 'renewed' || renewed.outcome === 'replayed'
    ? { status: 'ok', value: renewed.candidate }
    : { status: 'error', failure: { statusCode: 409, payload: { error: 'deferred_receipt_transition_conflict' } } };
}

function candidateInput(
  prepared: PreparedPersonMemoryProposal,
  person: Parameters<typeof makeCandidateInput>[0]['person'],
  evidence: ResolvedProposalEvidence,
  deferredOrigin: Parameters<typeof makeCandidateInput>[5],
  opportunityBinding: ProposalOpportunityBinding,
): StagePersonMemoryCandidateInput {
  const { auth, body } = prepared;
  return {
    ...makeCandidateInput(
      { ...body, person },
      auth,
      prepared.originMessageId,
      evidence.interactionSourceEvidence,
      evidence.sourceResolution.bundle,
      deferredOrigin,
    ),
    ...(opportunityBinding.status === 'resolved'
      ? {
          writeOpportunityLineage: {
            reflexId: opportunityBinding.record.reflexId,
            reflexVersion: opportunityBinding.record.reflexVersion,
            opportunityId: opportunityBinding.record.opportunityId,
            dedupeLineage: opportunityBinding.record.dedupeLineage,
            generation: opportunityBinding.record.generation,
          },
        }
      : {}),
  };
}

export async function prepareProposalCandidate(
  prepared: PreparedPersonMemoryProposal,
  person: Parameters<typeof makeCandidateInput>[0]['person'],
  evidence: ResolvedProposalEvidence,
  opportunityBinding: ProposalOpportunityBinding,
  deps: ProposalCandidateExecutionDeps,
): Promise<ExecutionStep<PreparedProposalCandidate>> {
  const { auth, body } = prepared;
  const deferred = await resolveDeferredProposalReceipt({
    lineage: body.deferredReceipt,
    ownerUserId: auth.userId,
    requesterCatId: auth.catId,
    targetPersonId: body.targetPersonId,
    person,
    sourceBundle: evidence.sourceResolution.bundle,
    messageStore: deps.messageStore,
    receiptStore: deps.deferredReceiptStore,
  });
  if (deferred.status === 'error') return deferred;
  const input = candidateInput(prepared, person, evidence, deferred.value?.originMessageRef, opportunityBinding);
  const priorResolution = await resolvePriorCandidate(
    input,
    person,
    evidence.sourceResolution.bundleDigest,
    deps.store,
  );
  if (priorResolution.status === 'error') return priorResolution;
  const prior = priorResolution.value;
  const card = preflightPersonMemoryProposalCard(prior ?? previewCandidateForProposal(input));
  if (card.status === 'blocked') {
    return {
      status: 'error',
      failure: {
        statusCode: 422,
        payload: { error: 'person_memory_preflight_failed', preflight: card.preflight },
      },
    };
  }
  let candidate: StoredPersonMemoryCandidate;
  try {
    candidate = prior ?? (await observePersonMemoryStage('stage', () => deps.store.stageCandidate(input)));
  } catch (error) {
    if (error instanceof PersonMemoryDeltaConflictError) {
      return { status: 'error', failure: { statusCode: 409, payload: { error: 'delta_already_captured' } } };
    }
    throw error;
  }
  const revalidated = await evidence.sourceResolver.revalidate(
    evidence.publicSourceBundle,
    { ownerUserId: auth.userId },
    evidence.targets,
    evidence.sourceResolution.bundleDigest,
  );
  if (revalidated.status === 'invalid') {
    if (!prior) await deps.store.abortStaged(candidate.candidateId, revalidated.error);
    return { status: 'error', failure: { statusCode: 409, payload: { error: 'source_drift' } } };
  }
  return { status: 'ok', value: { candidate, prior, card: card.card } };
}
