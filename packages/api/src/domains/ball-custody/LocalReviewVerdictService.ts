import type { ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type { ActionSuccessorCompletionResult } from './ActionSuccessorCompletionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import {
  type LocalReviewEvidenceProvider,
  type LocalReviewVerdict,
  localReviewEvidenceRef,
} from './LocalReviewEvidenceProvider.js';

export type LocalReviewVerdictRecordResult =
  | { outcome: 'committed'; leaseId: string; generation: number; evidenceRef: string }
  | { outcome: 'mismatch' | 'insufficient' | 'stale'; reason: string };

export interface LocalReviewVerdictServiceDeps {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'recoverLocalReviewVerdict'>;
  evidenceProvider: LocalReviewEvidenceProvider;
  truthResolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>;
  completeActionLease(input: {
    leaseId: string;
    generation: number;
    catId: string;
    evidenceRefs: string[];
    now: number;
  }): Promise<ActionSuccessorCompletionResult>;
}

interface LocalReviewRecoveryInput {
  leaseId: string;
  generation: number;
  messageId: string;
  headSha: string;
  verdict: LocalReviewVerdict;
  now: number;
  principal: { catId: string; threadId: string; tenantScope: string };
}

type ReviewDeliveryTerminalPredicate = CanonicalActionTerminalPredicate & {
  readonly kind: 'review_delivered';
  readonly headSha: string;
};

type LocalReviewRecoveryPreflight =
  | {
      ok: true;
      reviewerCatId: string;
      terminalPredicate: ReviewDeliveryTerminalPredicate;
    }
  | { ok: false; result: Exclude<LocalReviewVerdictRecordResult, { outcome: 'committed' }> };

function matchesRecoveryPrincipal(lease: ActionSuccessorLease, input: LocalReviewRecoveryInput): boolean {
  return lease.predecessorThreadId === input.principal.threadId && lease.tenantScope === input.principal.tenantScope;
}

function isUntouchedRecoveryGeneration(lease: ActionSuccessorLease): boolean {
  return Object.keys(lease.holderOutcomes).length === 0 && Object.keys(lease.completionCandidates).length === 0;
}

function preflightLocalReviewRecovery(
  lease: ActionSuccessorLease,
  input: LocalReviewRecoveryInput,
): LocalReviewRecoveryPreflight {
  if (lease.generation !== input.generation) {
    return { ok: false, result: { outcome: 'stale', reason: 'stale_generation' } };
  }
  if (lease.status !== 'active') return { ok: false, result: { outcome: 'stale', reason: 'lease_not_active' } };
  if (lease.actionFamily !== 'review' || lease.successorSlot !== 'reviewer') {
    return { ok: false, result: { outcome: 'mismatch', reason: 'action lease is not local review custody' } };
  }
  const reviewerCatId = lease.holderCatIds[0];
  if (lease.mode !== 'single' || lease.holderCatIds.length !== 1 || !reviewerCatId) {
    return { ok: false, result: { outcome: 'mismatch', reason: 'local review recovery requires one review holder' } };
  }
  if (lease.claimOrigin !== 'structured_transfer' || !lease.predecessorCatId || !lease.predecessorThreadId) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery requires structured predecessor custody' },
    };
  }
  if (lease.predecessorCatId !== input.principal.catId) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery caller is not the lease predecessor' },
    };
  }
  if (!matchesRecoveryPrincipal(lease, input)) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery principal does not match the predecessor route' },
    };
  }
  if (!isUntouchedRecoveryGeneration(lease)) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery requires an untouched active generation' },
    };
  }
  if (lease.returnTransitions.length > 0) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'local review recovery does not accept returned generations' },
    };
  }
  if (lease.terminalPredicate?.kind !== 'review_delivered' || !lease.terminalPredicate.headSha) {
    return { ok: false, result: { outcome: 'insufficient', reason: 'review delivery predicate unavailable' } };
  }
  if (lease.terminalPredicate.headSha !== input.headSha) {
    return { ok: false, result: { outcome: 'mismatch', reason: 'local review input HEAD does not match lease' } };
  }
  return {
    ok: true,
    reviewerCatId,
    terminalPredicate: {
      ...lease.terminalPredicate,
      kind: 'review_delivered',
      headSha: lease.terminalPredicate.headSha,
    },
  };
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

  /**
   * Historical settlement for one carrierless review verdict after the PR HEAD
   * has advanced. The persisted predecessor is the recovery principal; normal
   * holder completion and active replacement keep their existing auth paths.
   */
  async recover(input: LocalReviewRecoveryInput): Promise<LocalReviewVerdictRecordResult> {
    const lease = await this.deps.leaseStore.get(input.leaseId);
    if (!lease) return { outcome: 'stale', reason: 'lease_missing' };
    const preflight = preflightLocalReviewRecovery(lease, input);
    if (!preflight.ok) return preflight.result;

    const { reviewerCatId, terminalPredicate } = preflight;
    const freshness = await this.deps.truthResolver.resolveFreshness(terminalPredicate);
    if (freshness.status === 'verified') {
      return { outcome: 'mismatch', reason: 'local review lease HEAD is still current' };
    }
    if (freshness.status === 'insufficient') return { outcome: 'insufficient', reason: freshness.reason };

    const evidenceRef = localReviewEvidenceRef({
      messageId: input.messageId,
      generation: input.generation,
      verdict: input.verdict,
    });
    const evidence = await this.deps.evidenceProvider.resolveRecovery({
      evidenceRef,
      leaseId: lease.leaseId,
      subjectRef: lease.subjectRef,
      headSha: terminalPredicate.headSha,
      generation: lease.generation,
      reviewerCatId,
      holderThreadId: lease.holderThreadId,
      predecessorCatId: lease.predecessorCatId,
      predecessorThreadId: lease.predecessorThreadId,
      tenantScope: lease.tenantScope,
    });
    if (evidence.status !== 'verified') return { outcome: evidence.status, reason: evidence.reason };

    const completion = await this.deps.leaseStore.recoverLocalReviewVerdict(input.leaseId, {
      expectedGeneration: input.generation,
      reviewerCatId,
      predecessorCatId: input.principal.catId,
      predecessorThreadId: input.principal.threadId,
      tenantScope: input.principal.tenantScope,
      headSha: input.headSha,
      evidenceRef,
      now: input.now,
    });
    return completion.outcome === 'recovered'
      ? { outcome: 'committed', leaseId: input.leaseId, generation: input.generation, evidenceRef }
      : { outcome: 'stale', reason: completion.outcome };
  }
}
