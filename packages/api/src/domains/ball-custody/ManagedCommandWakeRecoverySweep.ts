import { createModuleLogger } from '../../infrastructure/logger.js';
import {
  managedCommandCompletionUnconsumedTotal,
  managedCommandDispatchRetryTotal,
  managedCommandWakeSlaBreachTotal,
} from '../../infrastructure/telemetry/instruments.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../cats/services/stores/ports/invocation-state-machine.js';
import {
  buildCancelledManagedCommandCompletionParams,
  type ManagedCommandWakeProjection,
  type ManagedCommandWakeRecoveryDeps,
  type ManagedCommandWakeRecoveryResult,
  type ManagedCommandWakeRecoveryStats,
  type ManagedCommandWakeTriggerOutcome,
  type ParsedManagedCommandWakeTask,
  parseManagedCommandWakeTask as parseWakeTask,
  persistManagedCommandCompletionEvidence,
  type RecordManagedCommandCompletionInput,
} from './managed-command-wake-lifecycle.js';
import { publishManagedCommandWakeMessage } from './managed-command-wake-message-fence.js';

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
} from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/managed-command-wake-recovery');
const INVOCATION_KEY_PREFIX = 'connector-';
const DEFAULT_DISPATCHED_CARRIER_GRACE_MS = 15_000;
const DEFAULT_WAKE_SLA_MS = 60_000;

function isDispatchableWakeState(state: ManagedCommandWakeProjection['state']): boolean {
  return state === 'message_written' || state === 'dispatch_pending' || state === 'dispatched' || state === 'enqueued';
}

export class ManagedCommandWakeRecoverySweep {
  private readonly now: () => number;
  private readonly dispatchedCarrierGraceMs: number;
  private readonly wakeSlaMs: number;

  constructor(private readonly deps: ManagedCommandWakeRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.dispatchedCarrierGraceMs = deps.dispatchedCarrierGraceMs ?? DEFAULT_DISPATCHED_CARRIER_GRACE_MS;
    this.wakeSlaMs = deps.wakeSlaMs ?? DEFAULT_WAKE_SLA_MS;
  }

  async recordCompletion(input: RecordManagedCommandCompletionInput): Promise<ManagedCommandWakeRecoveryResult> {
    const evidence = persistManagedCommandCompletionEvidence(this.deps.dynamicTaskStore, input, this.now());
    if (evidence === 'missing') return 'missing';
    if (evidence === 'terminal') return 'recovered';
    if (evidence === 'contended') return 'pending';
    const result = await this.recoverTask(input.taskId);
    if (result === 'pending') managedCommandCompletionUnconsumedTotal.add(1);
    return result;
  }

  async recordFallbackDue(taskId: string): Promise<ManagedCommandWakeRecoveryResult> {
    const parsed = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
    if (!parsed) return 'missing';
    if (parsed.command.state === 'command_running') {
      const wakeContent = parsed.task.params.message;
      if (typeof wakeContent !== 'string' || wakeContent.length === 0) return 'pending';
      this.updateCommand(parsed, {
        ...parsed.command,
        state: 'condition_met',
        conditionMetAt: this.now(),
        wakeContent,
        wakeSource: 'fallback_timer',
      });
    }
    return this.recoverTask(taskId);
  }
  async recordCancelledCompletion(
    input: RecordManagedCommandCompletionInput,
  ): Promise<ManagedCommandWakeRecoveryResult> {
    const task = this.deps.dynamicTaskStore.getById(input.taskId);
    const params = buildCancelledManagedCommandCompletionParams(task, input, this.now());
    if (!task || !params) return 'missing';
    const persisted = this.deps.dynamicTaskStore.updateParamsIfCurrent(task.id, task.params, params);
    return persisted ? 'recovered' : 'missing';
  }

  async runOnce(): Promise<ManagedCommandWakeRecoveryStats> {
    const candidates = this.deps.dynamicTaskStore.getAll().filter((task) => {
      const parsed = parseWakeTask(task);
      return !!parsed && parsed.command.state !== 'command_running';
    });

    let recovered = 0;
    let pending = 0;
    for (const task of candidates) {
      const result = await this.recoverTask(task.id);
      if (result === 'recovered') recovered += 1;
      else if (result === 'pending') pending += 1;
    }
    return { scanned: candidates.length, recovered, pending };
  }

  async recoverTask(taskId: string): Promise<ManagedCommandWakeRecoveryResult> {
    let parsed = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
    if (!parsed) return 'missing';
    parsed = this.recordSlaBreach(parsed);

    if (parsed.command.state === 'condition_met') {
      const published = await this.publishCompletion(parsed);
      if (!published) return 'pending';
      parsed = parseWakeTask(this.deps.dynamicTaskStore.getById(taskId));
      if (!parsed) return 'missing';
    }

    if (isDispatchableWakeState(parsed.command.state)) {
      const eventCarrier = parsed.command.messageId
        ? await this.deps.getEventCarrier?.({
            threadId: parsed.threadId,
            userId: parsed.userId,
            catId: parsed.catId,
            messageId: parsed.command.messageId,
          })
        : undefined;
      if (eventCarrier?.state === 'handled') return this.consume(parsed, eventCarrier.invocationId);
      if (eventCarrier?.state === 'pending') return 'pending';
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
      `${INVOCATION_KEY_PREFIX}${parsed.command.messageId}`,
    );
  }

  private consume(parsed: ParsedManagedCommandWakeTask, invocationId?: string): ManagedCommandWakeRecoveryResult {
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
          consumedAt,
        },
      },
    });
    if (!updated) return 'missing';
    this.deps.dynamicTaskStore.setEnabled(parsed.task.id, false);
    this.deps.taskRunner.unregister(parsed.task.id);
    return 'recovered';
  }

  private recordSlaBreach(parsed: ParsedManagedCommandWakeTask): ParsedManagedCommandWakeTask {
    const conditionMetAt = parsed.command.conditionMetAt;
    if (
      conditionMetAt === undefined ||
      parsed.command.slaBreachObservedAt !== undefined ||
      this.now() - conditionMetAt < this.wakeSlaMs
    ) {
      return parsed;
    }
    const observedAt = this.now();
    const updated = this.updateCommand(parsed, { ...parsed.command, slaBreachObservedAt: observedAt });
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
    return parseWakeTask(this.deps.dynamicTaskStore.getById(parsed.task.id)) ?? parsed;
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
