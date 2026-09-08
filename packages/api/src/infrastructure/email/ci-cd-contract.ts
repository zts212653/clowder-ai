import type { AwaitStateV1, WaitOutcomeV1 } from '@cat-cafe/shared';

export type CiBucket = 'pass' | 'fail' | 'pending' | 'external_infrastructure';
export type CiExecutionFailure = 'billing_spending_limit_zero_step';

export interface CiCheckDetail {
  readonly name: string;
  readonly bucket: CiBucket;
  readonly link?: string;
  readonly workflow?: string;
  readonly description?: string;
  /** Closed enum derived only from typed GitHub execution payloads. */
  readonly executionFailure?: CiExecutionFailure;
}

export interface CiPollResult {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly prState: 'open' | 'merged' | 'closed';
  readonly aggregateBucket: CiBucket;
  /** Raw GitHub rollup presence; an empty rollup is never positive CI evidence. */
  readonly checkRollup?: 'empty' | 'present';
  readonly checks: readonly CiCheckDetail[];
  /** GitHub login of the user who merged the PR (only present when prState=merged). */
  readonly mergedByLogin?: string;
}

/**
 * sol R33: the wait outcome a CI poll delivers may have been created by REVIEW. Its wake
 * decision travels with it, so both delivering shapes must carry it — required, because an
 * object spread bypasses TypeScript's excess-property check and a silently dropped field is
 * exactly how this rule went missing from the CI path in the first place.
 */
export type CiRouteResult =
  | {
      kind: 'notified';
      threadId: string;
      catId: string;
      messageId: string;
      bucket: CiBucket;
      content: string;
      headSha?: string;
      autoWakeSuppressed: boolean;
      observationEvaluated: boolean;
    }
  | {
      kind: 'lifecycle';
      threadId: string;
      catId: string;
      messageId: string;
      prState: 'merged' | 'closed';
      content: string;
      autoWakeSuppressed: boolean;
      observationEvaluated: boolean;
    }
  | { kind: 'deduped'; reason: string }
  | { kind: 'skipped'; reason: string };

/** Subset of the tracked TaskItem fields the lifecycle-close path reads. */
export interface TrackedTaskLike {
  readonly id: string;
  readonly threadId: string;
  readonly ownerCatId: string | null;
  readonly userId?: string;
  readonly title?: string;
  readonly automationState?: {
    readonly ci?: { readonly prState?: 'merged' | 'closed'; readonly headSha?: string };
    readonly await?: AwaitStateV1;
    readonly waitOutcome?: WaitOutcomeV1;
  };
}

export function getConnectorDeliveryTarget(task: Pick<TrackedTaskLike, 'threadId' | 'userId' | 'ownerCatId'>): {
  threadId: string;
  userId: string;
  catId: string;
} {
  return {
    threadId: task.threadId,
    userId: task.userId ?? '',
    catId: task.ownerCatId ?? '',
  };
}
