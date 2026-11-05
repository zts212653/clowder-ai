import { isTrackingKind, type TaskItem } from '@cat-cafe/shared';

/** Make room for admission while preserving all entrusted history and preferring inactive work. */
export function evictTaskForAdmission(
  tasks: ReadonlyMap<string, TaskItem>,
  maxTasks: number,
  remove: (taskId: string, task: TaskItem) => void,
  protectedByOwner: (task: TaskItem) => boolean = () => false,
): void {
  if (tasks.size < maxTasks) return;
  const candidates = [...tasks.values()].filter((task) => !task.entrustedWork && !protectedByOwner(task));
  const candidate =
    candidates.find((task) => task.status === 'done') ??
    candidates.find((task) => !isTrackingKind(task.kind)) ??
    candidates[0];
  if (!candidate) throw new Error('TaskStore capacity reached with only non-evictable work');
  remove(candidate.id, candidate);
}
