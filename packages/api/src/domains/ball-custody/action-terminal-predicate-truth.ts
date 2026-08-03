import type { CommunityObjectProjection } from '@cat-cafe/shared';
import {
  type CanonicalActionTerminalPredicate,
  getActionTerminalCapabilityForPredicateKind,
} from './ActionTerminalPredicateCatalog.js';
import type {
  ActionCompletionCandidateSnapshot,
  ActionCompletionTruthVerdict,
} from './action-successor-completion-state-machine.js';

function verified(predicate: CanonicalActionTerminalPredicate, evidenceRef: string): ActionCompletionTruthVerdict {
  return {
    status: 'verified',
    evidenceRef,
    predicateDigest: predicate.digest,
    freshnessKey: predicate.freshnessKey,
  };
}

function isSubjectBoundGitHubReviewEvidenceRef(
  evidenceRef: string,
  predicate: CanonicalActionTerminalPredicate,
): boolean {
  if (!evidenceRef.startsWith('github:')) return false;
  const subject = /^pr:([^/\s]+)\/([^#\s]+)#([1-9]\d*)$/.exec(predicate.subjectRef);
  if (!subject) return false;
  const [, owner, repo, number] = subject;
  if (!owner || !repo || !number) return false;
  try {
    const url = new URL(evidenceRef.slice('github:'.length));
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return false;
    const expectedPath = `/${owner.toLowerCase()}/${repo.toLowerCase()}/pull/${number}`;
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    if (path !== expectedPath && path !== `${expectedPath}/files`) return false;
    return /^#(?:pullrequestreview-|discussion_r|issuecomment-|r)\d+$/.test(url.hash.toLowerCase());
  } catch {
    return false;
  }
}

function resolveReviewCompletion(
  predicate: CanonicalActionTerminalPredicate,
  projection: CommunityObjectProjection | null,
  evidenceRefs: readonly string[],
): ActionCompletionTruthVerdict {
  if (!predicate.headSha) return { status: 'insufficient', reason: 'review predicate HEAD unavailable' };
  const review = projection?.externalReview;
  if (!projection || projection.type !== 'pr' || !review) {
    return { status: 'insufficient', reason: 'external review projection unavailable' };
  }
  if (review.currentHeadSha !== predicate.headSha) {
    return { status: 'mismatch', reason: 'review predicate does not cover current HEAD' };
  }
  const githubEvidence = evidenceRefs.find((ref) => isSubjectBoundGitHubReviewEvidenceRef(ref, predicate));
  if (githubEvidence) return verified(predicate, githubEvidence);
  if (
    review.lastReviewedHeadSha !== predicate.headSha ||
    review.delivery?.kind !== 'delivered' ||
    review.delivery.headSha !== predicate.headSha
  ) {
    return { status: 'insufficient', reason: 'current-HEAD review verdict is not delivered' };
  }
  const evidenceRef = evidenceRefs.find((ref) => ref.startsWith(`community:${predicate.subjectRef}:review:`));
  return evidenceRef
    ? verified(predicate, evidenceRef)
    : { status: 'insufficient', reason: 'candidate lacks review delivery evidence' };
}

export function resolveProjectedActionCompletion(
  predicate: CanonicalActionTerminalPredicate,
  projection: CommunityObjectProjection | null,
  candidate: ActionCompletionCandidateSnapshot,
): ActionCompletionTruthVerdict {
  const capability = getActionTerminalCapabilityForPredicateKind(predicate.kind);
  if (capability.completionResolver === 'review_delivery') {
    return resolveReviewCompletion(predicate, projection, candidate.evidenceRefs);
  }
  throw new Error(`unsupported action completion resolver: ${capability.completionResolver}`);
}
