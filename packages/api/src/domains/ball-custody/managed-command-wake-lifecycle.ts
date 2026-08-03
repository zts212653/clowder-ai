import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';

export type ManagedCommandWakeState =
  | 'command_running'
  | 'condition_met'
  | 'message_written'
  | 'dispatch_pending'
  | 'dispatched'
  | 'enqueued'
  | 'cancelled'
  | 'consumed';

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
  readonly result?: ManagedCommandTerminalResult;
  readonly messageId?: string;
  readonly messageWrittenAt?: number;
  readonly dispatchAttemptCount?: number;
  readonly lastDispatchAt?: number;
  readonly lastDispatchOutcome?: 'dispatched' | 'enqueued' | 'full' | 'failed' | 'unavailable';
  readonly invocationId?: string;
  readonly consumedAt?: number;
  readonly slaBreachObservedAt?: number;
}

export interface ManagedCommandWakeRecoveryStats {
  readonly scanned: number;
  readonly recovered: number;
  readonly pending: number;
}

export type ManagedCommandWakeTriggerOutcome = 'dispatched' | 'enqueued' | 'full';

export interface ManagedCommandWakeTrigger {
  trigger(
    threadId: string,
    catId: string,
    userId: string,
    message: string,
    messageId: string,
    contentBlocks?: undefined,
    policy?: { sourceCategory?: string },
  ): Promise<ManagedCommandWakeTriggerOutcome>;
}

export interface ManagedCommandWakeDynamicTaskStore {
  getAll(): DynamicTaskDef[];
  getById(id: string): DynamicTaskDef | null;
  updateParams(id: string, params: Record<string, unknown>): boolean;
  setEnabled(id: string, enabled: boolean): boolean;
}

export interface ManagedCommandWakeRecoveryDeps {
  readonly dynamicTaskStore: ManagedCommandWakeDynamicTaskStore;
  readonly messageStore: Pick<IMessageStore, 'append' | 'getByIdempotencyKey'>;
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
