import type { ActionSuccessorCompletionResult } from './ActionSuccessorCompletionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import {
  type LocalReviewEvidenceProvider,
  type LocalReviewVerdict,
  localReviewEvidenceRef,
} from './LocalReviewEvidenceProvider.js';

export type LocalReviewVerdictRecordResult =
  | { outcome: 'committed'; leaseId: string; generation: number; evidenceRef: string }
  | { outcome: 'mismatch' | 'insufficient' | 'stale'; reason: string };

export interface LocalReviewVerdictServiceDeps {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get'>;
  evidenceProvider: LocalReviewEvidenceProvider;
  completeActionLease(input: {
    leaseId: string;
    generation: number;
    catId: string;
    evidenceRefs: string[];
    now: number;
  }): Promise<ActionSuccessorCompletionResult>;
}

/**
 * Machine-checkable completion producer for local cat reviews. Unlike the
 * external F168 producer, this path never accepts a GitHub URL or writes a
 * community verdict. It only settles custody after re-reading an already
 * persisted, exact-HEAD verdict from the structured predecessor route.
 */
export class LocalReviewVerdictService {
  constructor(private readonly deps: LocalReviewVerdictServiceDeps) {}

  async record(input: {
    leaseId: string;
    generation: number;
    messageId: string;
    headSha: string;
    verdict: LocalReviewVerdict;
    now: number;
    principal: { catId: string; threadId: string; tenantScope: string };
  }): Promise<LocalReviewVerdictRecordResult> {
    const lease = await this.deps.leaseStore.get(input.leaseId);
    if (!lease) return { outcome: 'stale', reason: 'lease_missing' };
    if (lease.generation !== input.generation) return { outcome: 'stale', reason: 'stale_generation' };
    if (!lease.holderCatIds.includes(input.principal.catId)) {
      return { outcome: 'mismatch', reason: 'local review caller is not a lease holder' };
    }
    if (lease.holderThreadId !== input.principal.threadId || lease.tenantScope !== input.principal.tenantScope) {
      return { outcome: 'mismatch', reason: 'local review callback principal does not match lease' };
    }
    if (lease.actionFamily !== 'review' || lease.successorSlot !== 'reviewer') {
      return { outcome: 'mismatch', reason: 'action lease is not local review custody' };
    }
    if (lease.terminalPredicate?.kind !== 'review_delivered' || !lease.terminalPredicate.headSha) {
      return { outcome: 'insufficient', reason: 'review delivery predicate unavailable' };
    }
    if (lease.terminalPredicate.headSha !== input.headSha) {
      return { outcome: 'mismatch', reason: 'local review input HEAD does not match lease' };
    }

    const evidenceRef = localReviewEvidenceRef({
      messageId: input.messageId,
      generation: input.generation,
      verdict: input.verdict,
    });
    const evidence = await this.deps.evidenceProvider.resolve({
      evidenceRef,
      leaseId: lease.leaseId,
      subjectRef: lease.subjectRef,
      headSha: lease.terminalPredicate.headSha,
      generation: lease.generation,
      reviewerCatId: input.principal.catId,
      holderThreadId: lease.holderThreadId,
      predecessorCatId: lease.predecessorCatId,
      predecessorThreadId: lease.predecessorThreadId,
      tenantScope: lease.tenantScope,
    });
    if (evidence.status !== 'verified') return { outcome: evidence.status, reason: evidence.reason };

    const completion = await this.deps.completeActionLease({
      leaseId: input.leaseId,
      generation: input.generation,
      catId: input.principal.catId,
      evidenceRefs: [evidenceRef],
      now: input.now,
    });
    return completion.outcome === 'committed' ? { ...completion, evidenceRef } : completion;
  }
}
