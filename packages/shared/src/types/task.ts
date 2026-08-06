/**
 * Task Types (毛线球)
 * 猫猫任务系统 — 让每只猫追踪自己负责的事项
 *
 * #320: Unified model — PR tracking merged into Task system.
 * kind=work: human/cat collaboration tasks (original)
 * kind=pr_tracking: automated PR monitoring tasks (merged from PrTrackingStore)
 */

import type { BallResolveMode } from './ball-custody.js';
import type { DispatchGateState } from './cross-thread-affordance.js';
import type { AwaitStateV1, WaitOutcomeV1 } from './github-wait.js';
import type { CatId } from './ids.js';

// Re-export affordance types so existing consumers don't break
export type {
  DispatchGateState,
  SuggestedCrossPostAction,
  SuggestedCrossPostActionSource,
} from './cross-thread-affordance.js';
export { extractFeatureIds } from './cross-thread-affordance.js';

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/**
 * Task kind discriminator (#320, F202-2D).
 * - work: manual tasks created by cats/humans
 * - pr_tracking: automated PR tasks (review-feedback, cicd-check, conflict-check)
 * - issue_tracking: automated GitHub issue comment tracking (F202 Phase 2D)
 */
export type TaskKind = 'work' | 'pr_tracking' | 'issue_tracking';

/** Tracking kinds that receive eviction/TTL protection when active (status !== 'done'). */
export function isTrackingKind(kind: TaskKind): kind is 'pr_tracking' | 'issue_tracking' {
  return kind === 'pr_tracking' || kind === 'issue_tracking';
}

/** CI/CD automation state for pr_tracking tasks */
export interface CiAutomationState {
  readonly headSha?: string;
  readonly lastFingerprint?: string;
  readonly lastBucket?: string;
  readonly lastNotifiedAt?: number;
  readonly enabled?: boolean;
  readonly skipNotified?: boolean;
  /** Terminal PR state — persisted by CiCdRouter on lifecycle close (F200 AC-D2.3). */
  readonly prState?: 'merged' | 'closed';
  /**
   * Durable receipts for PR-terminal world-truth effects. The terminal collector
   * remains schedulable until `completedAt` is present for the current `prState`.
   */
  readonly terminalEffects?: {
    readonly prState: 'merged' | 'closed';
    readonly prLifecycle?: true;
    readonly distillation?: true;
    readonly communityProjection?: true;
    readonly completedAt?: number;
  };
}

/** Conflict detection automation state for pr_tracking tasks */
export interface ConflictAutomationState {
  readonly mergeState?: string;
  readonly lastFingerprint?: string;
  readonly lastNotifiedAt?: number;
}

/** Review feedback automation state for pr_tracking tasks */
export interface ReviewAutomationState {
  /** @deprecated Combined cursor from schema v1. Inline and conversation IDs are incomparable. */
  readonly lastCommentCursor?: number;
  readonly lastInlineCommentCursor?: number;
  readonly lastConversationCommentCursor?: number;
  /**
   * True while a legacy combined cursor is being replayed into the two source-specific
   * cursors. Backfill through the frozen source targets remains state-only until durable.
   */
  readonly commentCursorMigrationPending?: boolean;
  /** Snapshot frontier for the one-time legacy backfill; later source activity remains live. */
  readonly commentCursorMigrationTargets?: {
    readonly inline: number;
    readonly conversation: number;
  };
  readonly lastDecisionCursor?: number;
  readonly lastNotifiedAt?: number;
  /** Terminal PR state observed by ReviewFeedbackTaskSpec before CI lifecycle delivery. */
  readonly prState?: 'merged' | 'closed';
}

/** Issue comment automation state for issue_tracking tasks (F202 Phase 2D) */
export interface IssueAutomationState {
  readonly lastCommentCursor?: number;
  readonly lastNotifiedAt?: number;
  readonly issueState?: 'open' | 'closed';
  /**
   * F168 Phase B: dual-cursor delivery tracking.
   * Tracks the max comment id routed to the thread or intentionally suppressed as an echo.
   * Separate from lastCommentCursor (collection) so delivery retries don't re-append events.
   * lastNotifiedAt is updated separately only after the owner wake is accepted.
   * Undefined means "not yet managed by dual-cursor; default to lastCommentCursor".
   */
  readonly lastDeliveredCursor?: number;
  /** Routed connector message whose owner wake has not yet reached durable admission. */
  readonly pendingWake?: IssuePendingWake | null;
}

export interface IssuePendingWake {
  readonly messageId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly content: string;
  readonly deliveredCursor: number;
  readonly closeTaskAfterWake?: boolean;
}

/** F280 Phase B: PR-only collector and wait state. */
export interface PrAutomationState {
  readonly ci?: CiAutomationState;
  readonly conflict?: ConflictAutomationState;
  readonly review?: ReviewAutomationState;
  readonly closedAt?: number;
  readonly await?: AwaitStateV1;
  readonly waitOutcome?: WaitOutcomeV1;
  /** Type-level quarantine: issue compatibility cannot be installed on a PR state. */
  readonly issue?: never;
}

/** F280 Phase B: issue-only compatibility surface until Phase C. */
export type IssueTrackingWakePolicy = 'all_feedback' | 'human_participant_activity';

export interface LegacyIssueAutomationState {
  readonly issue?: IssueAutomationState;
  readonly closedAt?: number;
  readonly wakePolicy?: IssueTrackingWakePolicy;
  readonly trackingInstructions?: string;
  /** Type-level quarantine: PR facts and waits cannot be installed on an issue state. */
  readonly ci?: never;
  readonly conflict?: never;
  readonly review?: never;
  readonly await?: never;
  readonly waitOutcome?: never;
}

/** Composite automation state embedded in pr_tracking/issue_tracking tasks (#320 KD-14, F202-2D). */
export type AutomationState = PrAutomationState | LegacyIssueAutomationState;

export type TaskProbeSpec =
  | {
      readonly kind: 'http_get';
      readonly url: string;
      readonly expectStatus?: number;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: 'redis_exists';
      readonly key: string;
    };

export interface TaskItem {
  readonly id: string;
  /** Task kind: 'work' (default) or 'pr_tracking' (#320) */
  readonly kind: TaskKind;
  readonly threadId: string;
  /**
   * Unique subject key for dedup/lookup (#320 KD-15).
   * Format: `pr:{owner/repo}#{num}` | `thread:{threadId}` | `repo:{owner/repo}`
   * Null for kind=work tasks that don't need subject-based dedup.
   */
  readonly subjectKey: string | null;
  readonly title: string;
  readonly ownerCatId: CatId | null;
  readonly status: TaskStatus;
  readonly why: string;
  readonly createdBy: CatId | 'user' | 'system';
  readonly createdAt: number;
  readonly updatedAt: number;
  /** PR tracking automation state (#320 KD-14). Only present for kind=pr_tracking. */
  readonly automationState?: AutomationState;
  /** User who registered this task (for ownership checks). */
  readonly userId?: string;
  /** Source message ID for traceability (4-A feature) */
  readonly sourceMessageId?: string;
  /** Source summary ID for traceability (4-A feature) */
  readonly sourceSummaryId?: string;
  /** F233 PR4: machine-checkable condition for blocked-task auto-resolution. */
  readonly probe?: TaskProbeSpec | null;
  /** F233 PR4: what to do once the probe is satisfied. */
  readonly resolveMode?: BallResolveMode | null;

  // --- F193 Phase E (dispatch gate) ---

  /** Feature ID explicitly associated with this task (e.g. "F193"). Optional override. */
  readonly relatedFeatureId?: string;
  /** All F-IDs auto-extracted from title + why (informational, for gate trigger logic) */
  readonly detectedFeatureIds?: string[];
  /** Dispatch gate state. Present when task references features outside current thread scope. */
  readonly dispatchGate?: DispatchGateState;
}

export type CreateTaskInput = Pick<TaskItem, 'threadId' | 'title' | 'why' | 'createdBy'> & {
  kind?: TaskKind;
  subjectKey?: string | null;
  ownerCatId?: CatId | null;
  automationState?: AutomationState;
  userId?: string;
  sourceMessageId?: string;
  sourceSummaryId?: string;
  probe?: TaskProbeSpec | null;
  resolveMode?: BallResolveMode | null;
  // F193 Phase E (dispatch gate)
  relatedFeatureId?: string;
  /** Cat's current feature context — used to determine if detected F-IDs are "external" */
  currentFeatureId?: string;
  /** Auto-extracted F-IDs (computed by MCP handler, passed through to store) */
  detectedFeatureIds?: string[];
  dispatchGate?: DispatchGateState;
};

/** Mutable partial for updates — strips readonly from TaskItem fields */
export type UpdateTaskInput = {
  title?: string;
  ownerCatId?: CatId | null;
  status?: TaskStatus;
  why?: string;
  automationState?: AutomationState;
  probe?: TaskProbeSpec | null;
  resolveMode?: BallResolveMode | null;
  /** Generic task move support. Callers that change threadId own the UX contract. */
  threadId?: string;
  /** F193-E1 P1-4: allow patching dispatchGate on existing tasks */
  dispatchGate?: DispatchGateState;
};

// F193 Phase E utilities re-exported from cross-thread-affordance.ts (see top of file)
