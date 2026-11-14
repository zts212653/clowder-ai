import { readDurableGateRecord } from '../managed-job/durable-managed-gate-job-store.js';
import {
  acknowledgeManagedJobWake,
  ensureManagedJobWakeIntent,
  readManagedJobRecovery,
  retireManagedJobWake,
} from '../managed-job/managed-job-recovery-ledger.js';
import { resolveManagedCommandJob } from './managed-command-job-reference.js';
import {
  type ManagedCommandWakeDynamicTaskStore,
  type ManagedCommandWakeRecoveryDeps,
  normalizeManagedCommandTerminalResult,
  parseManagedCommandWakeTask,
  type RecordManagedCommandCompletionInput,
  readManagedCommandWakeProjection,
} from './managed-command-wake-lifecycle.js';

/** A native completion can only hand off the job owner's terminal truth, never a runner's guess. */
export function prepareManagedCommandProductionHandoff(
  store: ManagedCommandWakeDynamicTaskStore,
  input: RecordManagedCommandCompletionInput,
): RecordManagedCommandCompletionInput | null {
  const task = store.getById(input.taskId);
  const command = task && readManagedCommandWakeProjection(task);
  if (!task || !command || (!command.jobId && !command.durableJob)) return input;
  const job = resolveManagedCommandJob(task);
  if (!job) return null;
  const record = readDurableGateRecord(job);
  let production = readManagedJobRecovery(job);
  if (record?.state !== 'terminal') return null;
  if (!record.result) return job.recordStorage === 'sqlite_v1' ? null : input;
  const parsed = parseManagedCommandWakeTask(task);
  if (!production?.recovery.wakeIntent && parsed && ['command_running', 'condition_met'].includes(command.state))
    production = ensureManagedJobWakeIntent(job, Date.now(), record as unknown as Record<string, unknown>);
  if (!production?.recovery.wakeIntent)
    return job.recordStorage === 'sqlite_v1' ? null : { ...input, result: record.result };
  if (parsed && !command.productionIntentKey && !command.messageId) {
    if (
      !store.updateParamsIfCurrent(task.id, task.params, {
        ...task.params,
        holdLifecycle: {
          ...parsed.lifecycle,
          managedCommand: { ...command, productionIntentKey: production.recovery.wakeIntent.key },
        },
      })
    )
      return null;
  }
  const original = normalizeManagedCommandTerminalResult(record.result);
  const sameResult = JSON.stringify(normalizeManagedCommandTerminalResult(input.result)) === JSON.stringify(original);
  return {
    ...input,
    result: record.result,
    wakeContent: sameResult
      ? input.wakeContent
      : `持球唤醒（命令完成）：退出码 ${record.result.exitCode}${record.result.timedOut ? '（超时）' : ''}\n${record.result.tailOutput ?? ''}`,
  };
}

/** Queue admission transfers production responsibility; delivery/consumption stay in the original wait. */
export async function acknowledgeManagedCommandProductionHandoff(
  deps: Pick<ManagedCommandWakeRecoveryDeps, 'dynamicTaskStore' | 'messageStore' | 'getEventCarrier'>,
  taskId: string,
  now: number,
): Promise<void> {
  const store = deps.dynamicTaskStore;
  const task = store.getById(taskId);
  const command = task && readManagedCommandWakeProjection(task);
  if (!task || !command || (!command.jobId && !command.durableJob)) return;
  const job = resolveManagedCommandJob(task);
  if (!job) return;
  const production = readManagedJobRecovery(job);
  const intent = production?.recovery.wakeIntent;
  if (!intent || intent.status !== 'pending') return;
  if (command.messageId) {
    const target = job.wakeTarget;
    const source =
      (await deps.messageStore.getByIdempotencyKey(target.userId, target.threadId, intent.key)) ??
      (await deps.messageStore.getByIdempotencyKey(target.userId, target.threadId, `hold-ball-completion:${taskId}`));
    if (
      source?.id !== command.messageId ||
      source.source?.meta?.taskId !== taskId ||
      source.source.meta.catId !== target.catId
    )
      return;
    const carrier = await deps.getEventCarrier?.({ ...target, messageId: command.messageId });
    if (!carrier || carrier.state === 'missing' || carrier.state === 'orphaned') return;
    acknowledgeManagedJobWake(job, intent.key, command.messageId, now);
    return;
  }
  const lifecycle = task.params.holdLifecycle as Record<string, unknown> | undefined;
  if (
    lifecycle &&
    ['cancelled_by_user', 'cancel_requested', 'retired_by_replacement', 'not_started', 'fired'].includes(
      String(lifecycle.status),
    )
  ) {
    const waiting = lifecycle.await as Record<string, unknown> | undefined;
    retireManagedJobWake(job, intent.key, `command:${task.id}:g${waiting?.generation ?? 'legacy'}:${lifecycle.status}`);
  }
}
