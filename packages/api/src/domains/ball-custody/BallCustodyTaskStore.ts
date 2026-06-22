import type { AutomationState, CreateTaskInput, TaskItem, TaskKind, UpdateTaskInput } from '@cat-cafe/shared';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IBallCustodyIngest } from './BallCustodyIngest.js';
import { buildTaskBlockedEvent, buildTaskDoneEvent, buildTaskUnblockedEvent } from './ball-custody-events.js';

type MaybePromise<T> = T | Promise<T>;
type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown })?.then === 'function';
}

export function withBallCustodyTaskEvents(
  inner: ITaskStore,
  ballCustody: IBallCustodyIngest,
  logger?: WarnLogger,
): ITaskStore {
  return new BallCustodyTaskStore(inner, ballCustody, logger);
}

class BallCustodyTaskStore implements ITaskStore {
  constructor(
    private readonly inner: ITaskStore,
    private readonly ballCustody: IBallCustodyIngest,
    private readonly logger?: WarnLogger,
  ) {}

  create(input: CreateTaskInput): MaybePromise<TaskItem> {
    return this.inner.create(input);
  }

  get(taskId: string): MaybePromise<TaskItem | null> {
    return this.inner.get(taskId);
  }

  update(taskId: string, input: UpdateTaskInput): MaybePromise<TaskItem | null> {
    const beforeResult = this.inner.get(taskId);
    const updateAfterBefore = (before: TaskItem | null): MaybePromise<TaskItem | null> => {
      const updatedResult = this.inner.update(taskId, input);
      const finish = (updated: TaskItem | null): TaskItem | null => {
        if (before && updated) this.recordStatusTransition(before, updated);
        return updated;
      };
      return isPromiseLike(updatedResult) ? updatedResult.then(finish) : finish(updatedResult);
    };

    return isPromiseLike(beforeResult) ? beforeResult.then(updateAfterBefore) : updateAfterBefore(beforeResult);
  }

  updateIfThreadId(taskId: string, expectedThreadId: string, input: UpdateTaskInput): MaybePromise<TaskItem | null> {
    const beforeResult = this.inner.get(taskId);
    const updateAfterBefore = (before: TaskItem | null): MaybePromise<TaskItem | null> => {
      const updatedResult = this.inner.updateIfThreadId(taskId, expectedThreadId, input);
      const finish = (updated: TaskItem | null): TaskItem | null => {
        if (before && updated) this.recordStatusTransition(before, updated);
        return updated;
      };
      return isPromiseLike(updatedResult) ? updatedResult.then(finish) : finish(updatedResult);
    };

    return isPromiseLike(beforeResult) ? beforeResult.then(updateAfterBefore) : updateAfterBefore(beforeResult);
  }

  listByThread(threadId: string): MaybePromise<TaskItem[]> {
    return this.inner.listByThread(threadId);
  }

  delete(taskId: string): MaybePromise<boolean> {
    return this.inner.delete(taskId);
  }

  deleteByThread(threadId: string): MaybePromise<number> {
    return this.inner.deleteByThread(threadId);
  }

  getBySubject(subjectKey: string): MaybePromise<TaskItem | null> {
    return this.inner.getBySubject(subjectKey);
  }

  upsertBySubject(input: CreateTaskInput): MaybePromise<TaskItem> {
    return this.inner.upsertBySubject(input);
  }

  listByKind(kind: TaskKind): MaybePromise<TaskItem[]> {
    return this.inner.listByKind(kind);
  }

  patchAutomationState(taskId: string, patch: Partial<AutomationState>): MaybePromise<TaskItem | null> {
    return this.inner.patchAutomationState(taskId, patch);
  }

  private recordStatusTransition(before: TaskItem, updated: TaskItem): void {
    if (before.status === updated.status) return;

    const event =
      updated.status === 'blocked'
        ? buildTaskBlockedEvent({
            taskId: updated.id,
            threadId: updated.threadId,
            ownerCatId: updated.ownerCatId,
            blockedSinceAt: updated.updatedAt,
            resolveMode: updated.resolveMode,
          })
        : updated.status === 'done'
          ? buildTaskDoneEvent({ taskId: updated.id, at: updated.updatedAt })
          : before.status === 'blocked'
            ? buildTaskUnblockedEvent({ taskId: updated.id, at: updated.updatedAt })
            : null;

    if (!event) return;
    this.ballCustody.record(event).catch((err) => {
      this.logger?.warn({ err, taskId: updated.id, eventKind: event.kind }, 'F233 PR3: failed to record task event');
    });
  }
}
