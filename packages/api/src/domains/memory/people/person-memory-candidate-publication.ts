import {
  type ApprovalEnvelope,
  assertApprovalEnvelopeIdentity,
  captureCandidateIdSchema,
  captureCandidateSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { StagePersonMemoryCandidateInput, StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import { candidateRepresentsPerson } from './person-memory-candidate-identity.js';
import { PersonMemoryDispositionAnchor } from './person-memory-disposition-anchor.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import {
  ABORT_STAGED_CANDIDATE_LUA,
  COMMIT_CANDIDATE_ENVELOPE_LUA,
  COMMIT_REPLACEMENT_ENVELOPE_LUA,
  STAGE_CANDIDATE_LUA,
} from './person-memory-lua.js';
import { parseStoredCandidate } from './person-memory-records.js';

function terminalWithdrawn(
  candidate: StoredPersonMemoryCandidate,
  replacementId: StoredPersonMemoryCandidate['candidateId'],
): StoredPersonMemoryCandidate {
  const {
    personDraft: _personDraft,
    relationshipDraft: _relationshipDraft,
    interactionDraft: _interactionDraft,
    sourceBundle: _sourceBundle,
    ...base
  } = candidate;
  return {
    ...base,
    state: 'withdrawn',
    claimDrafts: [],
    remainingDraftIds: [],
    replacedByProposalId: replacementId,
  };
}

function candidatePersonId(candidate: StoredPersonMemoryCandidate): string | undefined {
  return candidate.materializedPersonId ?? candidate.targetPersonId;
}

export class PersonMemoryCandidatePublication {
  constructor(
    private readonly redis: RedisClient,
    private readonly dispositionAnchor: PersonMemoryDispositionAnchor,
  ) {}

  async stage(input: StagePersonMemoryCandidateInput): Promise<StoredPersonMemoryCandidate> {
    const validated = captureCandidateSchema.parse({
      ...input,
      state: 'pending_approval',
      presentedAt: input.createdAt,
    });
    const stored: StoredPersonMemoryCandidate = {
      ...input,
      candidateId: validated.candidateId,
      personDraft: validated.personDraft,
      claimDrafts: validated.claimDrafts,
      relationshipDraft: validated.relationshipDraft,
      interactionDraft: validated.interactionDraft,
      remainingDraftIds: validated.remainingDraftIds,
      state: 'staged',
      publication: { state: 'staged', stagedAt: input.createdAt },
    };
    const keys = [
      PersonMemoryKeys.candidate(input.ownerUserId, input.candidateId),
      PersonMemoryKeys.candidateOwner(input.candidateId),
    ];
    if (input.targetPersonId) {
      keys.push(
        PersonMemoryKeys.forgetFence(input.ownerUserId, input.targetPersonId),
        PersonMemoryKeys.targetCandidates(input.ownerUserId, input.targetPersonId),
        PersonMemoryKeys.personArtifacts(input.ownerUserId, input.targetPersonId),
      );
    }
    const result = String(
      await this.redis.eval(
        STAGE_CANDIDATE_LUA,
        keys.length,
        ...keys,
        JSON.stringify(stored),
        input.candidateId,
        input.ownerUserId,
      ),
    );
    if (result === 'STAGED') return stored;
    if (result === 'NOT_AVAILABLE') throw new Error('target person is being forgotten');
    if (result === 'EXISTS') {
      const existing = await this.get(input.ownerUserId, input.candidateId);
      if (existing && JSON.stringify(existing) === JSON.stringify(stored)) return existing;
      throw new Error('candidate ID already exists');
    }
    throw new Error(`unexpected F276 stage result: ${result}`);
  }

  async commit(candidateId: string, envelope: ApprovalEnvelope): Promise<void> {
    const parsedCandidateId = captureCandidateIdSchema.parse(candidateId);
    const candidate = await this.get(envelope.ownerUserId, parsedCandidateId);
    if (!candidate) throw new Error('F276 candidate not found');
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: candidate.candidateId,
      sourceFeatureId: 'F276',
      ownerUserId: candidate.ownerUserId,
      requesterCatId: candidate.requesterCatId,
      createdAt: candidate.createdAt,
    });
    if (candidate.publication.state === 'anchored') {
      if (JSON.stringify(candidate.publication.envelope) !== JSON.stringify(envelope)) {
        throw new Error('conflicting F276 approval envelope');
      }
      return;
    }
    if (candidate.publication.state !== 'staged' || candidate.state !== 'staged') {
      throw new Error('F276 candidate is not staged');
    }
    const presentedAt = Date.now();
    const anchored: StoredPersonMemoryCandidate = {
      ...candidate,
      state: 'pending_approval',
      publication: { state: 'anchored', envelope },
      presentedAt,
    };
    if (candidate.replacesProposalId) {
      const dispositionResult = await this.dispositionAnchor.commitReplacement(candidate, anchored, presentedAt);
      if (dispositionResult === 'anchored') return;
      await this.commitReplacement(candidate, anchored, presentedAt);
      return;
    }
    const dispositionResult = await this.dispositionAnchor.commitRoot(candidate, anchored, presentedAt);
    if (dispositionResult === 'anchored') return;
    const keys = [
      PersonMemoryKeys.candidate(candidate.ownerUserId, candidate.candidateId),
      PersonMemoryKeys.pending(candidate.ownerUserId),
    ];
    const personId = candidatePersonId(candidate);
    if (personId) keys.push(PersonMemoryKeys.forgetFence(candidate.ownerUserId, personId));
    const result = String(
      await this.redis.eval(
        COMMIT_CANDIDATE_ENVELOPE_LUA,
        keys.length,
        ...keys,
        JSON.stringify(anchored),
        String(presentedAt),
        candidate.candidateId,
      ),
    );
    if (result !== 'ANCHORED') throw new Error(`F276 envelope commit failed: ${result}`);
  }

  async abort(candidateId: string): Promise<void> {
    const owner = await this.redis.get(PersonMemoryKeys.candidateOwner(candidateId));
    if (!owner) return;
    const candidate = await this.get(owner, candidateId);
    if (!candidate) return;
    const keys = [PersonMemoryKeys.candidate(owner, candidateId), PersonMemoryKeys.candidateOwner(candidateId)];
    if (candidate.targetPersonId) {
      keys.push(
        PersonMemoryKeys.forgetFence(owner, candidate.targetPersonId),
        PersonMemoryKeys.targetCandidates(owner, candidate.targetPersonId),
        PersonMemoryKeys.personArtifacts(owner, candidate.targetPersonId),
      );
    }
    await this.redis.eval(ABORT_STAGED_CANDIDATE_LUA, keys.length, ...keys, candidateId);
  }

  private async commitReplacement(
    candidate: StoredPersonMemoryCandidate,
    anchored: StoredPersonMemoryCandidate,
    presentedAt: number,
  ): Promise<void> {
    const originalId = candidate.replacesProposalId;
    if (!originalId || originalId === candidate.candidateId) {
      throw new Error('F276 replacement cannot reference itself');
    }
    const original = await this.get(candidate.ownerUserId, originalId);
    if (!original) throw new Error('F276 replacement candidate not found');
    if (!candidate.personDraft || !candidateRepresentsPerson(original, candidate.personDraft)) {
      throw new Error('F276 replacement identity conflict');
    }
    const withdrawn = terminalWithdrawn(original, candidate.candidateId);
    const result = String(
      await this.redis.eval(
        COMMIT_REPLACEMENT_ENVELOPE_LUA,
        5,
        PersonMemoryKeys.candidate(candidate.ownerUserId, candidate.candidateId),
        PersonMemoryKeys.pending(candidate.ownerUserId),
        PersonMemoryKeys.candidate(candidate.ownerUserId, original.candidateId),
        candidatePersonId(candidate)
          ? PersonMemoryKeys.forgetFence(candidate.ownerUserId, candidatePersonId(candidate) as string)
          : '',
        candidatePersonId(original)
          ? PersonMemoryKeys.forgetFence(original.ownerUserId, candidatePersonId(original) as string)
          : '',
        JSON.stringify(anchored),
        String(presentedAt),
        candidate.candidateId,
        JSON.stringify(withdrawn),
        original.candidateId,
      ),
    );
    if (result !== 'ANCHORED') throw new Error(`F276 replacement envelope commit failed: ${result}`);
  }

  private async get(ownerUserId: string, candidateId: string): Promise<StoredPersonMemoryCandidate | null> {
    return parseStoredCandidate(await this.redis.get(PersonMemoryKeys.candidate(ownerUserId, candidateId)));
  }
}
