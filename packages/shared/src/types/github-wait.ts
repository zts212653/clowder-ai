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
 * #1392 AC-7: normal registration names a subject; the server decides who may wake you.
 *
 * The gap is concrete. An author reported a published dependency in a conversation comment while HEAD
 * never moved; a registration watching only `pr_head_changed` was healthy, unexpired, and never woke,
 * because what was awaited was a reply and not a push. Raising the condition cap gave callers room to
 * ask for the comment condition. It did nothing to stop them leaving it out, and an agent that cannot
 * poll does not discover the omission — it simply never hears anything again.
 *
 * An earlier build closed half of that: the bare default armed the four conditions a PR raises about
 * itself and no comment condition at all, because a comment audience had to be named and no default
 * audience was approved. A registration that succeeds while listening to no comments is the original
 * silent failure wearing a new hat, and the product owner has since settled the table it was waiting
 * on (#1392 §4, 2026-09-20). Both perspectives land together here; neither waits for the other.
 *
 * Role is resolved once, at registration, from authoritative GitHub metadata, and frozen into the
 * armed predicate so the caller can read back exactly what was armed and what will be filtered.
 */
export type GitHubTrackingIdentityGap = 'self' | 'subject_author' | 'reviewer_ground';

/**
 * What makes the maintainer/reviewer perspective checkable. "Not the author" is deliberately not on
 * this list: it is an absence, and an absence would let a passer-by inherit a reviewer's narrow
 * audience and then hear almost nothing. Each of these is a positive fact GitHub states.
 */
export type GitHubReviewerGround = 'review_requested' | 'review_submitted' | 'repo_write_access';

/** Authoritative GitHub facts about a tracking subject and about us. Any field may be unresolved. */
export interface GitHubTrackingIdentityV1 {
  /** The authenticated GitHub identity every cat posts as. */
  readonly selfLogin?: string;
  /** The login that opened the PR or issue. */
  readonly subjectAuthorLogin?: string;
  readonly reviewerGround?: GitHubReviewerGround;
}

export type GitHubNotificationPerspective =
  | { readonly role: 'subject_author'; readonly selfLogin: string }
  | {
      readonly role: 'maintainer_or_reviewer';
      readonly selfLogin: string;
      readonly subjectAuthorLogin: string;
      readonly ground: GitHubReviewerGround;
    }
  /**
   * #1392 R4: an issue has one accepted default and no role split, so knowing our own login is the
   * whole identity requirement. Reporting it through the PR resolver claimed a missing
   * `subject_author` the issue default never reads, and sent the caller to fix a gap that was not
   * there while the audience it described was already correct.
   */
  | { readonly role: 'issue_participant'; readonly selfLogin: string }
  | { readonly role: 'unresolved'; readonly missing: readonly GitHubTrackingIdentityGap[] };

/**
 * The server-derived audience of a comment surface, frozen at registration.
 *
 * This sits beside `authorLogins` rather than replacing it because the two have different
 * provenance, and collapsing them would hide which one you got. `authorLogins` is a list the caller
 * wrote; `audience` is a rule the server derived from GitHub metadata.
 *
 * #1392 R2: on the normal entry both are present and both apply — the derived rule first, then the
 * caller's list as a further narrowing. Only the advanced explicit `when[]` path carries
 * `authorLogins` alone, where the list is the whole rule by design.
 */
export type GitHubCommentAudienceV1 =
  /** PR author perspective, and every issue: every comment that is not our own, bots included. */
  | { readonly mode: 'everyone_but_self'; readonly selfLogin: string }
  /** Maintainer/reviewer perspective: the subject author's own words, bots and pure summons filtered. */
  | { readonly mode: 'subject_author_only'; readonly subjectAuthorLogin: string }
  /**
   * Identity or role could not be determined. Nothing is dropped quietly: every comment matches and
   * is delivered, flagged, so the owner learns that coverage was never established. Over-delivering
   * costs a sentence; under-delivering costs an agent that cannot tell silence from nothing happening.
   */
  | { readonly mode: 'unresolved_identity'; readonly missing: readonly GitHubTrackingIdentityGap[] };

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

/** GitHub logins are case-insensitive, and a padded login could never equal a real one. */
function normalizeLogin(value: string | undefined): string | undefined {
  const login = value?.trim();
  return login ? login : undefined;
}

export function sameGitHubLogin(left: string | undefined, right: string | undefined): boolean {
  const a = normalizeLogin(left);
  const b = normalizeLogin(right);
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * The accepted table, as one function. Read it as: we can only claim a perspective we can prove.
 * Missing either login, or holding no reviewer ground while not being the author, is not an error to
 * return to the caller — it is a state the owner has to be told about on the normal path (AC-7).
 */
export function resolveGitHubNotificationPerspective(
  identity: GitHubTrackingIdentityV1,
): GitHubNotificationPerspective {
  const selfLogin = normalizeLogin(identity.selfLogin);
  const subjectAuthorLogin = normalizeLogin(identity.subjectAuthorLogin);
  const missing: GitHubTrackingIdentityGap[] = [];
  if (!selfLogin) missing.push('self');
  if (!subjectAuthorLogin) missing.push('subject_author');
  if (selfLogin === undefined || subjectAuthorLogin === undefined) {
    return { role: 'unresolved', missing };
  }
  if (sameGitHubLogin(selfLogin, subjectAuthorLogin)) {
    return { role: 'subject_author', selfLogin };
  }
  if (!identity.reviewerGround) {
    return { role: 'unresolved', missing: ['reviewer_ground'] };
  }
  return {
    role: 'maintainer_or_reviewer',
    selfLogin,
    subjectAuthorLogin,
    ground: identity.reviewerGround,
  };
}

export function commentAudienceForPerspective(perspective: GitHubNotificationPerspective): GitHubCommentAudienceV1 {
  switch (perspective.role) {
    case 'subject_author':
    case 'issue_participant':
      return { mode: 'everyone_but_self', selfLogin: perspective.selfLogin };
    case 'maintainer_or_reviewer':
      return { mode: 'subject_author_only', subjectAuthorLogin: perspective.subjectAuthorLogin };
    default:
      return { mode: 'unresolved_identity', missing: perspective.missing };
  }
}

/**
 * An issue has one accepted default — every comment that is not our own — so it needs no role split
 * and no reviewer ground. Only our own login has to be known, and when it is not, the same
 * unresolved path applies rather than a silent "any comment" that could not say why.
 */
/**
 * #1392 R4: the issue counterpart of `resolveGitHubNotificationPerspective`.
 *
 * It asks only what the issue default actually reads. Handing an issue identity to the PR resolver
 * reported `missing: ['subject_author']` for a perspective that was fully resolved, so the answer
 * contradicted the very filter printed beside it.
 */
export function resolveGitHubIssueNotificationPerspective(
  identity: GitHubTrackingIdentityV1,
): GitHubNotificationPerspective {
  const selfLogin = normalizeLogin(identity.selfLogin);
  return selfLogin ? { role: 'issue_participant', selfLogin } : { role: 'unresolved', missing: ['self'] };
}

export function issueCommentAudience(identity: GitHubTrackingIdentityV1): GitHubCommentAudienceV1 {
  const selfLogin = normalizeLogin(identity.selfLogin);
  return selfLogin ? { mode: 'everyone_but_self', selfLogin } : { mode: 'unresolved_identity', missing: ['self'] };
}

export type GitHubPrTrackingGoal = {
  readonly kind: 'await_reply_from';
  readonly authorLogins: readonly string[];
};

export type GitHubPrTrackingGoalExpansion =
  | { readonly ok: true; readonly when: readonly GitHubPrWaitPredicate[] }
  | { readonly ok: false; readonly error: string };

/** Conditions a PR raises about itself. None of them needs an audience, so all are always armed. */
const GITHUB_PR_SUBJECT_STATE_PREDICATES: readonly GitHubPrWaitPredicate[] = [
  { kind: 'pr_review_decision_changed' },
  { kind: 'pr_ci_terminal' },
  { kind: 'pr_became_conflicting' },
  { kind: 'pr_head_changed' },
];

/**
 * The normal PR entry. Both comment surfaces are always armed — that is the whole point — and the
 * audience comes from the resolved perspective unless the caller narrowed it by naming people.
 *
 * `goal` stays a narrowing, never a precondition — and #1392 R2 is what "narrowing" has to mean:
 * the derived audience stays armed and the caller's list is applied on top of it. Using the list
 * verbatim here replaced the rule instead of narrowing it, which re-admitted the two groups the
 * accepted table excludes: a named passer-by reached a maintainer, and a caller who named
 * themselves was woken by their own comment. The advanced explicit `when[]` path is untouched;
 * there the list is the whole rule, as it always was.
 */
export function expandGitHubPrTrackingGoal(
  perspective: GitHubNotificationPerspective,
  goal?: GitHubPrTrackingGoal,
): GitHubPrTrackingGoalExpansion {
  if (!goal) {
    const audience = commentAudienceForPerspective(perspective);
    return {
      ok: true,
      when: [
        ...GITHUB_PR_SUBJECT_STATE_PREDICATES,
        { kind: 'pr_conversation_comment_added', audience },
        { kind: 'pr_inline_comment_added', audience },
      ],
    };
  }

  const authorLogins = goal.authorLogins.map((login) => login.trim()).filter((login) => login.length > 0);
  if (authorLogins.length === 0) {
    return {
      ok: false,
      error:
        'goal.authorLogins must name at least one login — a registration with nobody to wait on is not widened to everyone',
    };
  }

  const audience = commentAudienceForPerspective(perspective);
  return {
    ok: true,
    when: [
      ...GITHUB_PR_SUBJECT_STATE_PREDICATES,
      { kind: 'pr_conversation_comment_added', audience, authorLogins },
      { kind: 'pr_inline_comment_added', audience, authorLogins },
    ],
  };
}

/**
 * The normal issue entry. One condition, because `issue_author_commented` would fire a second time
 * on the very same comment the audience already matched, and two deltas for one comment reads as two
 * events to whoever is woken.
 */
export function expandGitHubIssueTracking(identity: GitHubTrackingIdentityV1): readonly GitHubIssueWaitPredicate[] {
  return [{ kind: 'issue_comment_added', audience: issueCommentAudience(identity) }];
}

/**
 * #1392 AC-7: what the registration actually armed, in the registration's own answer.
 *
 * A caller who names nothing now gets a policy they did not write, so the policy has to be legible
 * at the moment it is chosen — otherwise "registered" means the same opaque thing it did before and
 * the owner is back to not knowing what they will hear. This states the perspective, the conditions
 * armed, and, in words, what will be filtered out and why.
 */
export interface GitHubNotificationCoverageV1 {
  readonly perspective: GitHubNotificationPerspective;
  readonly armed: readonly GitHubWaitPredicateKind[];
  readonly commentFilters: readonly string[];
}

/**
 * #1392 R2 follow-up: can any comment satisfy the derived rule AND the list the caller named?
 *
 * Narrowing can produce a pair nothing satisfies, and stating the two rules side by side is true
 * while still leaving the owner waiting for a wake that cannot arrive. Only a provably empty pair
 * answers no here: an unresolved identity is unknown, not empty.
 */
function narrowingMatchesNobody(audience: GitHubCommentAudienceV1, named: readonly string[]): boolean {
  switch (audience.mode) {
    case 'everyone_but_self':
      return named.every((login) => sameGitHubLogin(login, audience.selfLogin));
    case 'subject_author_only':
      return !named.some((login) => sameGitHubLogin(login, audience.subjectAuthorLogin));
    default:
      return false;
  }
}

function describeCommentAudience(predicate: GitHubWaitPredicate): string | undefined {
  if (
    predicate.kind !== 'pr_conversation_comment_added' &&
    predicate.kind !== 'pr_inline_comment_added' &&
    predicate.kind !== 'issue_comment_added'
  ) {
    return undefined;
  }
  const surface =
    predicate.kind === 'pr_inline_comment_added'
      ? 'inline comments'
      : predicate.kind === 'pr_conversation_comment_added'
        ? 'conversation comments'
        : 'issue comments';
  const audience = predicate.audience;
  if (!audience) {
    return predicate.authorLogins
      ? `${surface}: only from ${predicate.authorLogins.join(', ')} (audience you named)`
      : `${surface}: from anyone`;
  }
  // #1392 R2: when the caller also named people, both rules apply, so both have to be stated. Saying
  // only the derived half would describe a wider audience than the one actually armed.
  const named = predicate.authorLogins;
  const narrowing = named
    ? `, then narrowed to only ${named.join(', ')} (you named them)${
        narrowingMatchesNobody(audience, named) ? ' — no comment can match both, so nothing will wake you' : ''
      }`
    : '';
  switch (audience.mode) {
    case 'everyone_but_self':
      return `${surface}: from anyone except ${audience.selfLogin} (you), bots included${narrowing}`;
    case 'subject_author_only':
      return `${surface}: only from ${audience.subjectAuthorLogin} (the subject author); bots and pure summon commands filtered${narrowing}`;
    default:
      return `${surface}: identity unknown (${audience.missing.join(', ')}) — every comment is delivered and flagged, and normal coverage is NOT established${narrowing}`;
  }
}

export function describeGitHubNotificationCoverage(
  perspective: GitHubNotificationPerspective,
  when: readonly GitHubWaitPredicate[],
): GitHubNotificationCoverageV1 {
  return {
    perspective,
    armed: when.map((predicate) => predicate.kind),
    commentFilters: when
      .map((predicate) => describeCommentAudience(predicate))
      .filter((line): line is string => line !== undefined),
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
   * #1392 AC-3 / AC-6 / AC-7: a new PR review comment on one surface. The two surfaces keep separate
   * frontiers — inline and conversation comment ids are not comparable.
   *
   * At least one of `authorLogins` and `audience` is present, and never neither: an omitted-means-anyone
   * form is the silent widening this issue exists to remove. `authorLogins` is the caller's own exact
   * allowlist; `audience` is the role the server resolved on the normal path.
   *
   * #1392 R2: the normal entry carries BOTH, and both have to admit a comment — the caller's list narrows
   * the derived rule instead of replacing it, so a list the rule already excludes matches nobody. Only the
   * advanced explicit `when[]` path carries `authorLogins` alone, used verbatim. Both are frozen at
   * registration and compared case-insensitively.
   */
  | {
      readonly kind: 'pr_conversation_comment_added';
      readonly authorLogins?: readonly string[];
      readonly audience?: GitHubCommentAudienceV1;
    }
  | {
      readonly kind: 'pr_inline_comment_added';
      readonly authorLogins?: readonly string[];
      readonly audience?: GitHubCommentAudienceV1;
    }
  /**
   * #1392 AC-3 / AC-7: `authorLogins` is the caller's optional exact allowlist; `audience` is the
   * server-resolved default. Both omitted keeps main's any-comment issue wait, which the issue
   * surface has always had and which is not a widening of anything.
   */
  | {
      readonly kind: 'issue_comment_added';
      readonly authorLogins?: readonly string[];
      readonly audience?: GitHubCommentAudienceV1;
    }
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
  /**
   * #1392 AC-7: this delta was matched while the subject's identity or our role on it was unknown,
   * so it was delivered rather than filtered. It says the event and its source are real and that
   * normal coverage was never established — not that the rule was applied and passed.
   */
  readonly identityUnknown?: true;
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
