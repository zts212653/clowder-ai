/**
 * Task Types (毛线球)
 * 猫猫任务系统 — 让每只猫追踪自己负责的事项
 *
 * #320: Unified model — PR tracking merged into Task system.
 * kind=work: human/cat collaboration tasks (original)
 * kind=pr_tracking: automated PR monitoring tasks (merged from PrTrackingStore)
 */

import type { CatId } from './ids.js';

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/**
 * Task kind discriminator (#320).
 * - work: manual tasks created by cats/humans
 * - pr_tracking: automated PR tasks (review-feedback, cicd-check, conflict-check)
 */
export type TaskKind = 'work' | 'pr_tracking';

/** CI/CD automation state for pr_tracking tasks */
export interface CiAutomationState {
  readonly headSha?: string;
  readonly lastFingerprint?: string;
  readonly lastBucket?: string;
  readonly lastNotifiedAt?: number;
  readonly enabled?: boolean;
}

/** Conflict detection automation state for pr_tracking tasks */
export interface ConflictAutomationState {
  readonly mergeState?: string;
  readonly lastFingerprint?: string;
  readonly lastNotifiedAt?: number;
}

/** Review feedback automation state for pr_tracking tasks */
export interface ReviewAutomationState {
  readonly lastCommentCursor?: number;
  readonly lastDecisionCursor?: number;
  readonly lastNotifiedAt?: number;
}

/** Composite automation state embedded in pr_tracking tasks (#320 KD-14) */
export interface AutomationState {
  readonly ci?: CiAutomationState;
  readonly conflict?: ConflictAutomationState;
  readonly review?: ReviewAutomationState;
  readonly closedAt?: number;
}

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
}

export type CreateTaskInput = Pick<TaskItem, 'threadId' | 'title' | 'why' | 'createdBy'> & {
  kind?: TaskKind;
  subjectKey?: string | null;
  ownerCatId?: CatId | null;
  automationState?: AutomationState;
  userId?: string;
  sourceMessageId?: string;
  sourceSummaryId?: string;
};

/** Mutable partial for updates — strips readonly from TaskItem fields */
export type UpdateTaskInput = {
  title?: string;
  ownerCatId?: CatId | null;
  status?: TaskStatus;
  why?: string;
  automationState?: AutomationState;
};
