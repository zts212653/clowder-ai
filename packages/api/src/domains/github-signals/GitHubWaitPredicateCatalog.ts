import {
  GITHUB_WAIT_PREDICATE_KINDS,
  type GitHubCiBaselineBucket,
  type GitHubIssueWaitPredicate,
  type GitHubReviewThreadBaseline,
  type GitHubWaitBaseline,
  type GitHubWaitMatchedDelta,
  type GitHubWaitPredicate,
} from '@cat-cafe/shared';
import { z } from 'zod';

/*
 * Keep the shared closed catalog and both API admission schemas in lockstep.
 * This runs when the module is loaded, before any wait can be registered.
 */
export function assertGitHubWaitPredicateCatalogReady(): void {
  const admittedKinds = [
    ...githubPrWaitPredicateSchema.options.map((option) => option.shape.kind.value),
    ...githubIssueWaitPredicateSchema.options.map((option) => option.shape.kind.value),
  ];
  const uniqueKinds = new Set(admittedKinds);
  if (uniqueKinds.size !== admittedKinds.length) {
    throw new Error('GitHub wait predicate catalog contains duplicate API schema kinds');
  }
  const expected = [...GITHUB_WAIT_PREDICATE_KINDS].sort();
  const actual = [...uniqueKinds].sort();
  if (actual.length !== expected.length || actual.some((kind, index) => kind !== expected[index])) {
    throw new Error(`GitHub wait predicate catalog drift: shared=${expected.join(',')} api=${actual.join(',')}`);
  }
}

const githubAuthorLoginsSchema = z
  .array(z.string().trim().min(1).max(100))
  .min(1)
  .max(20)
  .superRefine((authorLogins, ctx) => {
    const normalized = new Set<string>();
    for (const [index, authorLogin] of authorLogins.entries()) {
      const key = authorLogin.toLowerCase();
      if (normalized.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'authorLogins must be unique case-insensitively; example: ["maintainer-login"]',
        });
      }
      normalized.add(key);
    }
  });

export const githubPrWaitPredicateSchema = z.discriminatedUnion('kind', [
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
  z
    .object({
      kind: z.literal('pr_conversation_comment_added'),
      authorLogins: githubAuthorLoginsSchema,
    })
    .strict(),
  z.object({ kind: z.literal('pr_ci_terminal') }).strict(),
  z.object({ kind: z.literal('pr_became_conflicting') }).strict(),
]);

export const githubIssueWaitPredicateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('issue_comment_added'),
      authorLogins: githubAuthorLoginsSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('issue_author_commented') }).strict(),
]);

assertGitHubWaitPredicateCatalogReady();

export const githubWaitPredicateSchema = z.union([githubPrWaitPredicateSchema, githubIssueWaitPredicateSchema]);

function predicateListSchema<T extends z.ZodTypeAny>(schema: T) {
  return z
    .array(schema)
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
}

export const githubWaitPredicatesSchema = predicateListSchema(githubPrWaitPredicateSchema);
export const githubIssueWaitPredicatesSchema = predicateListSchema(githubIssueWaitPredicateSchema);

export function canonicalizeGitHubWaitPredicates(input: unknown): readonly GitHubWaitPredicate[] {
  return githubWaitPredicatesSchema.parse(input) as readonly GitHubWaitPredicate[];
}

export function canonicalizeGitHubIssueWaitPredicates(input: unknown): readonly GitHubIssueWaitPredicate[] {
  return githubIssueWaitPredicatesSchema.parse(input) as readonly GitHubIssueWaitPredicate[];
}

export interface GitHubWaitFacts {
  readonly headSha?: string;
  readonly review?: {
    readonly decisionCursor: number;
    readonly decision?: string;
    readonly reviewer?: string;
    readonly resultTriggerCommentId?: number;
    readonly resultSourceRef?: string;
    readonly resultConversationCommentCursor?: number;
    readonly conversationComments?: readonly {
      readonly id: number;
      readonly author: string;
      readonly createdAt: string;
      readonly sourceRef?: string;
    }[];
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
  readonly issue?: {
    readonly state: 'open' | 'closed';
    readonly comments: readonly {
      readonly id: number;
      readonly author: string;
      readonly body?: string;
      readonly sourceRef?: string;
    }[];
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
        if ('headSha' in baseline && current.headSha && current.headSha !== baseline.headSha) {
          matches.push({
            kind: predicate.kind,
            delta: `HEAD ${shortSha(baseline.headSha)} → ${shortSha(current.headSha)}`,
          });
        }
        break;
      case 'pr_review_result_available': {
        if (!('headSha' in baseline) || !current.headSha) break;
        const before = baseline.review;
        const after = current.review;
        const resultFrontierAdvanced =
          before !== undefined &&
          after !== undefined &&
          (after.decisionCursor > before.decisionCursor ||
            (after.resultConversationCommentCursor !== undefined &&
              after.resultConversationCommentCursor > before.conversationCommentCursor));
        if (
          before &&
          after &&
          current.headSha === baseline.headSha &&
          resultFrontierAdvanced &&
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
        if (!('headSha' in baseline) || !current.headSha) break;
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
        if (!('headSha' in baseline) || !current.headSha) break;
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
      case 'pr_conversation_comment_added': {
        if (!('headSha' in baseline) || !baseline.review) break;
        const authors = new Set(predicate.authorLogins.map((login) => login.toLowerCase()));
        for (const comment of current.review?.conversationComments ?? []) {
          if (comment.id <= baseline.review.conversationCommentCursor || !authors.has(comment.author.toLowerCase())) {
            continue;
          }
          matches.push({
            kind: predicate.kind,
            delta: `conversation comment #${comment.id} added by ${comment.author} at ${comment.createdAt}${
              comment.sourceRef ? ` (${comment.sourceRef})` : ''
            }`,
            ...(comment.sourceRef ? { sourceRef: comment.sourceRef } : {}),
          });
        }
        break;
      }
      case 'pr_ci_terminal': {
        if (!('headSha' in baseline) || !current.headSha) break;
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
        if (!('headSha' in baseline) || !current.headSha) break;
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
      case 'issue_comment_added': {
        if (!('issue' in baseline)) break;
        const allowed = predicate.authorLogins
          ? new Set(predicate.authorLogins.map((login) => login.toLowerCase()))
          : null;
        for (const comment of current.issue?.comments ?? []) {
          if (comment.id <= baseline.issue.lastCommentCursor) continue;
          if (allowed && !allowed.has(comment.author.toLowerCase())) continue;
          matches.push({
            kind: predicate.kind,
            delta: `issue comment #${comment.id} added by ${comment.author}`,
            ...(comment.sourceRef ? { sourceRef: comment.sourceRef } : {}),
          });
        }
        break;
      }
      case 'issue_author_commented': {
        if (!('issue' in baseline) || !baseline.issue.authorLogin) break;
        const author = baseline.issue.authorLogin.toLowerCase();
        for (const comment of current.issue?.comments ?? []) {
          if (comment.id <= baseline.issue.lastCommentCursor || comment.author.toLowerCase() !== author) continue;
          matches.push({
            kind: predicate.kind,
            delta: `issue author ${baseline.issue.authorLogin} commented (#${comment.id})`,
            ...(comment.sourceRef ? { sourceRef: comment.sourceRef } : {}),
          });
        }
        break;
      }
    }
  }
  return matches;
}
