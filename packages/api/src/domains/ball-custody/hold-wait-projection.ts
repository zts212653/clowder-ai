/**
 * Held balls that are waiting, not running — the read model behind the "在等" rows.
 *
 * A timer hold leaves no process behind: the cat exited and only a scheduler wake is armed. The active-execution
 * projection admits a hold only while it owns a running command, so before this a timer hold was visible nowhere
 * except its own card in the timeline (You, 2026-11-02: "看起来他完全不在运行和等待").
 *
 * Only timer holds are enumerated. A wake_when hold is a managed execution while its command runs; its other states
 * (completed and being delivered, lost and being recovered by the sweep) are transitional, and showing their fallback
 * timer as "wakes at HH:MM" would contradict a wake that is already under way.
 *
 * Judgement of "is this hold still armed" is the single owner `isPendingHoldBallWakeTask`, the same predicate the
 * cancel path uses, so a row offered as cancelable is one the DELETE route accepts.
 */

import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { isPendingHoldBallWakeTask, readHoldLifecycleProjection } from './managed-command-wake-task-projection.js';

export interface PendingHoldWait {
  readonly taskId: string;
  readonly threadId: string;
  readonly catId: string;
  /** Trigger principal; decides who may cancel, never who may see. */
  readonly userId: string;
  readonly since: number;
  readonly wakeAt: number;
}

const HOLD_CREATOR_PREFIX = 'hold-ball:';

function isTimerHold(task: DynamicTaskDef): boolean {
  // Legacy holds predate the lifecycle record and were all timers.
  if (!Object.hasOwn(task.params, 'holdLifecycle')) return true;
  return readHoldLifecycleProjection(task)?.mode === 'timer';
}

export function listPendingHoldWaits(tasks: readonly DynamicTaskDef[]): PendingHoldWait[] {
  const waits: PendingHoldWait[] = [];
  for (const task of tasks) {
    if (!isPendingHoldBallWakeTask(task) || !isTimerHold(task)) continue;
    if (task.trigger.type !== 'once' || task.deliveryThreadId === null) continue;
    const catId = task.createdBy.slice(HOLD_CREATOR_PREFIX.length);
    const userId = task.params.triggerUserId;
    const since = Date.parse(task.createdAt);
    if (!catId || typeof userId !== 'string' || !userId || !Number.isFinite(since)) continue;
    waits.push({
      taskId: task.id,
      threadId: task.deliveryThreadId,
      catId,
      userId,
      since,
      wakeAt: task.trigger.fireAt,
    });
  }
  return waits;
}
