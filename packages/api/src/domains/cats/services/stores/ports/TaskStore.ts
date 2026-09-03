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
  ManagedWorkBinding,
  TaskItem,
  TaskKind,
  UpdateTaskInput,
} from '@cat-cafe/shared';
import { isTrackingKind } from '@cat-cafe/shared';
import { automationGeneration, mergeTaskAutomationState } from './TaskAutomationState.js';
import { TaskEntrustedWorkMutationStore } from './TaskEntrustedWorkMutationStore.js';
import { createEntrustedTaskItem, createGenericTaskItem } from './TaskItemFactory.js';
import { TaskManagedWorkRegistrationStore } from './TaskManagedWorkRegistrationStore.js';
import {
  type AdmitEntrustedWorkStoreInput,
  type AdmitEntrustedWorkStoreResult,
  assertEntrustedWorkGenericDeletionAllowed,
  assertEntrustedWorkGenericUpdateAllowed,
  assertEntrustedWorkGenericUpsertAllowed,
  assertEntrustedWorkReplayCompatible,
  assertEntrustedWorkStatusUpdateAllowed,
  assertGenericTaskSubjectNamespaceAllowed,
  type CloseEntrustedWorkStoreInput,
  type CloseEntrustedWorkStoreResult,
  createTaskSubjectAlreadyExistsError,
  type ITaskStore,
  isEntrustedWorkSubjectKey,
  type ReplaceAutomationStateIfGenerationInput,
  type UpdateEntrustedWorkStoreInput,
  type UpdateEntrustedWorkStoreResult,
} from './TaskStoreContract.js';
import { assertSubjectUpdateOwnership } from './TaskSubjectOwnership.js';

export type { ITaskStore } from './TaskStoreContract.js';
export {
  assertSubjectUpdateOwnership,
  createSubjectOwnershipConflict,
  isSubjectOwnershipConflictError,
  SUBJECT_OWNERSHIP_CONFLICT_CODE,
} from './TaskSubjectOwnership.js';

const MAX_TASKS = 500;

/**
 * In-memory task store with bounded capacity.
 * #320: Extended with kind/subject indexes.
 */
export class TaskStore implements ITaskStore {
  private tasks: Map<string, TaskItem> = new Map();
  /** subject_key → taskId reverse index */
  private subjectIndex: Map<string, string> = new Map();
  private readonly managedWorkRegistration: TaskManagedWorkRegistrationStore;
  private readonly entrustedWorkMutations: TaskEntrustedWorkMutationStore;
  private readonly maxTasks: number;

  constructor(options?: { maxTasks?: number }) {
    this.maxTasks = options?.maxTasks ?? MAX_TASKS;
    this.managedWorkRegistration = new TaskManagedWorkRegistrationStore({
      getBySubject: (subjectKey) => this.getBySubject(subjectKey),
      getById: (taskId) => this.tasks.get(taskId),
      upsertBySubject: (input) => this.upsertBySubject(input),
    });
    this.entrustedWorkMutations = new TaskEntrustedWorkMutationStore(this.tasks);
  }

  create(input: CreateTaskInput): TaskItem {
    const subjectKey = input.subjectKey;
    if (subjectKey) {
      assertGenericTaskSubjectNamespaceAllowed(subjectKey);
      const existingId = this.subjectIndex.get(subjectKey);
      if (existingId) {
        if (this.tasks.has(existingId)) {
          throw createTaskSubjectAlreadyExistsError(subjectKey);
        }
        this.subjectIndex.delete(subjectKey);
      }
    }

    this.evictDoneIfNeeded();

    const task = createGenericTaskItem(input);

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

    this.assertGenericUpsertSubjectAllowed(sk);

    const existingId = this.subjectIndex.get(sk);
    if (!existingId) return this.create(input);
    const existing = this.tasks.get(existingId);
    if (!existing) {
      this.subjectIndex.delete(sk);
      return this.create(input);
    }

    return this.updateExistingSubjectTask(sk, existing, input);
  }

  private assertGenericUpsertSubjectAllowed(subjectKey: string): void {
    if (!isEntrustedWorkSubjectKey(subjectKey)) return;
    const existingId = this.subjectIndex.get(subjectKey);
    const existing = existingId ? this.tasks.get(existingId) : undefined;
    if (existing) assertEntrustedWorkGenericUpsertAllowed(existing);
    assertGenericTaskSubjectNamespaceAllowed(subjectKey);
  }

  private updateExistingSubjectTask(subjectKey: string, existing: TaskItem, input: CreateTaskInput): TaskItem {
    assertSubjectUpdateOwnership(subjectKey, existing, input);
    assertEntrustedWorkGenericUpsertAllowed(existing);
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
        ? mergeTaskAutomationState(existing.automationState, input.automationState)
        : existing.automationState,
      updatedAt: Date.now(),
    };
    this.tasks.set(existing.id, updated);
    return updated;
  }

  upsertBySubjectWithManagedWorkBinding(input: CreateTaskInput, binding: ManagedWorkBinding): TaskItem {
    return this.managedWorkRegistration.upsert(input, binding);
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
      automationState: mergeTaskAutomationState(existing.automationState, patch),
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  bindManagedWorkBinding(taskId: string, binding: ManagedWorkBinding): ManagedWorkBinding | null {
    return this.managedWorkRegistration.bind(taskId, binding);
  }

  getManagedWorkBinding(taskId: string): ManagedWorkBinding | null {
    return this.managedWorkRegistration.get(taskId);
  }

  admitEntrustedWork(input: AdmitEntrustedWorkStoreInput): AdmitEntrustedWorkStoreResult {
    const existingId = this.subjectIndex.get(input.subjectKey);
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (existing) {
        assertEntrustedWorkReplayCompatible(input.subjectKey, existing, input.entrustedWork);
        return { kind: 'resumed', task: existing };
      }
      this.subjectIndex.delete(input.subjectKey);
    }

    this.evictDoneIfNeeded();
    const task = createEntrustedTaskItem(input);
    this.tasks.set(task.id, task);
    this.subjectIndex.set(input.subjectKey, task.id);
    return { kind: 'admitted', task };
  }

  closeEntrustedWork(taskId: string, input: CloseEntrustedWorkStoreInput): CloseEntrustedWorkStoreResult {
    return this.entrustedWorkMutations.close(taskId, input);
  }

  updateEntrustedWork(taskId: string, input: UpdateEntrustedWorkStoreInput): UpdateEntrustedWorkStoreResult {
    return this.entrustedWorkMutations.update(taskId, input);
  }

  replaceAutomationStateIfGeneration(taskId: string, input: ReplaceAutomationStateIfGenerationInput): TaskItem | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    assertEntrustedWorkStatusUpdateAllowed(existing, input);
    if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) return null;
    if (automationGeneration(existing.automationState) !== input.expectedGeneration) return null;

    const updated: TaskItem = {
      ...existing,
      automationState: input.automationState,
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  update(taskId: string, input: UpdateTaskInput): TaskItem | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    assertEntrustedWorkGenericUpdateAllowed(existing);

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
    assertEntrustedWorkGenericDeletionAllowed(task);
    this.deleteTask(taskId, task);
    return true;
  }

  deleteByThread(threadId: string): number {
    const owned = [...this.tasks.values()].filter((task) => task.threadId === threadId);
    owned.forEach(assertEntrustedWorkGenericDeletionAllowed);
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (task.threadId === threadId) {
        this.deleteTask(id, task);
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

    if (this.evictOldestTask((task) => !task.entrustedWork && task.status === 'done')) return;
    if (this.evictOldestTask((task) => !task.entrustedWork && !this.isProtectedFromFallbackEviction(task))) return;
    if (this.evictOldestTask((task) => !task.entrustedWork)) return;
    throw new Error('TaskStore capacity reached with only non-evictable entrusted work');
  }

  private deleteTask(taskId: string, task?: TaskItem): void {
    if (task?.subjectKey) this.subjectIndex.delete(task.subjectKey);
    this.managedWorkRegistration.delete(taskId);
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
