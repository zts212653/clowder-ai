import type { WaitTerminationActor, WaitTerminationReason } from './wait-termination.js';

export const GITHUB_PR_WAIT_PREDICATE_KINDS = [
  'pr_head_changed',
  'pr_review_result_available',
  'pr_review_decision_changed',
  'pr_review_thread_changed',
  'pr_ci_terminal',
  'pr_became_conflicting',
  'pr_conversation_comment_added',
  'pr_inline_comment_added',
] as const;

export const GITHUB_ISSUE_WAIT_PREDICATE_KINDS = ['issue_comment_added', 'issue_author_commented'] as const;

export const GITHUB_WAIT_PREDICATE_KINDS = [
  ...GITHUB_PR_WAIT_PREDICATE_KINDS,
  ...GITHUB_ISSUE_WAIT_PREDICATE_KINDS,
] as const;

/**
 * #1392 D1: one registration must be able to name every distinct condition its subject can raise.
 *
 * The cap is derived from the catalog rather than written down, because a hand-chosen number silently
 * becomes wrong the moment a kind is added. A fixed cap of four rejected a combination of five valid,
 * non-duplicate conditions — `pr_review_decision_changed`, `pr_conversation_comment_added`,
 * `pr_inline_comment_added`, `pr_ci_terminal`, `pr_became_conflicting` — forcing a caller to drop a
 * signal they needed or register a second tracker. Deduplication, unknown-kind rejection and required
 * parameters are unchanged: capacity is the only thing this raises.
 */
export const GITHUB_PR_WAIT_PREDICATE_LIMIT = GITHUB_PR_WAIT_PREDICATE_KINDS.length;

export const GITHUB_ISSUE_WAIT_PREDICATE_LIMIT = GITHUB_ISSUE_WAIT_PREDICATE_KINDS.length;

/**
 * #1392 AC-7: normal registration names a subject, not a predicate list.
 *
 * The gap is concrete. An author reported a published dependency in a conversation comment while HEAD
 * never moved; a registration watching only `pr_head_changed` was healthy, unexpired, and never woke,
 * because what was awaited was a reply and not a push. Raising the condition cap gave callers room to
 * ask for the comment condition. It did nothing to stop them leaving it out, and an agent that cannot
 * poll does not discover the omission — it simply never hears anything again.
 *
 * So the common path expands here, from one definition shared by the API and the MCP entry, and the
 * advanced path (`when[]`) stays exactly as it was for callers who need a precise wait.
 *
 * Two deliberate limits:
 *
 * The default covers only conditions that need no audience. Both comment conditions require a positive
 * audience (AC-3), and an open default — receive from everyone but yourself — is a product decision the
 * maintainer has explicitly not signed off. Rather than invent one, the default omits comments and the
 * caller adds them by naming who they are waiting on. That is honest about what a bare registration
 * does and does not cover.
 *
 * The audience is always supplied, never derived from GitHub authorship. Who you are waiting on is a
 * claim about the work, and inferring it from who opened the PR would answer a question nobody asked.
 * An empty audience is refused at registration rather than widened to everyone — silent widening is the
 * failure this issue exists to remove.
 */
/**
 * #1392 AC-7: `nextStep` is a note to the owner, not a condition. Requiring it made every caller
 * invent a sentence before they could register, and an invented sentence is worse than a generated
 * one — it tempts a reader into treating it as policy. The matcher never reads this text; it is shown
 * with the wake and carried into the next generation, nothing more.
 *
 * The generated default says the only thing that is always true of a wake: something changed on the
 * subject you registered, and the responsibility you already held still applies.
 */
export const DEFAULT_GITHUB_TRACKING_NEXT_STEP =
  'Check what changed on this subject, then continue the responsibility you already hold.';

export type GitHubPrTrackingGoal = {
  readonly kind: 'await_reply_from';
  readonly authorLogins: readonly string[];
};

export type GitHubPrTrackingGoalExpansion =
  | { readonly ok: true; readonly when: readonly GitHubPrWaitPredicate[] }
  | { readonly ok: false; readonly error: string };

/** Conditions a PR raises about itself. None of them needs an audience, so all are always safe to arm. */
const GITHUB_PR_SUBJECT_STATE_PREDICATES: readonly GitHubPrWaitPredicate[] = [
  { kind: 'pr_review_decision_changed' },
  { kind: 'pr_ci_terminal' },
  { kind: 'pr_became_conflicting' },
  { kind: 'pr_head_changed' },
];

export function expandGitHubPrTrackingGoal(goal?: GitHubPrTrackingGoal): GitHubPrTrackingGoalExpansion {
  if (!goal) {
    return { ok: true, when: GITHUB_PR_SUBJECT_STATE_PREDICATES };
  }

  const authorLogins = goal.authorLogins.map((login) => login.trim()).filter((login) => login.length > 0);
  if (authorLogins.length === 0) {
    return {
      ok: false,
      error:
        'goal.authorLogins must name at least one login — a registration with nobody to wait on is not widened to everyone',
    };
  }

  return {
    ok: true,
    when: [
      ...GITHUB_PR_SUBJECT_STATE_PREDICATES,
      { kind: 'pr_conversation_comment_added', authorLogins },
      { kind: 'pr_inline_comment_added', authorLogins },
    ],
  };
}

export type GitHubWaitPredicateKind = (typeof GITHUB_WAIT_PREDICATE_KINDS)[number];

export type GitHubWaitPredicate =
  | { readonly kind: 'pr_head_changed' }
  | { readonly kind: 'pr_review_result_available'; readonly triggerCommentId?: number }
  | { readonly kind: 'pr_review_decision_changed' }
  | { readonly kind: 'pr_review_thread_changed'; readonly reviewThreadIds: readonly string[] }
  | { readonly kind: 'pr_ci_terminal' }
  | { readonly kind: 'pr_became_conflicting' }
  /**
   * #1392 AC-3 / AC-6: a new PR review comment on one surface. The two surfaces keep separate
   * frontiers — inline and conversation comment ids are not comparable. `authorLogins` is a
   * required, non-empty positive audience, frozen at registration and compared
   * case-insensitively. There is no omitted-means-anyone form.
   */
  | { readonly kind: 'pr_conversation_comment_added'; readonly authorLogins: readonly string[] }
  | { readonly kind: 'pr_inline_comment_added'; readonly authorLogins: readonly string[] }
  /**
   * #1392 AC-3: optional positive audience, frozen at registration, compared case-insensitively.
   * Omitted keeps main's any-comment issue wait.
   */
  | { readonly kind: 'issue_comment_added'; readonly authorLogins?: readonly string[] }
  | { readonly kind: 'issue_author_commented' };

export type GitHubPrWaitPredicate = Extract<GitHubWaitPredicate, { readonly kind: `pr_${string}` }>;
export type GitHubIssueWaitPredicate = Extract<GitHubWaitPredicate, { readonly kind: `issue_${string}` }>;

export type GitHubCiBaselineBucket = 'pending' | 'pass' | 'fail' | 'external_infrastructure';

export interface GitHubReviewThreadBaseline {
  readonly reviewThreadId: string;
  readonly lastCommentId: string | null;
  readonly resolved: boolean;
}

export interface GitHubPrWaitBaseline {
  readonly capturedAt: number;
  readonly headSha: string;
  readonly review?: {
    readonly inlineCommentCursor: number;
    readonly conversationCommentCursor: number;
    readonly decisionCursor: number;
    readonly decision?: string;
    readonly resultTriggerCommentId?: number;
    readonly resultTriggerHeadSha?: string;
    readonly threads?: readonly GitHubReviewThreadBaseline[];
  };
  readonly ci?: {
    readonly bucket: GitHubCiBaselineBucket;
    readonly fingerprint: string;
  };
  readonly conflict?: {
    readonly mergeState: string;
  };
}

export interface GitHubIssueWaitBaseline {
  readonly capturedAt: number;
  readonly issue: {
    readonly lastCommentCursor: number;
    readonly state: 'open' | 'closed';
    readonly authorLogin?: string;
  };
}

export type GitHubWaitBaseline = GitHubPrWaitBaseline | GitHubIssueWaitBaseline;
export type GitHubWaitSubjectRef = `pr:${string}#${number}` | `issue:${string}#${number}`;

export type WaitOwnerFence =
  | { readonly kind: 'containing_task'; readonly generation: number }
  | {
      readonly kind: 'action_successor';
      readonly leaseId: string;
      readonly generation: number;
    };

/**
 * Immutable transport projection for one canonical wait outcome.
 *
 * The containing task or action-successor lease remains authoritative. This
 * value only lets Message/Queue/Invocation retain which exact owner fence
 * authorized the one-shot continuation.
 */
export interface WaitContinuationCarrierV1 {
  readonly v: 1;
  readonly waitId: string;
  readonly outcomeId: string;
  readonly ownerFence: WaitOwnerFence;
}

export interface UnifiedAwaitStateV1<SubjectRef extends string, Baseline, Predicate> {
  readonly v: 1;
  readonly generation: number;
  readonly subjectRef: SubjectRef;
  readonly ownerFence: WaitOwnerFence;
  readonly baseline: Baseline;
  readonly continuation: {
    readonly when: readonly Predicate[];
    readonly then: string;
  };
  /**
   * #1392 AC-2: optional absolute deadline. Omitted means no time-based termination. When
   * supplied it is a loud terminal outcome and is not extended by renewal. Read it only through
   * `isAwaitExpired` — see that function for why direct comparison is unsafe.
   */
  readonly expiresAt?: number;
  /**
   * #1392 AC-1: default true — after a match, this generation is consumed and the next one is
   * installed in the same transition. `false` is the explicit single-fire opt-in.
   */
  readonly autoRenew?: boolean;
  readonly createdAt: number;
}

type GitHubWaitProvenance = {
  readonly provenance?: 'explicit_registration' | 'legacy_migration_default';
};

export type GitHubPrAwaitStateV1 = UnifiedAwaitStateV1<
  `pr:${string}#${number}`,
  GitHubPrWaitBaseline,
  GitHubPrWaitPredicate
> &
  GitHubWaitProvenance;

export type GitHubIssueAwaitStateV1 = UnifiedAwaitStateV1<
  `issue:${string}#${number}`,
  GitHubIssueWaitBaseline,
  GitHubIssueWaitPredicate
> &
  GitHubWaitProvenance;

export type AwaitStateV1 = GitHubPrAwaitStateV1 | GitHubIssueAwaitStateV1;

export interface GitHubWaitMatchedDelta {
  readonly kind: GitHubWaitPredicateKind;
  readonly delta: string;
  readonly sourceRef?: string;
}

export type WaitOutcomeDelivery = 'pending' | 'delivered' | 'not_applicable' | 'legacy_unfenced';

export interface WaitOutcomeV1 {
  readonly v: 1;
  readonly outcomeId: string;
  readonly generation: number;
  readonly subjectRef: GitHubWaitSubjectRef;
  /** Exact owner fence consumed by this outcome; never reconstructed from mutable task fields. */
  readonly ownerFence: WaitOwnerFence;
  readonly reason: WaitTerminationReason;
  readonly at: number;
  readonly delivery: WaitOutcomeDelivery;
  readonly matched?: readonly GitHubWaitMatchedDelta[];
  readonly nextStep?: string;
  readonly terminalSubjectState?: 'merged' | 'closed';
  readonly actor?: WaitTerminationActor;
  /**
   * #1392 AC-1: whether tracking continues after this outcome. `rearmed` means the next
   * generation was installed in the same transition; `rearm_failed` means the event is still
   * delivered but nothing is armed, and the owner must be told so. Absent means the wait ended.
   */
  readonly renewal?: 'rearmed' | 'rearm_failed';
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function parseWaitOwnerFence(value: unknown): WaitOwnerFence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === 'containing_task' &&
    hasExactKeys(candidate, ['kind', 'generation']) &&
    Number.isSafeInteger(candidate.generation) &&
    (candidate.generation as number) > 0
  ) {
    return Object.freeze({ kind: 'containing_task', generation: candidate.generation as number });
  }
  if (
    candidate.kind === 'action_successor' &&
    hasExactKeys(candidate, ['kind', 'leaseId', 'generation']) &&
    typeof candidate.leaseId === 'string' &&
    candidate.leaseId.length > 0 &&
    Number.isSafeInteger(candidate.generation) &&
    (candidate.generation as number) > 0
  ) {
    return Object.freeze({
      kind: 'action_successor',
      leaseId: candidate.leaseId,
      generation: candidate.generation as number,
    });
  }
  return null;
}

export function parseWaitContinuationCarrier(value: unknown): WaitContinuationCarrierV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !hasExactKeys(candidate, ['v', 'waitId', 'outcomeId', 'ownerFence']) ||
    candidate.v !== 1 ||
    typeof candidate.waitId !== 'string' ||
    candidate.waitId.length === 0 ||
    typeof candidate.outcomeId !== 'string' ||
    candidate.outcomeId.length === 0
  ) {
    return null;
  }
  const ownerFence = parseWaitOwnerFence(candidate.ownerFence);
  if (!ownerFence) return null;
  return Object.freeze({
    v: 1,
    waitId: candidate.waitId,
    outcomeId: candidate.outcomeId,
    ownerFence,
  });
}

export function createWaitContinuationCarrier(
  waitId: string,
  outcome: Pick<WaitOutcomeV1, 'outcomeId' | 'ownerFence'>,
): WaitContinuationCarrierV1 {
  const carrier = parseWaitContinuationCarrier({
    v: 1,
    waitId,
    outcomeId: outcome.outcomeId,
    ownerFence: outcome.ownerFence,
  });
  if (!carrier) throw new Error('canonical wait outcome cannot produce a valid continuation carrier');
  return carrier;
}
