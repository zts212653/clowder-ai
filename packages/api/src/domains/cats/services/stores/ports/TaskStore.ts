/**
 * Task Store (毛线球)
 * 内存实现，Map-based，有界 (MAX=500)。
 *
 * #320: Unified model — added kind/subjectKey/automationState support.
 * ID 使用 generateSortableId 保证天然有序。
 */

import type { AutomationState, CreateTaskInput, TaskItem, TaskKind, UpdateTaskInput } from '@cat-cafe/shared';
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

/**
 * Common interface for task stores (in-memory and Redis).
 * #320: Extended with kind/subject-based queries for unified PR tracking.
 */
export interface ITaskStore {
  create(input: CreateTaskInput): TaskItem | Promise<TaskItem>;
  get(taskId: string): TaskItem | null | Promise<TaskItem | null>;
  update(taskId: string, input: UpdateTaskInput): TaskItem | null | Promise<TaskItem | null>;
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
        if (existing.userId && input.userId && existing.userId !== input.userId) {
          throw createSubjectOwnershipConflict(sk, existing.userId, input.userId);
        }
        const updated: TaskItem = {
          ...existing,
          threadId: input.threadId,
          title: input.title,
          ownerCatId: input.ownerCatId ?? existing.ownerCatId,
          status: existing.kind === 'pr_tracking' && existing.status === 'done' ? 'todo' : existing.status,
          why: input.why,
          userId: input.userId ?? existing.userId,
          automationState: input.automationState ?? existing.automationState,
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

    const merged: AutomationState = {
      ...existing.automationState,
      ...patch,
      ci: patch.ci ? { ...existing.automationState?.ci, ...patch.ci } : existing.automationState?.ci,
      conflict: patch.conflict
        ? { ...existing.automationState?.conflict, ...patch.conflict }
        : existing.automationState?.conflict,
      review: patch.review
        ? { ...existing.automationState?.review, ...patch.review }
        : existing.automationState?.review,
    };

    const updated: TaskItem = {
      ...existing,
      automationState: merged,
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, updated);
    return updated;
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
      updatedAt: Date.now(),
    };

    this.tasks.set(taskId, updated);
    return updated;
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
    return task.kind === 'pr_tracking' && task.status !== 'done';
  }
}
