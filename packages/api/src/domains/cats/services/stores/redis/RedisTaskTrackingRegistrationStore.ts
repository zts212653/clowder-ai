import type { ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createGenericTaskItem } from '../ports/TaskItemFactory.js';
import type { ReplaceTrackingRegistrationIfUnchangedInput } from '../ports/TaskStoreContract.js';
import {
  assertTrackingRegistrationBindingCompatible,
  assertTrackingRegistrationCurrentCompatible,
  assertTrackingRegistrationInput,
  matchesTrackingRegistrationExpectation,
  trackingRegistrationUpdate,
} from '../ports/TaskTrackingRegistrationStore.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

const MAX_RETRIES = 5;

type TrackingRegistrationWatchOutcome = { task: TaskItem; previousThreadId?: string } | null | undefined;

interface RedisTaskTrackingRegistrationStoreOptions {
  applyTtl: (task: TaskItem) => Promise<void>;
  applyThreadTtl: (threadId: string) => Promise<void>;
  waitForInFlightTaskWrite: () => Promise<void>;
}

interface TrackingRegistrationAttempt {
  input: ReplaceTrackingRegistrationIfUnchangedInput;
  subjectKey: string;
  subjectIndexKey: string;
  detailKey: string;
  bindingKey: string;
  created: TaskItem | null;
}

export class RedisTaskTrackingRegistrationStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly options: RedisTaskTrackingRegistrationStoreOptions,
  ) {}

  async replace(input: ReplaceTrackingRegistrationIfUnchangedInput): Promise<TaskItem | null> {
    const attempt = this.createAttempt(input);
    for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
      const outcome = await this.tryReplace(attempt);
      if (outcome !== undefined) return this.finalize(outcome);
      await this.options.waitForInFlightTaskWrite();
    }
    throw new Error(`RedisTaskStore conditional tracking registration kept racing for ${attempt.subjectKey}`);
  }

  private createAttempt(input: ReplaceTrackingRegistrationIfUnchangedInput): TrackingRegistrationAttempt {
    const subjectKey = assertTrackingRegistrationInput(input);
    const created =
      input.expectedTask === null
        ? createGenericTaskItem({ ...input.task, automationState: input.automationState })
        : null;
    const targetId = input.expectedTask?.id ?? created?.id;
    if (!targetId) throw new Error('Conditional tracking registration could not resolve a task id');
    return {
      input,
      subjectKey,
      subjectIndexKey: TaskKeys.subject(subjectKey),
      detailKey: TaskKeys.detail(targetId),
      bindingKey: TaskKeys.managedWorkBinding(targetId),
      created,
    };
  }

  private tryReplace(attempt: TrackingRegistrationAttempt): Promise<TrackingRegistrationWatchOutcome> {
    return runWithExclusiveRedisWatchSession(
      this.redis,
      [attempt.subjectIndexKey, attempt.detailKey, attempt.bindingKey],
      async (session) => {
        const currentId = await session.get(attempt.subjectIndexKey);
        return attempt.input.expectedTask === null
          ? this.createInSession(session, currentId, attempt)
          : this.updateInSession(session, currentId, attempt);
      },
    );
  }

  private async createInSession(
    session: RedisClient,
    currentId: string | null,
    attempt: TrackingRegistrationAttempt,
  ): Promise<TrackingRegistrationWatchOutcome> {
    if (currentId) return null;
    if (!attempt.created) return undefined;
    const existingDetail = await session.hgetall(attempt.detailKey);
    if (existingDetail?.id) return undefined;

    const pipeline = session.multi();
    pipeline.set(attempt.subjectIndexKey, attempt.created.id);
    pipeline.hset(attempt.detailKey, serializeTask(attempt.created));
    pipeline.zadd(TaskKeys.thread(attempt.created.threadId), String(attempt.created.createdAt), attempt.created.id);
    pipeline.zadd(TaskKeys.kind(attempt.created.kind), String(attempt.created.createdAt), attempt.created.id);
    if (attempt.input.managedWorkBinding) {
      pipeline.set(attempt.bindingKey, JSON.stringify(attempt.input.managedWorkBinding));
    }
    const result = await pipeline.exec();
    return result ? { task: attempt.created } : undefined;
  }

  private async updateInSession(
    session: RedisClient,
    currentId: string | null,
    attempt: TrackingRegistrationAttempt,
  ): Promise<TrackingRegistrationWatchOutcome> {
    const expected = attempt.input.expectedTask;
    if (!expected || currentId !== expected.id) return null;
    const data = await session.hgetall(attempt.detailKey);
    if (!data?.id) return null;
    const current = hydrateTask(data);
    if (!matchesTrackingRegistrationExpectation(current, expected)) return null;
    if (current.automationState?.waitOutcome?.delivery === 'pending') return null;
    assertTrackingRegistrationCurrentCompatible(attempt.subjectKey, current, attempt.input);
    if (current.kind !== attempt.input.task.kind) return null;

    const encodedBinding = await session.get(attempt.bindingKey);
    const currentBinding = encodedBinding ? (JSON.parse(encodedBinding) as ManagedWorkBinding) : null;
    assertTrackingRegistrationBindingCompatible(current.id, currentBinding, attempt.input.managedWorkBinding);

    const updated = trackingRegistrationUpdate(current, attempt.input);
    const pipeline = session.multi();
    pipeline.hset(attempt.detailKey, serializeTask(updated));
    if (updated.threadId !== current.threadId) {
      pipeline.zrem(TaskKeys.thread(current.threadId), current.id);
      pipeline.zadd(TaskKeys.thread(updated.threadId), String(updated.createdAt), updated.id);
    }
    if (attempt.input.managedWorkBinding && !encodedBinding) {
      pipeline.set(attempt.bindingKey, JSON.stringify(attempt.input.managedWorkBinding));
    }
    const result = await pipeline.exec();
    return result ? { task: updated, previousThreadId: current.threadId } : undefined;
  }

  private async finalize(outcome: Exclude<TrackingRegistrationWatchOutcome, undefined>): Promise<TaskItem | null> {
    if (!outcome) return null;
    await this.options.applyTtl(outcome.task);
    if (outcome.previousThreadId && outcome.previousThreadId !== outcome.task.threadId) {
      await this.options.applyThreadTtl(outcome.previousThreadId);
    }
    return outcome.task;
  }
}
