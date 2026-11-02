import type { TaskItem } from '@cat-cafe/shared';
import type { DynamicTaskStore } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';
import { isPendingHoldBallWakeTask } from './managed-command-wake-task-projection.js';
import { isLiveTypedWaitRegistration, type TypedWaitRegistrationSnapshot } from './TypedWaitRegistration.js';

export interface OwnedWaitScope {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
}

/** Read-only thread/owner fact, never a Task-specific continuation or routing authority. */
export type OwnedWaitStatusReader = (
  scope: OwnedWaitScope,
  tasks?: readonly TaskItem[],
) => Promise<boolean | undefined>;

type TaskWaitReader = Pick<ITaskStore, 'listByThread' | 'getWaitRegistration'>;
type HoldWaitReader = Pick<DynamicTaskStore, 'findByDeliveryThreadAndCreatedBy'>;

function ownsOpenTask(task: TaskItem, scope: OwnedWaitScope): boolean {
  return (
    task.userId === scope.userId &&
    task.threadId === scope.threadId &&
    task.ownerCatId === scope.catId &&
    task.status !== 'done'
  );
}

function isLiveStoredWait(snapshot: TypedWaitRegistrationSnapshot | null, scope: OwnedWaitScope, now: number): boolean {
  const receipt = snapshot?.task.pluginWait?.registration ?? snapshot?.receipt;
  if (!receipt) return false;
  return isLiveTypedWaitRegistration(
    snapshot,
    {
      ...scope,
      invocationId: receipt.invocationId,
      sourceMessageId: receipt.source.sourceMessageId,
      ...(receipt.source.holdTaskId ? { holdTaskId: receipt.source.holdTaskId } : {}),
    },
    now,
  );
}

async function readTaskWait(
  store: TaskWaitReader,
  scope: OwnedWaitScope,
  now: number,
  preloadedTasks?: readonly TaskItem[],
): Promise<boolean | undefined> {
  try {
    const tasks = preloadedTasks ?? (await store.listByThread(scope.threadId));
    for (const task of tasks) {
      if (!ownsOpenTask(task, scope) || (!task.pluginWait?.await && !task.deploymentWait?.await)) continue;
      if (isLiveStoredWait(await store.getWaitRegistration(task.id), scope, now)) return true;
    }
    return false;
  } catch {
    return undefined;
  }
}

function readHoldWait(store: HoldWaitReader | undefined, scope: OwnedWaitScope): boolean | undefined {
  if (!store) return undefined;
  try {
    const createdBy = `hold-ball:${scope.catId}`;
    return store
      .findByDeliveryThreadAndCreatedBy(scope.threadId, createdBy)
      .some(
        (hold) =>
          hold.deliveryThreadId === scope.threadId &&
          hold.createdBy === createdBy &&
          hold.params.triggerUserId === scope.userId &&
          hold.params.targetCatId === scope.catId &&
          isPendingHoldBallWakeTask(hold),
      );
  } catch {
    return undefined;
  }
}

/**
 * Task waits and scheduler holds have different canonical stores. Only a complete
 * negative read means false; unavailable state stays unknown. No wait is created.
 */
export function createOwnedWaitStatusReader(deps: {
  taskStore: TaskWaitReader;
  dynamicTaskStore?: HoldWaitReader;
  now?: () => number;
}): OwnedWaitStatusReader {
  return async (scope, preloadedTasks) => {
    const holdWait = readHoldWait(deps.dynamicTaskStore, scope);
    if (holdWait === true) return true;
    const taskWait = await readTaskWait(deps.taskStore, scope, deps.now?.() ?? Date.now(), preloadedTasks);
    if (taskWait === true) return true;
    return taskWait === false && holdWait === false ? false : undefined;
  };
}
