import { createModuleLogger } from '../../infrastructure/logger.js';
import {
  managedCommandCompletionUnconsumedTotal,
  managedCommandDispatchRetryTotal,
} from '../../infrastructure/telemetry/instruments.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../cats/services/stores/ports/invocation-state-machine.js';
import {
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
  async runOnce(): Promise<ManagedCommandWakeRecoveryStats> {
    const tasks = this.deps.dynamicTaskStore.getAll();
    const candidates = tasks.filter((task) => {
      const parsed = parseWakeTask(task);
      return !!parsed && parsed.command.state !== 'command_running';
    });
    const retiredTaskIds = listRetiredManagedCommandRecoveryTaskIds(tasks);
    let recovered = 0;
    let pending = 0;
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
    return { scanned: candidates.length + retiredTaskIds.length, recovered, pending };
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
