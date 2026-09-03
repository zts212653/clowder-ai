/**
 * ExternalReviewRecoveryService — settles stale external review lease
 * generations when the GitHub HEAD has advanced past the reviewed HEAD.
 *
 * This is the external counterpart to LocalReviewVerdictService.recover().
 * It authenticates the predecessor principal (author cat + tenant), verifies
 * the GitHub review artifact URL, confirms a server-observed HEAD advance,
 * and atomically settles the old generation via CAS.
 *
 * F167: stale-external-review-recovery
 */

import { isGitHubReviewDeliveryProof } from '../community/external-review/external-review-verdict-submission.js';
import type { ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export type ExternalReviewRecoveryResult =
  | { outcome: 'committed'; leaseId: string; generation: number; evidenceRef: string }
  | { outcome: 'mismatch' | 'insufficient' | 'stale'; reason: string };

export interface ExternalReviewRecoveryInput {
  leaseId: string;
  generation: number;
  /** GitHub review artifact URL (e.g. pull request review permalink) */
  githubReviewUrl: string;
  now: number;
  principal: { catId: string; threadId: string; tenantScope: string };
}

export interface ExternalReviewRecoveryServiceDeps {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'recoverExternalReviewVerdict'>;
  truthResolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>;
}

type ReviewDeliveryTerminalPredicate = CanonicalActionTerminalPredicate & {
  readonly kind: 'review_delivered';
  readonly headSha: string;
};

function hasStructuredPredecessor(lease: ActionSuccessorLease): boolean {
  return lease.claimOrigin === 'structured_transfer' && !!lease.predecessorCatId && !!lease.predecessorThreadId;
}

function isUntouchedGeneration(lease: ActionSuccessorLease): boolean {
  return Object.keys(lease.holderOutcomes).length === 0 && Object.keys(lease.completionCandidates).length === 0;
}

type ExternalReviewRecoveryPreflight =
  | {
      ok: true;
      reviewerCatId: string;
      predecessorCatId: string;
      predecessorThreadId: string;
      terminalPredicate: ReviewDeliveryTerminalPredicate;
    }
  | { ok: false; result: Exclude<ExternalReviewRecoveryResult, { outcome: 'committed' }> };

function preflightExternalReviewRecovery(
  lease: ActionSuccessorLease,
  input: ExternalReviewRecoveryInput,
): ExternalReviewRecoveryPreflight {
  if (lease.generation !== input.generation) {
    return { ok: false, result: { outcome: 'stale', reason: 'stale_generation' } };
  }
  if (lease.status !== 'active' && lease.status !== 'completed') {
    return { ok: false, result: { outcome: 'stale', reason: 'lease_not_active' } };
  }
  if (lease.actionFamily !== 'review' || lease.successorSlot !== 'reviewer') {
    return { ok: false, result: { outcome: 'mismatch', reason: 'action lease is not review custody' } };
  }
  const reviewerCatId = lease.holderCatIds[0];
  if (lease.mode !== 'single' || lease.holderCatIds.length !== 1 || !reviewerCatId) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'external review recovery requires one review holder' },
    };
  }
  if (!hasStructuredPredecessor(lease)) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'external review recovery requires structured predecessor custody' },
    };
  }
  if (lease.predecessorCatId !== input.principal.catId) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'external review recovery caller is not the lease predecessor' },
    };
  }
  if (lease.tenantScope !== input.principal.tenantScope) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'external review recovery caller is outside the predecessor tenant' },
    };
  }
  if (lease.status === 'active' && !isUntouchedGeneration(lease)) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'external review recovery requires an untouched active generation' },
    };
  }
  if (lease.returnTransitions.length > 0) {
    return {
      ok: false,
      result: { outcome: 'mismatch', reason: 'external review recovery does not accept returned generations' },
    };
  }
  if (lease.terminalPredicate?.kind !== 'review_delivered' || !lease.terminalPredicate.headSha) {
    return { ok: false, result: { outcome: 'insufficient', reason: 'review delivery predicate unavailable' } };
  }
  // hasStructuredPredecessor validated these above; narrow for TypeScript
  const predecessorCatId = lease.predecessorCatId!;
  const predecessorThreadId = lease.predecessorThreadId!;
  return {
    ok: true,
    reviewerCatId,
    predecessorCatId,
    predecessorThreadId,
    terminalPredicate: {
      ...lease.terminalPredicate,
      kind: 'review_delivered',
      headSha: lease.terminalPredicate.headSha,
    },
  };
}

/**
 * Parse a PR subject ref (pr:owner/repo#number) into its components.
 * Returns null if the subject doesn't match the PR pattern.
 */
function parsePrSubjectRef(subjectRef: string): { repoFullName: string; prNumber: number } | null {
  const match = /^pr:([^/\s]+\/[^#\s]+)#([1-9]\d*)$/.exec(subjectRef);
  if (!match?.[1] || !match[2]) return null;
  const prNumber = Number(match[2]);
  if (!Number.isSafeInteger(prNumber)) return null;
  return { repoFullName: match[1], prNumber };
}

export class ExternalReviewRecoveryService {
  constructor(private readonly deps: ExternalReviewRecoveryServiceDeps) {}

  async recover(input: ExternalReviewRecoveryInput): Promise<ExternalReviewRecoveryResult> {
    const lease = await this.deps.leaseStore.get(input.leaseId);
    if (!lease) return { outcome: 'stale', reason: 'lease_missing' };

    const preflight = preflightExternalReviewRecovery(lease, input);
    if (!preflight.ok) return preflight.result;

    const { reviewerCatId, predecessorCatId, predecessorThreadId, terminalPredicate } = preflight;

    // Verify the GitHub review artifact URL is anchored to the lease's subject
    const prSubject = parsePrSubjectRef(lease.subjectRef);
    if (!prSubject) {
      return { outcome: 'mismatch', reason: 'lease subject is not a PR — cannot validate GitHub review URL' };
    }
    if (!isGitHubReviewDeliveryProof(input.githubReviewUrl, prSubject.repoFullName, prSubject.prNumber)) {
      return {
        outcome: 'mismatch',
        reason: `githubReviewUrl does not match lease subject ${lease.subjectRef}`,
      };
    }

    // If already completed, check for idempotent replay
    const evidenceRef = `github:${input.githubReviewUrl}`;
    if (lease.status === 'completed') {
      const settled = lease.holderOutcomes[reviewerCatId];
      return settled?.outcome === 'succeeded' && settled.evidenceRef === evidenceRef
        ? { outcome: 'committed', leaseId: input.leaseId, generation: input.generation, evidenceRef }
        : { outcome: 'stale', reason: 'lease_not_active' };
    }

    // Require HEAD advance — if still current, use normal verdict path;
    // if PR is terminal, fail-closed (recovery is only for HEAD-advanced cases)
    const freshness = await this.deps.truthResolver.resolveFreshness(terminalPredicate);
    if (freshness.status === 'verified') {
      return {
        outcome: 'mismatch',
        reason: 'review lease HEAD is still current — use record_external_review_verdict instead',
      };
    }
    if (freshness.status === 'insufficient') return { outcome: 'insufficient', reason: freshness.reason };
    // mismatch can mean "HEAD advanced" or "PR is terminal" — only allow HEAD-advanced.
    // Terminal can arrive from two sources:
    //   1. community projection  → 'PR is already terminal'
    //   2. live bootstrap        → 'bootstrap observation reports a terminal PR'
    const TERMINAL_PR_REASONS: readonly string[] = [
      'PR is already terminal',
      'bootstrap observation reports a terminal PR',
    ];
    if (TERMINAL_PR_REASONS.includes(freshness.reason)) {
      return { outcome: 'mismatch', reason: 'PR is already terminal — recovery not applicable' };
    }

    // Atomically settle the old generation
    const completion = await this.deps.leaseStore.recoverExternalReviewVerdict(input.leaseId, {
      expectedGeneration: input.generation,
      reviewerCatId,
      predecessorCatId,
      predecessorThreadId,
      tenantScope: input.principal.tenantScope,
      headSha: terminalPredicate.headSha,
      evidenceRef,
      now: input.now,
    });

    if (completion.outcome === 'recovered' || completion.outcome === 'replayed') {
      return { outcome: 'committed', leaseId: input.leaseId, generation: input.generation, evidenceRef };
    }
    return { outcome: 'stale', reason: completion.outcome };
  }
}
