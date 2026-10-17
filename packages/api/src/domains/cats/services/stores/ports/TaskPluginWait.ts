import { isDeepStrictEqual } from 'node:util';
import type { TaskItem } from '@cat-cafe/shared';
import type { ReplacePluginWaitInput } from './TaskStoreContract.js';

/** Applied to the same Task snapshot used by the memory/Redis commit. */
export function replaceTaskPluginWait(task: TaskItem, input: ReplacePluginWaitInput): TaskItem | null {
  const { state, expectedGeneration } = input;
  const old = task.pluginWait;
  if (!isDeepStrictEqual(old, input.expectedState) || task.status !== input.expectedStatus) return null;
  const tracking = task.kind === 'pr_tracking' || task.kind === 'issue_tracking';
  const restart = tracking && !!old && state.generation > old.generation && input.newRegistration === true;
  const terminalTrackingRepair = (task.kind === 'pr_tracking' || task.kind === 'issue_tracking') && !!state.waitOutcome;
  if (
    task.entrustedWork ||
    (old?.invalidated && !restart) ||
    (task.status === 'done' && !restart && (state.await || (!old && !terminalTrackingRepair))) ||
    task.userId !== state.userId ||
    task.ownerCatId !== state.catId ||
    task.threadId !== state.threadId ||
    (old && old.pluginInstanceId !== state.pluginInstanceId) ||
    (old?.generation ?? null) !== expectedGeneration ||
    state.generation < (old?.generation ?? 0)
  )
    return null;
  const status = tracking ? (state.await ? 'doing' : state.waitOutcome ? 'done' : task.status) : task.status;
  return { ...task, status, pluginWait: structuredClone(state), updatedAt: Math.max(Date.now(), task.updatedAt + 1) };
}

/** Revoke wait authority in the same aggregate write that changes task ownership or closes it. */
export function reconcilePluginWaitTaskMutation(previous: TaskItem, next: TaskItem): TaskItem {
  const old = previous.pluginWait;
  if (!old) return next;
  const ownerChanged =
    previous.ownerCatId !== next.ownerCatId || previous.threadId !== next.threadId || previous.userId !== next.userId;
  const closed = previous.status !== 'done' && next.status === 'done';
  if (!ownerChanged && !closed) return next;
  const reason = ownerChanged ? 'owner_changed' : 'user_cancel';
  const { await: _active, registration: _registration, ...rest } = old;
  return {
    ...next,
    pluginWait: {
      ...rest,
      invalidated: reason,
      waitOutcome: {
        outcomeId: `task:${next.id}:g${old.generation}:${reason}`,
        generation: old.generation,
        ownerFence: { kind: 'containing_task', generation: old.generation },
        reason,
        delivery: 'not_applicable',
      },
    },
  };
}
