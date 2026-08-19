import {
  buildHumanDispositionLedgerReceipt,
  type HumanDispositionFeedbackInput,
  type PersonMemorySuppressionToken,
  personMemorySuppressionTokenSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  buildPersonMemoryDispositionLedgerEntry,
  type HumanDispositionRandomBytesSource,
  mintPersonMemoryDispositionOpaqueProof,
  type PersonMemoryDispositionOpaqueProof,
} from '../../human-disposition/human-disposition-adapters.js';
import { HumanDispositionKeys } from '../../human-disposition/human-disposition-keys.js';
import type { EligiblePersonMemoryProposalDispositionClosure } from './PersonMemoryDispositionProofResolver.js';
import type { RejectPersonMemoryCandidateInput, StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import { candidateSubjectRefs } from './person-memory-candidate-registry.js';
import {
  type PersonMemoryProposalDispositionLineageBinding,
  personMemoryProposalDispositionDecisionReceiptLocatorSchema,
  personMemoryProposalDispositionLineageBindingSchema,
  personMemoryProposalDispositionLineageHandleLocatorSchema,
} from './person-memory-disposition-records.js';
import type { LedgerRejectMutation } from './person-memory-disposition-reject-support.js';
import { PersonMemoryKeys } from './person-memory-keys.js';

function terminalCandidate(candidate: StoredPersonMemoryCandidate): StoredPersonMemoryCandidate {
  const {
    personDraft: _personDraft,
    relationshipDraft: _relationshipDraft,
    interactionDraft: _interactionDraft,
    sourceBundle: _sourceBundle,
    ...base
  } = candidate;
  return {
    ...base,
    state: 'rejected',
    claimDrafts: [],
    remainingDraftIds: [],
  };
}

function proofFromWinner(
  binding: PersonMemoryProposalDispositionLineageBinding,
  candidate: StoredPersonMemoryCandidate,
): PersonMemoryDispositionOpaqueProof | null {
  const entry = candidate.humanDispositionLedgerEntry;
  if (
    !entry ||
    !binding.latestDecisionReceiptHandle ||
    entry.episode.proposalId !== binding.currentOpaqueProposalHandle ||
    entry.episode.subjectRef !== binding.opaqueLineageHandle
  ) {
    return null;
  }
  return {
    opaqueLineageHandle: binding.opaqueLineageHandle,
    opaqueProposalHandle: binding.currentOpaqueProposalHandle,
    opaqueSupersessionHandle: binding.currentOpaqueSupersessionHandle,
    opaqueDecisionReceiptHandle: binding.latestDecisionReceiptHandle,
  };
}

async function loadSuppression(
  redis: RedisClient,
  input: RejectPersonMemoryCandidateInput,
  candidate: StoredPersonMemoryCandidate,
  isReplay: boolean,
): Promise<{ suppression: PersonMemorySuppressionToken; subjectRefs: string[] } | null> {
  if (!isReplay) {
    const subjectRefs = candidateSubjectRefs(candidate);
    if (subjectRefs.length === 0) return null;
    return {
      subjectRefs,
      suppression: personMemorySuppressionTokenSchema.parse({
        tokenId: `person_suppression_${input.candidateId.replace(/^person_candidate_/, '')}`,
        ownerUserId: input.ownerUserId,
        candidateId: input.candidateId,
        subjectRefs,
        createdAt: input.decidedAt,
      }),
    };
  }
  try {
    const raw = await redis.get(PersonMemoryKeys.suppression(input.ownerUserId, input.candidateId));
    const suppression = raw ? personMemorySuppressionTokenSchema.parse(JSON.parse(raw)) : null;
    return suppression && suppression.subjectRefs.length > 0
      ? { suppression, subjectRefs: suppression.subjectRefs }
      : null;
  } catch {
    return null;
  }
}

export async function prepareProposalLedgerRejectMutation(input: {
  redis: RedisClient;
  decision: RejectPersonMemoryCandidateInput;
  candidate: StoredPersonMemoryCandidate;
  expectedRaw: string;
  closure: EligiblePersonMemoryProposalDispositionClosure;
  binding: PersonMemoryProposalDispositionLineageBinding | null;
  feedback: HumanDispositionFeedbackInput | undefined;
  randomBytesSource?: HumanDispositionRandomBytesSource;
}): Promise<LedgerRejectMutation | null> {
  const isReplay = input.candidate.state === 'rejected' && input.candidate.humanDispositionLedgerEntry !== undefined;
  if (isReplay !== (input.binding !== null)) return null;
  const freshProof = isReplay ? null : mintPersonMemoryDispositionOpaqueProof(input.randomBytesSource);
  const binding =
    input.binding ??
    personMemoryProposalDispositionLineageBindingSchema.parse({
      version: 1,
      ownerUserId: input.decision.ownerUserId,
      purgeScope: 'exact_proposal',
      rootCandidateId: input.closure.root.candidateId,
      currentCandidateId: input.candidate.candidateId,
      opaqueLineageHandle: freshProof?.opaqueLineageHandle,
      currentOpaqueProposalHandle: freshProof?.opaqueProposalHandle,
      currentOpaqueSupersessionHandle: freshProof?.opaqueSupersessionHandle,
    });
  const proof = isReplay ? proofFromWinner(binding, input.candidate) : freshProof;
  if (!proof) return null;
  const entry =
    (isReplay && input.candidate.humanDispositionLedgerEntry) ||
    buildPersonMemoryDispositionLedgerEntry({
      canonical: input.candidate,
      proof,
      decidedAt: input.decision.decidedAt,
      feedback: input.feedback,
    });
  if (!entry) return null;
  const suppressionState = await loadSuppression(input.redis, input.decision, input.candidate, isReplay);
  if (!suppressionState) return null;

  const updated = isReplay ? input.candidate : terminalCandidate(input.candidate);
  if (!isReplay) {
    updated.latestDecisionId = input.decision.decisionId;
    updated.dispositionLineageBindingKey = input.closure.bindingKey;
    if (input.feedback) updated.latestHumanDisposition = input.feedback;
    else delete updated.latestHumanDisposition;
    updated.humanDispositionLedgerEntry = entry;
  }
  const updatedBinding = personMemoryProposalDispositionLineageBindingSchema.parse({
    ...binding,
    latestDecisionReceiptHandle: proof.opaqueDecisionReceiptHandle,
  });
  const lineageLocator = personMemoryProposalDispositionLineageHandleLocatorSchema.parse({
    bindingKey: input.closure.bindingKey,
    purgeScope: 'exact_proposal',
    rootCandidateId: input.closure.root.candidateId,
  });
  const candidateKey = PersonMemoryKeys.candidate(input.decision.ownerUserId, input.decision.candidateId);
  const decisionLocator = personMemoryProposalDispositionDecisionReceiptLocatorSchema.parse({
    bindingKey: input.closure.bindingKey,
    candidateKey,
    purgeScope: 'exact_proposal',
    rootCandidateId: input.closure.root.candidateId,
  });
  const receipt = buildHumanDispositionLedgerReceipt(entry);
  const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
    input.decision.ownerUserId,
    binding.opaqueLineageHandle,
  );
  const decisionLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(
    input.decision.ownerUserId,
    proof.opaqueDecisionReceiptHandle,
  );
  const keys = [
    candidateKey,
    PersonMemoryKeys.pending(input.decision.ownerUserId),
    PersonMemoryKeys.suppression(input.decision.ownerUserId, input.decision.candidateId),
    input.closure.bindingKey,
    locatorKey,
    decisionLocatorKey,
    PersonMemoryKeys.proposalForgetFence(input.decision.ownerUserId, input.closure.root.candidateId),
    HumanDispositionKeys.receipts(input.decision.ownerUserId),
    HumanDispositionKeys.episodes(input.decision.ownerUserId),
    HumanDispositionKeys.subject(input.decision.ownerUserId, receipt.subjectRef),
  ];
  const subjectKeyStart = keys.length + 1;
  for (const subjectRef of suppressionState.subjectRefs) {
    keys.push(PersonMemoryKeys.suppressionSubject(input.decision.ownerUserId, subjectRef));
  }
  return {
    keys,
    updated,
    replayCandidate: input.candidate,
    args: [
      input.expectedRaw,
      JSON.stringify(updated),
      input.decision.candidateId,
      JSON.stringify(suppressionState.suppression),
      input.decision.decisionId,
      input.feedback ? JSON.stringify(input.feedback) : '',
      JSON.stringify(binding),
      JSON.stringify(updatedBinding),
      JSON.stringify(lineageLocator),
      JSON.stringify(decisionLocator),
      JSON.stringify(receipt),
      receipt.sourceRef,
      receipt.subjectRef,
      String(receipt.decidedAt),
      String(subjectKeyStart),
      String(suppressionState.subjectRefs.length),
      input.closure.bindingKey,
      candidateKey,
    ],
  };
}
