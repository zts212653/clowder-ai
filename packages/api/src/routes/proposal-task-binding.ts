import type { TaskItem, ThreadProposal } from '@cat-cafe/shared';

type Binding = Pick<ThreadProposal, 'subjectTaskId' | 'subjectTaskTitle' | 'approvedDevelopmentScope'>;
type Lookup = { get(taskId: string): TaskItem | null | Promise<TaskItem | null> };
type Resolution = { ok: true; binding: Binding } | { ok: false; status: 400 | 403; error: string };

/** Re-read both explicit and inherited Task authority; an omitted field cannot erase an entrusted binding. */
export async function resolveProposalTaskBinding(
  lookup: Lookup | undefined,
  taskId: string | undefined,
  userId: string,
): Promise<Resolution> {
  if (!taskId) return { ok: true, binding: {} };
  if (!lookup) return { ok: false, status: 400, error: 'subjectTaskId is not supported without a task store' };
  const task = await lookup.get(taskId);
  if (!task) return { ok: false, status: 400, error: 'subjectTaskId references a non-existent task' };
  if (task.userId && task.userId !== userId)
    return { ok: false, status: 403, error: 'subjectTaskId belongs to a different user' };
  const scope = task.entrustedWork?.developmentScope;
  return {
    ok: true,
    binding: {
      subjectTaskId: task.id,
      ...(task.title ? { subjectTaskTitle: task.title } : {}),
      ...(scope ? { approvedDevelopmentScope: scope } : {}),
    },
  };
}
