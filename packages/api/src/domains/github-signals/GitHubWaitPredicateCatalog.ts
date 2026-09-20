import type {
  GitHubCiBaselineBucket,
  GitHubCommentAudienceV1,
  GitHubIssueWaitPredicate,
  GitHubReviewThreadBaseline,
  GitHubWaitBaseline,
  GitHubWaitMatchedDelta,
  GitHubWaitPredicate,
} from '@cat-cafe/shared';
import { GITHUB_ISSUE_WAIT_PREDICATE_LIMIT, GITHUB_PR_WAIT_PREDICATE_LIMIT, sameGitHubLogin } from '@cat-cafe/shared';
import { z } from 'zod';

/**
 * #1392 AC-3: a positive audience, frozen at registration. It must name someone — an empty
 * allowlist matches nobody, which is a dead wait that never fires and never says so.
 *
 * This is the *caller's* schema, and on the advanced `when[]` path PR comment predicates still
 * REQUIRE it, unchanged (AC-3 as accepted in #1392 comment 5433764333). An omitted audience that
 * quietly meant "any author" would be an open audience nobody chose; the maintainer rejected
 * exactly that shape (#1394 comment 5462922571). `issue_comment_added` keeps it optional, as AC-3
 * states for issues, which preserves main's any-comment issue wait.
 *
 * The AC-7 role default is deliberately absent from this schema. A derived `audience` is a claim
 * about who someone is on GitHub, so only the server may write one; accepting it here would let a
 * caller assert a perspective the server never verified. `.strict()` rejects the key outright.
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

/**
 * #1392 AC-7: one observed comment, as collected. `actorType` and `body` are carried because the
 * accepted maintainer/reviewer default filters bots and pure summon commands, and both of those are
 * decided here, at delivery — never at collection, which must stay unconditional so cursors advance
 * over filtered comments and a later policy change loses no history.
 *
 * The body reaches the matcher and never reaches the owner's message: a wake states the fact and
 * points at the source, and copying untrusted prose into a cat's context is a separate hazard.
 */
export interface GitHubObservedComment {
  readonly id: number;
  readonly author: string;
  readonly commentType?: 'inline' | 'conversation';
  readonly sourceRef?: string;
  readonly body?: string;
  /** GitHub's own account type for the comment author: `Bot` for an app, `User` for a person. */
  readonly actorType?: string;
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
    readonly comments?: readonly GitHubObservedComment[];
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
    readonly comments: readonly GitHubObservedComment[];
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
 * #1392 AC-7: an account GitHub itself calls an app. Both tests are facts GitHub states — the `Bot`
 * account type it returns on every comment, and the `[bot]` suffix it reserves for app logins — so
 * nothing here guesses from prose or from a maintained list of vendor names.
 *
 * This only ever narrows the maintainer/reviewer default. A PR author still hears from bots, and an
 * explicit `authorLogins` allowlist that names a bot still wakes on it: the caller said so.
 */
export function isBotComment(comment: GitHubObservedComment): boolean {
  if (comment.actorType?.toLowerCase() === 'bot') return true;
  return comment.author.trim().toLowerCase().endsWith('[bot]');
}

/**
 * #1392 AC-7: handles this deployment can prove are summon targets.
 *
 * `codex` is already hardcoded as a review trigger elsewhere in this codebase
 * (`pr-review-event-wait-coverage.ts`), and `chatgpt-codex-connector[bot]` is the account that
 * answers it. Nothing else is listed, because filtering on an unverified handle would let
 * `@maintainer please look` — a person asking a person — be deleted as machine noise.
 */
export const GITHUB_SUMMON_HANDLES: readonly string[] = ['codex', 'chatgpt-codex-connector[bot]'];

/**
 * #1392 R1: the commands we have evidence are actually issued, and nothing else.
 *
 * The rule used to accept any trailing bare word, which made `@codex tests pass` — a test-result
 * receipt — indistinguishable from `@codex review`. Recognition is by vocabulary now, so an
 * unfamiliar word means "not a command I know" and the comment is delivered. Widening this list is
 * a deliberate act with evidence behind it, not a side effect of someone writing a short sentence.
 */
export const GITHUB_SUMMON_COMMANDS: readonly string[] = ['review'];

/**
 * #1392 AC-7: is this comment *only* a bot summons, with nothing in it for a human?
 *
 * The rule is structural and deliberately narrow. The body must be a single line that opens with a
 * mention of a known summon handle and then contains nothing but known command words — no
 * punctuation, no second line, no prose. `@codex review` is a summons. `@codex review — but note
 * the base moved` is not, and neither is `@maintainer please look`, because the handle is not a
 * summon target. It never reads prose to judge whether a reply was worth having; it only recognises
 * a command it knows, and when it cannot, the comment is delivered.
 *
 * #1392 R1: "known command" is the load-bearing word. Checking only that the trailing tokens looked
 * like bare words silently ate `@codex tests pass`, an author telling their reviewer the result.
 */
export function isPureSummonCommand(body: string | undefined): boolean {
  const text = body?.trim();
  if (!text || !text.startsWith('@') || /[\r\n]/.test(text)) return false;
  const tokens = text.split(/\s+/);
  if (tokens.length > 4) return false;
  const [mention, ...rest] = tokens;
  const handle = mention.slice(1).toLowerCase();
  if (!GITHUB_SUMMON_HANDLES.some((known) => known.toLowerCase() === handle)) return false;
  return rest.every((token) => GITHUB_SUMMON_COMMANDS.some((command) => command === token.toLowerCase()));
}

type AudienceVerdict = { readonly wake: false } | { readonly wake: true; readonly identityUnknown: boolean };

const IGNORE: AudienceVerdict = { wake: false };

/**
 * #1392 AC-7: the accepted default table, applied to one comment.
 *
 * Which arm runs is fixed at registration, so a single reading of the armed predicate tells the
 * owner what they will and will not hear. The `unresolved_identity` arm is the one that looks
 * strange and is the most important: when we could not establish who we are or who opened the
 * subject, we deliver everything rather than quietly applying a rule we cannot justify. An agent
 * discards one extra wake in a sentence; it cannot discover a wake it never got.
 */
function judgeAudience(
  comment: GitHubObservedComment,
  predicate: { readonly authorLogins?: readonly string[]; readonly audience?: GitHubCommentAudienceV1 },
): AudienceVerdict {
  const { audience, authorLogins } = predicate;
  if (!audience) {
    // The caller's own allowlist, used verbatim. Absent on the issue surface means main's any-comment wait.
    if (!authorLogins) return { wake: true, identityUnknown: false };
    return inAudience(comment.author, authorLogins) ? { wake: true, identityUnknown: false } : IGNORE;
  }
  // #1392 R2: on the normal entry a list the caller named is a further narrowing of the accepted
  // rule, never a replacement for it. Both have to admit the comment. Returning early here — rather
  // than inside each arm — is what keeps "narrowing" true of every arm, including the unresolved one:
  // a list is a rule the caller gave us, so it stays justified even when identity is not.
  if (authorLogins && !inAudience(comment.author, authorLogins)) return IGNORE;
  switch (audience.mode) {
    case 'everyone_but_self':
      return sameGitHubLogin(comment.author, audience.selfLogin) ? IGNORE : { wake: true, identityUnknown: false };
    case 'subject_author_only':
      if (!sameGitHubLogin(comment.author, audience.subjectAuthorLogin)) return IGNORE;
      if (isBotComment(comment)) return IGNORE;
      if (isPureSummonCommand(comment.body)) return IGNORE;
      return { wake: true, identityUnknown: false };
    default:
      return { wake: true, identityUnknown: true };
  }
}

function commentDelta(
  kind: GitHubWaitMatchedDelta['kind'],
  label: string,
  comment: GitHubObservedComment,
  verdict: { readonly identityUnknown: boolean },
): GitHubWaitMatchedDelta {
  return {
    kind,
    delta: `${label} by ${comment.author}`,
    ...(comment.sourceRef ? { sourceRef: comment.sourceRef } : {}),
    ...(verdict.identityUnknown ? { identityUnknown: true as const } : {}),
  };
}

/**
 * #1392 AC-3 / AC-6: the one path both PR comment surfaces share. Each surface is compared only
 * against its OWN frontier — inline and conversation ids come from different GitHub sequences, so
 * judging one against the other's cursor would drop real comments as "old".
 */
function matchNewComments(
  kind: 'pr_conversation_comment_added' | 'pr_inline_comment_added',
  predicate: { readonly authorLogins?: readonly string[]; readonly audience?: GitHubCommentAudienceV1 },
  baseline: GitHubWaitBaseline,
  current: GitHubWaitFacts,
): GitHubWaitMatchedDelta[] {
  if (!('headSha' in baseline) || !baseline.review) return [];
  const surface = kind === 'pr_inline_comment_added' ? 'inline' : 'conversation';
  const frontier =
    surface === 'inline' ? baseline.review.inlineCommentCursor : baseline.review.conversationCommentCursor;
  const matches: GitHubWaitMatchedDelta[] = [];
  for (const comment of current.review?.comments ?? []) {
    if (comment.commentType !== surface || comment.id <= frontier) continue;
    const verdict = judgeAudience(comment, predicate);
    if (!verdict.wake) continue;
    matches.push(commentDelta(kind, `${surface} comment #${comment.id}`, comment, verdict));
  }
  return matches;
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
        matches.push(...matchNewComments(predicate.kind, predicate, baseline, current));
        break;
      case 'issue_comment_added': {
        if (!('issue' in baseline)) break;
        for (const comment of current.issue?.comments ?? []) {
          if (comment.id <= baseline.issue.lastCommentCursor) continue;
          const verdict = judgeAudience(comment, predicate);
          if (!verdict.wake) continue;
          matches.push(commentDelta(predicate.kind, `issue comment #${comment.id} added`, comment, verdict));
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
