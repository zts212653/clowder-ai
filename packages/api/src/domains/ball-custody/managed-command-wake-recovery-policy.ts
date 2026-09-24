import { createModuleLogger } from '../../infrastructure/logger.js';
import { managedCommandWakeSlaBreachTotal } from '../../infrastructure/telemetry/instruments.js';
import type { ManagedCommandWakeRecoveryDeps } from './managed-command-wake-lifecycle.js';
import {
  type ManagedCommandWakeProjection,
  type ParsedManagedCommandWakeTask,
  parseManagedCommandWakeTask,
} from './managed-command-wake-task-projection.js';

const log = createModuleLogger('ball-custody/managed-command-wake-recovery-policy');

export function isDispatchableManagedCommandWakeState(state: ManagedCommandWakeProjection['state']): boolean {
  return state === 'message_written' || state === 'dispatch_pending' || state === 'dispatched' || state === 'enqueued';
}

export function recordManagedCommandWakeSlaBreach(
  deps: ManagedCommandWakeRecoveryDeps,
  parsed: ParsedManagedCommandWakeTask,
  now: () => number,
  wakeSlaMs: number,
): ParsedManagedCommandWakeTask {
  const conditionMetAt = parsed.command.conditionMetAt;
  if (
    conditionMetAt === undefined ||
    parsed.command.slaBreachObservedAt !== undefined ||
    now() - conditionMetAt < wakeSlaMs
  ) {
    return parsed;
  }
  const observedAt = now();
  const updated = deps.dynamicTaskStore.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
    ...parsed.task.params,
    holdLifecycle: {
      ...parsed.lifecycle,
      managedCommand: { ...parsed.command, slaBreachObservedAt: observedAt },
    },
  });
  if (!updated) return parsed;
  managedCommandWakeSlaBreachTotal.add(1);
  log.warn(
    {
      taskId: parsed.task.id,
      threadId: parsed.threadId,
      messageId: parsed.command.messageId,
      conditionMetAt,
      observedAt,
    },
    'managed-command completion wake exceeded SLA',
  );
  return parseManagedCommandWakeTask(deps.dynamicTaskStore.getById(parsed.task.id)) ?? parsed;
}
