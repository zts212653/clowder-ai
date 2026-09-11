import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import {
  isPlainRecord,
  type ManagedCommandTerminalResult,
  type ManagedCommandWakeCarrierTerminalReason,
  type ManagedCommandWakeProjection,
  readManagedCommandWakeProjection,
} from './managed-command-wake-task-projection.js';

/**
 * R6 P1-1: task 判别 / read-model 已拆到 `managed-command-wake-task-projection.ts`
 * （本文件基线 323 行，被 F297 的判别收口推到 403，跨过 350 硬线）。
 * 此处 re-export 保持既有 import 路径不变；判别仍然只有一份实现。
 */
export {
  buildAdmissionFactIdempotencyKey,
  createInitialManagedCommandWakeProjection,
  HOLD_BALL_TASK_ID_PREFIX,
  isHoldBallWakeTask,
  isPendingHoldBallWakeTask,
  isRetiredWakeWithRunningManagedCommand,
  type ManagedCommandTerminalResult,
  type ManagedCommandWakeCarrierTerminalReason,
  type ManagedCommandWakeProjection,
  type ManagedCommandWakeState,
  type ParsedManagedCommandWakeTask,
  parseManagedCommandWakeTask,
  parseRetiredManagedCommandWakeTask,
  readHoldLifecycleProjection,
  readManagedCommandWakeProjection,
} from './managed-command-wake-task-projection.js';

export interface ManagedCommandWakeRecoveryStats {
  readonly scanned: number;
  readonly recovered: number;
  readonly pending: number;
}

export type ManagedCommandWakeTriggerOutcome = 'enqueued' | 'full';

export type ManagedCommandWakeEventCarrier =
  | { state: 'missing' | 'pending' | 'orphaned' }
  | {
      state: 'failed';
      attemptId: string;
      attemptSequence: number;
      invocationId?: string;
      errorCode?: string;
    }
  | { state: 'handled'; invocationId?: string }
  | { state: 'terminal'; reason: ManagedCommandWakeCarrierTerminalReason };

export function resolveManagedCommandWakeEventCarrier(
  message: StoredMessage | null | undefined,
  response: StoredMessage | null | undefined,
  pendingTarget: boolean,
  expected: { threadId: string; userId: string; catId: string },
): ManagedCommandWakeEventCarrier {
  if (!message || message.threadId !== expected.threadId || message.userId !== expected.userId) {
    return { state: 'missing' };
  }
  if (message.deliveryStatus === 'canceled') return { state: 'terminal', reason: 'canceled' };
  const refs = message.lifecycle && 'dispatchRefs' in message.lifecycle ? (message.lifecycle.dispatchRefs ?? []) : [];
  const matchingRefs = refs.filter((ref) => ref.targetId === expected.catId);
  if (matchingRefs.length === 0) {
    return message.deliveryStatus === 'queued' && pendingTarget ? { state: 'pending' } : { state: 'orphaned' };
  }
  if (matchingRefs.length !== 1 || message.deliveryStatus !== 'delivered') return { state: 'orphaned' };
  const ref = matchingRefs[0]!;
  if (
    !response ||
    response.id !== ref.statusMessageId ||
    response.threadId !== expected.threadId ||
    response.userId !== expected.userId
  ) {
    return { state: 'orphaned' };
  }
  const lifecycle = response.lifecycle;
  if (lifecycle?.kind === 'delivery_failure') {
    if (lifecycle.inputMessageId !== message.id || !lifecycle.requestedTargets.includes(expected.catId)) {
      return { state: 'orphaned' };
    }
    return {
      state: 'failed',
      attemptId: `${message.id}:${expected.catId}:${response.id}`,
      attemptSequence: 1,
      errorCode: lifecycle.reason,
    };
  }
  if (
    lifecycle?.kind !== 'response' ||
    lifecycle.targetId !== expected.catId ||
    !lifecycle.inputMessageIds.includes(message.id)
  ) {
    return { state: 'orphaned' };
  }
  if (lifecycle.status === 'processing') return { state: 'pending' };
  if (lifecycle.status === 'completed') return { state: 'handled', invocationId: lifecycle.invocationId };
  if (lifecycle.status === 'failed') {
    return {
      state: 'failed',
      attemptId: `${message.id}:${expected.catId}:${lifecycle.invocationId}`,
      attemptSequence: 1,
      invocationId: lifecycle.invocationId,
    };
  }
  return {
    state: 'terminal',
    reason: lifecycle.status === 'canceled' ? 'canceled' : 'terminal',
  };
}

export interface ManagedCommandWakeTrigger {
  trigger(
    threadId: string,
    catId: string,
    userId: string,
    message: string,
    messageId: string,
    contentBlocks?: undefined,
    policy?: { sourceCategory?: string; priority?: 'urgent' | 'normal' },
  ): Promise<ManagedCommandWakeTriggerOutcome>;
}

export interface ManagedCommandWakeDynamicTaskStore {
  getAll(): DynamicTaskDef[];
  getById(id: string): DynamicTaskDef | null;
  updateParamsIfCurrent(id: string, current: Record<string, unknown>, next: Record<string, unknown>): boolean;
  setEnabled(id: string, enabled: boolean): boolean;
}

export interface ManagedCommandWakeRecoveryDeps {
  readonly dynamicTaskStore: ManagedCommandWakeDynamicTaskStore;
  readonly messageStore: Pick<IMessageStore, 'append' | 'getByIdempotencyKey' | 'markCanceled'> &
    Partial<Pick<IMessageStore, 'getById'>>;
  readonly socketManager: { broadcastToRoom(room: string, event: string, payload: unknown): void };
  readonly taskRunner: { unregister(taskId: string): void };
  readonly invocationRecordStore: {
    getByIdempotencyKey(
      threadId: string,
      userId: string,
      key: string,
    ): InvocationRecord | null | Promise<InvocationRecord | null>;
  };
  readonly getInvokeTrigger: () => ManagedCommandWakeTrigger | undefined;
  /** F167×F254: current Queue/F264 carrier truth for event wakes. */
  readonly getEventCarrier?: (input: {
    threadId: string;
    userId: string;
    catId: string;
    messageId: string;
  }) => ManagedCommandWakeEventCarrier | Promise<ManagedCommandWakeEventCarrier>;
  readonly now?: () => number;
  readonly dispatchedCarrierGraceMs?: number;
  readonly wakeSlaMs?: number;
  /** Process-local liveness fence: present in production, omitted by isolated consumers. */
  readonly isCommandRunnerActive?: (taskId: string) => boolean;
}

export interface RecordManagedCommandCompletionInput {
  readonly taskId: string;
  readonly wakeContent: string;
  readonly result: ManagedCommandTerminalResult;
}

export type ManagedCommandWakeRecoveryResult = 'missing' | 'pending' | 'recovered';

export type ManagedCommandCompletionEvidenceWrite = 'missing' | 'active' | 'terminal' | 'contended';

export function buildCancelledManagedCommandCompletionParams(
  task: DynamicTaskDef | null,
  input: RecordManagedCommandCompletionInput,
  conditionMetAt: number,
): Record<string, unknown> | null {
  const lifecycle = task?.params.holdLifecycle;
  const command = task ? readManagedCommandWakeProjection(task) : null;
  if (
    !task ||
    !command ||
    command.state !== 'command_running' ||
    !isPlainRecord(lifecycle) ||
    (lifecycle.status !== 'cancelled_by_user' && lifecycle.status !== 'cancel_requested')
  ) {
    return null;
  }
  return {
    ...task.params,
    holdLifecycle: {
      ...lifecycle,
      status: 'cancelled_by_user',
      managedCommand: {
        ...command,
        state: 'cancelled',
        conditionMetAt,
        result: {
          exitCode: input.result.exitCode,
          timedOut: input.result.timedOut,
          ...(input.result.cancelled !== undefined ? { cancelled: input.result.cancelled } : {}),
          durationMs: input.result.durationMs,
          ...(input.result.tailOutput ? { tailOutput: input.result.tailOutput } : {}),
        },
      },
    },
  };
}

export function normalizeManagedCommandTerminalResult(
  result: ManagedCommandTerminalResult,
): ManagedCommandTerminalResult {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(result.cancelled !== undefined ? { cancelled: result.cancelled } : {}),
    durationMs: result.durationMs,
    ...(result.tailOutput ? { tailOutput: result.tailOutput } : {}),
  };
}

/**
 * Merge a real command completion into the existing durable wake receipt.
 *
 * The fallback timer may have advanced the receipt before the child process
 * reports its terminal result. Before the durable message-content claim, the
 * real completion owns the content. Once claimed, content stays frozen while
 * late terminal evidence is enriched, so source-message and dispatch payload
 * cannot diverge or create a second user-visible reinvocation.
 */
export function persistManagedCommandCompletionEvidence(
  store: ManagedCommandWakeDynamicTaskStore,
  input: RecordManagedCommandCompletionInput,
  conditionMetAt: number,
): ManagedCommandCompletionEvidenceWrite {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const task = store.getById(input.taskId);
    const lifecycle = task?.params.holdLifecycle;
    const command = task ? readManagedCommandWakeProjection(task) : null;
    if (!task || !isPlainRecord(lifecycle) || !command || command.state === 'cancelled') return 'missing';

    const terminal = lifecycle.status === 'fired' && command.state === 'consumed';
    const active = lifecycle.status === 'active' && task.enabled;
    if (!terminal && !active) return 'missing';
    if (command.result) return terminal ? 'terminal' : 'active';

    let nextCommand: ManagedCommandWakeProjection;
    if (command.state === 'command_running') {
      nextCommand = {
        ...command,
        state: 'condition_met',
        conditionMetAt,
        wakeContent: input.wakeContent,
        wakeSource: 'command_completion',
        result: normalizeManagedCommandTerminalResult(input.result),
      };
    } else if (command.state === 'condition_met' && !command.messageId && command.messageClaimedAt === undefined) {
      nextCommand = {
        ...command,
        wakeContent: input.wakeContent,
        wakeSource: 'command_completion',
        result: normalizeManagedCommandTerminalResult(input.result),
      };
    } else if (command.state === 'condition_met' && !command.messageId) {
      nextCommand = {
        ...command,
        result: normalizeManagedCommandTerminalResult(input.result),
        pendingCompletionContent: input.wakeContent,
      };
    } else {
      nextCommand = {
        ...command,
        result: normalizeManagedCommandTerminalResult(input.result),
      };
    }

    const persisted = store.updateParamsIfCurrent(task.id, task.params, {
      ...task.params,
      holdLifecycle: {
        ...lifecycle,
        managedCommand: nextCommand,
      },
    });
    if (persisted) return terminal ? 'terminal' : 'active';
  }
  return 'contended';
}
