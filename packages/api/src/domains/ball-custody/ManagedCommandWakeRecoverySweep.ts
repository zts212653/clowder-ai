import { createModuleLogger } from '../../infrastructure/logger.js';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { managedCommandCompletionUnconsumedTotal } from '../../infrastructure/telemetry/instruments.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { ManagedCommandWaitEventSettlement } from './ManagedCommandWaitEventSettlement.js';
import { ManagedCommandWakeRecoveryEngine } from './ManagedCommandWakeRecoveryEngine.js';
import { recoverManagedCommandAdmissionFacts } from './managed-command-admission-recovery.js';
import { resolveManagedCommandJob } from './managed-command-job-reference.js';
import { reconcileManagedCommandProducers } from './managed-command-producer-reconciliation.js';
import { prepareManagedCommandProductionHandoff } from './managed-command-production-handoff.js';
import { recoverManagedCommandProduction } from './managed-command-production-recovery.js';
import { processManagedCommandWait } from './managed-command-wait-recovery.js';
import {
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
  private inFlight: Promise<ManagedCommandWakeRecoveryStats> | undefined;
  private readonly now: () => number;
  private readonly engine: ManagedCommandWakeRecoveryEngine;
  private readonly settlement: ManagedCommandWaitEventSettlement;
  constructor(private readonly deps: ManagedCommandWakeRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.engine = new ManagedCommandWakeRecoveryEngine(deps);
    this.settlement = new ManagedCommandWaitEventSettlement(deps.dynamicTaskStore, (id, force) =>
      this.processWait(id, force),
    );
  }
  async recordCompletion(input: CompletionInput): Promise<ManagedCommandWakeRecoveryResult> {
    const handoff = prepareManagedCommandProductionHandoff(this.deps.dynamicTaskStore, input);
    if (!handoff) return 'pending';
    input = handoff;
    const evidence = persistManagedCommandCompletionEvidence(this.deps.dynamicTaskStore, input, this.now());
    if (evidence === 'missing') return 'missing';
    if (evidence === 'terminal') {
      await this.repairProductionReceipt(input.taskId);
      return 'recovered';
    }
    if (evidence === 'contended') return 'pending';
    const command = this.deps.dynamicTaskStore.getById(input.taskId);
    const projection = command && readManagedCommandWakeProjection(command);
    if (projection?.admissionFact && !projection.admissionFactAppended) return 'pending';
    const result = await this.recoverTask(input.taskId);
    if (result === 'pending') managedCommandCompletionUnconsumedTotal.add(1);
    return result;
  }
  async recordFallbackDue(taskId: string): Promise<ManagedCommandWakeRecoveryResult> {
    const evidence = persistManagedCommandFallbackDue(this.deps.dynamicTaskStore, taskId, this.now());
    if (evidence !== 'active') return evidence;
    return this.recoverTask(taskId, false);
  }
  async recordCancelledCompletion(input: CompletionInput): Promise<ManagedCommandWakeRecoveryResult> {
    const handoff = prepareManagedCommandProductionHandoff(this.deps.dynamicTaskStore, input);
    if (!handoff) return 'pending';
    const result = recordCancelledManagedCommandCompletion(this.deps.dynamicTaskStore, handoff, this.now());
    await this.repairProductionReceipt(input.taskId);
    return result;
  }
  async recordRetiredCompletion(input: CompletionInput): Promise<ManagedCommandWakeRecoveryResult> {
    const handoff = prepareManagedCommandProductionHandoff(this.deps.dynamicTaskStore, input);
    if (!handoff) return 'pending';
    input = handoff;
    if (input.result.cancelled === true) return this.recordCancelledCompletion(input);
    const result = await recordRetiredManagedCommandCompletion(this.deps, input, this.now);
    await this.repairProductionReceipt(input.taskId);
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
  private async recoverLostNonDurableCommands(tasks: DynamicTaskDef[]): Promise<ManagedCommandWakeRecoveryStats> {
    const isRunnerActive = this.deps.isCommandRunnerActive;
    if (!isRunnerActive) return { scanned: 0, recovered: 0, pending: 0 };
    let recovered = 0;
    let pending = 0;
    const lostCandidates = tasks.flatMap((task) => {
      const parsed = parseWakeTask(task) ?? parseRetiredManagedCommandWakeTask(task);
      return parsed &&
        parsed.command.state === 'command_running' &&
        !parsed.command.jobId &&
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
  runOnce(): Promise<ManagedCommandWakeRecoveryStats> {
    if (this.inFlight) return this.inFlight;
    const cycle = this.runCycle().finally(() => {
      if (this.inFlight === cycle) this.inFlight = undefined;
    });
    this.inFlight = cycle;
    return cycle;
  }

  private async runCycle(): Promise<ManagedCommandWakeRecoveryStats> {
    const selectedTasks =
      this.deps.dynamicTaskStore.listManagedCommandCandidates?.(this.now(), 100) ?? this.deps.dynamicTaskStore.getAll();
    const tasks = selectedTasks.filter(
      (task) => !this.deps.dynamicTaskStore.getManagedCommandRecoveryState?.(task.id)?.fact.disposition,
    );
    // Retired ordinary commands can retain pre-rollback terminal evidence in a
    // private column. Settle that exact proof without a completion wake or replay.
    for (const task of tasks) {
      if (task.enabled || readManagedCommandWakeProjection(task)?.state !== 'command_running') continue;
      if (this.deps.dynamicTaskStore.reconcileRetainedManagedCommand?.(task) === 'not_started') {
        this.deps.taskRunner.unregister(task.id);
      }
    }
    const admission = await recoverManagedCommandAdmissionFacts(this.deps, this.engine, tasks, this.now);
    const durable = await reconcileManagedCommandProducers(this.deps, tasks, this.now, {
      normal: (input) => this.recordCompletion(input),
      retired: (input) => this.recordRetiredCompletion(input),
    });
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
      const result = await this.recoverTask(task.id, false);
      if (result === 'recovered') recovered += 1;
      else if (result === 'pending') pending += 1;
    }
    for (const taskId of retiredTaskIds) {
      const result = await recoverRetiredManagedCommandTask(this.deps, taskId, this.now);
      if (result === 'recovered') recovered += 1;
      else if (result === 'pending') pending += 1;
    }
    if (this.deps.dynamicTaskStore.getManagedCommandRecoveryState) {
      for (const original of selectedTasks) {
        const current = this.deps.dynamicTaskStore.getById(original.id);
        const command = current && readManagedCommandWakeProjection(current);
        if (!current) continue;
        if (
          command?.state === 'command_running' ||
          command?.state === 'not_started' ||
          !parseWakeTask(current) ||
          this.deps.dynamicTaskStore.getManagedCommandRecoveryState(current.id)?.fact.disposition
        )
          await this.recoverTask(current.id, false);
      }
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

  recoverTask(taskId: string, force = true): Promise<ManagedCommandWakeRecoveryResult> {
    return this.settlement.recover(taskId, force);
  }
  onMessageLifecycleChanged(message: StoredMessage): Promise<number> {
    return this.settlement.onMessage(message);
  }

  private async processWait(taskId: string, force: boolean): Promise<ManagedCommandWakeRecoveryResult> {
    const result = await processManagedCommandWait(
      this.deps,
      taskId,
      () => this.engine.processTask(taskId),
      this.now(),
      force,
    );
    await this.repairProductionReceipt(taskId);
    return result;
  }

  private async repairProductionReceipt(taskId: string): Promise<void> {
    try {
      const task = this.deps.dynamicTaskStore.getById(taskId);
      const job = task && resolveManagedCommandJob(task);
      if (job) await recoverManagedCommandProduction(this.deps, job, this.now());
    } catch (err) {
      // The original wait/job outboxes retain responsibility when their storage cannot be read.
      log.warn({ err, taskId }, 'Managed production receipt remains unresolved');
    }
  }
}
