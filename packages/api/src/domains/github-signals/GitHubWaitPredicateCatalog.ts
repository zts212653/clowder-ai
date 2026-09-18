import type {
  GitHubCiBaselineBucket,
  GitHubIssueWaitPredicate,
  GitHubReviewThreadBaseline,
  GitHubWaitBaseline,
  GitHubWaitMatchedDelta,
  GitHubWaitPredicate,
} from '@cat-cafe/shared';
import { GITHUB_ISSUE_WAIT_PREDICATE_LIMIT, GITHUB_PR_WAIT_PREDICATE_LIMIT } from '@cat-cafe/shared';
import { z } from 'zod';

/**
 * #1392 AC-3: a positive audience, frozen at registration. It must name someone — an empty
 * allowlist matches nobody, which is a dead wait that never fires and never says so.
 *
 * PR comment predicates REQUIRE it (AC-3 as accepted in #1392 comment 5433764333). An omitted
 * audience that quietly meant "any author" would be an open audience nobody chose; the maintainer
 * rejected exactly that shape (#1394 comment 5462922571). `issue_comment_added` keeps it optional,
 * as AC-3 states for issues, which preserves main's any-comment issue wait.
 *
 * Logins are trimmed before the emptiness check: `' '` names nobody, and a padded login could
 * never equal a real one, so either would register the same dead wait as an empty list.
 */
const authorLoginsSchema = z.array(z.string().trim().min(1)).min(1).max(20);

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
  z.object({ kind: z.literal('pr_ci_terminal') }).strict(),
  z.object({ kind: z.literal('pr_became_conflicting') }).strict(),
  z.object({ kind: z.literal('pr_conversation_comment_added'), authorLogins: authorLoginsSchema }).strict(),
  z.object({ kind: z.literal('pr_inline_comment_added'), authorLogins: authorLoginsSchema }).strict(),
]);

export const githubIssueWaitPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue_comment_added'), authorLogins: authorLoginsSchema.optional() }).strict(),
  z.object({ kind: z.literal('issue_author_commented') }).strict(),
]);

export const githubWaitPredicateSchema = z.union([githubPrWaitPredicateSchema, githubIssueWaitPredicateSchema]);

function predicateListSchema<T extends z.ZodTypeAny>(schema: T, limit: number) {
  return z
    .array(schema)
    .min(1)
    .max(limit)
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

export const githubWaitPredicatesSchema = predicateListSchema(
  githubPrWaitPredicateSchema,
  GITHUB_PR_WAIT_PREDICATE_LIMIT,
);
export const githubIssueWaitPredicatesSchema = predicateListSchema(
  githubIssueWaitPredicateSchema,
  GITHUB_ISSUE_WAIT_PREDICATE_LIMIT,
);

/**
 * #1392 AC-2: which collector observes the facts each predicate reads. Exhaustive on purpose, so a
 * new predicate has to say who can see it. Comments, reviews and threads are read only by the review
 * collector, through cursors it moves past them: once a PR task is done, nothing observes them again.
 */
const PREDICATE_OBSERVER: Readonly<
  Record<GitHubWaitPredicate['kind'], 'any_pr_collector' | 'review' | 'ci' | 'conflict' | 'issue'>
> = {
  pr_head_changed: 'any_pr_collector',
  pr_review_result_available: 'review',
  pr_review_decision_changed: 'review',
  pr_review_thread_changed: 'review',
  pr_ci_terminal: 'ci',
  pr_became_conflicting: 'conflict',
  pr_conversation_comment_added: 'review',
  pr_inline_comment_added: 'review',
  issue_comment_added: 'issue',
  issue_author_commented: 'issue',
};

/** Whether a wait is for anything only the review collector can observe. */
export function awaitsReviewCollection(when: readonly GitHubWaitPredicate[]): boolean {
  return when.some((predicate) => PREDICATE_OBSERVER[predicate.kind] === 'review');
}

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
    /**
     * #1392 AC-1: the highest id among this observation's reviews OF `headSha`. `decisionCursor`
     * also moves past late reviews of an older commit, so only this says a review of the current
     * HEAD arrived — the one fact that stays reportable when the HEAD changed in the same poll.
     */
    readonly headDecisionCursor?: number;
    readonly decision?: string;
    readonly reviewer?: string;
    readonly resultTriggerCommentId?: number;
    readonly resultSourceRef?: string;
    readonly resultConversationCommentCursor?: number;
    readonly threads?: readonly GitHubReviewThreadBaseline[];
    /** #1392 AC-6: new review comments this observation collected, on either surface. */
    readonly comments?: readonly {
      readonly id: number;
      readonly author: string;
      readonly commentType: 'inline' | 'conversation';
      readonly sourceRef?: string;
    }[];
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

/** GitHub logins are case-insensitive, so the frozen audience is compared that way. */
function inAudience(author: string, authorLogins: readonly string[]): boolean {
  const login = author.toLowerCase();
  return authorLogins.some((allowed) => allowed.toLowerCase() === login);
}

/**
 * #1392 AC-3 / AC-6: the one path both PR comment surfaces share. Each surface is compared only
 * against its OWN frontier — inline and conversation ids come from different GitHub sequences, so
 * judging one against the other's cursor would drop real comments as "old".
 */
function matchNewComments(
  kind: 'pr_conversation_comment_added' | 'pr_inline_comment_added',
  authorLogins: readonly string[],
  baseline: GitHubWaitBaseline,
  current: GitHubWaitFacts,
): GitHubWaitMatchedDelta[] {
  if (!('headSha' in baseline) || !baseline.review) return [];
  const surface = kind === 'pr_inline_comment_added' ? 'inline' : 'conversation';
  const frontier =
    surface === 'inline' ? baseline.review.inlineCommentCursor : baseline.review.conversationCommentCursor;
  return (current.review?.comments ?? [])
    .filter((comment) => comment.commentType === surface && comment.id > frontier)
    .filter((comment) => inAudience(comment.author, authorLogins))
    .map((comment) => ({
      kind,
      delta: `${surface} comment #${comment.id} by ${comment.author}`,
      ...(comment.sourceRef ? { sourceRef: comment.sourceRef } : {}),
    }));
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
        // After a push only a review of the pushed HEAD is news; a late review of the old one is
        // not its approval. N must report it here, because N+1 starts past this poll's review ids.
        const frontier = current.headSha === baseline.headSha ? after?.decisionCursor : after?.headDecisionCursor;
        if (before && after && frontier !== undefined && frontier > before.decisionCursor) {
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
      case 'pr_conversation_comment_added':
      case 'pr_inline_comment_added':
        matches.push(...matchNewComments(predicate.kind, predicate.authorLogins, baseline, current));
        break;
      case 'issue_comment_added': {
        if (!('issue' in baseline)) break;
        for (const comment of current.issue?.comments ?? []) {
          if (comment.id <= baseline.issue.lastCommentCursor) continue;
          // Omitted is main's any-comment issue wait (the collector has already dropped the owner's own).
          if (predicate.authorLogins && !inAudience(comment.author, predicate.authorLogins)) continue;
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
