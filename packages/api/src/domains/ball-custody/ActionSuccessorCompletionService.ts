import type { ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorProjectionRetirementService } from './ActionSuccessorProjectionRetirementService.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

function sameFenceSucceededLease(
  lease: Awaited<ReturnType<ActionSuccessorLeaseStore['get']>>,
  input: { generation: number; catId: string },
): ActionSuccessorLease | null {
  return lease?.generation === input.generation && lease.holderOutcomes[input.catId]?.outcome === 'succeeded'
    ? lease
    : null;
}

export type ActionSuccessorCompletionResult =
  | { outcome: 'committed'; leaseId: string; generation: number }
  | { outcome: 'mismatch' | 'insufficient'; reason: string }
  | { outcome: 'stale'; reason: string };

/**
 * Focused Evidence→Verdict boundary for the canonical lease. Producers submit
 * typed durable refs; this service loads the frozen predicate, asks the
 * server-owned resolver, then performs the success CAS. It owns no state.
 */
export class ActionSuccessorCompletionService {
  constructor(
    private readonly leaseStore: Pick<
      ActionSuccessorLeaseStore,
      'get' | 'recordCompletionCandidate' | 'commitCompletionVerdict'
    >,
    private readonly truthResolver: Pick<ActionSubjectTruthResolver, 'resolveCompletion'>,
    private readonly projectionRetirement?: Pick<ActionSuccessorProjectionRetirementService, 'retire'>,
  ) {}

  private async committed(lease: ActionSuccessorLease, input: { leaseId: string; generation: number }) {
    if (lease.status === 'completed') await this.projectionRetirement?.retire(lease);
    return { outcome: 'committed' as const, leaseId: input.leaseId, generation: input.generation };
  }

  async complete(input: {
    leaseId: string;
    generation: number;
    catId: string;
    evidenceRefs: string[];
    now: number;
  }): Promise<ActionSuccessorCompletionResult> {
    const lease = await this.leaseStore.get(input.leaseId);
    if (!lease) return { outcome: 'stale', reason: 'lease_missing' };
    if (lease.generation !== input.generation) return { outcome: 'stale', reason: 'stale_generation' };
    const replayedLease = sameFenceSucceededLease(lease, input);
    if (replayedLease) return this.committed(replayedLease, input);
    if (lease.status !== 'active') return { outcome: 'stale', reason: 'lease_not_active' };
    if (!lease.terminalPredicate) return { outcome: 'insufficient', reason: 'terminal predicate unavailable' };

    const candidate = await this.leaseStore.recordCompletionCandidate(input.leaseId, {
      generation: input.generation,
      catId: input.catId,
      evidenceRefs: input.evidenceRefs,
      now: input.now,
    });
    if (candidate.outcome !== 'recorded' || !candidate.lease) {
      const replayedCandidate = sameFenceSucceededLease(candidate.lease, input);
      return replayedCandidate
        ? this.committed(replayedCandidate, input)
        : { outcome: 'stale', reason: candidate.outcome };
    }
    const predicate = candidate.lease.terminalPredicate;
    if (!predicate) return { outcome: 'insufficient', reason: 'terminal predicate unavailable after candidate CAS' };
    const candidateSnapshot = candidate.lease.completionCandidates[input.catId];
    if (!candidateSnapshot) return { outcome: 'stale', reason: 'candidate_missing' };
    const verdict = await this.truthResolver.resolveCompletion(predicate, candidateSnapshot, {
      leaseId: candidate.lease.leaseId,
      generation: candidate.lease.generation,
      catId: input.catId,
      holderThreadId: candidate.lease.holderThreadId,
      predecessorCatId: candidate.lease.predecessorCatId,
      predecessorThreadId: candidate.lease.predecessorThreadId,
      tenantScope: candidate.lease.tenantScope,
    });
    if (verdict.status !== 'verified') return { outcome: verdict.status, reason: verdict.reason };

    const committed = await this.leaseStore.commitCompletionVerdict(input.leaseId, {
      generation: input.generation,
      catId: input.catId,
      verdict,
      now: input.now,
    });
    if (committed.outcome === 'committed') return this.committed(committed.lease, input);
    const concurrentlyCommitted = sameFenceSucceededLease(committed.lease, input);
    return concurrentlyCommitted
      ? this.committed(concurrentlyCommitted, input)
      : { outcome: 'stale', reason: committed.outcome };
  }
}
