import type { AwaitStateV1, GitHubWaitOutcomeV1 } from '@cat-cafe/shared';

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
  /** Query start, fencing buffered facts against a newer registered HEAD wait. */
  readonly observedAt?: number;
  /** Raw failure facts collected in admission; details belong to its work item. */
  readonly failureDetailsPending?: boolean;
  /** More than one GraphQL context page; exact PR read belongs to execution. */
  readonly fullRollupPending?: boolean;
  /** A detail read failed open: checks lack their required projection or execution classification. */
  readonly failureDetailsIncomplete?: boolean;
  /** GitHub login of the user who merged the PR (only present when prState=merged). */
  readonly mergedByLogin?: string;
}

export function isStaleCiSnapshot(poll: CiPollResult, wait?: AwaitStateV1): boolean {
  return (
    poll.prState === 'open' &&
    poll.observedAt !== undefined &&
    wait !== undefined &&
    'headSha' in wait.baseline &&
    poll.observedAt < wait.baseline.capturedAt &&
    poll.headSha !== wait.baseline.headSha
  );
}

export type CiRouteResult =
  | {
      kind: 'notified';
      threadId: string;
      catId: string;
      messageId: string;
      bucket: CiBucket;
      content: string;
      headSha?: string;
    }
  | {
      kind: 'lifecycle';
      threadId: string;
      catId: string;
      messageId: string;
      prState: 'merged' | 'closed';
      content: string;
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
    readonly waitOutcome?: GitHubWaitOutcomeV1;
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
