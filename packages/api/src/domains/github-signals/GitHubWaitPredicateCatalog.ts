import type {
  GitHubCiBaselineBucket,
  GitHubReviewThreadBaseline,
  GitHubWaitBaseline,
  GitHubWaitMatchedDelta,
  GitHubWaitPredicate,
} from '@cat-cafe/shared';
import { z } from 'zod';

export const githubWaitPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr_head_changed') }).strict(),
  z
    .object({
      kind: z.literal('pr_review_result_available'),
      triggerCommentId: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('pr_review_decision_changed') }).strict(),
  z
    .object({
      kind: z.literal('pr_review_thread_changed'),
      reviewThreadIds: z.array(z.string().min(1)).min(1).max(20),
    })
    .strict(),
  z.object({ kind: z.literal('pr_ci_terminal') }).strict(),
  z.object({ kind: z.literal('pr_became_conflicting') }).strict(),
]);

export const githubWaitPredicatesSchema = z
  .array(githubWaitPredicateSchema)
  .min(1)
  .max(4)
  .superRefine((predicates, ctx) => {
    const kinds = new Set<string>();
    for (const [index, predicate] of predicates.entries()) {
      if (kinds.has(predicate.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'kind'],
          message: `duplicate wait predicate kind: ${predicate.kind}`,
        });
      }
      kinds.add(predicate.kind);
      if (
        predicate.kind === 'pr_review_thread_changed' &&
        new Set(predicate.reviewThreadIds).size !== predicate.reviewThreadIds.length
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'reviewThreadIds'],
          message: 'reviewThreadIds must be unique',
        });
      }
    }
  });

export function canonicalizeGitHubWaitPredicates(input: unknown): readonly GitHubWaitPredicate[] {
  return githubWaitPredicatesSchema.parse(input) as readonly GitHubWaitPredicate[];
}

export interface GitHubWaitFacts {
  readonly headSha: string;
  readonly review?: {
    readonly decisionCursor: number;
    readonly decision?: string;
    readonly reviewer?: string;
    readonly resultTriggerCommentId?: number;
    readonly resultSourceRef?: string;
    readonly threads?: readonly GitHubReviewThreadBaseline[];
  };
  readonly ci?: {
    readonly bucket: GitHubCiBaselineBucket;
    readonly fingerprint: string;
    readonly blockerCount: number;
  };
  readonly conflict?: {
    readonly mergeState: string;
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function reviewThreadDelta(
  baseline: GitHubReviewThreadBaseline,
  current: GitHubReviewThreadBaseline,
): GitHubWaitMatchedDelta | null {
  if (baseline.lastCommentId === current.lastCommentId && baseline.resolved === current.resolved) return null;
  const change =
    baseline.resolved !== current.resolved
      ? `${baseline.resolved ? 'resolved' : 'open'} → ${current.resolved ? 'resolved' : 'open'}`
      : `reply ${baseline.lastCommentId ?? 'none'} → ${current.lastCommentId ?? 'present'}`;
  return {
    kind: 'pr_review_thread_changed',
    delta: `review thread ${current.reviewThreadId}: ${change}`,
    sourceRef: current.reviewThreadId,
  };
}

export function matchGitHubWaitPredicates(
  when: readonly GitHubWaitPredicate[],
  baseline: GitHubWaitBaseline,
  current: GitHubWaitFacts,
): readonly GitHubWaitMatchedDelta[] {
  const matches: GitHubWaitMatchedDelta[] = [];
  for (const predicate of when) {
    switch (predicate.kind) {
      case 'pr_head_changed':
        if (current.headSha !== baseline.headSha) {
          matches.push({
            kind: predicate.kind,
            delta: `HEAD ${shortSha(baseline.headSha)} → ${shortSha(current.headSha)}`,
          });
        }
        break;
      case 'pr_review_result_available': {
        const before = baseline.review;
        const after = current.review;
        if (
          before &&
          after &&
          current.headSha === baseline.headSha &&
          after.decisionCursor > before.decisionCursor &&
          after.resultSourceRef &&
          (before.resultTriggerCommentId === undefined ||
            after.resultTriggerCommentId === before.resultTriggerCommentId)
        ) {
          const verdict = after.decision ?? 'RESULT_AVAILABLE';
          matches.push({
            kind: predicate.kind,
            delta: `review ${before.decision ?? 'pending'} → ${verdict}${after.reviewer ? ` (${after.reviewer})` : ''}`,
            ...(after.resultSourceRef ? { sourceRef: after.resultSourceRef } : {}),
          });
        }
        break;
      }
      case 'pr_review_decision_changed': {
        const before = baseline.review;
        const after = current.review;
        if (before && after && current.headSha === baseline.headSha && after.decisionCursor > before.decisionCursor) {
          const verdict = after.decision ?? 'RESULT_AVAILABLE';
          matches.push({
            kind: predicate.kind,
            delta: `review ${before.decision ?? 'pending'} → ${verdict}${after.reviewer ? ` (${after.reviewer})` : ''}`,
            ...(after.resultSourceRef ? { sourceRef: after.resultSourceRef } : {}),
          });
        }
        break;
      }
      case 'pr_review_thread_changed': {
        const beforeById = new Map((baseline.review?.threads ?? []).map((thread) => [thread.reviewThreadId, thread]));
        const afterById = new Map((current.review?.threads ?? []).map((thread) => [thread.reviewThreadId, thread]));
        for (const threadId of predicate.reviewThreadIds) {
          const before = beforeById.get(threadId);
          const after = afterById.get(threadId);
          if (!before || !after || current.headSha !== baseline.headSha) continue;
          const delta = reviewThreadDelta(before, after);
          if (delta) matches.push(delta);
        }
        break;
      }
      case 'pr_ci_terminal': {
        const before = baseline.ci;
        const after = current.ci;
        if (
          before &&
          after &&
          current.headSha === baseline.headSha &&
          (after.bucket === 'pass' || after.bucket === 'fail') &&
          after.fingerprint !== before.fingerprint
        ) {
          matches.push({
            kind: predicate.kind,
            delta: `CI ${before.bucket} → ${after.bucket} (${after.blockerCount} blocker${
              after.blockerCount === 1 ? '' : 's'
            })`,
          });
        }
        break;
      }
      case 'pr_became_conflicting': {
        const before = baseline.conflict;
        const after = current.conflict;
        if (
          before &&
          after &&
          current.headSha === baseline.headSha &&
          before.mergeState !== 'CONFLICTING' &&
          after.mergeState === 'CONFLICTING'
        ) {
          matches.push({
            kind: predicate.kind,
            delta: `${before.mergeState.toLowerCase()} → conflicting`,
          });
        }
        break;
      }
    }
  }
  return matches;
}
