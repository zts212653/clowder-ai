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
import type { EligiblePersonMemoryDispositionClosure } from './PersonMemoryDispositionProofResolver.js';
import type {
  PersonMemoryRejectResult,
  RejectPersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
} from './PersonMemoryStore.js';
import { candidateSubjectRefs } from './person-memory-candidate-registry.js';
import {
  type PersonMemoryDispositionLineageBinding,
  personMemoryDispositionDecisionReceiptLocatorSchema,
  personMemoryDispositionLineageBindingSchema,
  personMemoryDispositionLineageHandleLocatorSchema,
} from './person-memory-disposition-records.js';
import { PersonMemoryKeys } from './person-memory-keys.js';

export type RejectAttemptResult = PersonMemoryRejectResult | { outcome: 'retry' };

export interface LedgerRejectMutation {
  keys: string[];
  args: string[];
  updated: StoredPersonMemoryCandidate;
  replayCandidate: StoredPersonMemoryCandidate;
}

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

function membershipKey(candidate: StoredPersonMemoryCandidate, personId: string): string {
  return candidate.materializedPersonId
    ? PersonMemoryKeys.personCandidates(candidate.ownerUserId, personId)
    : PersonMemoryKeys.targetCandidates(candidate.ownerUserId, personId);
}

function proofFromWinner(
  binding: PersonMemoryDispositionLineageBinding,
  candidate: StoredPersonMemoryCandidate,
): PersonMemoryDispositionOpaqueProof | null {
  const entry = candidate.humanDispositionLedgerEntry;
  const matchesBinding =
    entry?.episode.proposalId === binding.currentOpaqueProposalHandle &&
    entry.episode.subjectRef === binding.opaqueLineageHandle;
  if (!entry || !binding.latestDecisionReceiptHandle || !matchesBinding) return null;
  return {
    opaqueLineageHandle: binding.opaqueLineageHandle,
    opaqueProposalHandle: binding.currentOpaqueProposalHandle,
    opaqueSupersessionHandle: binding.currentOpaqueSupersessionHandle,
    opaqueDecisionReceiptHandle: binding.latestDecisionReceiptHandle,
  };
}

function newProof(
  binding: PersonMemoryDispositionLineageBinding,
  randomBytesSource?: HumanDispositionRandomBytesSource,
): PersonMemoryDispositionOpaqueProof {
  return {
    ...mintPersonMemoryDispositionOpaqueProof(randomBytesSource),
    opaqueLineageHandle: binding.opaqueLineageHandle,
    opaqueProposalHandle: binding.currentOpaqueProposalHandle,
    opaqueSupersessionHandle: binding.currentOpaqueSupersessionHandle,
  };
}

function updateRejectedCandidate(
  candidate: StoredPersonMemoryCandidate,
  input: RejectPersonMemoryCandidateInput,
  feedback: HumanDispositionFeedbackInput | undefined,
  entry: NonNullable<StoredPersonMemoryCandidate['humanDispositionLedgerEntry']>,
  isReplay: boolean,
): StoredPersonMemoryCandidate {
  if (isReplay) return candidate;
  const updated = terminalCandidate(candidate);
  updated.latestDecisionId = input.decisionId;
  if (feedback) updated.latestHumanDisposition = feedback;
  else delete updated.latestHumanDisposition;
  updated.humanDispositionLedgerEntry = entry;
  return updated;
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

function buildClosureProof(
  redis: RedisClient,
  input: RejectPersonMemoryCandidateInput,
  closure: EligiblePersonMemoryDispositionClosure,
  locatorKey: string,
  keys: string[],
): { membershipChecks: Array<{ keyIndex: number; member: string }>; artifactMembers: string[] } {
  const keyIndexes = new Map(keys.map((key, index) => [key, index + 1]));
  const membershipChecks = closure.chain.map((current) => {
    const key = membershipKey(current, closure.closurePersonId);
    let keyIndex = keyIndexes.get(key);
    if (keyIndex === undefined) {
      keys.push(key);
      keyIndex = keys.length;
      keyIndexes.set(key, keyIndex);
    }
    return { keyIndex, member: current.candidateId };
  });
  const keyPrefix = redis.options.keyPrefix ?? '';
  return {
    membershipChecks,
    artifactMembers: [
      ...closure.chain.map(
        (current) => `${keyPrefix}${PersonMemoryKeys.candidate(input.ownerUserId, current.candidateId)}`,
      ),
      `${keyPrefix}${closure.bindingKey}`,
      `${keyPrefix}${locatorKey}`,
    ],
  };
}

export async function prepareLedgerRejectMutation(input: {
  redis: RedisClient;
  decision: RejectPersonMemoryCandidateInput;
  candidate: StoredPersonMemoryCandidate;
  expectedRaw: string;
  closure: EligiblePersonMemoryDispositionClosure;
  binding: PersonMemoryDispositionLineageBinding;
  feedback: HumanDispositionFeedbackInput | undefined;
  randomBytesSource?: HumanDispositionRandomBytesSource;
}): Promise<LedgerRejectMutation | null> {
  const isReplay = input.candidate.state === 'rejected' && input.candidate.humanDispositionLedgerEntry !== undefined;
  const proof = isReplay
    ? proofFromWinner(input.binding, input.candidate)
    : newProof(input.binding, input.randomBytesSource);
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

  const updated = updateRejectedCandidate(input.candidate, input.decision, input.feedback, entry, isReplay);
  const updatedBinding = personMemoryDispositionLineageBindingSchema.parse({
    ...input.binding,
    latestDecisionReceiptHandle: proof.opaqueDecisionReceiptHandle,
  });
  const lineageLocator = personMemoryDispositionLineageHandleLocatorSchema.parse({
    bindingKey: input.closure.bindingKey,
    closurePersonId: input.closure.closurePersonId,
  });
  const candidateKey = PersonMemoryKeys.candidate(input.decision.ownerUserId, input.decision.candidateId);
  const decisionLocator = personMemoryDispositionDecisionReceiptLocatorSchema.parse({
    bindingKey: input.closure.bindingKey,
    candidateKey,
    closurePersonId: input.closure.closurePersonId,
  });
  const receipt = buildHumanDispositionLedgerReceipt(entry);
  const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
    input.decision.ownerUserId,
    input.binding.opaqueLineageHandle,
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
    PersonMemoryKeys.personArtifacts(input.decision.ownerUserId, input.closure.closurePersonId),
    PersonMemoryKeys.forgetFence(input.decision.ownerUserId, input.closure.closurePersonId),
    HumanDispositionKeys.receipts(input.decision.ownerUserId),
    HumanDispositionKeys.episodes(input.decision.ownerUserId),
    HumanDispositionKeys.subject(input.decision.ownerUserId, receipt.subjectRef),
  ];
  const subjectKeyStart = keys.length + 1;
  for (const subjectRef of suppressionState.subjectRefs) {
    keys.push(PersonMemoryKeys.suppressionSubject(input.decision.ownerUserId, subjectRef));
  }
  const closureProof = buildClosureProof(input.redis, input.decision, input.closure, locatorKey, keys);
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
      JSON.stringify(input.binding),
      JSON.stringify(updatedBinding),
      JSON.stringify(lineageLocator),
      JSON.stringify(decisionLocator),
      JSON.stringify(receipt),
      receipt.sourceRef,
      receipt.subjectRef,
      String(receipt.decidedAt),
      String(subjectKeyStart),
      String(suppressionState.subjectRefs.length),
      JSON.stringify(closureProof),
      input.closure.bindingKey,
      candidateKey,
    ],
  };
}

export function mapLedgerRejectResult(result: string, mutation: LedgerRejectMutation): RejectAttemptResult {
  if (result === 'UPDATED') return { outcome: 'applied', candidate: mutation.updated };
  if (result === 'REPLAYED') return { outcome: 'replayed', candidate: mutation.replayCandidate };
  if (
    result === 'SNAPSHOT_CONFLICT' ||
    result === 'DECISION_RECEIPT_COLLISION' ||
    result === 'LINEAGE_HANDLE_COLLISION'
  ) {
    return { outcome: 'retry' };
  }
  if (result === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (result === 'CONFLICT') return { outcome: 'conflict' };
  if (result === 'LEGACY_UNMIGRATED') return { outcome: 'legacy_disposition_unmigrated' };
  if (result === 'INVARIANT_FAILURE') return { outcome: 'invariant_failure' };
  if (result === 'BINDING_CONFLICT') return { outcome: 'invariant_failure' };
  throw new Error(`unexpected F276 disposition reject result: ${result}`);
}

export function mapLegacyRejectResult(
  result: string,
  updated: StoredPersonMemoryCandidate,
  replayCandidate: StoredPersonMemoryCandidate,
): RejectAttemptResult {
  if (result === 'UPDATED') return { outcome: 'applied', candidate: updated };
  if (result === 'REPLAYED') return { outcome: 'replayed', candidate: replayCandidate };
  if (result === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (result === 'SNAPSHOT_CONFLICT') return { outcome: 'retry' };
  if (result === 'CONFLICT') return { outcome: 'conflict' };
  throw new Error(`unexpected F276 reject result: ${result}`);
}
