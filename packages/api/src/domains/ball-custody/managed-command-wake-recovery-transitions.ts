import {
  buildCancelledManagedCommandCompletionParams,
  type ManagedCommandWakeDynamicTaskStore,
  type ManagedCommandWakeRecoveryResult,
  parseManagedCommandWakeTask,
  type RecordManagedCommandCompletionInput,
} from './managed-command-wake-lifecycle.js';

export function recordCancelledManagedCommandCompletion(
  store: ManagedCommandWakeDynamicTaskStore,
  input: RecordManagedCommandCompletionInput,
  now: number,
): ManagedCommandWakeRecoveryResult {
  const task = store.getById(input.taskId);
  const params = buildCancelledManagedCommandCompletionParams(task, input, now);
  if (!task || !params) return 'missing';
  return store.updateParamsIfCurrent(task.id, task.params, params) ? 'recovered' : 'missing';
}

export function persistManagedCommandFallbackDue(
  store: ManagedCommandWakeDynamicTaskStore,
  taskId: string,
  now: number,
): 'missing' | 'pending' | 'active' {
  const parsed = parseManagedCommandWakeTask(store.getById(taskId));
  if (!parsed) return 'missing';
  if (parsed.command.state !== 'command_running') return 'active';
  const wakeContent = parsed.task.params.message;
  if (typeof wakeContent !== 'string' || wakeContent.length === 0) return 'pending';
  return store.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
    ...parsed.task.params,
    holdLifecycle: {
      ...parsed.lifecycle,
      managedCommand: {
        ...parsed.command,
        state: 'condition_met',
        conditionMetAt: now,
        wakeContent,
        wakeSource: 'fallback_timer',
      },
    },
  })
    ? 'active'
    : 'pending';
}
