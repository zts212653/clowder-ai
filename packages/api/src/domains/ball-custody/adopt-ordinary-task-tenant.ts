import type { TaskItem } from '@cat-cafe/shared';
import { ordinaryTaskExpectation } from '../cats/services/stores/ports/OrdinaryTaskMutation.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import { ThreadKeys } from '../cats/services/stores/redis-keys/thread-keys.js';

/** Old board rows omitted userId. Only their canonical home can supply it, never a caller default. */
export async function adoptOrdinaryTaskTenant(input: {
  task: TaskItem;
  userId: string;
  tasks: ITaskStore;
  threads?: Pick<IThreadStore, 'get'>;
}): Promise<TaskItem | null> {
  const { task, userId, tasks, threads } = input;
  if (!isOrdinaryImplementTask(task) || !userId) return null;
  if (task.userId) return task.userId === userId ? task : null;
  if (!threads) return null;
  const isCurrentHome = async () => {
    const home = await threads.get(task.threadId);
    return home !== null && !home.deletedAt && home.createdBy === userId;
  };
  if (!(await isCurrentHome())) return null;
  const result = await tasks.mutateOrdinaryTask(
    { kind: 'adopt_legacy_tenant', taskId: task.id, expected: ordinaryTaskExpectation(task), userId },
    {
      watchKeys: [ThreadKeys.detail(task.threadId)],
      async assertCurrent() {
        if (!(await isCurrentHome())) throw new Error('TASK_LEGACY_HOME_AUTHORITY_CHANGED');
      },
    },
  );
  return result.kind === 'updated' || result.kind === 'replayed' ? result.task : null;
}
