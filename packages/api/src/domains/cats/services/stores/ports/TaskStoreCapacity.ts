import { isTrackingKind, type TaskItem } from '@cat-cafe/shared';

/** Make room for admission while preserving all entrusted history and preferring inactive work. */
export function evictTaskForAdmission(
  tasks: ReadonlyMap<string, TaskItem>,
  maxTasks: number,
  remove: (taskId: string, task: TaskItem) => void,
): void {
  if (tasks.size < maxTasks) return;
  const candidates = [...tasks.values()].filter((task) => !task.entrustedWork);
  const candidate =
    candidates.find((task) => task.status === 'done') ??
    candidates.find((task) => !isTrackingKind(task.kind)) ??
    candidates[0];
  if (!candidate) throw new Error('TaskStore capacity reached with only non-evictable entrusted work');
  remove(candidate.id, candidate);
}
