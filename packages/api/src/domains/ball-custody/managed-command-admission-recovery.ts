import { createModuleLogger } from '../../infrastructure/logger.js';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { ManagedCommandWakeRecoveryEngine } from './ManagedCommandWakeRecoveryEngine.js';
import { resolveManagedCommandJob } from './managed-command-job-reference.js';
import { settleNoSpawnDurableGate } from './managed-command-no-spawn-terminal.js';
import type {
  ManagedCommandWakeRecoveryDeps,
  ManagedCommandWakeRecoveryStats,
} from './managed-command-wake-lifecycle.js';
import {
  buildAdmissionFactIdempotencyKey,
  parseManagedCommandWakeTask as parseWakeTask,
} from './managed-command-wake-lifecycle.js';
import { parseNotStartedManagedCommandTask } from './managed-command-wake-task-projection.js';

const log = createModuleLogger('ball-custody/managed-admission-recovery');

/** Original admission visibility is recovered before any original completion can be delivered. */
export async function recoverManagedCommandAdmissionFacts(
  deps: ManagedCommandWakeRecoveryDeps,
  engine: ManagedCommandWakeRecoveryEngine,
  tasks: DynamicTaskDef[],
  now: () => number,
): Promise<ManagedCommandWakeRecoveryStats> {
  let recovered = 0;
  let pending = 0;
  const undelivered = tasks.flatMap((task) => {
    const parsed = parseWakeTask(task) ?? parseNotStartedManagedCommandTask(task);
    const admissionFact = parsed?.command.admissionFact;
    return parsed && admissionFact && !parsed.command.admissionFactAppended ? [{ task, parsed, admissionFact }] : [];
  });
  for (const { task, parsed, admissionFact } of undelivered) {
    const idempotencyKey = buildAdmissionFactIdempotencyKey(task.id);
    try {
      if (parsed.command.state === 'not_started') {
        const durableJob = resolveManagedCommandJob(task);
        // Recover the exact params-written / enabled-not-yet-written crash window.
        // The explicit lifecycle fact is proof; pid=null is never used as proof.
        if (
          ((parsed.command.jobId || parsed.command.durableJob) && !durableJob) ||
          (durableJob &&
            !settleNoSpawnDurableGate(durableJob, task.id, parsed.command.notStartedDetail ?? 'admission_rejected')) ||
          (task.enabled && !deps.dynamicTaskStore.setEnabled(task.id, false))
        ) {
          pending += 1;
          continue;
        }
        deps.taskRunner.unregister(task.id);
      }
      const existing = await deps.messageStore.getByIdempotencyKey(parsed.userId, parsed.threadId, idempotencyKey);
      if (!existing) {
        const stored = await deps.messageStore.append({
          from: { kind: 'system', service: 'hold-ball' },
          userId: parsed.userId,
          content: admissionFact,
          mentions: [],
          timestamp: now(),
          threadId: parsed.threadId,
          idempotencyKey,
          source: {
            connector: 'hold-ball',
            label: '持球通知',
            icon: '🏓',
            meta: {
              managedHold: true,
              phase: 'status',
              cancelable: false,
              taskId: task.id,
              threadId: parsed.threadId,
              catId: parsed.catId,
              wakeWhen: true,
              recoverySource: 'startup_sweep',
              ...(parsed.command.jobId ? { jobId: parsed.command.jobId, managedJobReceipt: 'admission' } : {}),
            },
          },
        });
        deps.socketManager.broadcastToRoom(`thread:${parsed.threadId}`, 'connector_message', {
          threadId: parsed.threadId,
          message: {
            id: stored.id,
            from: stored.from,
            type: 'connector',
            content: stored.content,
            source: stored.source,
            timestamp: stored.timestamp,
          },
        });
      }
      const casOk = engine.updateCommand(parsed, { ...parsed.command, admissionFactAppended: true });
      if (casOk) recovered += 1;
      else pending += 1;
      log.info(
        { taskId: task.id, threadId: parsed.threadId, command: parsed.command.command, casOk },
        'F167 Phase P: admission-fact re-delivered via startup recovery',
      );
    } catch (err) {
      log.warn(
        { taskId: task.id, threadId: parsed.threadId, err },
        'F167 Phase P: admission-fact startup recovery failed — will retry on next sweep',
      );
      pending += 1;
    }
  }
  return { scanned: undelivered.length, recovered, pending };
}
