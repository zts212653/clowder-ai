import {
  GITHUB_WAIT_PREDICATE_KINDS,
  type GitHubCiBaselineBucket,
  type GitHubIssueWaitPredicate,
  type GitHubWaitBaseline,
  type GitHubWaitMatchedDelta,
  type GitHubWaitPredicate,
} from '@cat-cafe/shared';
import { z } from 'zod';

// #1392 AC-3: shared positive-allowlist schema — non-empty, case-insensitively unique logins.
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
  z.object({ kind: z.literal('pr_review_decision_changed') }).strict(),
  z
    .object({
      kind: z.literal('pr_conversation_comment_added'),
      // #1392: allowlist is now optional. Omitted = match all conversation
      // comments; self/bot echoes are filtered at the delivery layer.
      authorLogins: githubAuthorLoginsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pr_inline_comment_added'),
      // #1392: optional allowlist. Omitted = match all inline comments;
      // self/bot echoes are filtered at the delivery layer.
      authorLogins: githubAuthorLoginsSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('pr_bot_interaction') }).strict(),
  z.object({ kind: z.literal('pr_ci_terminal') }).strict(),
  z.object({ kind: z.literal('pr_became_conflicting') }).strict(),
  z.object({ kind: z.literal('pr_base_behind') }).strict(),
]);

export const githubIssueWaitPredicateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('issue_comment_added'),
      // #1392 AC-3: optional allowlist; omitted ⇒ any comment author matches.
      authorLogins: githubAuthorLoginsSchema.optional(),
    })
    .strict(),
]);

export const githubWaitPredicateSchema = z.union([githubPrWaitPredicateSchema, githubIssueWaitPredicateSchema]);

/*
 * #1392: keep the shared closed catalog and both API admission schemas in lockstep.
 * This runs when the module is loaded, before any wait can be registered.
 *
 * #1394: this is the structural guard against "added a predicate kind, forgot to wire
 * it" — the exact class of miss that let inline review comments sit unmatchable.
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

assertGitHubWaitPredicateCatalogReady();

function predicateListSchema<T extends z.ZodTypeAny>(schema: T) {
  return (
    z
      .array(schema)
      .min(1)
      // #1392: raised from 4 to fit the 6-event default set plus includes. The
      // dedupe-by-kind refine below still bounds the list to one per kind.
      .max(9)
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
        }
      })
  );
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
    /** Every new PR comment on this surface, self included — frontier math, not audience. */
    readonly conversationComments?: readonly {
      readonly id: number;
      readonly author: string;
      readonly sourceRef?: string;
    }[];
    readonly inlineComments?: readonly {
      readonly id: number;
      readonly author: string;
      readonly createdAt: string;
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
  readonly base?: {
    readonly isBehind: boolean;
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

/**
 * State-comparison matcher for the observations that carry FACTS instead of events (CI,
 * conflict, base). `pr_bot_interaction` has no case here on purpose: a bot turn is a product
 * of the normalized event stream (GitHubTrackingEvent), and an eventless observation has
 * nothing to evaluate it against. Adding a branch here would be the §3.1 mistake again —
 * a second place that decides what a turn is.
 */
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
      case 'pr_review_decision_changed': {
        if (!('headSha' in baseline) || !current.headSha) break;
        const before = baseline.review;
        const after = current.review;
        if (before && after && current.headSha === baseline.headSha && after.decisionCursor > before.decisionCursor) {
          const verdict = after.decision ?? 'RESULT_AVAILABLE';
          matches.push({
            kind: predicate.kind,
            delta: `review ${before.decision ?? 'pending'} → ${verdict}${after.reviewer ? ` (${after.reviewer})` : ''}`,
          });
        }
        break;
      }
      case 'pr_conversation_comment_added': {
        // #1392 AC-3 + sol P1: authorLogins is the complete exact audience — a
        // listed author's comment always matches; it is never self/bot-vetoed here.
        if (!('headSha' in baseline) || !baseline.review) break;
        // #1392: optional allowlist (mirrors issue_comment_added). Omitted =
        // match every comment; self/bot echoes are dropped at the delivery layer.
        const allowed = predicate.authorLogins
          ? new Set(predicate.authorLogins.map((login) => login.toLowerCase()))
          : null;
        for (const comment of current.review?.conversationComments ?? []) {
          if (comment.id <= baseline.review.conversationCommentCursor) continue;
          if (allowed && !allowed.has(comment.author.toLowerCase())) continue;
          matches.push({
            kind: predicate.kind,
            delta: `conversation comment #${comment.id} by ${comment.author}`,
            ...(comment.sourceRef ? { sourceRef: comment.sourceRef } : {}),
          });
        }
        break;
      }
      case 'pr_inline_comment_added': {
        if (!('headSha' in baseline) || !baseline.review) break;
        // #1392: optional allowlist (mirrors conversation). Omitted = match
        // every inline comment; self/bot echoes are dropped at delivery.
        const allowed = predicate.authorLogins
          ? new Set(predicate.authorLogins.map((login) => login.toLowerCase()))
          : null;
        for (const comment of current.review?.inlineComments ?? []) {
          if (comment.id <= baseline.review.inlineCommentCursor) continue;
          if (allowed && !allowed.has(comment.author.toLowerCase())) continue;
          matches.push({
            kind: predicate.kind,
            delta: `inline comment #${comment.id} added by ${comment.author} at ${comment.createdAt}${
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
      case 'pr_base_behind': {
        if (!('headSha' in baseline) || !current.headSha) break;
        // #1392: fire on transition into behind-base (mirrors conflict). The
        // poller resolves it via an update-branch action; if it falls behind
        // again later, this fires again.
        const before = baseline.base;
        const after = current.base;
        if (before && after && !before.isBehind && after.isBehind) {
          matches.push({
            kind: predicate.kind,
            delta: 'base branch advanced → PR is behind base',
          });
        }
        break;
      }
      case 'issue_comment_added': {
        if (!('issue' in baseline)) break;
        // #1392 AC-3: optional allowlist; when omitted, any comment author matches.
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
    }
  }
  return matches;
}
