import type { ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';

export const MANAGED_WORK_BINDING_CONFLICT_CODE = 'TASK_MANAGED_WORK_BINDING_CONFLICT';

export function createManagedWorkBindingConflict(
  taskId: string,
): Error & { code: typeof MANAGED_WORK_BINDING_CONFLICT_CODE; taskId: string } {
  const error = new Error(`Task ${taskId} already has a different managed-work binding`) as Error & {
    code: typeof MANAGED_WORK_BINDING_CONFLICT_CODE;
    taskId: string;
  };
  error.code = MANAGED_WORK_BINDING_CONFLICT_CODE;
  error.taskId = taskId;
  return error;
}

export function isManagedWorkBindingConflictError(
  error: unknown,
): error is Error & { code: typeof MANAGED_WORK_BINDING_CONFLICT_CODE } {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === MANAGED_WORK_BINDING_CONFLICT_CODE
  );
}

/** Private in-memory coordinate; callers still expose it only through ITaskStore's server-side port. */
export class TaskManagedWorkBindingStore {
  private readonly bindings = new Map<string, ManagedWorkBinding>();

  bind(task: Pick<TaskItem, 'id' | 'kind'> | undefined, binding: ManagedWorkBinding): ManagedWorkBinding | null {
    if (!task || task.kind !== 'pr_tracking') return null;
    const existing = this.bindings.get(task.id);
    if (existing) {
      if (existing.workId === binding.workId && existing.attemptId === binding.attemptId) return existing;
      throw createManagedWorkBindingConflict(task.id);
    }
    const stored = Object.freeze({ workId: binding.workId, attemptId: binding.attemptId });
    this.bindings.set(task.id, stored);
    return stored;
  }

  get(taskId: string): ManagedWorkBinding | null {
    return this.bindings.get(taskId) ?? null;
  }

  delete(taskId: string): void {
    this.bindings.delete(taskId);
  }
}
