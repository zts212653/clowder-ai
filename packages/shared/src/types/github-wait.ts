import type { WaitTerminationActor, WaitTerminationReason } from './wait-termination.js';

export const GITHUB_WAIT_PREDICATE_KINDS = [
  'pr_head_changed',
  'pr_review_result_available',
  'pr_review_decision_changed',
  'pr_review_thread_changed',
  'pr_ci_terminal',
  'pr_became_conflicting',
  'issue_comment_added',
  'issue_author_commented',
] as const;

export type GitHubWaitPredicateKind = (typeof GITHUB_WAIT_PREDICATE_KINDS)[number];

export type GitHubWaitPredicate =
  | { readonly kind: 'pr_head_changed' }
  | { readonly kind: 'pr_review_result_available'; readonly triggerCommentId?: number }
  | { readonly kind: 'pr_review_decision_changed' }
  | { readonly kind: 'pr_review_thread_changed'; readonly reviewThreadIds: readonly string[] }
  | { readonly kind: 'pr_ci_terminal' }
  | { readonly kind: 'pr_became_conflicting' }
  | { readonly kind: 'issue_comment_added' }
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
  readonly expiresAt: number;
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
