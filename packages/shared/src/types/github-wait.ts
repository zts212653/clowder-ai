import type { WaitTerminationActor, WaitTerminationReason } from './wait-termination.js';

export const GITHUB_WAIT_PREDICATE_KINDS = [
  'pr_head_changed',
  'pr_review_decision_changed',
  'pr_conversation_comment_added',
  'pr_inline_comment_added',
  'pr_bot_interaction',
  'pr_ci_terminal',
  'pr_became_conflicting',
  'pr_base_behind',
  'issue_comment_added',
] as const;

export type GitHubWaitPredicateKind = (typeof GITHUB_WAIT_PREDICATE_KINDS)[number];

/**
 * #1392 / #1394: the PUBLIC, user-facing PR-tracking event vocabulary.
 *
 * A registering cat speaks these names — never predicate kinds, never GitHub cursor
 * names. `register_pr_tracking(repo, pr)` materializes the default subscription set
 * server-side; `include` / `exclude` adjust it BY NAME.
 *
 * This list lives in shared because the MCP tool schema and the API route must offer
 * exactly the same words. When they drifted, the tool advertised one contract and the
 * server enforced another.
 */
export const PR_TRACKING_EVENT_NAMES = [
  'review_decision',
  'conversation_comment',
  'inline_comment',
  'bot_interaction',
  'ci_terminal',
  'conflict',
  'base_behind',
  'head_changed',
] as const;

export type PrTrackingEventName = (typeof PR_TRACKING_EVENT_NAMES)[number];

export type GitHubWaitPredicate =
  | { readonly kind: 'pr_head_changed' }
  | { readonly kind: 'pr_review_decision_changed' }
  | {
      readonly kind: 'pr_conversation_comment_added';
      /**
       * Optional allowlist. When omitted, every conversation comment matches;
       * self echoes are dropped at the delivery layer (isEchoComment), NOT at the
       * predicate — per #1392 "catch all others".
       *
       * #1394: making this REQUIRED (the superseded AC-3) is what forced a caller to
       * name the exact audience up front — the "picked the wrong one" failure the
       * issue exists to remove. Identity belongs to the producer, not the predicate.
       */
      readonly authorLogins?: readonly string[];
    }
  | {
      readonly kind: 'pr_inline_comment_added';
      /**
       * Optional allowlist. When omitted, every inline (code-level) review
       * comment matches; self echoes are dropped at the delivery layer.
       */
      readonly authorLogins?: readonly string[];
    }
  /**
   * F280 section 2.4b: one bot interaction TURN — the comment that @-mentions a known bot
   * and the response that bot writes back. Both halves carry this one name, because they
   * are two sides of the same round; splitting them would put "trigger" and "result" on
   * separate coordinate axes and force a caller to subscribe to both to see either.
   */
  | { readonly kind: 'pr_bot_interaction' }
  | { readonly kind: 'pr_ci_terminal' }
  | { readonly kind: 'pr_became_conflicting' }
  | { readonly kind: 'pr_base_behind' }
  | {
      readonly kind: 'issue_comment_added';
      /** #1392 AC-3: optional positive allowlist; when omitted, any comment author matches. */
      readonly authorLogins?: readonly string[];
    };

export type GitHubPrWaitPredicate = Extract<GitHubWaitPredicate, { readonly kind: `pr_${string}` }>;
export type GitHubIssueWaitPredicate = Extract<GitHubWaitPredicate, { readonly kind: `issue_${string}` }>;

export type GitHubCiBaselineBucket = 'pending' | 'pass' | 'fail' | 'external_infrastructure';

export interface GitHubPrWaitBaseline {
  readonly capturedAt: number;
  readonly headSha: string;
  /**
   * F280 A30: the PR author, frozen at registration so the audience filter can answer
   * "whose words does this tracker want". Registration already resolved it to pick role
   * defaults; not persisting it here is why the role could never reach the filter.
   */
  readonly prAuthorLogin?: string;
  readonly review?: {
    readonly inlineCommentCursor: number;
    readonly conversationCommentCursor: number;
    readonly decisionCursor: number;
    readonly decision?: string;
  };
  readonly ci?: {
    readonly bucket: GitHubCiBaselineBucket;
    readonly fingerprint: string;
  };
  readonly conflict?: {
    readonly mergeState: string;
  };
  /**
   * #1392 base_behind: whether the PR is behind its base branch at capture.
   * Derived from GitHub mergeStateStatus === 'BEHIND'. Registration freezes it
   * with every other source frontier, regardless of event selection.
   */
  readonly base?: {
    readonly isBehind: boolean;
  };
  /**
   * F280 section 4b: OPEN bot interaction turns, keyed by the canonical known-bot login.
   *
   * A turn opens when any comment @-mentions a known bot and closes when that bot answers.
   * It is a normalization product, not something a caller subscribes to: the caller names
   * `bot_interaction`, and open/closed/expired is derived here from the same event stream
   * that feeds every other surface. Bounded by the known-bot list, so it cannot grow.
   */
  readonly botTurns?: Readonly<Record<string, GitHubBotTurn>>;
}

/** F280 section 4b: one open bot interaction turn. */
export interface GitHubBotTurn {
  /** Comment id that opened the turn (the one summoning the bot). */
  readonly triggerId: number;
  /** Epoch ms the turn opened — the only clock in the chain, and only for "never came back". */
  readonly openedAt: number;
  /**
   * PR HEAD at the moment the round was opened.
   *
   * A verdict is about a diff, so a round belongs to the commit it was asked about. Without
   * this, a round opened on an old HEAD reads as "still running" against a new one, and an old
   * HEAD's bot review reads as a verdict on code the bot never saw (F168 current-HEAD).
   */
  readonly headSha?: string;
  /**
   * The authenticated invocation this round was granted to, when it was opened by an explicit
   * registration.
   *
   * F177 (`shared-rules.md` 2b) requires the routing guard to honour only a wait belonging to
   * THIS invocation/owner/thread/subject — "a tracker exists somewhere in the thread" is not an
   * exit. Without this field the proof degrades to "some pending summon exists on the PR", and
   * a foreign invocation gets a clean stop it never earned.
   */
  readonly grantInvocationId?: string;
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
  readonly expiresAt?: number;
  readonly createdAt: number;
  /**
   * #1392 AC-1: when true, a predicate match
   * auto-renews the tracking task with a fresh baseline + incremented
   * generation inside TaskStore; terminal subject states suppress renewal.
   * Public GitHub tracking always sets true. Absent/false remains available to
   * internal one-shot lifecycle users only.
   */
  readonly autoRenew?: boolean;
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
  /** #1392 AC-1: true when the system auto-renewed tracking after this outcome; false/absent when it did not (truthful rearm signal). */
  readonly autoRenewed?: boolean;
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
