import { createModuleLogger } from '../../infrastructure/logger.js';
import { managedCommandDispatchRetryTotal } from '../../infrastructure/telemetry/instruments.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../cats/services/stores/ports/invocation-state-machine.js';
import { ManagedCommandWakeActionLeaseAdmissionError } from './managed-command-wake-action-lease-admission.js';
import {
  type ManagedCommandWakeCarrierTerminalReason,
  type ManagedCommandWakeProjection,
  type ManagedCommandWakeRecoveryDeps,
  type ManagedCommandWakeRecoveryResult,
  type ManagedCommandWakeTriggerOutcome,
  type ParsedManagedCommandWakeTask,
  parseManagedCommandWakeTask as parseWakeTask,
} from './managed-command-wake-lifecycle.js';
import { publishManagedCommandWakeMessage } from './managed-command-wake-message-fence.js';
import {
  isDispatchableManagedCommandWakeState,
  recordManagedCommandWakeSlaBreach,
} from './managed-command-wake-recovery-policy.js';

const log = createModuleLogger('ball-custody/managed-command-wake-recovery-engine');

/** Reconciles one managed wake after its command has produced durable evidence. */
export class ManagedCommandWakeRecoveryEngine {
  private readonly now: () => number;
  private readonly dispatchedCarrierGraceMs: number;
  private readonly wakeSlaMs: number;

  constructor(private readonly deps: ManagedCommandWakeRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.dispatchedCarrierGraceMs = deps.dispatchedCarrierGraceMs ?? 15_000;
    this.wakeSlaMs = deps.wakeSlaMs ?? 60_000;
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
    if (parsed.command.state === 'lost') return this.persistLostCommandStatus(parsed);
    if (parsed.command.state === 'condition_met') {
      const published = await publishManagedCommandWakeMessage(this.deps, parsed, this.now);
      if (!published) return 'pending';
      parsed = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
      if (!parsed) return 'missing';
    }
    if (isDispatchableManagedCommandWakeState(parsed.command.state)) {
      return this.recoverDispatchableTask(parsed);
    }
    return parsed.command.state === 'consumed' ? 'recovered' : 'pending';
  }

  private async recoverDispatchableTask(
    parsed: ParsedManagedCommandWakeTask,
  ): Promise<ManagedCommandWakeRecoveryResult> {
    const eventCarrier = parsed.command.messageId
      ? await this.deps.getEventCarrier?.({
          threadId: parsed.threadId,
          userId: parsed.userId,
          catId: parsed.catId,
          messageId: parsed.command.messageId,
        })
      : undefined;
    if (eventCarrier?.state === 'handled') return this.consume(parsed, eventCarrier.invocationId);
    if (eventCarrier?.state === 'terminal') return this.consume(parsed, undefined, eventCarrier.reason);
    if (eventCarrier?.state === 'failed') return this.consume(parsed, eventCarrier.invocationId, 'failed');
    if (eventCarrier?.state === 'pending') return 'pending';

    const carrier = await this.findInvocationCarrier(parsed);
    if (carrier) {
      const recoveryStatus = classifyInvocationRecoveryStatus(carrier.status);
      if (recoveryStatus === 'completed') return this.consume(parsed, carrier.id);
      if (recoveryStatus === 'in_flight' || recoveryStatus === 'terminal') return 'pending';
    }
    const lastDispatchAt = parsed.command.lastDispatchAt ?? 0;
    if (lastDispatchAt > 0 && this.now() - lastDispatchAt < this.dispatchedCarrierGraceMs) return 'pending';
    return this.dispatch(parsed);
  }

  private async persistLostCommandStatus(
    parsed: ParsedManagedCommandWakeTask,
  ): Promise<ManagedCommandWakeRecoveryResult> {
    const idempotencyKey = `hold-ball-lost:${parsed.task.id}`;
    try {
      const existing = await this.deps.messageStore.getByIdempotencyKey(parsed.userId, parsed.threadId, idempotencyKey);
      if (!existing) await this.appendLostStatus(parsed, idempotencyKey);
      const latest = parseWakeTask(this.deps.dynamicTaskStore.getById(parsed.task.id));
      return latest?.command.state === 'lost' ? this.consume(latest, undefined, 'failed') : 'pending';
    } catch (err) {
      log.warn(
        { err, taskId: parsed.task.id, threadId: parsed.threadId },
        'lost managed-command terminal status persistence failed — will retry',
      );
      return 'pending';
    }
  }

  private async appendLostStatus(parsed: ParsedManagedCommandWakeTask, idempotencyKey: string): Promise<void> {
    const detail = parsed.command.lostDetail ? `（${parsed.command.lostDetail}）` : '';
    const content =
      parsed.command.lostReason === 'spawn_failed'
        ? `等待失败：命令「${parsed.command.command}」未启动${detail}。`
        : parsed.command.lostReason === 'runner_failed'
          ? `等待已结束：命令「${parsed.command.command}」执行进程异常终止${detail}。`
          : `等待已结束：服务重启导致命令「${parsed.command.command}」的本地执行进程丢失。`;
    const recoverySource =
      parsed.command.lostReason === 'spawn_failed'
        ? 'spawn_admission'
        : parsed.command.lostReason === 'runner_failed'
          ? 'command_runner'
          : 'startup_sweep';
    const stored = await this.deps.messageStore.append({
      from: { kind: 'system', service: 'hold-ball' },
      userId: parsed.userId,
      content,
      mentions: [],
      timestamp: this.now(),
      threadId: parsed.threadId,
      idempotencyKey,
      source: {
        connector: 'hold-ball',
        label: '持球状态',
        icon: '🏓',
        meta: {
          managedHold: true,
          phase: 'status',
          taskId: parsed.task.id,
          threadId: parsed.threadId,
          catId: parsed.catId,
          recoverySource,
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

  private async dispatch(parsed: ParsedManagedCommandWakeTask): Promise<ManagedCommandWakeRecoveryResult> {
    const messageId = parsed.command.messageId;
    const wakeContent = parsed.command.wakeContent;
    if (!messageId || !wakeContent) return 'pending';

    const attemptCount = (parsed.command.dispatchAttemptCount ?? 0) + 1;
    if (attemptCount > 1) managedCommandDispatchRetryTotal.add(1);
    if (
      !this.updateCommand(parsed, {
        ...parsed.command,
        state: 'dispatch_pending',
        dispatchAttemptCount: attemptCount,
        lastDispatchAt: this.now(),
      })
    ) {
      return 'pending';
    }

    const trigger = this.deps.getInvokeTrigger();
    if (!trigger) {
      this.persistDispatchOutcome(parsed.task.id, 'unavailable');
      return 'pending';
    }
    return this.invokeDispatchTrigger(parsed, trigger, messageId, wakeContent);
  }

  private async invokeDispatchTrigger(
    parsed: ParsedManagedCommandWakeTask,
    trigger: NonNullable<ReturnType<ManagedCommandWakeRecoveryDeps['getInvokeTrigger']>>,
    messageId: string,
    wakeContent: string,
  ): Promise<ManagedCommandWakeRecoveryResult> {
    let outcome: ManagedCommandWakeTriggerOutcome;
    try {
      outcome = await trigger.trigger(
        parsed.threadId,
        parsed.catId,
        parsed.userId,
        `[定时任务] ${wakeContent}`,
        messageId,
        undefined,
        { sourceCategory: 'scheduled', priority: 'urgent' },
      );
    } catch (err) {
      return this.handleDispatchError(parsed, messageId, err);
    }
    return this.commitDispatchOutcome(parsed, outcome);
  }

  private async handleDispatchError(
    parsed: ParsedManagedCommandWakeTask,
    messageId: string,
    err: unknown,
  ): Promise<ManagedCommandWakeRecoveryResult> {
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
    } else {
      log.warn(
        { err, taskId: parsed.task.id, threadId: parsed.threadId, messageId },
        'managed-command execution-plane dispatch failed',
      );
    }
    this.persistDispatchOutcome(parsed.task.id, 'failed');
    return 'pending';
  }

  private async commitDispatchOutcome(
    parsed: ParsedManagedCommandWakeTask,
    outcome: ManagedCommandWakeTriggerOutcome,
  ): Promise<ManagedCommandWakeRecoveryResult> {
    const latest = parseWakeTask(this.deps.dynamicTaskStore.getById(parsed.task.id));
    if (!latest) return 'missing';
    if (outcome === 'full') {
      this.updateCommand(latest, { ...latest.command, state: 'dispatch_pending', lastDispatchOutcome: 'full' });
      return 'pending';
    }
    if (!this.updateCommand(latest, { ...latest.command, state: outcome, lastDispatchOutcome: outcome })) {
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
    this.updateCommand(latest, { ...latest.command, state: 'dispatch_pending', lastDispatchOutcome: outcome });
  }

  private async findInvocationCarrier(parsed: ParsedManagedCommandWakeTask): Promise<InvocationRecord | null> {
    if (!parsed.command.messageId) return null;
    const targetScoped = await this.deps.invocationRecordStore.getByIdempotencyKey(
      parsed.threadId,
      parsed.userId,
      `connector-${parsed.command.messageId}:${parsed.catId}`,
    );
    if (targetScoped) return targetScoped;
    return this.deps.invocationRecordStore.getByIdempotencyKey(
      parsed.threadId,
      parsed.userId,
      `connector-${parsed.command.messageId}`,
    );
  }

  retireTask(taskId: string, reason: ManagedCommandWakeCarrierTerminalReason, expectedMessageId?: string): boolean {
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
          consumedAt: this.now(),
        },
      },
    });
    if (!updated) return 'missing';
    this.deps.dynamicTaskStore.setEnabled(parsed.task.id, false);
    this.deps.taskRunner.unregister(parsed.task.id);
    return 'recovered';
  }

  updateCommand(parsed: ParsedManagedCommandWakeTask, command: ManagedCommandWakeProjection): boolean {
    return this.deps.dynamicTaskStore.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
      ...parsed.task.params,
      holdLifecycle: { ...parsed.lifecycle, managedCommand: command },
    });
  }
}
