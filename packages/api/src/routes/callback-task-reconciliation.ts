import type { OwnedWaitScope, OwnedWaitStatusReader } from '../domains/ball-custody/OwnedWaitStatus.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStoreContract.js';

/** Advisory facts only: an open task does not imply that its owner should wait. */
export async function reconcileOwnedTaskWaits(
  taskStore: ITaskStore,
  readWait: OwnedWaitStatusReader | undefined,
  scope: OwnedWaitScope,
) {
  if (!readWait) return {};
  try {
    const tasks = await taskStore.listByThread(scope.threadId);
    const owned = tasks.filter(
      (task) =>
        task.threadId === scope.threadId &&
        task.userId === scope.userId &&
        task.ownerCatId === scope.catId &&
        task.kind === 'work' &&
        task.status !== 'done',
    );
    if (owned.length === 0 || (await readWait(scope, tasks)) !== false) return {};
    return {
      unheldOwnedTaskCount: owned.length,
      unheldOwnedTasks: owned
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
        .map(({ id, title, status }) => ({ id, title, status })),
    };
  } catch {
    // A read-only reconciliation failure must not change a successful mutation's receipt.
    return {};
  }
}
