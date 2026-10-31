import type { TaskItem } from '@cat-cafe/shared';

/** Task-owner encoding for cross-store authority commits; millisecond time alone is not a revision. */
export function taskAuthorityFence(task: TaskItem) {
  if (task.kind !== 'pr_tracking' || !task.subjectKey || !task.userId || !task.ownerCatId)
    throw new Error('Task authority fence requires a complete owned PR tracker');
  return {
    id: task.id,
    kind: task.kind,
    subjectKey: task.subjectKey,
    userId: task.userId,
    threadId: task.threadId,
    ownerCatId: task.ownerCatId,
    updatedAt: String(task.updatedAt),
    automationState: task.automationState ? JSON.stringify(task.automationState) : '',
  };
}
