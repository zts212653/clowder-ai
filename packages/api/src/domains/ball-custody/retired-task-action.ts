import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../cats/services/stores/ports/TaskStoreContract.js';

/** Historical lease data remains readable; it cannot revive ordinary Task work. */
export async function isRetiredTaskAction(
  tasks: Pick<ITaskStore, 'get'> | undefined,
  action: { subjectRef: string; actionFamily: string; terminalPredicate?: { kind: string } | null },
): Promise<boolean> {
  if (!tasks || action.actionFamily !== 'implement' || action.terminalPredicate?.kind !== 'task_done') return false;
  const taskId = /^subject:task:(\S+)$/.exec(action.subjectRef)?.[1];
  const task = taskId ? await tasks.get(taskId) : null;
  return Boolean(task && isOrdinaryImplementTask(task));
}
