import type { ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';
import { isTrackingKind } from '@cat-cafe/shared';
import { createGenericTaskItem } from './TaskItemFactory.js';
import { createManagedWorkBindingConflict } from './TaskManagedWorkBinding.js';
import type { TaskManagedWorkRegistrationStore } from './TaskManagedWorkRegistrationStore.js';
import {
  assertEntrustedWorkGenericUpsertAllowed,
  assertGenericTaskSubjectNamespaceAllowed,
  type ReplaceTrackingRegistrationIfUnchangedInput,
} from './TaskStoreContract.js';
import { assertSubjectUpdateOwnership } from './TaskSubjectOwnership.js';

interface TaskTrackingRegistrationStoreOptions {
  tasks: Map<string, TaskItem>;
  subjectIndex: Map<string, string>;
  managedWorkRegistration: Pick<TaskManagedWorkRegistrationStore, 'bind' | 'get'>;
  evictDoneIfNeeded: () => void;
}

export function assertTrackingRegistrationInput(input: ReplaceTrackingRegistrationIfUnchangedInput): string {
  const subjectKey = input.task.subjectKey;
  if (!subjectKey || !isTrackingKind(input.task.kind ?? 'work')) {
    throw new Error('Conditional tracking registration requires a tracking subject anchor');
  }
  if (
    input.managedWorkBinding &&
    (input.task.kind !== 'pr_tracking' || !input.managedWorkBinding.workId || !input.managedWorkBinding.attemptId)
  ) {
    throw new Error('Managed-work registration requires a complete pr_tracking binding');
  }
  assertGenericTaskSubjectNamespaceAllowed(subjectKey);
  return subjectKey;
}

export function matchesTrackingRegistrationExpectation(current: TaskItem | null, expected: TaskItem | null): boolean {
  if (!current || !expected) return current === expected;
  return (
    current.id === expected.id &&
    current.updatedAt === expected.updatedAt &&
    current.status === expected.status &&
    current.threadId === expected.threadId &&
    current.ownerCatId === expected.ownerCatId &&
    current.userId === expected.userId &&
    JSON.stringify(current.automationState) === JSON.stringify(expected.automationState)
  );
}

export function assertTrackingRegistrationCurrentCompatible(
  subjectKey: string,
  current: TaskItem,
  input: ReplaceTrackingRegistrationIfUnchangedInput,
): void {
  assertSubjectUpdateOwnership(subjectKey, current, input.task);
  assertEntrustedWorkGenericUpsertAllowed(current);
}

export function assertTrackingRegistrationBindingCompatible(
  taskId: string,
  current: ManagedWorkBinding | null,
  requested: ManagedWorkBinding | undefined,
): void {
  if (current && requested && (current.workId !== requested.workId || current.attemptId !== requested.attemptId)) {
    throw createManagedWorkBindingConflict(taskId);
  }
}

export function trackingRegistrationUpdate(
  current: TaskItem,
  input: ReplaceTrackingRegistrationIfUnchangedInput,
): TaskItem {
  return {
    ...current,
    threadId: input.task.threadId,
    title: input.task.title,
    ownerCatId: input.task.ownerCatId ?? current.ownerCatId,
    status: current.status === 'done' ? 'todo' : current.status,
    why: input.task.why,
    userId: input.task.userId ?? current.userId,
    probe: input.task.probe !== undefined ? input.task.probe : current.probe,
    resolveMode: input.task.resolveMode !== undefined ? input.task.resolveMode : current.resolveMode,
    automationState: input.automationState,
    updatedAt: Date.now(),
  };
}

export class TaskTrackingRegistrationStore {
  constructor(private readonly options: TaskTrackingRegistrationStoreOptions) {}

  replace(input: ReplaceTrackingRegistrationIfUnchangedInput): TaskItem | null {
    const subjectKey = assertTrackingRegistrationInput(input);
    const current = this.currentTask(subjectKey);
    if (!matchesTrackingRegistrationExpectation(current, input.expectedTask)) return null;
    if (current?.automationState?.waitOutcome?.delivery === 'pending') return null;

    if (!current) return this.create(subjectKey, input);

    assertTrackingRegistrationCurrentCompatible(subjectKey, current, input);
    if (current.kind !== input.task.kind) return null;
    const currentBinding = this.options.managedWorkRegistration.get(current.id);
    assertTrackingRegistrationBindingCompatible(current.id, currentBinding, input.managedWorkBinding);

    const updated = trackingRegistrationUpdate(current, input);
    this.options.tasks.set(current.id, updated);
    this.bindIfRequested(updated.id, input.managedWorkBinding);
    return updated;
  }

  private currentTask(subjectKey: string): TaskItem | null {
    const taskId = this.options.subjectIndex.get(subjectKey);
    return taskId ? (this.options.tasks.get(taskId) ?? null) : null;
  }

  private create(subjectKey: string, input: ReplaceTrackingRegistrationIfUnchangedInput): TaskItem {
    this.options.evictDoneIfNeeded();
    const created = createGenericTaskItem({ ...input.task, automationState: input.automationState });
    this.options.tasks.set(created.id, created);
    this.options.subjectIndex.set(subjectKey, created.id);
    this.bindIfRequested(created.id, input.managedWorkBinding);
    return created;
  }

  private bindIfRequested(taskId: string, binding: ManagedWorkBinding | undefined): void {
    if (binding && !this.options.managedWorkRegistration.bind(taskId, binding)) {
      throw new Error('Managed-work PR tracking binding failed closed: live anchor unavailable');
    }
  }
}
