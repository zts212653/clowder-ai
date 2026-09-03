/**
 * Redis Task Store (毛线球)
 * Redis-backed task storage with same interface as in-memory TaskStore.
 *
 * #320: Unified model — PR tracking merged into Task system.
 *
 * Redis 数据结构:
 *   cat-cafe:task:{taskId}              → Hash (任务详情)
 *   cat-cafe:tasks:thread:{threadId}    → Sorted Set (每线程任务列表, score=createdAt)
 *   cat-cafe:tasks:kind:{kind}          → Sorted Set (按类型索引, score=createdAt)
 *   cat-cafe:tasks:subject:{subjectKey} → String (subject→taskId 唯一映射)
 *
 * TTL: 30 days default. Tracking tasks (pr_tracking/issue_tracking) with status!=done have no TTL.
 */

import type {
  AutomationState,
  CreateTaskInput,
  ManagedWorkBinding,
  TaskItem,
  TaskKind,
  UpdateTaskInput,
} from '@cat-cafe/shared';
import { isTrackingKind } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { automationGeneration, mergeTaskAutomationState } from '../ports/TaskAutomationState.js';
import { createEntrustedTaskItem, createGenericTaskItem } from '../ports/TaskItemFactory.js';
import { assertSubjectUpdateOwnership, type ITaskStore } from '../ports/TaskStore.js';
import {
  type AdmitEntrustedWorkStoreInput,
  type AdmitEntrustedWorkStoreResult,
  assertEntrustedWorkGenericDeletionAllowed,
  assertEntrustedWorkGenericUpdateAllowed,
  assertEntrustedWorkGenericUpsertAllowed,
  assertEntrustedWorkReplayCompatible,
  assertEntrustedWorkStatusUpdateAllowed,
  assertGenericTaskSubjectNamespaceAllowed,
  type CloseEntrustedWorkStoreInput,
  type CloseEntrustedWorkStoreResult,
  createTaskSubjectAlreadyExistsError,
  isEntrustedWorkSubjectKey,
  type ReplaceAutomationStateIfGenerationInput,
  type UpdateEntrustedWorkStoreInput,
  type UpdateEntrustedWorkStoreResult,
} from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';
import { fetchRedisTasksByIds } from './RedisTaskCollectionReader.js';
import { RedisTaskEntrustedWorkMutationStore } from './RedisTaskEntrustedWorkMutationStore.js';
import { RedisTaskManagedWorkBindingStore } from './RedisTaskManagedWorkBindingStore.js';
import { RedisTaskManagedWorkRegistrationStore } from './RedisTaskManagedWorkRegistrationStore.js';
import {
  type AtomicSubjectCreateResult,
  tryCreateTaskWithAtomicSubject,
  writeTaskForSubjectOwner,
} from './RedisTaskSubjectTransactions.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

const DEFAULT_TTL = 0; // persistent — set >0 via env to enable expiry
const MAX_SUBJECT_LOOKUP_NULL_RETRIES = 3;
const MAX_MISSING_TASK_RETRIES = 3;
const MAX_AUTOMATION_STATE_PATCH_RETRIES = 5;
const MAX_CONDITIONAL_TASK_UPDATE_RETRIES = 5;
const MAX_ANCHOR_LIFETIME_RECONCILIATION_RETRIES = 5;
const MAX_UNIQUE_SUBJECT_CREATE_RETRIES = 8;

export class RedisTaskStore implements ITaskStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;
  private readonly managedWorkBindings: RedisTaskManagedWorkBindingStore;
  private readonly managedWorkRegistration: RedisTaskManagedWorkRegistrationStore;
  private readonly entrustedWorkMutations: RedisTaskEntrustedWorkMutationStore;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    this.managedWorkBindings = new RedisTaskManagedWorkBindingStore(redis);
    this.managedWorkRegistration = new RedisTaskManagedWorkRegistrationStore(redis, {
      mergeAutomationState: mergeTaskAutomationState,
      applyThreadTtl: (threadId) => this.applyThreadTtl(threadId),
      compareAndDeleteSubject: (subjectKey, staleTaskId) => this.compareAndDeleteSubject(subjectKey, staleTaskId),
      waitForInFlightTaskWrite: () => this.waitForInFlightTaskWrite(),
    });
    this.entrustedWorkMutations = new RedisTaskEntrustedWorkMutationStore(
      redis,
      (task) => this.applyTtl(task),
      () => this.waitForInFlightTaskWrite(),
    );
    const raw = options?.ttlSeconds ?? DEFAULT_TTL;
    if (!Number.isFinite(raw) || raw <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(raw);
    }
  }

  async create(input: CreateTaskInput): Promise<TaskItem> {
    const subjectKey = input.subjectKey;
    if (subjectKey) {
      assertGenericTaskSubjectNamespaceAllowed(subjectKey);
      return this.createWithUniqueSubject(input);
    }

    const task = createGenericTaskItem(input);
    await this.writeTask(task);
    return task;
  }

  private async createWithUniqueSubject(input: CreateTaskInput): Promise<TaskItem> {
    const subjectKey = input.subjectKey;
    if (!subjectKey) throw new Error('createWithUniqueSubject requires a subject key');

    let missingTaskRetries = 0;
    for (let attempt = 0; attempt < MAX_UNIQUE_SUBJECT_CREATE_RETRIES; attempt += 1) {
      const task = createGenericTaskItem(input);
      const result = await this.tryAtomicSubjectCreate(task);
      if (result === 'created') return task;
      if (result === 'task_id_exists') continue;

      const existingId = await this.redis.get(TaskKeys.subject(subjectKey));
      if (!existingId) {
        await this.waitForInFlightTaskWrite();
        continue;
      }
      const existing = await this.get(existingId);
      if (existing) throw createTaskSubjectAlreadyExistsError(subjectKey);

      if (missingTaskRetries < MAX_MISSING_TASK_RETRIES) {
        missingTaskRetries += 1;
        await this.waitForInFlightTaskWrite();
        continue;
      }
      await this.compareAndDeleteSubject(subjectKey, existingId);
      missingTaskRetries = 0;
    }

    throw new Error(`RedisTaskStore create: failed to establish unique subject ${subjectKey}`);
  }

  private async tryAtomicSubjectCreate(task: TaskItem): Promise<AtomicSubjectCreateResult> {
    const result = await tryCreateTaskWithAtomicSubject(this.redis, task);
    if (result === 'created') await this.applyTtl(task);
    return result;
  }

  async get(taskId: string): Promise<TaskItem | null> {
    const data = await this.redis.hgetall(TaskKeys.detail(taskId));
    if (!data || !data.id) {
      await this.redis.del(TaskKeys.managedWorkBinding(taskId));
      return null;
    }
    return hydrateTask(data);
  }

  async getBySubject(subjectKey: string): Promise<TaskItem | null> {
    const taskId = await this.redis.get(TaskKeys.subject(subjectKey));
    if (!taskId) return null;
    const task = await this.get(taskId);
    if (task) return task;
    await this.compareAndDeleteSubject(subjectKey, taskId);
    return null;
  }

  async upsertBySubject(input: CreateTaskInput): Promise<TaskItem> {
    const subjectKey = input.subjectKey;
    if (subjectKey && isEntrustedWorkSubjectKey(subjectKey)) {
      const existingId = await this.redis.get(TaskKeys.subject(subjectKey));
      if (existingId) {
        const existing = await this.get(existingId);
        if (existing) assertEntrustedWorkGenericUpsertAllowed(existing);
      }
      assertGenericTaskSubjectNamespaceAllowed(subjectKey);
    }
    if (!subjectKey) return this.create(input);

    const existingId = await this.redis.get(TaskKeys.subject(subjectKey));
    if (!existingId) {
      return this.createWithUniqueSubject(input);
    }
    return this.upsertExistingSubject(input, existingId, 0);
  }

  async upsertBySubjectWithManagedWorkBinding(input: CreateTaskInput, binding: ManagedWorkBinding): Promise<TaskItem> {
    return this.managedWorkRegistration.upsert(input, binding);
  }

  private async upsertExistingSubject(
    input: CreateTaskInput,
    existingId: string,
    missingTaskRetries: number,
  ): Promise<TaskItem> {
    const sk = input.subjectKey;
    if (!sk) throw new Error('upsertExistingSubject requires a subject key');

    const existing = await this.get(existingId);
    if (!existing) {
      if (missingTaskRetries < MAX_MISSING_TASK_RETRIES) {
        await this.waitForInFlightTaskWrite();
        return this.upsertExistingSubject(input, existingId, missingTaskRetries + 1);
      }
      await this.compareAndDeleteSubject(sk, existingId);
      return this.createWithUniqueSubject(input);
    }

    assertSubjectUpdateOwnership(sk, existing, input);
    assertEntrustedWorkGenericUpsertAllowed(existing);

    const now = Date.now();
    const updated: TaskItem = {
      ...existing,
      threadId: input.threadId,
      title: input.title,
      ownerCatId: input.ownerCatId ?? existing.ownerCatId,
      status: isTrackingKind(existing.kind) && existing.status === 'done' ? 'todo' : existing.status,
      why: input.why,
      userId: input.userId ?? existing.userId,
      probe: input.probe !== undefined ? input.probe : existing.probe,
      resolveMode: input.resolveMode !== undefined ? input.resolveMode : existing.resolveMode,
      automationState: input.automationState
        ? mergeTaskAutomationState(existing.automationState, input.automationState)
        : existing.automationState,
      updatedAt: now,
    };

    const written = await this.writeTask(updated, { syncSubject: false, requireSubjectOwner: true });
    if (!written) {
      throw createTaskSubjectAlreadyExistsError(sk);
    }
    if (existing.threadId !== updated.threadId) {
      await this.redis.zrem(TaskKeys.thread(existing.threadId), existing.id);
      await this.applyThreadTtl(existing.threadId);
    }
    return updated;
  }

  async listByKind(kind: TaskKind): Promise<TaskItem[]> {
    const ids = await this.redis.zrange(TaskKeys.kind(kind), 0, -1);
    if (ids.length === 0) return [];
    return fetchRedisTasksByIds(this.redis, ids, { cleanupKey: TaskKeys.kind(kind) });
  }

  async patchAutomationState(taskId: string, patch: Partial<AutomationState>): Promise<TaskItem | null> {
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_AUTOMATION_STATE_PATCH_RETRIES; attempt += 1) {
      const outcome = await runWithExclusiveRedisWatchSession<TaskItem | null | undefined>(
        this.redis,
        key,
        async (session) => {
          const data = await session.hgetall(key);
          if (!data || !data.id) {
            return null;
          }

          const existing = hydrateTask(data);
          const updated: TaskItem = {
            ...existing,
            automationState: mergeTaskAutomationState(existing.automationState, patch),
            updatedAt: Date.now(),
          };

          const pipeline = session.multi();
          pipeline.hset(key, serializeTask(updated));
          const result = await pipeline.exec();
          return result ? updated : undefined;
        },
      );
      if (outcome !== undefined) return outcome;
      await this.waitForInFlightTaskWrite();
    }

    throw new Error(`RedisTaskStore patchAutomationState: failed to apply atomic patch for ${taskId}`);
  }

  async bindManagedWorkBinding(taskId: string, binding: ManagedWorkBinding): Promise<ManagedWorkBinding | null> {
    return this.managedWorkBindings.bind(taskId, binding);
  }

  async getManagedWorkBinding(taskId: string): Promise<ManagedWorkBinding | null> {
    return this.managedWorkBindings.get(taskId);
  }

  async admitEntrustedWork(input: AdmitEntrustedWorkStoreInput): Promise<AdmitEntrustedWorkStoreResult> {
    return this.admitEntrustedWorkInternal(input, 0, 0);
  }

  private async admitEntrustedWorkInternal(
    input: AdmitEntrustedWorkStoreInput,
    missingTaskRetries: number,
    subjectLookupNullRetries: number,
  ): Promise<AdmitEntrustedWorkStoreResult> {
    const task = createEntrustedTaskItem(input);
    const result = await this.tryAtomicSubjectCreate(task);

    if (result === 'created') {
      return { kind: 'admitted', task };
    }
    if (result === 'task_id_exists') return this.admitEntrustedWorkInternal(input, 0, 0);

    const existingId = await this.redis.get(TaskKeys.subject(input.subjectKey));
    if (!existingId) {
      if (subjectLookupNullRetries >= MAX_SUBJECT_LOOKUP_NULL_RETRIES) {
        throw new Error(
          `RedisTaskStore admitEntrustedWork: subject lookup kept returning null for ${input.subjectKey}`,
        );
      }
      await this.waitForInFlightTaskWrite();
      return this.admitEntrustedWorkInternal(input, missingTaskRetries, subjectLookupNullRetries + 1);
    }

    const existing = await this.get(existingId);
    if (!existing) {
      if (missingTaskRetries < MAX_MISSING_TASK_RETRIES) {
        await this.waitForInFlightTaskWrite();
        return this.admitEntrustedWorkInternal(input, missingTaskRetries + 1, 0);
      }
      await this.compareAndDeleteSubject(input.subjectKey, existingId);
      return this.admitEntrustedWorkInternal(input, 0, 0);
    }

    assertEntrustedWorkReplayCompatible(input.subjectKey, existing, input.entrustedWork);
    return { kind: 'resumed', task: existing };
  }

  async closeEntrustedWork(
    taskId: string,
    input: CloseEntrustedWorkStoreInput,
  ): Promise<CloseEntrustedWorkStoreResult> {
    return this.entrustedWorkMutations.close(taskId, input);
  }

  async updateEntrustedWork(
    taskId: string,
    input: UpdateEntrustedWorkStoreInput,
  ): Promise<UpdateEntrustedWorkStoreResult> {
    return this.entrustedWorkMutations.update(taskId, input);
  }

  async replaceAutomationStateIfGeneration(
    taskId: string,
    input: ReplaceAutomationStateIfGenerationInput,
  ): Promise<TaskItem | null> {
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_AUTOMATION_STATE_PATCH_RETRIES; attempt += 1) {
      const outcome = await runWithExclusiveRedisWatchSession<TaskItem | null | undefined>(
        this.redis,
        key,
        async (session) => {
          const data = await session.hgetall(key);
          if (!data || !data.id) {
            return null;
          }
          const existing = hydrateTask(data);
          assertEntrustedWorkStatusUpdateAllowed(existing, input);
          if (!this.matchesAutomationReplacementExpectation(existing, input)) {
            return null;
          }
          const updated = this.buildAutomationReplacement(existing, input);
          const pipeline = session.multi();
          pipeline.hset(key, serializeTask(updated));
          const result = await pipeline.exec();
          return result ? updated : undefined;
        },
      );
      if (outcome !== undefined) {
        if (outcome) await this.applyTtl(outcome);
        return outcome;
      }
      await this.waitForInFlightTaskWrite();
    }
    throw new Error(`RedisTaskStore replaceAutomationStateIfGeneration: CAS exhausted for ${taskId}`);
  }

  async update(taskId: string, input: UpdateTaskInput): Promise<TaskItem | null> {
    const existing = await this.get(taskId);
    if (!existing) return null;

    const updated = this.applyTaskUpdate(existing, input);

    await this.redis.hset(TaskKeys.detail(taskId), serializeTask(updated));

    // If threadId changed, update the thread index (remove from old, add to new).
    if (input.threadId !== undefined && input.threadId !== existing.threadId) {
      const pipeline = this.redis.multi();
      pipeline.zrem(TaskKeys.thread(existing.threadId), taskId);
      pipeline.zadd(TaskKeys.thread(input.threadId), updated.updatedAt, taskId);
      await pipeline.exec();
    }

    // Update TTL based on new status
    await this.applyTtl(updated);
    return updated;
  }

  async updateIfThreadId(taskId: string, expectedThreadId: string, input: UpdateTaskInput): Promise<TaskItem | null> {
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_TASK_UPDATE_RETRIES; attempt += 1) {
      const outcome = await runWithExclusiveRedisWatchSession<TaskItem | null | undefined>(
        this.redis,
        key,
        async (session) => {
          const data = await session.hgetall(key);
          if (!data || !data.id) {
            return null;
          }

          const existing = hydrateTask(data);
          if (existing.threadId !== expectedThreadId) {
            return null;
          }

          const updated = this.applyTaskUpdate(existing, input);
          const pipeline = session.multi();
          pipeline.hset(key, serializeTask(updated));
          if (input.threadId !== undefined && input.threadId !== existing.threadId) {
            pipeline.zrem(TaskKeys.thread(existing.threadId), taskId);
            pipeline.zadd(TaskKeys.thread(input.threadId), updated.updatedAt, taskId);
          }

          const result = await pipeline.exec();
          return result ? updated : undefined;
        },
      );
      if (outcome !== undefined) {
        if (outcome) await this.applyTtl(outcome);
        return outcome;
      }
      await this.waitForInFlightTaskWrite();
    }

    throw new Error(`RedisTaskStore updateIfThreadId: failed to apply conditional update for ${taskId}`);
  }

  async listByThread(threadId: string): Promise<TaskItem[]> {
    const ids = await this.redis.zrange(TaskKeys.thread(threadId), 0, -1);
    if (ids.length === 0) return [];
    return fetchRedisTasksByIds(this.redis, ids, { cleanupKey: TaskKeys.thread(threadId) });
  }

  async delete(taskId: string): Promise<boolean> {
    const data = await this.redis.hgetall(TaskKeys.detail(taskId));
    if (!data || !data.id) {
      await this.redis.del(TaskKeys.managedWorkBinding(taskId));
      return false;
    }

    const task = hydrateTask(data);
    assertEntrustedWorkGenericDeletionAllowed(task);
    const pipeline = this.redis.multi();
    pipeline.del(TaskKeys.detail(taskId));
    pipeline.del(TaskKeys.managedWorkBinding(taskId));
    if (task.threadId) pipeline.zrem(TaskKeys.thread(task.threadId), taskId);
    if (task.kind) pipeline.zrem(TaskKeys.kind(task.kind), taskId);
    await pipeline.exec();
    if (task.subjectKey) {
      await this.compareAndDeleteSubject(task.subjectKey, task.id);
    }
    if (task.threadId) {
      await this.applyThreadTtl(task.threadId);
    }
    return true;
  }

  private applyTaskUpdate(existing: TaskItem, input: UpdateTaskInput): TaskItem {
    assertEntrustedWorkGenericUpdateAllowed(existing);
    return {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.ownerCatId !== undefined ? { ownerCatId: input.ownerCatId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.automationState !== undefined ? { automationState: input.automationState } : {}),
      ...(input.probe !== undefined ? { probe: input.probe } : {}),
      ...(input.resolveMode !== undefined ? { resolveMode: input.resolveMode } : {}),
      // Generic task move support: callers that change threadId own the UX contract.
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      // F193-E1 P1-4: allow patching dispatchGate
      ...(input.dispatchGate !== undefined ? { dispatchGate: input.dispatchGate } : {}),
      updatedAt: Date.now(),
    };
  }

  async deleteByThread(threadId: string): Promise<number> {
    const key = TaskKeys.thread(threadId);
    const ids = await this.redis.zrange(key, 0, -1);
    if (ids.length === 0) return 0;

    // Fetch all tasks to clean up kind/subject indexes
    const tasks = await fetchRedisTasksByIds(this.redis, ids);
    tasks.forEach(assertEntrustedWorkGenericDeletionAllowed);
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.del(TaskKeys.detail(id));
      pipeline.del(TaskKeys.managedWorkBinding(id));
    }
    for (const task of tasks) {
      if (task.kind) pipeline.zrem(TaskKeys.kind(task.kind), task.id);
    }
    pipeline.del(key);
    await pipeline.exec();
    for (const task of tasks) {
      if (task.subjectKey) {
        await this.compareAndDeleteSubject(task.subjectKey, task.id);
      }
    }

    return ids.length;
  }

  // --- private helpers ---

  private async writeTask(
    task: TaskItem,
    options?: { syncSubject?: boolean; requireSubjectOwner?: boolean },
  ): Promise<boolean> {
    const subjectKey = task.subjectKey;
    const key = TaskKeys.detail(task.id);

    if (options?.requireSubjectOwner && subjectKey) {
      if (!(await writeTaskForSubjectOwner(this.redis, task))) return false;
      await this.applyTtl(task);
      return true;
    }

    const pipeline = this.redis.multi();
    pipeline.hset(key, serializeTask(task));
    pipeline.zadd(TaskKeys.thread(task.threadId), String(task.createdAt), task.id);
    pipeline.zadd(TaskKeys.kind(task.kind), String(task.createdAt), task.id);
    if ((options?.syncSubject ?? true) && subjectKey) {
      pipeline.set(TaskKeys.subject(subjectKey), task.id);
    }
    await pipeline.exec();
    await this.applyTtl(task);
    return true;
  }

  private async waitForInFlightTaskWrite(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  private matchesAutomationReplacementExpectation(
    existing: TaskItem,
    input: ReplaceAutomationStateIfGenerationInput,
  ): boolean {
    if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) return false;
    return automationGeneration(existing.automationState) === input.expectedGeneration;
  }

  private buildAutomationReplacement(existing: TaskItem, input: ReplaceAutomationStateIfGenerationInput): TaskItem {
    return {
      ...existing,
      automationState: input.automationState,
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };
  }

  /** Tracking tasks (pr_tracking/issue_tracking) with status!=done never expire; others get default TTL. */
  private async applyTtl(task: TaskItem): Promise<void> {
    if (this.ttlSeconds === null) return;
    let current = task;
    for (let attempt = 0; attempt < MAX_ANCHOR_LIFETIME_RECONCILIATION_RETRIES; attempt += 1) {
      const mode = isTrackingKind(current.kind) && current.status !== 'done' ? 'persist' : 'expire';
      const result = await this.managedWorkBindings.applyAnchorLifetime(current.id, mode, this.ttlSeconds, {
        updatedAt: current.updatedAt,
        status: current.status,
      });
      if (result !== 'stale') {
        await this.applyThreadTtl(current.threadId);
        return;
      }

      const latest = await this.get(current.id);
      if (!latest) {
        await this.applyThreadTtl(current.threadId);
        return;
      }
      current = latest;
    }

    throw new Error(`RedisTaskStore applyTtl: task ${task.id} kept changing during lifetime reconciliation`);
  }

  private async applyThreadTtl(threadId: string): Promise<void> {
    if (this.ttlSeconds === null) return;
    const threadKey = TaskKeys.thread(threadId);

    // A thread index shared with any active tracking task must remain durable.
    const threadTasks = await this.listByThread(threadId);
    const hasActiveTracking = threadTasks.some((item) => isTrackingKind(item.kind) && item.status !== 'done');
    if (hasActiveTracking) {
      await this.redis.persist(threadKey);
    } else {
      await this.redis.expire(threadKey, this.ttlSeconds);
    }
  }

  private async compareAndDeleteSubject(subjectKey: string, staleTaskId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]) return 1 end return 0",
      1,
      TaskKeys.subject(subjectKey),
      staleTaskId,
    );
  }
}
