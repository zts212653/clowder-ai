/**
 * F167 Phase J — Hold ball cancel + auto-cancel lifecycle.
 *
 * Extracted from callback-hold-ball-routes.ts for reuse by:
 * - DELETE /api/callbacks/hold-ball/:taskId (user-initiated cancel)
 * - POST /api/messages auto-cancel (user message invalidates pending holds)
 */

import type { DynamicTaskDef } from '../infrastructure/scheduler/DynamicTaskStore.js';

const HOLD_BALL_TASK_ID_PREFIX = 'hold-ball-';

export interface HoldBallCancelDeps {
  readonly dynamicTaskStore: {
    getById(id: string): DynamicTaskDef | null;
    getAll(): DynamicTaskDef[];
    remove(id: string): boolean;
  };
  readonly taskRunner: {
    unregister(id: string): void;
  };
}

function isHoldBallTask(task: DynamicTaskDef): boolean {
  return (
    task.id.startsWith(HOLD_BALL_TASK_ID_PREFIX) &&
    task.templateId === 'reminder' &&
    typeof task.createdBy === 'string' &&
    task.createdBy.startsWith('hold-ball:')
  );
}

export function findHoldBallTask(
  taskId: string,
  store: Pick<HoldBallCancelDeps['dynamicTaskStore'], 'getById'>,
): DynamicTaskDef | null {
  const task = store.getById(taskId);
  if (!task || !isHoldBallTask(task)) return null;
  return task;
}

export function executeHoldCancel(task: DynamicTaskDef, deps: HoldBallCancelDeps): void {
  deps.taskRunner.unregister(task.id);
  deps.dynamicTaskStore.remove(task.id);
}

export function cancelHoldTaskById(taskId: string, deps: HoldBallCancelDeps): DynamicTaskDef | null {
  const task = findHoldBallTask(taskId, deps.dynamicTaskStore);
  if (!task) return null;
  executeHoldCancel(task, deps);
  return task;
}

export function cancelPendingHoldsForThread(threadId: string, deps: HoldBallCancelDeps): DynamicTaskDef[] {
  const pending = deps.dynamicTaskStore.getAll().filter((t) => isHoldBallTask(t) && t.deliveryThreadId === threadId);

  for (const task of pending) {
    deps.taskRunner.unregister(task.id);
    deps.dynamicTaskStore.remove(task.id);
  }
  return pending;
}
