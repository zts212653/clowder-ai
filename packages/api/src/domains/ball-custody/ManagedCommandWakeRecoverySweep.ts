import { createModuleLogger } from '../../infrastructure/logger.js';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { managedCommandCompletionUnconsumedTotal } from '../../infrastructure/telemetry/instruments.js';
import {
  cancelDurableManagedGateJob,
  inspectDurableManagedGateJob,
  validateDurableManagedGateJob,
} from './durable-managed-gate-job.js';
import { ManagedCommandWakeRecoveryEngine } from './ManagedCommandWakeRecoveryEngine.js';
import {
  buildAdmissionFactIdempotencyKey,
  type RecordManagedCommandCompletionInput as CompletionInput,
  type ManagedCommandWakeCarrierTerminalReason,
  type ManagedCommandWakeRecoveryDeps,
  type ManagedCommandWakeRecoveryResult,
  type ManagedCommandWakeRecoveryStats,
  parseManagedCommandWakeTask as parseWakeTask,
  persistManagedCommandCompletionEvidence,
} from './managed-command-wake-lifecycle.js';
import {
  persistManagedCommandFallbackDue,
  recordCancelledManagedCommandCompletion,
} from './managed-command-wake-recovery-transitions.js';
import {
  type ManagedCommandWakeLostReason,
  parseRetiredManagedCommandWakeTask,
  readManagedCommandWakeProjection,
} from './managed-command-wake-task-projection.js';
import {
  listRetiredManagedCommandRecoveryTaskIds,
  recordRetiredManagedCommandCompletion,
  recoverRetiredManagedCommandTask,
} from './RetiredManagedCommandTerminalRecovery.js';

export type {
  ManagedCommandTerminalResult,
  ManagedCommandWakeProjection,
  ManagedCommandWakeRecoveryDeps,
  ManagedCommandWakeRecoveryResult,
  ManagedCommandWakeRecoveryStats,
  ManagedCommandWakeState,
  RecordManagedCommandCompletionInput,
} from './managed-command-wake-lifecycle.js';
export {
  buildAdmissionFactIdempotencyKey,
  createInitialManagedCommandWakeProjection,
  readManagedCommandWakeProjection,
  resolveManagedCommandWakeEventCarrier,
} from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/managed-command-wake-recovery');

export class ManagedCommandWakeRecoverySweep {
  private readonly now: () => number;
  private readonly engine: ManagedCommandWakeRecoveryEngine;
  constructor(private readonly deps: ManagedCommandWakeRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.engine = new ManagedCommandWakeRecoveryEngine(deps);
  }
  async recordCompletion(input: CompletionInput): Promise<ManagedCommandWakeRecoveryResult> {
    const evidence = persistManagedCommandCompletionEvidence(this.deps.dynamicTaskStore, input, this.now());
    if (evidence === 'missing') return 'missing';
    if (evidence === 'terminal') return 'recovered';
    if (evidence === 'contended') return 'pending';
    const result = await this.recoverTask(input.taskId);
    if (result === 'pending') managedCommandCompletionUnconsumedTotal.add(1);
    return result;
  }
  async recordFallbackDue(taskId: string): Promise<ManagedCommandWakeRecoveryResult> {
    const evidence = persistManagedCommandFallbackDue(this.deps.dynamicTaskStore, taskId, this.now());
    if (evidence !== 'active') return evidence;
    return this.recoverTask(taskId);
  }
  async recordCancelledCompletion(input: CompletionInput): Promise<ManagedCommandWakeRecoveryResult> {
    return recordCancelledManagedCommandCompletion(this.deps.dynamicTaskStore, input, this.now());
  }
  async recordRetiredCompletion(input: CompletionInput): Promise<ManagedCommandWakeRecoveryResult> {
    if (input.result.cancelled === true) return this.recordCancelledCompletion(input);
    const result = await recordRetiredManagedCommandCompletion(this.deps, input, this.now);
    if (result === 'pending') managedCommandCompletionUnconsumedTotal.add(1);
    return result;
  }
  async recordLost(
    taskId: string,
    lostReason: ManagedCommandWakeLostReason,
    lostDetail?: string,
  ): Promise<ManagedCommandWakeRecoveryResult> {
    const task = this.deps.dynamicTaskStore.getById(taskId);
    const parsed = parseWakeTask(task);
    if (!parsed) {
      const retired = parseRetiredManagedCommandWakeTask(task);
      if (!retired || retired.command.state !== 'command_running') return 'missing';
      const detail = lostDetail ? `（${lostDetail.slice(0, 500)}）` : '';
      return this.recordRetiredCompletion({
        taskId,
        wakeContent: `等待失败：命令「${retired.command.command}」执行归属已丢失${detail}。`,
        result: {
          exitCode: null,
          timedOut: false,
          durationMs: Math.max(0, this.now() - retired.command.startedAt),
          ...(lostDetail ? { tailOutput: lostDetail.slice(0, 500) } : {}),
        },
      });
    }
    if (parsed.command.state === 'lost') return this.recoverTask(taskId);
    if (parsed.command.state === 'consumed') return 'recovered';
    if (parsed.command.state !== 'command_running') return 'pending';
    if (
      !this.engine.updateCommand(parsed, {
        ...parsed.command,
        state: 'lost',
        lostAt: this.now(),
        lostReason,
        ...(lostDetail ? { lostDetail: lostDetail.slice(0, 500) } : {}),
      })
    ) {
      return 'pending';
    }
    return this.recoverTask(taskId);
  }
  private async reconcileDurableGateJobs(tasks: DynamicTaskDef[]): Promise<ManagedCommandWakeRecoveryStats> {
    let recovered = 0;
    let pending = 0;
    const running = tasks.flatMap((task) => {
      const command = readManagedCommandWakeProjection(task);
      const durableJob = command?.state === 'command_running' ? command.durableJob : undefined;
      return durableJob?.kind === 'full_gate' ? [{ task, durableJob }] : [];
    });
    for (const { task, durableJob } of running) {
      if (!validateDurableManagedGateJob(durableJob, task.id)) {
        pending += 1;
        continue;
      }
      const lifecycle = task.params.holdLifecycle;
      if (
        lifecycle &&
        typeof lifecycle === 'object' &&
        !Array.isArray(lifecycle) &&
        (lifecycle as Record<string, unknown>).status === 'cancel_requested'
      ) {
        const cancellation = lifecycle as Record<string, unknown>;
        cancelDurableManagedGateJob(durableJob, {
          cancelledBy:
            typeof cancellation.cancelledBy === 'string' ? cancellation.cancelledBy : 'persisted_hold_cancellation',
          reason: 'explicit_hold_cancel',
          now: this.now(),
        });
      }
      const inspection = inspectDurableManagedGateJob(durableJob);
      if (!('result' in inspection)) {
        pending += 1;
        continue;
      }
      const completion = {
        taskId: task.id,
        wakeContent: `持球唤醒（durable full gate 终态）：${inspection.result.tailOutput ?? inspection.state}`,
        result: inspection.result,
      };
      const result = parseRetiredManagedCommandWakeTask(task)
        ? await this.recordRetiredCompletion(completion)
        : await this.recordCompletion(completion);
      if (result === 'recovered') recovered += 1;
      else if (result === 'pending') pending += 1;
    }
    return { scanned: running.length, recovered, pending };
  }
  private async recoverAdmissionFacts(tasks: DynamicTaskDef[]): Promise<ManagedCommandWakeRecoveryStats> {
    let recovered = 0;
    let pending = 0;
    const undelivered = tasks.flatMap((task) => {
      const parsed = parseWakeTask(task);
      const admissionFact = parsed?.command.admissionFact;
      return parsed && admissionFact && !parsed.command.admissionFactAppended ? [{ task, parsed, admissionFact }] : [];
    });
    for (const { task, parsed, admissionFact } of undelivered) {
      const idempotencyKey = buildAdmissionFactIdempotencyKey(task.id);
      try {
        const existing = await this.deps.messageStore.getByIdempotencyKey(
          parsed.userId,
          parsed.threadId,
          idempotencyKey,
        );
        if (!existing) {
          const stored = await this.deps.messageStore.append({
            from: { kind: 'system', service: 'hold-ball' },
            userId: parsed.userId,
            content: admissionFact,
            mentions: [],
            timestamp: this.now(),
            threadId: parsed.threadId,
            idempotencyKey,
            source: {
              connector: 'hold-ball',
              label: '持球通知',
              icon: '🏓',
              meta: {
                managedHold: true,
                phase: 'status',
                taskId: task.id,
                threadId: parsed.threadId,
                catId: parsed.catId,
                wakeWhen: true,
                recoverySource: 'startup_sweep',
              },
            },
          });
          this.deps.socketManager.broadcastToRoom(`thread:${parsed.threadId}`, 'connector_message', {
            threadId: parsed.threadId,
            message: {
              id: stored.id,
              type: 'connector',
              content: stored.content,
              source: stored.source,
              timestamp: stored.timestamp,
            },
          });
        }
        const casOk = this.engine.updateCommand(parsed, { ...parsed.command, admissionFactAppended: true });
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
  private async recoverLostNonDurableCommands(tasks: DynamicTaskDef[]): Promise<ManagedCommandWakeRecoveryStats> {
    const isRunnerActive = this.deps.isCommandRunnerActive;
    if (!isRunnerActive) return { scanned: 0, recovered: 0, pending: 0 };
    let recovered = 0;
    let pending = 0;
    const lostCandidates = tasks.flatMap((task) => {
      const parsed = parseWakeTask(task) ?? parseRetiredManagedCommandWakeTask(task);
      return parsed &&
        parsed.command.state === 'command_running' &&
        !parsed.command.durableJob &&
        !isRunnerActive(task.id)
        ? [parsed]
        : [];
    });
    for (const parsed of lostCandidates) {
      const result = await this.recordLost(parsed.task.id, 'runtime_restart');
      if (result === 'recovered') recovered += 1;
      else pending += 1;
    }
    return { scanned: lostCandidates.length, recovered, pending };
  }
  async runOnce(): Promise<ManagedCommandWakeRecoveryStats> {
    const tasks = this.deps.dynamicTaskStore.getAll();
    const admission = await this.recoverAdmissionFacts(tasks);
    const durable = await this.reconcileDurableGateJobs(tasks);
    const lost = await this.recoverLostNonDurableCommands(tasks);
    let { recovered, pending } = admission;
    recovered += durable.recovered;
    pending += durable.pending;
    recovered += lost.recovered;
    pending += lost.pending;

    // F261: API restart loses the in-memory ManagedRunner, not the authorized
    // action-plane job. Reconcile durable full-gate process/receipt truth before
    // ordinary completion delivery. The existing lifecycle CAS and idempotency
    // key provide exactly-once terminal settlement.
    // ── F167 Phase P: admission-fact startup recovery (BEFORE completion) ──
    // R6 P1-2: admission visibility must settle BEFORE completion publish/dispatch.
    // A condition_met task with admissionFactAppended=false must see its admission
    // fact re-delivered first, then the completion candidate loop can publish and
    // dispatch — otherwise the provider receives the wake before the timeline
    // shows what happened at spawn.
    // ── Normal completion candidates (non-command_running active tasks) ──
    const candidates = tasks.filter((task) => {
      const parsed = parseWakeTask(task);
      return !!parsed && parsed.command.state !== 'command_running';
    });
    const retiredTaskIds = listRetiredManagedCommandRecoveryTaskIds(tasks);
    for (const task of candidates) {
      const result = await this.recoverTask(task.id);
      if (result === 'recovered') recovered += 1;
      else if (result === 'pending') pending += 1;
    }
    for (const taskId of retiredTaskIds) {
      const result = await recoverRetiredManagedCommandTask(this.deps, taskId, this.now);
      if (result === 'recovered') recovered += 1;
      else if (result === 'pending') pending += 1;
    }

    return {
      scanned: candidates.length + retiredTaskIds.length + admission.scanned + durable.scanned + lost.scanned,
      recovered,
      pending,
    };
  }
  async retireCarrier(messageIds: readonly string[], reason: ManagedCommandWakeCarrierTerminalReason): Promise<number> {
    return this.engine.retireCarrier(messageIds, reason);
  }
  async retireThread(
    threadId: string,
    userId: string,
    reason: ManagedCommandWakeCarrierTerminalReason,
  ): Promise<{ retired: number; messageIds: string[] }> {
    return this.engine.retireThread(threadId, userId, reason);
  }

  async recoverTask(taskId: string): Promise<ManagedCommandWakeRecoveryResult> {
    return this.engine.recoverTask(taskId);
  }
}
