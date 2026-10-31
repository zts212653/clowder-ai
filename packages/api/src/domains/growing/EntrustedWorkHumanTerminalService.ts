import type {
  EntrustedWorkHumanDecisionV1,
  EntrustedWorkHumanTerminalReceiptV1,
  EntrustedWorkTaskExecutionStopV1,
  TaskItem,
} from '@cat-cafe/shared';
import {
  entrustedWorkHumanDecisionV1Schema,
  entrustedWorkTaskExecutionStopV1Schema,
  entrustedWorkTaskExecutionV1Schema,
} from '@cat-cafe/shared';
import type {
  IdempotentAppendResult,
  IMessageStore,
  StoredMessage,
} from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkHumanTerminalError } from './EntrustedWorkHumanTerminalError.js';
import {
  buildHumanTerminalClosure,
  buildHumanTerminalReceipt,
  type HumanDecisionCoordinates,
  humanDecisionCoordinates,
  humanTerminalReceiptMessage,
  matchPersistedHumanDecision,
  type PersistedHumanDecision,
  parseMatchingHumanTerminalReceipt,
  satisfiedDecisionStop,
} from './EntrustedWorkHumanTerminalReceipt.js';
import { EntrustedWorkLifecycleError, type EntrustedWorkLifecycleService } from './EntrustedWorkLifecycleService.js';
import type {
  EntrustedWorkTaskExecutionInspection,
  EntrustedWorkTaskExecutionService,
} from './EntrustedWorkTaskExecutionService.js';

export type { EntrustedWorkHumanTerminalErrorCode } from './EntrustedWorkHumanTerminalError.js';
export { EntrustedWorkHumanTerminalError } from './EntrustedWorkHumanTerminalError.js';

export interface EntrustedWorkHumanTerminalServiceDeps {
  readonly tasks: Pick<ITaskStore, 'get'>;
  readonly lifecycle: Pick<EntrustedWorkLifecycleService, 'close'>;
  readonly messages: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>;
  readonly execution: Pick<EntrustedWorkTaskExecutionService, 'inspect' | 'stopAfterTerminal'>;
  readonly now?: () => number;
}

export interface EntrustedWorkHumanTerminalResult {
  readonly status: 'closed' | 'replayed';
  readonly task: TaskItem;
  readonly execution: EntrustedWorkHumanTerminalReceiptV1['execution'];
  readonly receipt: {
    readonly message: StoredMessage;
    readonly receipt: EntrustedWorkHumanTerminalReceiptV1;
    readonly created: boolean;
  };
}

export class EntrustedWorkHumanTerminalService {
  private readonly now: () => number;
  private readonly taskLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: EntrustedWorkHumanTerminalServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async decide(command: {
    readonly taskId: string;
    readonly userId: string;
    readonly input: EntrustedWorkHumanDecisionV1;
  }): Promise<EntrustedWorkHumanTerminalResult> {
    return this.withTaskLock(command.taskId, () => this.decideUnlocked(command));
  }

  private async decideUnlocked(command: {
    readonly taskId: string;
    readonly userId: string;
    readonly input: EntrustedWorkHumanDecisionV1;
  }): Promise<EntrustedWorkHumanTerminalResult> {
    const input = entrustedWorkHumanDecisionV1Schema.parse(command.input);
    let task = await this.requireOwnedTask(command.taskId, command.userId);
    const coordinates = humanDecisionCoordinates(task.id, command.userId, input.decisionId);
    const existingMessage = await this.readReceiptMessage(task, coordinates.idempotencyKey);

    if (task.entrustedWork?.closure.state !== 'open') {
      const persisted = matchPersistedHumanDecision(task, input, coordinates);
      if (!persisted) {
        throw new EntrustedWorkHumanTerminalError(
          'HUMAN_TERMINAL_ALREADY_CLOSED',
          'Entrusted work is already closed by a different terminal decision',
        );
      }
      if (existingMessage) return this.resultFromExisting(task, existingMessage, coordinates, 'replayed');
      return this.finishReceipt(task, input, coordinates, persisted, 'replayed');
    }

    if (existingMessage) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_RECEIPT_CONFLICT',
        'A terminal receipt already occupies this decision identity before Task closure',
      );
    }
    if (task.entrustedWork.revision !== input.expectedRevision) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_REVISION_CONFLICT',
        'Entrusted-work revision is no longer current',
      );
    }

    const inspection = await this.inspectCurrentTask(task);
    if (input.decision.state === 'satisfied' && inspection.projection.state !== 'idle') {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_EXECUTION_NOT_IDLE',
        'This Task binding is not proven idle; completion confirmation was not recorded',
        inspection.projection,
      );
    }

    const decidedAt = this.now();
    const closure = buildHumanTerminalClosure({
      task,
      decision: input,
      coordinates,
      decidedAt,
      execution: inspection.projection,
    });

    let status: EntrustedWorkHumanTerminalResult['status'] = 'closed';
    let persistedDecision: PersistedHumanDecision = { decidedAt, execution: inspection.projection };
    try {
      task = await this.deps.lifecycle.close({
        taskId: task.id,
        expectedRevision: input.expectedRevision,
        closure,
      });
    } catch (error) {
      const current = await this.requireOwnedTask(command.taskId, command.userId);
      const persisted = matchPersistedHumanDecision(current, input, coordinates);
      if (!persisted) throw this.translateLifecycleError(error);
      task = current;
      status = 'replayed';
      persistedDecision = persisted;
    }

    return this.finishReceipt(
      task,
      input,
      coordinates,
      persistedDecision,
      status,
      status === 'closed' ? inspection : undefined,
    );
  }

  private async withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.taskLocks.set(taskId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.taskLocks.get(taskId) === tail) this.taskLocks.delete(taskId);
    }
  }

  private async finishReceipt(
    task: TaskItem,
    input: EntrustedWorkHumanDecisionV1,
    coordinates: HumanDecisionCoordinates,
    persisted: PersistedHumanDecision,
    status: EntrustedWorkHumanTerminalResult['status'],
    initialInspection?: EntrustedWorkTaskExecutionInspection,
  ): Promise<EntrustedWorkHumanTerminalResult> {
    const stopInspection = initialInspection ?? this.inspectionFromPersistedDecision(task, persisted);
    const stop =
      input.decision.state === 'satisfied'
        ? satisfiedDecisionStop()
        : await this.stopCancelledTask(task, stopInspection);
    const receipt = buildHumanTerminalReceipt({
      task,
      decision: input,
      coordinates,
      persisted,
      stop,
      recordedAt: this.now(),
    });
    let append: IdempotentAppendResult;
    try {
      append = await this.deps.messages.appendIdempotent(humanTerminalReceiptMessage(receipt, coordinates));
    } catch (error) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_RECEIPT_UNAVAILABLE',
        `Task closed, but its original-Thread receipt is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const storedReceipt = this.requireMatchingReceipt(append.message, task, coordinates);
    return {
      status,
      task,
      execution: storedReceipt.execution,
      receipt: { message: append.message, receipt: storedReceipt, created: !append.idempotent },
    };
  }

  private async stopCancelledTask(
    task: TaskItem,
    inspection: EntrustedWorkTaskExecutionInspection,
  ): Promise<EntrustedWorkTaskExecutionStopV1> {
    try {
      return await this.deps.execution.stopAfterTerminal(task, inspection);
    } catch {
      return entrustedWorkTaskExecutionStopV1Schema.parse({
        state: 'unknown',
        reasonCode: 'execution_control_unavailable',
        executionRefs: [],
      });
    }
  }

  private inspectionFromPersistedDecision(
    task: TaskItem,
    persisted: PersistedHumanDecision,
  ): EntrustedWorkTaskExecutionInspection {
    const projection = entrustedWorkTaskExecutionV1Schema.parse(persisted.execution);
    if (
      projection.state !== 'running' ||
      !task.userId ||
      projection.taskRef.taskId !== task.id ||
      projection.taskRef.subjectRef !== `task:work:${task.id}` ||
      projection.taskRef.ownerRef !== `task:item:${task.id}`
    ) {
      return { projection };
    }
    return {
      projection,
      control: {
        parentInvocationId: projection.execution.parentInvocationId,
        ...(projection.execution.childInvocationId
          ? { childInvocationId: projection.execution.childInvocationId }
          : {}),
        threadId: projection.binding.threadId,
        userId: task.userId,
        catId: projection.binding.catId,
      },
    };
  }

  private async inspectCurrentTask(task: TaskItem): Promise<EntrustedWorkTaskExecutionInspection> {
    const inspection = await this.deps.execution.inspect(task);
    const projection = entrustedWorkTaskExecutionV1Schema.parse(inspection.projection);
    if (projection.taskRef.taskId !== task.id || projection.taskRef.revision !== task.entrustedWork?.revision) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_EXECUTION_NOT_IDLE',
        'Task execution evidence does not match the current Task revision',
        projection,
      );
    }
    return { ...inspection, projection };
  }

  private async requireOwnedTask(taskId: string, userId: string): Promise<TaskItem> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) throw new EntrustedWorkHumanTerminalError('HUMAN_TERMINAL_NOT_FOUND', 'Task not found');
    if (task.userId !== userId) {
      throw new EntrustedWorkHumanTerminalError('HUMAN_TERMINAL_FORBIDDEN', 'Entrusted work belongs to another user');
    }
    if (!task.entrustedWork) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_CONTRACT_MISSING',
        'Task does not own an entrusted-work contract',
      );
    }
    return task;
  }

  private async readReceiptMessage(task: TaskItem, idempotencyKey: string): Promise<StoredMessage | null> {
    if (!task.userId) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_CONTRACT_MISSING',
        'Entrusted work has no owner identity',
      );
    }
    try {
      return await this.deps.messages.getByIdempotencyKey(task.userId, task.threadId, idempotencyKey);
    } catch (error) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_RECEIPT_UNAVAILABLE',
        `Original-Thread receipt read is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resultFromExisting(
    task: TaskItem,
    message: StoredMessage,
    coordinates: HumanDecisionCoordinates,
    status: EntrustedWorkHumanTerminalResult['status'],
  ): EntrustedWorkHumanTerminalResult {
    const receipt = this.requireMatchingReceipt(message, task, coordinates);
    return { status, task, execution: receipt.execution, receipt: { message, receipt, created: false } };
  }

  private requireMatchingReceipt(
    message: StoredMessage,
    task: TaskItem,
    coordinates: HumanDecisionCoordinates,
  ): EntrustedWorkHumanTerminalReceiptV1 {
    const receipt = parseMatchingHumanTerminalReceipt(message, task, coordinates);
    if (!receipt) {
      throw new EntrustedWorkHumanTerminalError(
        'HUMAN_TERMINAL_RECEIPT_CONFLICT',
        'The decision idempotency key resolves to a different receipt',
      );
    }
    return receipt;
  }

  private translateLifecycleError(error: unknown): Error {
    if (!(error instanceof EntrustedWorkLifecycleError))
      return error instanceof Error ? error : new Error(String(error));
    switch (error.code) {
      case 'ENTRUSTED_WORK_NOT_FOUND':
        return new EntrustedWorkHumanTerminalError('HUMAN_TERMINAL_NOT_FOUND', error.message);
      case 'ENTRUSTED_WORK_CONTRACT_MISSING':
        return new EntrustedWorkHumanTerminalError('HUMAN_TERMINAL_CONTRACT_MISSING', error.message);
      case 'ENTRUSTED_WORK_REVISION_CONFLICT':
        return new EntrustedWorkHumanTerminalError('HUMAN_TERMINAL_REVISION_CONFLICT', error.message);
      case 'ENTRUSTED_WORK_ALREADY_CLOSED':
        return new EntrustedWorkHumanTerminalError('HUMAN_TERMINAL_ALREADY_CLOSED', error.message);
      default:
        return error;
    }
  }
}
