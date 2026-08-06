import type { WaitTerminationActor, WaitTerminationReason } from './wait-termination.js';

export const GITHUB_WAIT_PREDICATE_KINDS = [
  'pr_head_changed',
  'pr_review_result_available',
  'pr_review_decision_changed',
  'pr_review_thread_changed',
  'pr_ci_terminal',
  'pr_became_conflicting',
] as const;

export type GitHubWaitPredicateKind = (typeof GITHUB_WAIT_PREDICATE_KINDS)[number];

export type GitHubWaitPredicate =
  | { readonly kind: 'pr_head_changed' }
  | { readonly kind: 'pr_review_result_available'; readonly triggerCommentId?: number }
  | { readonly kind: 'pr_review_decision_changed' }
  | { readonly kind: 'pr_review_thread_changed'; readonly reviewThreadIds: readonly string[] }
  | { readonly kind: 'pr_ci_terminal' }
  | { readonly kind: 'pr_became_conflicting' };

export type GitHubCiBaselineBucket = 'pending' | 'pass' | 'fail' | 'external_infrastructure';

export interface GitHubReviewThreadBaseline {
  readonly reviewThreadId: string;
  readonly lastCommentId: string | null;
  readonly resolved: boolean;
}

export interface GitHubWaitBaseline {
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

export type WaitOwnerFence =
  | { readonly kind: 'containing_task'; readonly generation: number }
  | {
      readonly kind: 'action_successor';
      readonly leaseId: string;
      readonly generation: number;
    };

export interface AwaitStateV1 {
  readonly v: 1;
  readonly generation: number;
  readonly subjectRef: `pr:${string}#${number}`;
  readonly ownerFence: WaitOwnerFence;
  readonly baseline: GitHubWaitBaseline;
  readonly continuation: {
    readonly when: readonly GitHubWaitPredicate[];
    readonly then: string;
  };
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly provenance?: 'explicit_registration' | 'legacy_migration_default';
}

export interface GitHubWaitMatchedDelta {
  readonly kind: GitHubWaitPredicateKind;
  readonly delta: string;
  readonly sourceRef?: string;
}

export type WaitOutcomeDelivery = 'pending' | 'delivered' | 'not_applicable';

export interface WaitOutcomeV1 {
  readonly v: 1;
  readonly outcomeId: string;
  readonly generation: number;
  readonly subjectRef: `pr:${string}#${number}`;
  readonly reason: WaitTerminationReason;
  readonly at: number;
  readonly delivery: WaitOutcomeDelivery;
  readonly matched?: readonly GitHubWaitMatchedDelta[];
  readonly nextStep?: string;
  readonly terminalSubjectState?: 'merged' | 'closed';
  readonly actor?: WaitTerminationActor;
}
