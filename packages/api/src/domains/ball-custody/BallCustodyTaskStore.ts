import type {
  AutomationState,
  CreateTaskInput,
  ManagedWorkBinding,
  TaskItem,
  TaskKind,
  UpdateTaskInput,
} from '@cat-cafe/shared';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ReplaceAutomationStateIfGenerationInput } from '../cats/services/stores/ports/TaskStoreContract.js';
import type { IBallCustodyIngest } from './BallCustodyIngest.js';
import { buildTaskBlockedEvent, buildTaskDoneEvent, buildTaskUnblockedEvent } from './ball-custody-events.js';
import type { TaskActionSuccessorLifecycle } from './TaskActionSuccessorLifecycle.js';

type MaybePromise<T> = T | Promise<T>;
type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown })?.then === 'function';
}

export function withBallCustodyTaskEvents(
  inner: ITaskStore,
  ballCustody: IBallCustodyIngest,
  logger?: WarnLogger,
  actionLifecycle?: TaskActionSuccessorLifecycle,
): ITaskStore {
  return new BallCustodyTaskStore(inner, ballCustody, logger, actionLifecycle);
}

class BallCustodyTaskStore implements ITaskStore {
  constructor(
    private readonly inner: ITaskStore,
    private readonly ballCustody: IBallCustodyIngest,
    private readonly logger?: WarnLogger,
    private readonly actionLifecycle?: TaskActionSuccessorLifecycle,
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
      const performUpdate = (): MaybePromise<TaskItem | null> => {
        const updatedResult = this.inner.update(taskId, input);
        const finish = (updated: TaskItem | null): MaybePromise<TaskItem | null> => {
          if (!before || !updated) return updated;
          this.recordStatusTransition(before, updated);
          const completion = this.actionLifecycle?.completeStatusTransition(before, updated);
          return completion ? completion.then(() => updated) : updated;
        };
        return isPromiseLike(updatedResult) ? updatedResult.then(finish) : finish(updatedResult);
      };
      const gate = before ? this.actionLifecycle?.assertUpdateAllowed(before, input) : undefined;
      return gate ? gate.then(performUpdate) : performUpdate();
    };

    return isPromiseLike(beforeResult) ? beforeResult.then(updateAfterBefore) : updateAfterBefore(beforeResult);
  }

  updateIfThreadId(taskId: string, expectedThreadId: string, input: UpdateTaskInput): MaybePromise<TaskItem | null> {
    const beforeResult = this.inner.get(taskId);
    const updateAfterBefore = (before: TaskItem | null): MaybePromise<TaskItem | null> => {
      const performUpdate = (): MaybePromise<TaskItem | null> => {
        const updatedResult = this.inner.updateIfThreadId(taskId, expectedThreadId, input);
        const finish = (updated: TaskItem | null): MaybePromise<TaskItem | null> => {
          if (!before || !updated) return updated;
          this.recordStatusTransition(before, updated);
          const completion = this.actionLifecycle?.completeStatusTransition(before, updated);
          return completion ? completion.then(() => updated) : updated;
        };
        return isPromiseLike(updatedResult) ? updatedResult.then(finish) : finish(updatedResult);
      };
      const gate = before ? this.actionLifecycle?.assertUpdateAllowed(before, input) : undefined;
      return gate ? gate.then(performUpdate) : performUpdate();
    };

    return isPromiseLike(beforeResult) ? beforeResult.then(updateAfterBefore) : updateAfterBefore(beforeResult);
  }

  listByThread(threadId: string): MaybePromise<TaskItem[]> {
    return this.inner.listByThread(threadId);
  }

  delete(taskId: string): MaybePromise<boolean> {
    const actionLifecycle = this.actionLifecycle;
    if (!actionLifecycle) return this.inner.delete(taskId);
    return Promise.resolve(this.inner.get(taskId)).then(async (task) => {
      if (task) await actionLifecycle.assertDeleteAllowed(task);
      return this.inner.delete(taskId);
    });
  }

  deleteByThread(threadId: string): MaybePromise<number> {
    const actionLifecycle = this.actionLifecycle;
    if (!actionLifecycle) return this.inner.deleteByThread(threadId);
    return Promise.resolve(this.inner.listByThread(threadId)).then(async (tasks) => {
      await Promise.all(tasks.map((task) => actionLifecycle.assertDeleteAllowed(task)));
      return this.inner.deleteByThread(threadId);
    });
  }

  getBySubject(subjectKey: string): MaybePromise<TaskItem | null> {
    return this.inner.getBySubject(subjectKey);
  }

  upsertBySubject(input: CreateTaskInput): MaybePromise<TaskItem> {
    return this.inner.upsertBySubject(input);
  }

  upsertBySubjectWithManagedWorkBinding(input: CreateTaskInput, binding: ManagedWorkBinding): MaybePromise<TaskItem> {
    return this.inner.upsertBySubjectWithManagedWorkBinding(input, binding);
  }

  listByKind(kind: TaskKind): MaybePromise<TaskItem[]> {
    return this.inner.listByKind(kind);
  }

  patchAutomationState(taskId: string, patch: Partial<AutomationState>): MaybePromise<TaskItem | null> {
    return this.inner.patchAutomationState(taskId, patch);
  }

  bindManagedWorkBinding(taskId: string, binding: ManagedWorkBinding): MaybePromise<ManagedWorkBinding | null> {
    return this.inner.bindManagedWorkBinding(taskId, binding);
  }

  getManagedWorkBinding(taskId: string): MaybePromise<ManagedWorkBinding | null> {
    return this.inner.getManagedWorkBinding(taskId);
  }

  replaceAutomationStateIfGeneration(
    taskId: string,
    input: ReplaceAutomationStateIfGenerationInput,
  ): MaybePromise<TaskItem | null> {
    return this.inner.replaceAutomationStateIfGeneration(taskId, input);
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
