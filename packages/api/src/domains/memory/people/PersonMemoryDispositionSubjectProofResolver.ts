import type { ProactiveCandidateRegistryMatch } from '../ProactiveCandidateRegistryResolver.js';
import type {
  EligiblePersonMemoryDispositionClosure,
  PersonMemoryDispositionProofResolver,
} from './PersonMemoryDispositionProofResolver.js';
import type { PersonMemoryStore } from './PersonMemoryStore.js';

interface CandidateRegistryPort {
  resolve(input: { ownerUserId: string; phrase: string }): Promise<ProactiveCandidateRegistryMatch>;
}

interface DispositionProofPort {
  resolveClosure(
    ownerUserId: string,
    currentInput: Parameters<PersonMemoryDispositionProofResolver['resolveClosure']>[1],
  ): ReturnType<PersonMemoryDispositionProofResolver['resolveClosure']>;
  loadBinding(
    closure: EligiblePersonMemoryDispositionClosure,
  ): ReturnType<PersonMemoryDispositionProofResolver['loadBinding']>;
}

export type PersonMemoryDispositionSubjectProof =
  | {
      status: 'verified';
      subjectRef: string;
      currentSupersessionKey: string;
    }
  | { status: 'unknown' };

export class PersonMemoryDispositionSubjectProofResolver {
  constructor(
    private readonly registry: CandidateRegistryPort,
    private readonly store: Pick<PersonMemoryStore, 'getCandidateForOwner'>,
    private readonly proofResolver: DispositionProofPort,
  ) {}

  async resolve(input: { ownerUserId: string; phrase: string }): Promise<PersonMemoryDispositionSubjectProof> {
    try {
      const match = await this.registry.resolve(input);
      const isF276Candidate =
        (match.kind === 'pending_candidate' || match.kind === 'dormant_candidate') && match.producerId === 'F276';
      if (!isF276Candidate) return { status: 'unknown' };
      const candidate = await this.store.getCandidateForOwner(input.ownerUserId, match.proposalId);
      if (!candidate) return { status: 'unknown' };
      const closure = await this.proofResolver.resolveClosure(input.ownerUserId, candidate);
      if (closure.status !== 'eligible') return { status: 'unknown' };
      const binding = await this.proofResolver.loadBinding(closure);
      const hasExactCurrentBinding =
        binding?.currentCandidateId === candidate.candidateId &&
        candidate.dispositionLineageBindingKey === closure.bindingKey;
      if (!binding || !hasExactCurrentBinding) return { status: 'unknown' };
      return {
        status: 'verified',
        subjectRef: binding.opaqueLineageHandle,
        currentSupersessionKey: binding.currentOpaqueSupersessionHandle,
      };
    } catch {
      return { status: 'unknown' };
    }
  }
}
