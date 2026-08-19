import {
  type ApprovalEnvelope,
  assertApprovalEnvelopeIdentity,
  captureCandidateIdSchema,
  captureCandidateSchema,
  deferredPersonMemoryReceiptSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DeferredPersonMemoryReceiptKeys } from '../deferred-person-memory-redis-contract.js';
import type {
  RenewDeferredPersonMemoryCandidateClaimInput,
  RenewDeferredPersonMemoryCandidateClaimResult,
  StagePersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
} from './PersonMemoryStore.js';
import { candidateRepresentsPerson } from './person-memory-candidate-identity.js';
import { deferredReceiptLineageMarker, personMemoryProposalLineageMarker } from './person-memory-delta-lineage.js';
import { PersonMemoryDispositionAnchor } from './person-memory-disposition-anchor.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import {
  ABORT_STAGED_CANDIDATE_LUA,
  COMMIT_CANDIDATE_ENVELOPE_LUA,
  COMMIT_DEFERRED_CANDIDATE_ENVELOPE_LUA,
  COMMIT_REPLACEMENT_ENVELOPE_LUA,
  RENEW_DEFERRED_CANDIDATE_CLAIM_LUA,
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

export class PersonMemoryDeltaConflictError extends Error {
  constructor() {
    super('F276 exact person-memory delta already has active lineage');
    this.name = 'PersonMemoryDeltaConflictError';
  }
}

export class DeferredPersonMemoryCommitConflictError extends Error {
  constructor(result: string) {
    super(`F276 deferred receipt commit failed: ${result}`);
    this.name = 'DeferredPersonMemoryCommitConflictError';
  }
}

export class PersonMemoryCandidatePublication {
  constructor(
    private readonly redis: RedisClient,
    private readonly dispositionAnchor: PersonMemoryDispositionAnchor,
  ) {}

  async stage(input: StagePersonMemoryCandidateInput): Promise<StoredPersonMemoryCandidate> {
    const {
      deferredReceiptClaimId: _deferredReceiptClaimId,
      deltaFingerprint: _deltaFingerprint,
      ...candidateContract
    } = input;
    const validated = captureCandidateSchema.parse({
      ...candidateContract,
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
    const lineageKey =
      input.deltaFingerprint && !input.deferredReceiptId
        ? DeferredPersonMemoryReceiptKeys.dedupe(input.ownerUserId, input.deltaFingerprint)
        : '';
    const candidateKey = PersonMemoryKeys.candidate(input.ownerUserId, input.candidateId);
    const keys = [
      candidateKey,
      PersonMemoryKeys.candidateOwner(input.candidateId),
      lineageKey || candidateKey,
      candidateKey,
      candidateKey,
      candidateKey,
    ];
    if (input.targetPersonId) {
      keys[3] = PersonMemoryKeys.forgetFence(input.ownerUserId, input.targetPersonId);
      keys[4] = PersonMemoryKeys.targetCandidates(input.ownerUserId, input.targetPersonId);
      keys[5] = PersonMemoryKeys.personArtifacts(input.ownerUserId, input.targetPersonId);
    }
    const result = String(
      await this.redis.eval(
        STAGE_CANDIDATE_LUA,
        keys.length,
        ...keys,
        JSON.stringify(stored),
        input.candidateId,
        input.ownerUserId,
        personMemoryProposalLineageMarker(input.candidateId),
        lineageKey ? '1' : '0',
        input.targetPersonId ? '1' : '0',
      ),
    );
    if (result === 'STAGED') return stored;
    if (result === 'NOT_AVAILABLE') throw new Error('target person is being forgotten');
    if (result === 'DELTA_CONFLICT') throw new PersonMemoryDeltaConflictError();
    if (result === 'EXISTS') {
      const existing = await this.get(input.ownerUserId, input.candidateId);
      if (existing && JSON.stringify(existing) === JSON.stringify(stored)) return existing;
      throw new Error('candidate ID already exists');
    }
    throw new Error(`unexpected F276 stage result: ${result}`);
  }

  async renewDeferredClaim(
    input: RenewDeferredPersonMemoryCandidateClaimInput,
  ): Promise<RenewDeferredPersonMemoryCandidateClaimResult> {
    const candidateKey = PersonMemoryKeys.candidate(input.ownerUserId, input.candidateId);
    const rawCandidate = await this.redis.get(candidateKey);
    const current = parseStoredCandidate(rawCandidate);
    if (!rawCandidate || !current) return { outcome: 'not_available' };
    const renewedCandidate: StoredPersonMemoryCandidate = {
      ...current,
      deferredReceiptClaimId: input.nextClaimId,
    };
    const personId = candidatePersonId(current);
    const result = String(
      await this.redis.eval(
        RENEW_DEFERRED_CANDIDATE_CLAIM_LUA,
        3,
        candidateKey,
        DeferredPersonMemoryReceiptKeys.receipt(input.ownerUserId, input.receiptId),
        personId ? PersonMemoryKeys.forgetFence(input.ownerUserId, personId) : candidateKey,
        input.ownerUserId,
        input.candidateId,
        input.receiptId,
        input.previousClaimId,
        input.nextClaimId,
        input.deltaFingerprint,
        String(input.renewedAt),
        rawCandidate,
        JSON.stringify(renewedCandidate),
        personId ? '1' : '0',
      ),
    );
    if (result === 'RENEWED' || result === 'REPLAYED') {
      const candidate = await this.get(input.ownerUserId, input.candidateId);
      if (!candidate) return { outcome: 'not_available' };
      return { outcome: result === 'RENEWED' ? 'renewed' : 'replayed', candidate };
    }
    return { outcome: result === 'NOT_AVAILABLE' ? 'not_available' : 'conflict' };
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
    const { deferredReceiptClaimId: _claimId, ...candidateAfterClaim } = candidate;
    const anchored: StoredPersonMemoryCandidate = {
      ...candidateAfterClaim,
      state: 'pending_approval',
      publication: { state: 'anchored', envelope },
      presentedAt,
    };
    if (candidate.deferredReceiptId) {
      await this.commitDeferred(candidate, anchored, presentedAt);
      return;
    }
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
    const lineageKey =
      candidate.deltaFingerprint && !candidate.deferredReceiptId
        ? DeferredPersonMemoryReceiptKeys.dedupe(owner, candidate.deltaFingerprint)
        : '';
    const candidateKey = PersonMemoryKeys.candidate(owner, candidateId);
    const keys = [
      candidateKey,
      PersonMemoryKeys.candidateOwner(candidateId),
      lineageKey || candidateKey,
      candidateKey,
      candidateKey,
      candidateKey,
    ];
    if (candidate.targetPersonId) {
      keys[3] = PersonMemoryKeys.forgetFence(owner, candidate.targetPersonId);
      keys[4] = PersonMemoryKeys.targetCandidates(owner, candidate.targetPersonId);
      keys[5] = PersonMemoryKeys.personArtifacts(owner, candidate.targetPersonId);
    }
    await this.redis.eval(
      ABORT_STAGED_CANDIDATE_LUA,
      keys.length,
      ...keys,
      candidateId,
      personMemoryProposalLineageMarker(candidateId),
      lineageKey ? '1' : '0',
      candidate.targetPersonId ? '1' : '0',
    );
  }

  private async commitDeferred(
    candidate: StoredPersonMemoryCandidate,
    anchored: StoredPersonMemoryCandidate,
    presentedAt: number,
  ): Promise<void> {
    const receiptId = candidate.deferredReceiptId;
    const claimId = candidate.deferredReceiptClaimId;
    const fingerprint = candidate.deltaFingerprint;
    if (!receiptId || !claimId || !fingerprint) throw new DeferredPersonMemoryCommitConflictError('INCOMPLETE');
    const receiptKey = DeferredPersonMemoryReceiptKeys.receipt(candidate.ownerUserId, receiptId);
    const rawReceipt = await this.redis.get(receiptKey);
    const receipt = rawReceipt ? deferredPersonMemoryReceiptSchema.safeParse(JSON.parse(rawReceipt)) : null;
    if (!receipt?.success || !receipt.data.registryBinding) {
      throw new DeferredPersonMemoryCommitConflictError('NOT_AVAILABLE');
    }
    const terminalReceipt = deferredPersonMemoryReceiptSchema.parse({
      receiptId,
      ownerUserId: candidate.ownerUserId,
      requesterCatId: receipt.data.requesterCatId,
      dedupeHash: fingerprint,
      state: 'proposed',
      proposalId: candidate.candidateId,
      retention: receipt.data.retention,
      createdAt: receipt.data.createdAt,
      updatedAt: presentedAt,
    });
    const personId = candidatePersonId(candidate);
    const candidateKey = PersonMemoryKeys.candidate(candidate.ownerUserId, candidate.candidateId);
    const result = String(
      await this.redis.eval(
        COMMIT_DEFERRED_CANDIDATE_ENVELOPE_LUA,
        8,
        candidateKey,
        PersonMemoryKeys.pending(candidate.ownerUserId),
        personId ? PersonMemoryKeys.forgetFence(candidate.ownerUserId, personId) : candidateKey,
        receiptKey,
        DeferredPersonMemoryReceiptKeys.ready(candidate.ownerUserId),
        DeferredPersonMemoryReceiptKeys.proposal(candidate.ownerUserId, candidate.candidateId),
        DeferredPersonMemoryReceiptKeys.binding(
          candidate.ownerUserId,
          receipt.data.registryBinding.kind,
          receipt.data.registryBinding.ref,
        ),
        DeferredPersonMemoryReceiptKeys.dedupe(candidate.ownerUserId, fingerprint),
        JSON.stringify(anchored),
        String(presentedAt),
        candidate.candidateId,
        JSON.stringify(terminalReceipt),
        receiptId,
        claimId,
        fingerprint,
        deferredReceiptLineageMarker(receiptId),
        personMemoryProposalLineageMarker(candidate.candidateId),
        personId ? '1' : '0',
      ),
    );
    if (result !== 'ANCHORED') throw new DeferredPersonMemoryCommitConflictError(result);
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
