import {
  type HumanDispositionFeedbackInput,
  humanDispositionFeedbackInputSchema,
  type PersonMemorySuppressionToken,
  personMemorySuppressionTokenSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { HumanDispositionRandomBytesSource } from '../../human-disposition/human-disposition-adapters.js';
import {
  type EligiblePersonMemoryDispositionClosure,
  type EligiblePersonMemoryProposalDispositionClosure,
  PersonMemoryDispositionProofResolver,
} from './PersonMemoryDispositionProofResolver.js';
import type {
  PersonMemoryRejectResult,
  RejectPersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
} from './PersonMemoryStore.js';
import { candidateSubjectRefs } from './person-memory-candidate-registry.js';
import { REJECT_DISPOSITION_CANDIDATE_LUA } from './person-memory-disposition-reject-lua.js';
import {
  mapLedgerRejectResult,
  mapLegacyRejectResult,
  prepareLedgerRejectMutation,
} from './person-memory-disposition-reject-support.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { REJECT_CANDIDATE_LUA } from './person-memory-lua.js';
import { REJECT_PROPOSAL_DISPOSITION_CANDIDATE_LUA } from './person-memory-proposal-disposition-reject-lua.js';
import { prepareProposalLedgerRejectMutation } from './person-memory-proposal-disposition-reject-support.js';
import { parseStoredCandidate } from './person-memory-records.js';

const MAX_REJECT_ATTEMPTS = 3;

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

function candidatePersonId(candidate: StoredPersonMemoryCandidate): string | undefined {
  return candidate.materializedPersonId ?? candidate.targetPersonId;
}

function isRejectable(candidate: StoredPersonMemoryCandidate): boolean {
  return ['pending_approval', 'not_now', 'partially_materialized'].includes(candidate.state);
}

function buildSuppression(
  input: RejectPersonMemoryCandidateInput,
  subjectRefs: string[],
): PersonMemorySuppressionToken {
  return personMemorySuppressionTokenSchema.parse({
    tokenId: `person_suppression_${input.candidateId.replace(/^person_candidate_/, '')}`,
    ownerUserId: input.ownerUserId,
    candidateId: input.candidateId,
    subjectRefs,
    createdAt: input.decidedAt,
  });
}

function applyDecision(
  candidate: StoredPersonMemoryCandidate,
  input: RejectPersonMemoryCandidateInput,
  feedback: HumanDispositionFeedbackInput | undefined,
): StoredPersonMemoryCandidate {
  const updated = terminalCandidate(candidate);
  updated.latestDecisionId = input.decisionId;
  if (feedback) updated.latestHumanDisposition = feedback;
  else delete updated.latestHumanDisposition;
  return updated;
}

function appendLegacyClosureKeys(
  keys: string[],
  input: RejectPersonMemoryCandidateInput,
  candidate: StoredPersonMemoryCandidate,
): { artifactKeyIndex: number; fenceKeyIndex: number } {
  const personId = candidatePersonId(candidate);
  if (!personId) return { artifactKeyIndex: 0, fenceKeyIndex: 0 };
  const artifactKeyIndex = keys.push(PersonMemoryKeys.personArtifacts(input.ownerUserId, personId));
  const fenceKeyIndex = keys.push(PersonMemoryKeys.forgetFence(input.ownerUserId, personId));
  return { artifactKeyIndex, fenceKeyIndex };
}

export class PersonMemoryDispositionReject {
  constructor(
    private readonly redis: RedisClient,
    private readonly resolver: PersonMemoryDispositionProofResolver,
    private readonly randomBytesSource?: HumanDispositionRandomBytesSource,
  ) {}

  async reject(input: RejectPersonMemoryCandidateInput): Promise<PersonMemoryRejectResult> {
    const feedback = input.feedback ? humanDispositionFeedbackInputSchema.parse(input.feedback) : undefined;
    const candidateKey = PersonMemoryKeys.candidate(input.ownerUserId, input.candidateId);

    for (let attempt = 0; attempt < MAX_REJECT_ATTEMPTS; attempt += 1) {
      const expectedRaw = await this.redis.get(candidateKey);
      if (expectedRaw === null) return { outcome: 'not_available' };
      const candidate = parseStoredCandidate(expectedRaw);
      if (!candidate) return { outcome: 'not_available' };
      const closure = await this.resolver.resolveClosure(input.ownerUserId, candidate);
      if (closure.status === 'proposal_purge_eligible') {
        const result = await this.rejectWithProposalLedger(input, candidate, expectedRaw, closure, feedback);
        if (result.outcome === 'retry') continue;
        return result;
      }
      if (closure.status === 'unbound_or_mixed_forget_dependency') {
        const result = await this.rejectWithoutLedger(input, candidate, expectedRaw, feedback);
        if (result.outcome === 'retry') continue;
        return result;
      }
      if (closure.status !== 'eligible') return { outcome: 'invariant_failure' };

      const result = await this.rejectWithLedger(input, candidate, expectedRaw, closure, feedback);
      if (result.outcome === 'retry') continue;
      return result;
    }
    return { outcome: 'conflict' };
  }

  private async rejectWithProposalLedger(
    input: RejectPersonMemoryCandidateInput,
    candidate: StoredPersonMemoryCandidate,
    expectedRaw: string,
    closure: EligiblePersonMemoryProposalDispositionClosure,
    feedback: HumanDispositionFeedbackInput | undefined,
  ): Promise<PersonMemoryRejectResult | { outcome: 'retry' }> {
    const isLedgerReplay = candidate.state === 'rejected' && candidate.humanDispositionLedgerEntry !== undefined;
    if (!isRejectable(candidate) && candidate.state !== 'rejected') return { outcome: 'conflict' };
    if (candidate.state === 'rejected' && !isLedgerReplay) {
      return { outcome: 'legacy_disposition_unmigrated' };
    }
    const binding = isLedgerReplay ? await this.resolver.loadProposalBinding(closure) : null;
    if (isLedgerReplay && !binding) return { outcome: 'invariant_failure' };
    if (
      isLedgerReplay &&
      (candidate.dispositionLineageBindingKey !== closure.bindingKey ||
        binding?.currentCandidateId !== candidate.candidateId)
    ) {
      return { outcome: 'invariant_failure' };
    }
    const mutation = await prepareProposalLedgerRejectMutation({
      redis: this.redis,
      decision: input,
      candidate,
      expectedRaw,
      closure,
      binding,
      feedback,
      randomBytesSource: this.randomBytesSource,
    });
    if (!mutation) return { outcome: 'invariant_failure' };
    const result = String(
      await this.redis.eval(
        REJECT_PROPOSAL_DISPOSITION_CANDIDATE_LUA,
        mutation.keys.length,
        ...mutation.keys,
        ...mutation.args,
      ),
    );
    return mapLedgerRejectResult(result, mutation);
  }

  private async rejectWithLedger(
    input: RejectPersonMemoryCandidateInput,
    candidate: StoredPersonMemoryCandidate,
    expectedRaw: string,
    closure: EligiblePersonMemoryDispositionClosure,
    feedback: HumanDispositionFeedbackInput | undefined,
  ): Promise<PersonMemoryRejectResult | { outcome: 'retry' }> {
    const binding = await this.resolver.loadBinding(closure);
    if (!binding) {
      return {
        outcome: candidate.state === 'rejected' ? 'legacy_disposition_unmigrated' : 'invariant_failure',
      };
    }
    if (
      candidate.dispositionLineageBindingKey !== closure.bindingKey ||
      binding.currentCandidateId !== candidate.candidateId
    ) {
      return { outcome: 'invariant_failure' };
    }
    const mutation = await prepareLedgerRejectMutation({
      redis: this.redis,
      decision: input,
      candidate,
      expectedRaw,
      closure,
      binding,
      feedback,
      randomBytesSource: this.randomBytesSource,
    });
    if (!mutation) return { outcome: 'invariant_failure' };
    const result = String(
      await this.redis.eval(REJECT_DISPOSITION_CANDIDATE_LUA, mutation.keys.length, ...mutation.keys, ...mutation.args),
    );
    return mapLedgerRejectResult(result, mutation);
  }

  private async rejectWithoutLedger(
    input: RejectPersonMemoryCandidateInput,
    candidate: StoredPersonMemoryCandidate,
    expectedRaw: string,
    feedback: HumanDispositionFeedbackInput | undefined,
  ): Promise<PersonMemoryRejectResult | { outcome: 'retry' }> {
    const rejectable = isRejectable(candidate);
    const subjectRefs = rejectable ? candidateSubjectRefs(candidate) : [];
    if (rejectable && subjectRefs.length === 0) return { outcome: 'conflict' };
    const updated = applyDecision(candidate, input, feedback);
    const suppression = rejectable ? buildSuppression(input, subjectRefs) : null;
    const keys = [
      PersonMemoryKeys.candidate(input.ownerUserId, input.candidateId),
      PersonMemoryKeys.pending(input.ownerUserId),
      PersonMemoryKeys.suppression(input.ownerUserId, input.candidateId),
      ...subjectRefs.map((subjectRef) => PersonMemoryKeys.suppressionSubject(input.ownerUserId, subjectRef)),
    ];
    const subjectKeyStart = subjectRefs.length > 0 ? 4 : 0;
    const { artifactKeyIndex, fenceKeyIndex } = rejectable
      ? appendLegacyClosureKeys(keys, input, candidate)
      : { artifactKeyIndex: 0, fenceKeyIndex: 0 };
    const result = String(
      await this.redis.eval(
        REJECT_CANDIDATE_LUA,
        keys.length,
        ...keys,
        expectedRaw,
        JSON.stringify(updated),
        input.candidateId,
        suppression ? JSON.stringify(suppression) : '',
        input.decisionId,
        feedback ? JSON.stringify(feedback) : '',
        String(fenceKeyIndex),
        String(artifactKeyIndex),
        String(subjectKeyStart),
        String(subjectRefs.length),
      ),
    );
    return mapLegacyRejectResult(result, updated, candidate);
  }
}
