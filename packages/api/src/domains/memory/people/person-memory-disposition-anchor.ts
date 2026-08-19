import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type HumanDispositionRandomBytesSource,
  mintPersonMemoryDispositionOpaqueProof,
} from '../../human-disposition/human-disposition-adapters.js';
import {
  type EligiblePersonMemoryDispositionClosure,
  PersonMemoryDispositionProofResolver,
} from './PersonMemoryDispositionProofResolver.js';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import {
  COMMIT_DISPOSITION_REPLACEMENT_ENVELOPE_LUA,
  COMMIT_DISPOSITION_ROOT_ENVELOPE_LUA,
} from './person-memory-disposition-anchor-lua.js';
import {
  personMemoryDispositionLineageBindingSchema,
  personMemoryDispositionLineageHandleLocatorSchema,
} from './person-memory-disposition-records.js';
import { PersonMemoryKeys } from './person-memory-keys.js';

const MAX_HANDLE_ATTEMPTS = 3;

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

function membershipKey(closure: EligiblePersonMemoryDispositionClosure): string {
  return closure.current.materializedPersonId
    ? PersonMemoryKeys.personCandidates(closure.ownerUserId, closure.closurePersonId)
    : PersonMemoryKeys.targetCandidates(closure.ownerUserId, closure.closurePersonId);
}

export class PersonMemoryDispositionAnchor {
  constructor(
    private readonly redis: RedisClient,
    private readonly resolver: PersonMemoryDispositionProofResolver,
    private readonly randomBytesSource?: HumanDispositionRandomBytesSource,
  ) {}

  async commitRoot(
    candidate: StoredPersonMemoryCandidate,
    anchoredInput: StoredPersonMemoryCandidate,
    presentedAt: number,
  ): Promise<'anchored' | 'ineligible'> {
    const closure = await this.resolver.resolveClosure(candidate.ownerUserId, candidate);
    if (closure.status === 'unbound_or_mixed_forget_dependency' || closure.status === 'proposal_purge_eligible') {
      return 'ineligible';
    }
    if (closure.status !== 'eligible' || closure.root.candidateId !== candidate.candidateId) {
      throw new Error('F276 disposition root closure is unknown');
    }

    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
      const proof = mintPersonMemoryDispositionOpaqueProof(this.randomBytesSource);
      const binding = personMemoryDispositionLineageBindingSchema.parse({
        version: 1,
        ownerUserId: candidate.ownerUserId,
        closurePersonId: closure.closurePersonId,
        rootCandidateId: candidate.candidateId,
        currentCandidateId: candidate.candidateId,
        opaqueLineageHandle: proof.opaqueLineageHandle,
        currentOpaqueProposalHandle: proof.opaqueProposalHandle,
        currentOpaqueSupersessionHandle: proof.opaqueSupersessionHandle,
      });
      const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
        candidate.ownerUserId,
        binding.opaqueLineageHandle,
      );
      const locator = personMemoryDispositionLineageHandleLocatorSchema.parse({
        bindingKey: closure.bindingKey,
        closurePersonId: closure.closurePersonId,
      });
      const anchored: StoredPersonMemoryCandidate = {
        ...anchoredInput,
        dispositionLineageBindingKey: closure.bindingKey,
      };
      const candidateKey = PersonMemoryKeys.candidate(candidate.ownerUserId, candidate.candidateId);
      const result = String(
        await this.redis.eval(
          COMMIT_DISPOSITION_ROOT_ENVELOPE_LUA,
          7,
          candidateKey,
          PersonMemoryKeys.pending(candidate.ownerUserId),
          PersonMemoryKeys.forgetFence(candidate.ownerUserId, closure.closurePersonId),
          closure.bindingKey,
          locatorKey,
          PersonMemoryKeys.personArtifacts(candidate.ownerUserId, closure.closurePersonId),
          membershipKey(closure),
          JSON.stringify(candidate),
          JSON.stringify(anchored),
          String(presentedAt),
          candidate.candidateId,
          JSON.stringify(binding),
          JSON.stringify(locator),
          closure.bindingKey,
          locatorKey,
        ),
      );
      if (result === 'ANCHORED') return 'anchored';
      if (result === 'LINEAGE_HANDLE_COLLISION') continue;
      throw new Error(`F276 disposition root anchor failed: ${result}`);
    }
    throw new Error('F276 disposition lineage handle collision retry exhausted');
  }

  async commitReplacement(
    candidate: StoredPersonMemoryCandidate,
    anchoredInput: StoredPersonMemoryCandidate,
    presentedAt: number,
  ): Promise<'anchored' | 'ineligible'> {
    const closure = await this.resolver.resolveClosure(candidate.ownerUserId, candidate);
    if (closure.status === 'unbound_or_mixed_forget_dependency' || closure.status === 'proposal_purge_eligible') {
      return 'ineligible';
    }
    if (closure.status !== 'eligible' || !candidate.replacesProposalId) {
      throw new Error('F276 disposition replacement closure is unknown');
    }
    const original = closure.chain[1];
    const binding = await this.resolver.loadBinding(closure);
    if (
      !original ||
      !binding ||
      binding.currentCandidateId !== original.candidateId ||
      original.dispositionLineageBindingKey !== closure.bindingKey
    ) {
      throw new Error('F276 disposition replacement binding conflict');
    }

    const fresh = mintPersonMemoryDispositionOpaqueProof(this.randomBytesSource);
    const updatedBinding = personMemoryDispositionLineageBindingSchema.parse({
      ...binding,
      currentCandidateId: candidate.candidateId,
      currentOpaqueProposalHandle: fresh.opaqueProposalHandle,
      currentOpaqueSupersessionHandle: fresh.opaqueSupersessionHandle,
      latestDecisionReceiptHandle: undefined,
    });
    const anchored: StoredPersonMemoryCandidate = {
      ...anchoredInput,
      dispositionLineageBindingKey: closure.bindingKey,
    };
    const withdrawn = terminalWithdrawn(original, candidate.candidateId);
    const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
      candidate.ownerUserId,
      binding.opaqueLineageHandle,
    );
    const locator = personMemoryDispositionLineageHandleLocatorSchema.parse({
      bindingKey: closure.bindingKey,
      closurePersonId: closure.closurePersonId,
    });
    const result = String(
      await this.redis.eval(
        COMMIT_DISPOSITION_REPLACEMENT_ENVELOPE_LUA,
        8,
        PersonMemoryKeys.candidate(candidate.ownerUserId, candidate.candidateId),
        PersonMemoryKeys.pending(candidate.ownerUserId),
        PersonMemoryKeys.candidate(candidate.ownerUserId, original.candidateId),
        PersonMemoryKeys.forgetFence(candidate.ownerUserId, closure.closurePersonId),
        closure.bindingKey,
        locatorKey,
        PersonMemoryKeys.personArtifacts(candidate.ownerUserId, closure.closurePersonId),
        membershipKey(closure),
        JSON.stringify(candidate),
        JSON.stringify(original),
        JSON.stringify(anchored),
        JSON.stringify(withdrawn),
        String(presentedAt),
        candidate.candidateId,
        original.candidateId,
        JSON.stringify(binding),
        JSON.stringify(updatedBinding),
        JSON.stringify(locator),
      ),
    );
    if (result !== 'ANCHORED') throw new Error(`F276 disposition replacement anchor failed: ${result}`);
    return 'anchored';
  }
}
