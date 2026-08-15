import type { CatId } from '@cat-cafe/shared';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

export type ManagedCommandWakeState =
  | 'command_running'
  | 'condition_met'
  | 'message_written'
  | 'dispatch_pending'
  | 'dispatched'
  | 'enqueued'
  | 'cancelled'
  | 'consumed';

export type ManagedCommandWakeCarrierTerminalReason = 'withdrawn' | 'canceled' | 'terminal' | 'force_reset';

export interface ManagedCommandTerminalResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly durationMs: number;
  readonly tailOutput?: string;
}

export interface ManagedCommandWakeProjection {
  readonly state: ManagedCommandWakeState;
  readonly command: string;
  readonly startedAt: number;
  readonly conditionMetAt?: number;
  readonly wakeContent?: string;
  readonly wakeSource?: 'command_completion' | 'fallback_timer';
  readonly result?: ManagedCommandTerminalResult;
  readonly messageClaimGeneration?: number;
  readonly messageClaimedAt?: number;
  readonly pendingCompletionContent?: string;
  readonly messageId?: string;
  readonly messageWrittenAt?: number;
  readonly dispatchAttemptCount?: number;
  readonly lastDispatchAt?: number;
  readonly lastDispatchOutcome?: 'dispatched' | 'enqueued' | 'full' | 'failed' | 'unavailable';
  readonly invocationId?: string;
  readonly carrierTerminalReason?: ManagedCommandWakeCarrierTerminalReason;
  readonly consumedAt?: number;
  readonly slaBreachObservedAt?: number;
}

export interface ManagedCommandWakeRecoveryStats {
  readonly scanned: number;
  readonly recovered: number;
  readonly pending: number;
}

export type ManagedCommandWakeTriggerOutcome = 'dispatched' | 'enqueued' | 'full';

export type ManagedCommandWakeEventCarrier =
  | { state: 'missing' | 'pending' | 'orphaned' }
  | { state: 'handled'; invocationId?: string }
  | { state: 'terminal'; reason: ManagedCommandWakeCarrierTerminalReason };

/** Project the existing F264 receipt; this is a read model, not another lifecycle owner. */
export function resolveManagedCommandWakeEventCarrier(
  message: StoredMessage | null | undefined,
  expected: { threadId: string; catId: string; activeQueueEntryId?: string | null },
): ManagedCommandWakeEventCarrier {
  if (!message || message.threadId !== expected.threadId) {
    return { state: 'missing' };
  }
  if (message.deliveryStatus === 'canceled') return { state: 'terminal', reason: 'canceled' };
  const custody = message.queueCustody;
  if (!custody) return { state: 'missing' };
  const outcome = custody.targetOutcomeByCatId?.[expected.catId];
  if (custody.handledByCatIds.includes(expected.catId as CatId) && outcome) {
    return { state: 'handled', invocationId: outcome.invocationId };
  }
  if (custody.withdrawnByCatIds?.includes(expected.catId as CatId)) {
    return { state: 'terminal', reason: 'withdrawn' };
  }
  if (custody.status === 'terminal') return { state: 'terminal', reason: 'terminal' };
  if (custody.pendingTargetCats.includes(expected.catId as CatId)) {
    if ('activeQueueEntryId' in expected && expected.activeQueueEntryId !== custody.entryId) {
      return { state: 'orphaned' };
    }
    return { state: 'pending' };
  }
  return { state: 'missing' };
}

export interface ManagedCommandWakeTrigger {
  trigger(
    threadId: string,
    catId: string,
    userId: string,
    message: string,
    messageId: string,
    contentBlocks?: undefined,
    policy?: { sourceCategory?: string; forceQueue?: boolean },
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
  readonly messageStore: Pick<IMessageStore, 'append' | 'getByIdempotencyKey'> &
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
  /** F167×F254: current Queue/F264 carrier truth for force-queued event wakes. */
  readonly getEventCarrier?: (input: {
    threadId: string;
    userId: string;
    catId: string;
    messageId: string;
  }) => ManagedCommandWakeEventCarrier | Promise<ManagedCommandWakeEventCarrier>;
  readonly now?: () => number;
  readonly dispatchedCarrierGraceMs?: number;
  readonly wakeSlaMs?: number;
}

export interface RecordManagedCommandCompletionInput {
  readonly taskId: string;
  readonly wakeContent: string;
  readonly result: ManagedCommandTerminalResult;
}

export type ManagedCommandWakeRecoveryResult = 'missing' | 'pending' | 'recovered';

export type ManagedCommandCompletionEvidenceWrite = 'missing' | 'active' | 'terminal' | 'contended';

export interface ParsedManagedCommandWakeTask {
  readonly task: DynamicTaskDef;
  readonly lifecycle: Record<string, unknown>;
  readonly command: ManagedCommandWakeProjection;
  readonly threadId: string;
  readonly catId: string;
  readonly userId: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedCommandWakeState(value: unknown): value is ManagedCommandWakeState {
  return (
    value === 'command_running' ||
    value === 'condition_met' ||
    value === 'message_written' ||
    value === 'dispatch_pending' ||
    value === 'dispatched' ||
    value === 'enqueued' ||
    value === 'cancelled' ||
    value === 'consumed'
  );
}

export function readManagedCommandWakeProjection(task: DynamicTaskDef): ManagedCommandWakeProjection | null {
  const lifecycle = task.params.holdLifecycle;
  if (!isPlainRecord(lifecycle) || lifecycle.mode !== 'wake_when') return null;
  const command = lifecycle.managedCommand;
  if (!isPlainRecord(command) || !isManagedCommandWakeState(command.state)) return null;
  if (typeof command.command !== 'string' || command.command.length === 0) return null;
  if (typeof command.startedAt !== 'number') return null;
  return command as unknown as ManagedCommandWakeProjection;
}

export function parseManagedCommandWakeTask(task: DynamicTaskDef | null): ParsedManagedCommandWakeTask | null {
  if (!task || !task.enabled || task.deliveryThreadId === null) return null;
  const lifecycle = task.params.holdLifecycle;
  const command = readManagedCommandWakeProjection(task);
  if (!isPlainRecord(lifecycle) || lifecycle.status !== 'active' || !command) return null;
  const catId = task.createdBy.startsWith('hold-ball:') ? task.createdBy.slice('hold-ball:'.length) : '';
  const userId = task.params.triggerUserId;
  if (!catId || typeof userId !== 'string' || !userId) return null;
  return { task, lifecycle, command, threadId: task.deliveryThreadId, catId, userId };
}

/** Parse the disabled tombstone left when user activity retires only the wake carrier. */
export function parseRetiredManagedCommandWakeTask(task: DynamicTaskDef | null): ParsedManagedCommandWakeTask | null {
  if (!task || task.enabled || task.deliveryThreadId === null) return null;
  const lifecycle = task.params.holdLifecycle;
  const command = readManagedCommandWakeProjection(task);
  if (!isPlainRecord(lifecycle) || lifecycle.status !== 'cancelled_by_user' || !command) return null;
  const catId = task.createdBy.startsWith('hold-ball:') ? task.createdBy.slice('hold-ball:'.length) : '';
  const userId = task.params.triggerUserId;
  if (!catId || typeof userId !== 'string' || !userId) return null;
  return { task, lifecycle, command, threadId: task.deliveryThreadId, catId, userId };
}

export function createInitialManagedCommandWakeProjection(
  command: string,
  startedAt: number,
): ManagedCommandWakeProjection {
  return { state: 'command_running', command, startedAt };
}

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
    lifecycle.status !== 'cancelled_by_user'
  ) {
    return null;
  }
  return {
    ...task.params,
    holdLifecycle: {
      ...lifecycle,
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
