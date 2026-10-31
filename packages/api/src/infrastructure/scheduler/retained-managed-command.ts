import type Database from 'better-sqlite3';
import {
  isHoldBallWakeTask,
  isPlainRecord,
  type ManagedCommandTerminalResult,
  readHoldLifecycleProjection,
  readManagedCommandWakeProjection,
} from '../../domains/ball-custody/managed-command-wake-task-projection.js';
import type { DynamicTaskDef } from './DynamicTaskStore.js';

export type RetainedManagedCommandState = 'absent' | 'pending' | 'not_started' | 'conflict';

function readNoStartResult(raw: string, taskId: string): ManagedCommandTerminalResult | null {
  let resource: unknown;
  try {
    resource = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(resource)) return null;
  const business = resource.businessResult;
  const resultRef = `managed-result:${taskId}`;
  if (
    resource.v !== 1 ||
    resource.state !== 'terminal' ||
    resource.outcome !== 'not_started' ||
    resource.launchClosed !== true ||
    !Array.isArray(resource.nativeEffects) ||
    resource.nativeEffects.length !== 0 ||
    typeof resource.executionRef !== 'string' ||
    !resource.executionRef ||
    resource.pendingIntentRef !== `turnexec:${resource.executionRef}` ||
    resource.resultRef !== resultRef ||
    !isPlainRecord(business) ||
    business.outcome !== 'not_started' ||
    business.resultRef !== resultRef ||
    !isPlainRecord(business.result)
  )
    return null;
  const result = business.result;
  if (result.exitCode !== null || result.timedOut !== false || result.durationMs !== 0 || result.cancelled === true)
    return null;
  return {
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    ...(typeof result.tailOutput === 'string' ? { tailOutput: result.tailOutput } : {}),
  };
}

/**
 * Read the private column retained by the withdrawn admission implementation.
 * It is deliberately absent on fresh schemas and never added to public task DTOs.
 * A proven no-start can settle only an already retired, unpublished ordinary hold.
 * Keep the resource bytes, cancellation provenance and task identity intact.
 */
export function reconcileRetainedManagedCommand(
  db: Database.Database,
  task: DynamicTaskDef,
): RetainedManagedCommandState {
  return db
    .transaction((): RetainedManagedCommandState => {
      const row = db.prepare('SELECT * FROM dynamic_task_defs WHERE id = ?').get(task.id) as
        | {
            params_json: string;
            enabled: number;
            template_id: string;
            delivery_thread_id: string | null;
            created_by: string;
            managed_resource_json?: unknown;
          }
        | undefined;
      if (!row || row.managed_resource_json == null) return 'absent';
      if (
        row.params_json !== JSON.stringify(task.params) ||
        row.enabled !== Number(task.enabled) ||
        row.template_id !== task.templateId ||
        row.delivery_thread_id !== task.deliveryThreadId ||
        row.created_by !== task.createdBy
      )
        return 'conflict';
      // A retained record of unknown shape still must not be physically deleted.
      if (typeof row.managed_resource_json !== 'string' || !isHoldBallWakeTask(task)) return 'pending';
      const result = readNoStartResult(row.managed_resource_json, task.id);
      const lifecycle = readHoldLifecycleProjection(task);
      const command = readManagedCommandWakeProjection(task);
      if (
        !result ||
        row.enabled !== 0 ||
        task.enabled ||
        !lifecycle ||
        !['cancel_requested', 'cancelled_by_user', 'retired_by_replacement'].includes(String(lifecycle.status)) ||
        !command ||
        command.durableJob ||
        command.jobId ||
        command.messageId ||
        command.invocationId ||
        command.wakeSource ||
        (command.pid !== undefined && command.pid !== null)
      )
        return 'pending';
      if (command.state === 'not_started') return 'not_started';
      if (command.state !== 'command_running' || command.result) return 'pending';
      const nextParams = {
        ...task.params,
        holdLifecycle: {
          ...lifecycle,
          managedCommand: {
            ...command,
            state: 'not_started',
            notStartedReason: 'admission_rejected',
            notStartedDetail: typeof result.tailOutput === 'string' ? result.tailOutput : 'retained_no_start_receipt',
            result,
          },
        },
      };
      const updated = db
        .prepare(`UPDATE dynamic_task_defs SET params_json = ?
      WHERE id = ? AND enabled = 0 AND params_json = ? AND managed_resource_json = ?`)
        .run(JSON.stringify(nextParams), task.id, row.params_json, row.managed_resource_json);
      return updated.changes === 1 ? 'not_started' : 'conflict';
    })
    .immediate();
}
