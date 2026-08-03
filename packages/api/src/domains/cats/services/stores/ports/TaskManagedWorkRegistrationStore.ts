import type { CreateTaskInput, ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';
import { createManagedWorkBindingConflict, TaskManagedWorkBindingStore } from './TaskManagedWorkBinding.js';
import { assertSubjectUpdateOwnership } from './TaskSubjectOwnership.js';

type TaskManagedWorkRegistrationHost = {
  getBySubject(subjectKey: string): TaskItem | null;
  getById(taskId: string): TaskItem | undefined;
  upsertBySubject(input: CreateTaskInput): TaskItem;
};

/** Focused in-memory aggregate for private binding ownership and atomic managed registration. */
export class TaskManagedWorkRegistrationStore {
  private readonly bindings = new TaskManagedWorkBindingStore();

  constructor(private readonly host: TaskManagedWorkRegistrationHost) {}

  upsert(input: CreateTaskInput, binding: ManagedWorkBinding): TaskItem {
    const subjectKey = input.subjectKey;
    if (!subjectKey || input.kind !== 'pr_tracking') {
      throw new Error('Managed-work registration requires a pr_tracking subject anchor');
    }

    const existing = this.host.getBySubject(subjectKey);
    if (existing) {
      if (existing.kind !== 'pr_tracking') {
        throw new Error('Managed-work registration requires a pr_tracking subject anchor');
      }
      assertSubjectUpdateOwnership(subjectKey, existing, input);
      const currentBinding = this.bindings.get(existing.id);
      if (
        currentBinding &&
        (currentBinding.workId !== binding.workId || currentBinding.attemptId !== binding.attemptId)
      ) {
        throw createManagedWorkBindingConflict(existing.id);
      }
    }

    const task = this.host.upsertBySubject(input);
    const bound = this.bindings.bind(task, binding);
    if (!bound) throw new Error('Managed-work PR tracking binding failed closed: live anchor unavailable');
    return task;
  }

  bind(taskId: string, binding: ManagedWorkBinding): ManagedWorkBinding | null {
    return this.bindings.bind(this.host.getById(taskId), binding);
  }

  get(taskId: string): ManagedWorkBinding | null {
    return this.bindings.get(taskId);
  }

  delete(taskId: string): void {
    this.bindings.delete(taskId);
  }
}
