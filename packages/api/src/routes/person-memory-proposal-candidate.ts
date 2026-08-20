import { createHash } from 'node:crypto';
import {
  type CandidateClaimDraftId,
  type CandidateInteractionDraft,
  type CatId,
  candidateClaimDraftSchema,
  captureCandidateIdSchema,
  type PersonIdentityDraft,
  type PersonMemoryResolvedSourceBundle,
  type PersonMemorySourceRef,
} from '@cat-cafe/shared';
import {
  digestPersonMemoryResolvedBundle,
  type PersonMemoryAssertionTargetResolution,
} from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import type {
  PersonMemoryStore,
  StagePersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
} from '../domains/memory/people/PersonMemoryStore.js';
import { candidateRepresentsPerson } from '../domains/memory/people/person-memory-candidate-identity.js';
import { proposalPersonMemoryDeltaFingerprint } from '../domains/memory/people/person-memory-delta-lineage.js';
import type { WorkspacePersonAliasSetResolution } from '../domains/memory/people/WorkspacePersonResolver.js';
import type { ProposePersonMemoryBody } from './person-memory-proposal-source-contract.js';

type ProposalAuth = {
  invocationId: string;
  userId: string;
  catId: CatId;
  threadId: string;
};

function stableSuffix(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function draftId(candidateId: string, slot: string): CandidateClaimDraftId {
  return candidateClaimDraftSchema.shape.draftId.parse(
    `person_draft_${candidateId.replace(/^person_candidate_/, '')}:${slot}`,
  );
}

export function makeCandidateInput(
  parsed: ProposePersonMemoryBody,
  auth: ProposalAuth,
  originMessageId: string,
  interactionSourceEvidence: CandidateInteractionDraft['sourceEvidence'] | undefined,
  sourceBundle: PersonMemoryResolvedSourceBundle,
  sourceMessageRef?: PersonMemorySourceRef,
): StagePersonMemoryCandidateInput {
  const candidateId = candidateIdForProposal(parsed, auth);
  const claimDrafts = parsed.claims.map((claim, index) => ({
    ...claim,
    draftId: draftId(candidateId, `claim:${index}`),
    decision: 'pending' as const,
  }));
  const relationshipDraft = parsed.relationship
    ? {
        ...parsed.relationship,
        draftId: draftId(candidateId, 'relationship'),
        decision: 'pending' as const,
      }
    : undefined;
  const interactionDraft = parsed.interaction
    ? (() => {
        const { sources: _sources, ...interaction } = parsed.interaction;
        return {
          ...interaction,
          sourceEvidence: interactionSourceEvidence ?? [],
          draftId: draftId(candidateId, 'interaction'),
          decision: 'pending' as const,
        };
      })()
    : undefined;
  const deltaFingerprint = proposalPersonMemoryDeltaFingerprint({
    targetPersonId: parsed.targetPersonId,
    person: parsed.person,
    sourceBundle,
    replacesProposalId: parsed.replacesProposalId,
  });
  return {
    candidateId,
    ownerUserId: auth.userId,
    requesterCatId: auth.catId,
    sourceMessageRef: sourceMessageRef ?? { kind: 'message', threadId: auth.threadId, messageId: originMessageId },
    personDraft: parsed.person,
    ...(parsed.targetPersonId ? { targetPersonId: parsed.targetPersonId } : {}),
    claimDrafts,
    ...(relationshipDraft ? { relationshipDraft } : {}),
    ...(interactionDraft ? { interactionDraft } : {}),
    sourceBundle,
    ...(parsed.deferredReceipt ? { deferredReceiptId: parsed.deferredReceipt.receiptId } : {}),
    ...(parsed.deferredReceipt ? { deferredReceiptClaimId: parsed.deferredReceipt.claimId } : {}),
    ...(deltaFingerprint ? { deltaFingerprint } : {}),
    ...(parsed.replacesProposalId ? { replacesProposalId: parsed.replacesProposalId } : {}),
    remainingDraftIds: [
      ...claimDrafts.map((draft) => draft.draftId),
      ...(relationshipDraft ? [relationshipDraft.draftId] : []),
      ...(interactionDraft ? [interactionDraft.draftId] : []),
    ],
    retention: 'owner_controlled_no_ttl',
    createdAt: Date.now(),
  };
}

export function previewCandidateForProposal(input: StagePersonMemoryCandidateInput): StoredPersonMemoryCandidate {
  return {
    ...input,
    state: 'staged',
    publication: { state: 'staged', stagedAt: input.createdAt },
  };
}

export function candidateIdForProposal(
  parsed: ProposePersonMemoryBody,
  auth: Pick<ProposalAuth, 'invocationId' | 'userId' | 'catId'>,
) {
  const dedupKey = parsed.clientRequestId ?? auth.invocationId;
  return captureCandidateIdSchema.parse(`person_candidate_${stableSuffix(auth.userId, auth.catId, dedupKey)}`);
}

export function assertionTargets(
  candidateId: string,
  parsed: ProposePersonMemoryBody,
): PersonMemoryAssertionTargetResolution {
  return {
    claimDraftIds: parsed.claims.map((_claim, index) => draftId(candidateId, `claim:${index}`)),
    ...(parsed.relationship ? { relationshipDraftId: draftId(candidateId, 'relationship') } : {}),
    ...(parsed.interaction ? { interactionDraftId: draftId(candidateId, 'interaction') } : {}),
  };
}

export type DerivedPersonDraft =
  | { status: 'ok'; person: PersonIdentityDraft }
  | { status: 'error'; statusCode: 409 | 503; error: string };

export function derivePersonDraft(
  person: PersonIdentityDraft,
  resolution: WorkspacePersonAliasSetResolution,
): DerivedPersonDraft {
  if (resolution.status === 'unavailable') {
    return { status: 'error', statusCode: 503, error: 'identity_resolution_unavailable' };
  }
  if (resolution.status === 'ambiguous') {
    return { status: 'error', statusCode: 409, error: 'identity_ambiguous' };
  }
  if (resolution.status === 'conflict') {
    return { status: 'error', statusCode: 409, error: 'identity_conflict' };
  }
  if (resolution.status === 'not_found') {
    if (person.workspaceEntityLink) {
      return { status: 'error', statusCode: 409, error: 'identity_conflict' };
    }
    return { status: 'ok', person };
  }
  if (person.workspaceEntityLink && person.workspaceEntityLink.entityRef !== resolution.entityRef) {
    return { status: 'error', statusCode: 409, error: 'identity_conflict' };
  }
  return {
    status: 'ok',
    person: {
      ...person,
      workspaceEntityLink: {
        entityRef: resolution.entityRef,
        state: 'linked',
        checkedAt: Date.now(),
      },
    },
  };
}

export type PriorCandidateValidation =
  | {
      status: 'ok';
      prior: StoredPersonMemoryCandidate | null;
      deferredClaimRenewal?: { previousClaimId: string; nextClaimId: string; deltaFingerprint: string };
    }
  | { status: 'error'; statusCode: 404 | 409; error: string };

async function targetPersonIsActive(
  store: PersonMemoryStore,
  ownerUserId: string,
  targetPersonId: StagePersonMemoryCandidateInput['targetPersonId'],
): Promise<boolean> {
  if (!targetPersonId) return true;
  const target = await store.getPerson(ownerUserId, targetPersonId);
  return target?.status === 'active';
}

function sameWriteOpportunityLineage(
  left: StagePersonMemoryCandidateInput['writeOpportunityLineage'],
  right: StagePersonMemoryCandidateInput['writeOpportunityLineage'],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.reflexId === right.reflexId &&
    left.reflexVersion === right.reflexVersion &&
    left.opportunityId === right.opportunityId &&
    left.dedupeLineage === right.dedupeLineage &&
    left.generation === right.generation
  );
}

function validateExistingCandidate(
  prior: StoredPersonMemoryCandidate | null,
  input: StagePersonMemoryCandidateInput,
  person: PersonIdentityDraft,
  sourceDigest: string,
): PriorCandidateValidation | null {
  if (!prior) return null;
  if (prior.replacesProposalId !== input.replacesProposalId) {
    return { status: 'error', statusCode: 409, error: 'replacement_conflict' };
  }
  if (prior.deferredReceiptId !== input.deferredReceiptId) {
    return { status: 'error', statusCode: 409, error: 'deferred_receipt_conflict' };
  }
  if (!sameWriteOpportunityLineage(prior.writeOpportunityLineage, input.writeOpportunityLineage)) {
    return { status: 'error', statusCode: 409, error: 'write_opportunity_lineage_conflict' };
  }
  if (prior.deltaFingerprint !== input.deltaFingerprint) {
    return { status: 'error', statusCode: 409, error: 'delta_lineage_conflict' };
  }
  if (!prior.sourceBundle || digestPersonMemoryResolvedBundle(prior.sourceBundle) !== sourceDigest) {
    return { status: 'error', statusCode: 409, error: 'source_conflict' };
  }
  if (!candidateRepresentsPerson(prior, person)) {
    return { status: 'error', statusCode: 409, error: 'identity_conflict' };
  }
  if (prior.deferredReceiptClaimId !== input.deferredReceiptClaimId) {
    const previousClaimId = prior.deferredReceiptClaimId;
    const nextClaimId = input.deferredReceiptClaimId;
    const deltaFingerprint = prior.deltaFingerprint;
    const renewable =
      prior.state === 'staged' &&
      prior.publication.state === 'staged' &&
      prior.deferredReceiptId !== undefined &&
      previousClaimId !== undefined &&
      nextClaimId !== undefined &&
      deltaFingerprint !== undefined;
    if (!renewable) {
      return { status: 'error', statusCode: 409, error: 'deferred_receipt_claim_conflict' };
    }
    return {
      status: 'ok',
      prior,
      deferredClaimRenewal: {
        previousClaimId,
        nextClaimId,
        deltaFingerprint,
      },
    };
  }
  return { status: 'ok', prior };
}

export async function validatePriorCandidate(
  input: StagePersonMemoryCandidateInput,
  person: PersonIdentityDraft,
  sourceDigest: string,
  store: PersonMemoryStore,
): Promise<PriorCandidateValidation> {
  if (!(await targetPersonIsActive(store, input.ownerUserId, input.targetPersonId))) {
    return { status: 'error', statusCode: 404, error: 'not_available' };
  }
  const prior = await store.getCandidateForOwner(input.ownerUserId, input.candidateId);
  const existingValidation = validateExistingCandidate(prior, input, person, sourceDigest);
  if (existingValidation) return existingValidation;
  if (!input.replacesProposalId) return { status: 'ok', prior: null };
  if (input.replacesProposalId === input.candidateId) {
    return { status: 'error', statusCode: 409, error: 'proposal_cannot_replace_itself' };
  }
  const original = await store.getCandidateForOwner(input.ownerUserId, input.replacesProposalId);
  if (!original) return { status: 'error', statusCode: 404, error: 'not_available' };
  const replaceable =
    original.publication.state === 'anchored' &&
    (original.state === 'pending_approval' || original.state === 'not_now');
  if (!replaceable) return { status: 'error', statusCode: 409, error: 'proposal_not_replaceable' };
  if (!candidateRepresentsPerson(original, person)) {
    return { status: 'error', statusCode: 409, error: 'identity_conflict' };
  }
  return { status: 'ok', prior: null };
}
