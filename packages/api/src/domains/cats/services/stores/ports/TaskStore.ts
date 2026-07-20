/**
 * Task Store (毛线球)
 * 内存实现，Map-based，有界 (MAX=500)。
 *
 * #320: Unified model — added kind/subjectKey/automationState support.
 * ID 使用 generateSortableId 保证天然有序。
 */

import type {
  AutomationState,
  CreateTaskInput,
  IssueAutomationState,
  ReviewAutomationState,
  TaskItem,
  TaskKind,
  UpdateTaskInput,
} from '@cat-cafe/shared';
import { isTrackingKind } from '@cat-cafe/shared';
import { generateSortableId } from './MessageStore.js';

const MAX_TASKS = 500;
export const SUBJECT_OWNERSHIP_CONFLICT_CODE = 'TASK_SUBJECT_OWNERSHIP_CONFLICT';

export function createSubjectOwnershipConflict(
  subjectKey: string,
  ownerUserId: string,
  requestedUserId: string,
): Error & {
  code: typeof SUBJECT_OWNERSHIP_CONFLICT_CODE;
  subjectKey: string;
  ownerUserId: string;
  requestedUserId: string;
} {
  const error = new Error(`Subject ${subjectKey} is already owned by another user`) as Error & {
    code: typeof SUBJECT_OWNERSHIP_CONFLICT_CODE;
    subjectKey: string;
    ownerUserId: string;
    requestedUserId: string;
  };
  error.code = SUBJECT_OWNERSHIP_CONFLICT_CODE;
  error.subjectKey = subjectKey;
  error.ownerUserId = ownerUserId;
  error.requestedUserId = requestedUserId;
  return error;
}

export function isSubjectOwnershipConflictError(
  error: unknown,
): error is Error & { code: typeof SUBJECT_OWNERSHIP_CONFLICT_CODE } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === SUBJECT_OWNERSHIP_CONFLICT_CODE
  );
}

export function assertSubjectUpdateOwnership(
  subjectKey: string,
  existing: Pick<TaskItem, 'threadId' | 'userId'>,
  input: Pick<CreateTaskInput, 'threadId' | 'userId'>,
): void {
  if (existing.userId && input.userId && existing.userId === input.userId) return;
  if (!existing.userId && input.userId && existing.threadId === input.threadId) return;
  if (!existing.userId && !input.userId) return;

  throw createSubjectOwnershipConflict(
    subjectKey,
    existing.userId ?? `thread:${existing.threadId}`,
    input.userId ?? `thread:${input.threadId}`,
  );
}

/**
 * Common interface for task stores (in-memory and Redis).
 * #320: Extended with kind/subject-based queries for unified PR tracking.
 */
export interface ITaskStore {
  create(input: CreateTaskInput): TaskItem | Promise<TaskItem>;
  get(taskId: string): TaskItem | null | Promise<TaskItem | null>;
  update(taskId: string, input: UpdateTaskInput): TaskItem | null | Promise<TaskItem | null>;
  /** Conditionally update only when the task still belongs to the expected thread. */
  updateIfThreadId(
    taskId: string,
    expectedThreadId: string,
    input: UpdateTaskInput,
  ): TaskItem | null | Promise<TaskItem | null>;
  listByThread(threadId: string): TaskItem[] | Promise<TaskItem[]>;
  delete(taskId: string): boolean | Promise<boolean>;
  /** Delete all tasks in a thread (cascade delete support) */
  deleteByThread(threadId: string): number | Promise<number>;

  // --- #320 unified model extensions ---

  /** Get task by unique subject key. Returns null if not found. */
  getBySubject(subjectKey: string): TaskItem | null | Promise<TaskItem | null>;

  /** Create or update task by subject key (idempotent). */
  upsertBySubject(input: CreateTaskInput): TaskItem | Promise<TaskItem>;

  /** List tasks filtered by kind (e.g. 'pr_tracking'). */
  listByKind(kind: TaskKind): TaskItem[] | Promise<TaskItem[]>;

  /** Patch automationState without touching other fields. */
  patchAutomationState(taskId: string, patch: Partial<AutomationState>): TaskItem | null | Promise<TaskItem | null>;
}

/**
 * In-memory task store with bounded capacity.
 * #320: Extended with kind/subject indexes.
 */
export class TaskStore implements ITaskStore {
  private tasks: Map<string, TaskItem> = new Map();
  /** subject_key → taskId reverse index */
  private subjectIndex: Map<string, string> = new Map();
  private readonly maxTasks: number;

  constructor(options?: { maxTasks?: number }) {
    this.maxTasks = options?.maxTasks ?? MAX_TASKS;
  }

  create(input: CreateTaskInput): TaskItem {
    this.evictDoneIfNeeded();

    const now = Date.now();
    const task: TaskItem = {
      id: generateSortableId(now),
      kind: input.kind ?? 'work',
      threadId: input.threadId,
      subjectKey: input.subjectKey ?? null,
      title: input.title,
      ownerCatId: input.ownerCatId ?? null,
      status: 'todo',
      why: input.why,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      automationState: input.automationState,
      userId: input.userId,
      probe: input.probe,
      resolveMode: input.resolveMode,
      // F193 Phase E (dispatch gate)
      ...(input.relatedFeatureId ? { relatedFeatureId: input.relatedFeatureId } : {}),
      ...(input.detectedFeatureIds?.length ? { detectedFeatureIds: input.detectedFeatureIds } : {}),
      ...(input.dispatchGate ? { dispatchGate: input.dispatchGate } : {}),
    };

    this.tasks.set(task.id, task);
    if (task.subjectKey) {
      this.subjectIndex.set(task.subjectKey, task.id);
    }
    return task;
  }

  get(taskId: string): TaskItem | null {
    return this.tasks.get(taskId) ?? null;
  }

  getBySubject(subjectKey: string): TaskItem | null {
    const taskId = this.subjectIndex.get(subjectKey);
    if (!taskId) return null;
    return this.tasks.get(taskId) ?? null;
  }

  upsertBySubject(input: CreateTaskInput): TaskItem {
    const sk = input.subjectKey;
    if (!sk) return this.create(input);

    const existingId = this.subjectIndex.get(sk);
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (existing) {
        assertSubjectUpdateOwnership(sk, existing, input);
        const updated: TaskItem = {
          ...existing,
          threadId: input.threadId,
          title: input.title,
          ownerCatId: input.ownerCatId ?? existing.ownerCatId,
          status: isTrackingKind(existing.kind) && existing.status === 'done' ? 'todo' : existing.status,
          why: input.why,
          userId: input.userId ?? existing.userId,
          probe: input.probe !== undefined ? input.probe : existing.probe,
          resolveMode: input.resolveMode !== undefined ? input.resolveMode : existing.resolveMode,
          automationState: input.automationState
            ? this.mergeAutomationState(existing.automationState, input.automationState)
            : existing.automationState,
          updatedAt: Date.now(),
        };
        this.tasks.set(existingId, updated);
        return updated;
      }
    }

    return this.create(input);
  }

  listByKind(kind: TaskKind): TaskItem[] {
    const result: TaskItem[] = [];
    for (const task of this.tasks.values()) {
      if (task.kind === kind) {
        result.push(task);
      }
    }
    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  }

  patchAutomationState(taskId: string, patch: Partial<AutomationState>): TaskItem | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;

    const updated: TaskItem = {
      ...existing,
      automationState: this.mergeAutomationState(existing.automationState, patch),
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  /** Shallow-merge automation state preserving sub-object cursors (ci/review/conflict/issue). */
  private mergeAutomationState(
    existing: AutomationState | undefined,
    patch: Partial<AutomationState>,
  ): AutomationState {
    return {
      ...existing,
      ...patch,
      ci: patch.ci ? { ...existing?.ci, ...patch.ci } : existing?.ci,
      conflict: patch.conflict ? { ...existing?.conflict, ...patch.conflict } : existing?.conflict,
      review: patch.review ? this.mergeReviewAutomationState(existing?.review, patch.review) : existing?.review,
      issue: patch.issue ? this.mergeIssueAutomationState(existing?.issue, patch.issue) : existing?.issue,
    };
  }

  /** Review cursor sources are monotonic and must not regress on task re-registration. */
  private mergeReviewAutomationState(
    existing: ReviewAutomationState | undefined,
    patch: ReviewAutomationState,
  ): ReviewAutomationState {
    const merged: ReviewAutomationState = { ...existing, ...patch };
    const monotonic = (current: number | undefined, next: number | undefined) =>
      current !== undefined && next !== undefined ? Math.max(current, next) : (next ?? current);
    const legacy = monotonic(existing?.lastCommentCursor, patch.lastCommentCursor);
    const inline = monotonic(existing?.lastInlineCommentCursor, patch.lastInlineCommentCursor);
    const conversation = monotonic(existing?.lastConversationCommentCursor, patch.lastConversationCommentCursor);
    const decision = monotonic(existing?.lastDecisionCursor, patch.lastDecisionCursor);
    return {
      ...merged,
      ...(legacy !== undefined ? { lastCommentCursor: legacy } : {}),
      ...(inline !== undefined ? { lastInlineCommentCursor: inline } : {}),
      ...(conversation !== undefined ? { lastConversationCommentCursor: conversation } : {}),
      ...(decision !== undefined ? { lastDecisionCursor: decision } : {}),
    };
  }

  /** Merge issue automation state using Math.max for cursor fields to prevent stale re-seeds from lowering cursors. */
  private mergeIssueAutomationState(
    existing: IssueAutomationState | undefined,
    patch: IssueAutomationState,
  ): IssueAutomationState {
    const merged: IssueAutomationState = { ...existing, ...patch };
    return {
      ...merged,
      lastCommentCursor:
        existing?.lastCommentCursor !== undefined && patch.lastCommentCursor !== undefined
          ? Math.max(existing.lastCommentCursor, patch.lastCommentCursor)
          : merged.lastCommentCursor,
      lastDeliveredCursor:
        existing?.lastDeliveredCursor !== undefined && patch.lastDeliveredCursor !== undefined
          ? Math.max(existing.lastDeliveredCursor, patch.lastDeliveredCursor)
          : merged.lastDeliveredCursor,
    };
  }

  update(taskId: string, input: UpdateTaskInput): TaskItem | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;

    const updated: TaskItem = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.ownerCatId !== undefined ? { ownerCatId: input.ownerCatId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.automationState !== undefined ? { automationState: input.automationState } : {}),
      ...(input.probe !== undefined ? { probe: input.probe } : {}),
      ...(input.resolveMode !== undefined ? { resolveMode: input.resolveMode } : {}),
      // Generic task move support: callers that change threadId own the UX contract.
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      // F193-E1 P1-4: allow patching dispatchGate
      ...(input.dispatchGate !== undefined ? { dispatchGate: input.dispatchGate } : {}),
      updatedAt: Date.now(),
    };

    this.tasks.set(taskId, updated);
    return updated;
  }

  updateIfThreadId(taskId: string, expectedThreadId: string, input: UpdateTaskInput): TaskItem | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    if (existing.threadId !== expectedThreadId) return null;
    return this.update(taskId, input);
  }

  listByThread(threadId: string): TaskItem[] {
    const result: TaskItem[] = [];
    for (const task of this.tasks.values()) {
      if (task.threadId === threadId) {
        result.push(task);
      }
    }
    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  }

  delete(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.subjectKey) {
      this.subjectIndex.delete(task.subjectKey);
    }
    return this.tasks.delete(taskId);
  }

  deleteByThread(threadId: string): number {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (task.threadId === threadId) {
        if (task.subjectKey) {
          this.subjectIndex.delete(task.subjectKey);
        }
        this.tasks.delete(id);
        count++;
      }
    }
    return count;
  }

  get size(): number {
    return this.tasks.size;
  }

  private evictDoneIfNeeded(): void {
    if (this.tasks.size < this.maxTasks) return;

    if (this.evictOldestTask((task) => task.status === 'done')) return;
    if (this.evictOldestTask((task) => !this.isProtectedFromFallbackEviction(task))) return;
    this.evictOldestTask(() => true);
  }

  private deleteTask(taskId: string, task?: TaskItem): void {
    if (task?.subjectKey) this.subjectIndex.delete(task.subjectKey);
    this.tasks.delete(taskId);
  }

  private evictOldestTask(predicate: (task: TaskItem) => boolean): boolean {
    for (const [id, task] of this.tasks) {
      if (!predicate(task)) continue;
      this.deleteTask(id, task);
      return true;
    }
    return false;
  }

  private isProtectedFromFallbackEviction(task: TaskItem): boolean {
    return isTrackingKind(task.kind) && task.status !== 'done';
  }
}
