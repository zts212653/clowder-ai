import { createModuleLogger } from '../../infrastructure/logger.js';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import {
  managedCommandCompletionUnconsumedTotal,
  managedCommandDispatchRetryTotal,
} from '../../infrastructure/telemetry/instruments.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../cats/services/stores/ports/invocation-state-machine.js';
import {
  cancelDurableManagedGateJob,
  inspectDurableManagedGateJob,
  validateDurableManagedGateJob,
} from './durable-managed-gate-job.js';
import { ManagedCommandWakeActionLeaseAdmissionError } from './managed-command-wake-action-lease-admission.js';
import {
  buildAdmissionFactIdempotencyKey,
  type RecordManagedCommandCompletionInput as CompletionInput,
  type ManagedCommandWakeCarrierTerminalReason,
  type ManagedCommandWakeProjection,
  type ManagedCommandWakeRecoveryDeps,
  type ManagedCommandWakeRecoveryResult,
  type ManagedCommandWakeRecoveryStats,
  type ManagedCommandWakeTriggerOutcome,
  type ParsedManagedCommandWakeTask,
  parseManagedCommandWakeTask as parseWakeTask,
  persistManagedCommandCompletionEvidence,
} from './managed-command-wake-lifecycle.js';
import { publishManagedCommandWakeMessage } from './managed-command-wake-message-fence.js';
import {
  isDispatchableManagedCommandWakeState,
  recordManagedCommandWakeSlaBreach,
  recoverManagedCommandMissingDisposition,
} from './managed-command-wake-recovery-policy.js';
import {
  persistManagedCommandFallbackDue,
  recordCancelledManagedCommandCompletion,
} from './managed-command-wake-recovery-transitions.js';
import {
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
  private readonly dispatchedCarrierGraceMs: number;
  private readonly wakeSlaMs: number;
  constructor(private readonly deps: ManagedCommandWakeRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.dispatchedCarrierGraceMs = deps.dispatchedCarrierGraceMs ?? 15_000;
    this.wakeSlaMs = deps.wakeSlaMs ?? 60_000;
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
        const existing = await this.deps.messageStore.getByIdempotencyKey('system', parsed.threadId, idempotencyKey);
        if (!existing) {
          const stored = await this.deps.messageStore.append({
            userId: 'system',
            catId: null,
            content: admissionFact,
            mentions: [],
            timestamp: this.now(),
            threadId: parsed.threadId,
            idempotencyKey,
            source: {
              connector: 'hold-ball',
              label: '持球通知',
              icon: '🏓',
              meta: { wakeWhen: true, taskId: task.id, recoverySource: 'startup_sweep' },
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
        const casOk = this.updateCommand(parsed, { ...parsed.command, admissionFactAppended: true });
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
  async runOnce(): Promise<ManagedCommandWakeRecoveryStats> {
    const tasks = this.deps.dynamicTaskStore.getAll();
    const admission = await this.recoverAdmissionFacts(tasks);
    const durable = await this.reconcileDurableGateJobs(tasks);
    let { recovered, pending } = admission;
    recovered += durable.recovered;
    pending += durable.pending;

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
      scanned: candidates.length + retiredTaskIds.length + admission.scanned + durable.scanned,
      recovered,
      pending,
    };
  }
  async retireCarrier(messageIds: readonly string[], reason: ManagedCommandWakeCarrierTerminalReason): Promise<number> {
    const getById = this.deps.messageStore.getById?.bind(this.deps.messageStore);
    if (!getById) return 0;
    let retired = 0;
    for (const messageId of new Set(messageIds)) {
      const message = await getById(messageId);
      const meta = message?.source?.meta;
      if (
        message?.source?.connector !== 'hold-ball' ||
        meta?.wakeWhen !== true ||
        typeof meta.taskId !== 'string' ||
        meta.taskId.length === 0
      ) {
        continue;
      }
      if (this.retireTask(meta.taskId, reason, messageId)) retired += 1;
    }
    return retired;
  }
  async retireThread(
    threadId: string,
    userId: string,
    reason: ManagedCommandWakeCarrierTerminalReason,
  ): Promise<{ retired: number; messageIds: string[] }> {
    let retired = 0;
    const messageIds = new Set<string>();
    const taskIds = this.deps.dynamicTaskStore.getAll().flatMap((task) => {
      const parsed = parseWakeTask(task);
      if (!parsed || parsed.threadId !== threadId || parsed.userId !== userId) return [];
      if (parsed.command.messageId) messageIds.add(parsed.command.messageId);
      return [parsed.task.id];
    });
    for (const taskId of taskIds) {
      if (this.retireTask(taskId, reason)) retired += 1;
    }
    return { retired, messageIds: [...messageIds] };
  }
  async recoverTask(taskId: string): Promise<ManagedCommandWakeRecoveryResult> {
    let parsed = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
    if (!parsed) return 'missing';
    parsed = recordManagedCommandWakeSlaBreach(this.deps, parsed, this.now, this.wakeSlaMs);
    if (parsed.command.state === 'condition_met') {
      const published = await this.publishCompletion(parsed);
      if (!published) return 'pending';
      parsed = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
      if (!parsed) return 'missing';
    }
    if (isDispatchableManagedCommandWakeState(parsed.command.state)) {
      const eventCarrier = parsed.command.messageId
        ? await this.deps.getEventCarrier?.({
            threadId: parsed.threadId,
            userId: parsed.userId,
            catId: parsed.catId,
            messageId: parsed.command.messageId,
          })
        : undefined;
      if (eventCarrier?.state === 'handled') return this.consume(parsed, eventCarrier.invocationId);
      if (eventCarrier?.state === 'terminal') {
        return this.consume(parsed, undefined, eventCarrier.reason);
      }
      if (eventCarrier?.state === 'failed') {
        return eventCarrier.errorCode === 'managed_hold_disposition_missing'
          ? recoverManagedCommandMissingDisposition(this.deps, parsed, eventCarrier, this.now)
          : 'pending';
      }
      if (eventCarrier?.state === 'pending') return 'pending';
      // An orphaned receipt proves durable responsibility while also proving
      // that its exact Queue row disappeared. Only that state may reach the
      // Connector's verified custody-rebind path.
      const carrier = await this.findInvocationCarrier(parsed);
      if (carrier) {
        const recoveryStatus = classifyInvocationRecoveryStatus(carrier.status);
        if (recoveryStatus === 'completed') return this.consume(parsed, carrier.id);
        if (recoveryStatus === 'in_flight' || recoveryStatus === 'terminal') return 'pending';
      }
      const lastDispatchAt = parsed.command.lastDispatchAt ?? 0;
      if (lastDispatchAt > 0 && this.now() - lastDispatchAt < this.dispatchedCarrierGraceMs) {
        return 'pending';
      }
      return this.dispatch(parsed);
    }

    return parsed.command.state === 'consumed' ? 'recovered' : 'pending';
  }

  private async publishCompletion(parsed: ParsedManagedCommandWakeTask): Promise<boolean> {
    return publishManagedCommandWakeMessage(this.deps, parsed, this.now);
  }

  private async dispatch(parsed: ParsedManagedCommandWakeTask): Promise<ManagedCommandWakeRecoveryResult> {
    const messageId = parsed.command.messageId;
    const wakeContent = parsed.command.wakeContent;
    if (!messageId || !wakeContent) return 'pending';

    const attemptAt = this.now();
    const attemptCount = (parsed.command.dispatchAttemptCount ?? 0) + 1;
    if (attemptCount > 1) managedCommandDispatchRetryTotal.add(1);
    if (
      !this.updateCommand(parsed, {
        ...parsed.command,
        state: 'dispatch_pending',
        dispatchAttemptCount: attemptCount,
        lastDispatchAt: attemptAt,
      })
    ) {
      return 'pending';
    }

    const trigger = this.deps.getInvokeTrigger();
    if (!trigger) {
      this.persistDispatchOutcome(parsed.task.id, 'unavailable');
      return 'pending';
    }

    let outcome: ManagedCommandWakeTriggerOutcome;
    try {
      outcome = await trigger.trigger(
        parsed.threadId,
        parsed.catId,
        parsed.userId,
        `[定时任务] ${wakeContent}`,
        messageId,
        undefined,
        { sourceCategory: 'scheduled', forceQueue: true },
      );
    } catch (err) {
      if (err instanceof ManagedCommandWakeActionLeaseAdmissionError) {
        try {
          const canceled = await this.deps.messageStore.markCanceled(messageId);
          if (canceled?.deliveryStatus === 'canceled' && this.retireTask(parsed.task.id, 'canceled', messageId)) {
            log.info({ code: err.code, taskId: parsed.task.id, messageId }, 'stale managed-command wake retired');
            return 'recovered';
          }
        } catch (cancelError) {
          log.warn({ err, cancelError, taskId: parsed.task.id, messageId }, 'managed-command wake retirement failed');
        }
        this.persistDispatchOutcome(parsed.task.id, 'failed');
        return 'pending';
      }
      log.warn(
        { err, taskId: parsed.task.id, threadId: parsed.threadId, messageId },
        'managed-command execution-plane dispatch failed',
      );
      this.persistDispatchOutcome(parsed.task.id, 'failed');
      return 'pending';
    }

    const latest = parseWakeTask(this.deps.dynamicTaskStore.getById(parsed.task.id));
    if (!latest) return 'missing';
    if (outcome === 'full') {
      this.updateCommand(latest, { ...latest.command, state: 'dispatch_pending', lastDispatchOutcome: 'full' });
      return 'pending';
    }

    if (
      !this.updateCommand(latest, {
        ...latest.command,
        state: outcome,
        lastDispatchOutcome: outcome,
      })
    ) {
      return 'pending';
    }
    const acknowledged = parseWakeTask(this.deps.dynamicTaskStore.getById(parsed.task.id));
    if (!acknowledged) return 'missing';
    const carrier = await this.findInvocationCarrier(acknowledged);
    return carrier && classifyInvocationRecoveryStatus(carrier.status) === 'completed'
      ? this.consume(acknowledged, carrier.id)
      : 'pending';
  }

  private persistDispatchOutcome(taskId: string, outcome: 'failed' | 'unavailable'): void {
    const latest = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
    if (!latest) return;
    this.updateCommand(latest, {
      ...latest.command,
      state: 'dispatch_pending',
      lastDispatchOutcome: outcome,
    });
  }

  private async findInvocationCarrier(parsed: ParsedManagedCommandWakeTask): Promise<InvocationRecord | null> {
    if (!parsed.command.messageId) return null;
    return this.deps.invocationRecordStore.getByIdempotencyKey(
      parsed.threadId,
      parsed.userId,
      `connector-${parsed.command.messageId}`,
    );
  }

  private retireTask(
    taskId: string,
    reason: ManagedCommandWakeCarrierTerminalReason,
    expectedMessageId?: string,
  ): boolean {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const parsed = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
      if (!parsed || (expectedMessageId && parsed.command.messageId !== expectedMessageId)) return false;
      if (this.consume(parsed, undefined, reason) === 'recovered') return true;
    }
    return false;
  }

  private consume(
    parsed: ParsedManagedCommandWakeTask,
    invocationId?: string,
    carrierTerminalReason?: ManagedCommandWakeCarrierTerminalReason,
  ): ManagedCommandWakeRecoveryResult {
    const consumedAt = this.now();
    const updated = this.deps.dynamicTaskStore.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
      ...parsed.task.params,
      holdLifecycle: {
        ...parsed.lifecycle,
        status: 'fired',
        managedCommand: {
          ...parsed.command,
          state: 'consumed',
          ...(invocationId ? { invocationId } : {}),
          ...(carrierTerminalReason ? { carrierTerminalReason } : {}),
          consumedAt,
        },
      },
    });
    if (!updated) return 'missing';
    this.deps.dynamicTaskStore.setEnabled(parsed.task.id, false);
    this.deps.taskRunner.unregister(parsed.task.id);
    return 'recovered';
  }

  private updateCommand(parsed: ParsedManagedCommandWakeTask, command: ManagedCommandWakeProjection): boolean {
    return this.deps.dynamicTaskStore.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
      ...parsed.task.params,
      holdLifecycle: {
        ...parsed.lifecycle,
        managedCommand: command,
      },
    });
  }
}
