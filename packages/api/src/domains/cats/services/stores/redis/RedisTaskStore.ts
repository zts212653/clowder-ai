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
 * TTL: 30 days default. pr_tracking tasks with status!=done have no TTL.
 */

import type { AutomationState, CatId, CreateTaskInput, TaskItem, TaskKind, UpdateTaskInput } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { generateSortableId } from '../ports/MessageStore.js';
import { createSubjectOwnershipConflict, type ITaskStore } from '../ports/TaskStore.js';
import { TaskKeys } from '../redis-keys/task-keys.js';

const DEFAULT_TTL = 30 * 24 * 60 * 60; // 30 days
const MAX_SUBJECT_LOOKUP_NULL_RETRIES = 3;
const MAX_MISSING_TASK_RETRIES = 3;
const MAX_AUTOMATION_STATE_PATCH_RETRIES = 5;

/**
 * Lua script: atomically verify subject ownership then write task artifacts.
 * If the subject key doesn't map to the expected task ID, nothing is written.
 *
 * KEYS[1] = tasks:subject:{sk}
 * KEYS[2] = tasks:detail:{id}
 * KEYS[3] = tasks:thread:{threadId}
 * KEYS[4] = tasks:kind:{kind}
 * ARGV[1] = expected task.id
 * ARGV[2] = score (createdAt as string)
 * ARGV[3..] = hash field-value pairs (flattened)
 */
const ATOMIC_OWNED_WRITE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[2], unpack(ARGV, 3, #ARGV))
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
return 1
`;

export class RedisTaskStore implements ITaskStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    const ttl = options?.ttlSeconds;
    if (ttl === undefined) {
      this.ttlSeconds = DEFAULT_TTL;
    } else if (!Number.isFinite(ttl)) {
      this.ttlSeconds = DEFAULT_TTL;
    } else if (ttl <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(ttl);
    }
  }

  async create(input: CreateTaskInput): Promise<TaskItem> {
    const now = Date.now();
    const task: TaskItem = {
      id: generateSortableId(now),
      kind: input.kind ?? 'work',
      threadId: input.threadId,
      subjectKey: input.subjectKey ?? null,
      title: input.title,
      ownerCatId: input.ownerCatId ?? null,
      status: 'todo',
      why: input.why,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      automationState: input.automationState,
      userId: input.userId,
    };

    await this.writeTask(task);
    return task;
  }

  async get(taskId: string): Promise<TaskItem | null> {
    const data = await this.redis.hgetall(TaskKeys.detail(taskId));
    if (!data || !data.id) return null;
    return this.hydrateTask(data);
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
    return this.upsertBySubjectInternal(input, 0, 0);
  }

  private async upsertBySubjectInternal(
    input: CreateTaskInput,
    missingTaskRetries: number,
    subjectLookupNullRetries: number,
  ): Promise<TaskItem> {
    const sk = input.subjectKey;
    if (!sk) return this.create(input);

    // P1-1 fix: atomic claim via SETNX on subject index key.
    // SETNX returns 1 if set (we own the slot), 0 if already occupied (update path).
    const now = Date.now();
    const newId = generateSortableId(now);
    const claimed = await this.redis.setnx(TaskKeys.subject(sk), newId);

    if (claimed) {
      // Won the race — create task with the pre-claimed ID
      const task: TaskItem = {
        id: newId,
        kind: input.kind ?? 'work',
        threadId: input.threadId,
        subjectKey: sk,
        title: input.title,
        ownerCatId: input.ownerCatId ?? null,
        status: 'todo',
        why: input.why,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        automationState: input.automationState,
        userId: input.userId,
      };
      const written = await this.writeTask(task, { syncSubject: false, requireSubjectOwner: true });
      if (!written) {
        return this.upsertBySubjectInternal(input, 0, 0);
      }
      return task;
    }

    // Subject already claimed — read and update existing
    const existingId = await this.redis.get(TaskKeys.subject(sk));
    if (!existingId) {
      // Another worker may have claimed/released/reclaimed the slot between SETNX and GET.
      // Retry the atomic upsert flow instead of blindly creating a duplicate task hash,
      // but do not spin forever if the subject lookup keeps racing to null.
      if (subjectLookupNullRetries >= MAX_SUBJECT_LOOKUP_NULL_RETRIES) {
        throw new Error(`RedisTaskStore upsertBySubject: subject lookup kept returning null for ${sk}`);
      }
      await this.waitForInFlightTaskWrite();
      return this.upsertBySubjectInternal(input, missingTaskRetries, subjectLookupNullRetries + 1);
    }

    const existing = await this.get(existingId);
    if (!existing) {
      if (missingTaskRetries < MAX_MISSING_TASK_RETRIES) {
        await this.waitForInFlightTaskWrite();
        return this.upsertBySubjectInternal(input, missingTaskRetries + 1, 0);
      }
      // Orphaned subject key — CAS overwrite: only claim if value still matches stale ID
      const won = await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2]) return 1 end return 0",
        1,
        TaskKeys.subject(sk),
        existingId,
        newId,
      );
      if (!won) {
        // Another process already fixed the orphan — retry
        return this.upsertBySubjectInternal(input, 0, 0);
      }
      const task: TaskItem = {
        id: newId,
        kind: input.kind ?? 'work',
        threadId: input.threadId,
        subjectKey: sk,
        title: input.title,
        ownerCatId: input.ownerCatId ?? null,
        status: 'todo',
        why: input.why,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        automationState: input.automationState,
        userId: input.userId,
      };
      const written = await this.writeTask(task, { syncSubject: false, requireSubjectOwner: true });
      if (!written) {
        return this.upsertBySubjectInternal(input, 0, 0);
      }
      return task;
    }

    if (existing.userId && input.userId && existing.userId !== input.userId) {
      throw createSubjectOwnershipConflict(sk, existing.userId, input.userId);
    }

    const updated: TaskItem = {
      ...existing,
      threadId: input.threadId,
      title: input.title,
      ownerCatId: input.ownerCatId ?? existing.ownerCatId,
      status: existing.kind === 'pr_tracking' && existing.status === 'done' ? 'todo' : existing.status,
      why: input.why,
      userId: input.userId ?? existing.userId,
      automationState: input.automationState ?? existing.automationState,
      updatedAt: now,
    };

    if (existing.threadId !== input.threadId) {
      await this.redis.zrem(TaskKeys.thread(existing.threadId), existing.id);
      await this.applyThreadTtl(existing.threadId);
    }

    await this.writeTask(updated);
    return updated;
  }

  async listByKind(kind: TaskKind): Promise<TaskItem[]> {
    const ids = await this.redis.zrange(TaskKeys.kind(kind), 0, -1);
    if (ids.length === 0) return [];
    return this.fetchTasksByIds(ids, { cleanupKey: TaskKeys.kind(kind) });
  }

  async patchAutomationState(taskId: string, patch: Partial<AutomationState>): Promise<TaskItem | null> {
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_AUTOMATION_STATE_PATCH_RETRIES; attempt += 1) {
      await this.redis.watch(key);
      const data = await this.redis.hgetall(key);
      if (!data || !data.id) {
        await this.redis.unwatch();
        return null;
      }

      const existing = this.hydrateTask(data);
      const updated: TaskItem = {
        ...existing,
        automationState: this.mergeAutomationState(existing.automationState, patch),
        updatedAt: Date.now(),
      };

      const pipeline = this.redis.multi();
      pipeline.hset(key, this.serializeTask(updated));
      const result = await pipeline.exec();
      if (result) {
        return updated;
      }
      await this.waitForInFlightTaskWrite();
    }

    throw new Error(`RedisTaskStore patchAutomationState: failed to apply atomic patch for ${taskId}`);
  }

  async update(taskId: string, input: UpdateTaskInput): Promise<TaskItem | null> {
    const existing = await this.get(taskId);
    if (!existing) return null;

    const updated: TaskItem = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.ownerCatId !== undefined ? { ownerCatId: input.ownerCatId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.automationState !== undefined ? { automationState: input.automationState } : {}),
      updatedAt: Date.now(),
    };

    await this.redis.hset(TaskKeys.detail(taskId), this.serializeTask(updated));
    // Update TTL based on new status
    await this.applyTtl(updated);
    return updated;
  }

  async listByThread(threadId: string): Promise<TaskItem[]> {
    const ids = await this.redis.zrange(TaskKeys.thread(threadId), 0, -1);
    if (ids.length === 0) return [];
    return this.fetchTasksByIds(ids, { cleanupKey: TaskKeys.thread(threadId) });
  }

  async delete(taskId: string): Promise<boolean> {
    const data = await this.redis.hgetall(TaskKeys.detail(taskId));
    if (!data || !data.id) return false;

    const task = this.hydrateTask(data);
    const pipeline = this.redis.multi();
    pipeline.del(TaskKeys.detail(taskId));
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

  async deleteByThread(threadId: string): Promise<number> {
    const key = TaskKeys.thread(threadId);
    const ids = await this.redis.zrange(key, 0, -1);
    if (ids.length === 0) return 0;

    // Fetch all tasks to clean up kind/subject indexes
    const tasks = await this.fetchTasksByIds(ids);
    const pipeline = this.redis.multi();
    for (const task of tasks) {
      pipeline.del(TaskKeys.detail(task.id));
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
    const shouldVerifyOwnership = Boolean(options?.requireSubjectOwner && subjectKey);
    const key = TaskKeys.detail(task.id);

    if (shouldVerifyOwnership) {
      // Atomic ownership check + artifact write via Lua — no post-write window.
      const serialized = this.serializeTask(task);
      const flatFields: string[] = [];
      for (const [k, v] of Object.entries(serialized)) {
        flatFields.push(k, v);
      }
      const ok = await this.redis.eval(
        ATOMIC_OWNED_WRITE_LUA,
        4,
        TaskKeys.subject(subjectKey!),
        key,
        TaskKeys.thread(task.threadId),
        TaskKeys.kind(task.kind),
        task.id,
        String(task.createdAt),
        ...flatFields,
      );
      if (!ok) return false;
      await this.applyTtl(task);
      return true;
    }

    const pipeline = this.redis.multi();
    pipeline.hset(key, this.serializeTask(task));
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

  /** pr_tracking tasks with status!=done never expire; others get default TTL. */
  private async applyTtl(task: TaskItem): Promise<void> {
    if (this.ttlSeconds === null) return;
    const key = TaskKeys.detail(task.id);

    if (task.kind === 'pr_tracking' && task.status !== 'done') {
      // Active PR tracking tasks don't expire
      await this.redis.persist(key);
    } else {
      await this.redis.expire(key, this.ttlSeconds);
    }

    await this.applyThreadTtl(task.threadId);
  }

  private async applyThreadTtl(threadId: string): Promise<void> {
    if (this.ttlSeconds === null) return;
    const threadKey = TaskKeys.thread(threadId);

    // A thread index shared with any active PR-tracking task must remain durable.
    const threadTasks = await this.listByThread(threadId);
    const hasActivePrTracking = threadTasks.some((item) => item.kind === 'pr_tracking' && item.status !== 'done');
    if (hasActivePrTracking) {
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

  private async removeTaskArtifacts(task: TaskItem): Promise<void> {
    const cleanup = this.redis.multi();
    cleanup.del(TaskKeys.detail(task.id));
    cleanup.zrem(TaskKeys.thread(task.threadId), task.id);
    cleanup.zrem(TaskKeys.kind(task.kind), task.id);
    await cleanup.exec();
    await this.applyThreadTtl(task.threadId);
  }

  private mergeAutomationState(
    existing: AutomationState | undefined,
    patch: Partial<AutomationState>,
  ): AutomationState | undefined {
    if (!existing && Object.keys(patch).length === 0) return undefined;
    return {
      ...existing,
      ...patch,
      ci: patch.ci ? { ...existing?.ci, ...patch.ci } : existing?.ci,
      conflict: patch.conflict ? { ...existing?.conflict, ...patch.conflict } : existing?.conflict,
      review: patch.review ? { ...existing?.review, ...patch.review } : existing?.review,
    };
  }

  private async fetchTasksByIds(ids: string[], options?: { cleanupKey?: string }): Promise<TaskItem[]> {
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(TaskKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const tasks: TaskItem[] = [];
    const staleIds: string[] = [];
    for (const [index, [err, data]] of results.entries()) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.id) {
        staleIds.push(ids[index] ?? '');
        continue;
      }
      tasks.push(this.hydrateTask(d));
    }

    if (options?.cleanupKey && staleIds.length > 0) {
      const cleanup = this.redis.multi();
      for (const staleId of staleIds) {
        if (!staleId) continue;
        cleanup.zrem(options.cleanupKey, staleId);
      }
      await cleanup.exec();
    }

    return tasks;
  }

  private serializeTask(task: TaskItem): Record<string, string> {
    const out: Record<string, string> = {
      id: task.id,
      kind: task.kind ?? 'work',
      threadId: task.threadId,
      subjectKey: task.subjectKey ?? '',
      title: task.title,
      ownerCatId: task.ownerCatId ?? '',
      status: task.status,
      why: task.why,
      createdBy: task.createdBy,
      createdAt: String(task.createdAt),
      updatedAt: String(task.updatedAt),
      userId: task.userId ?? '',
    };
    if (task.automationState) {
      out.automationState = JSON.stringify(task.automationState);
    }
    return out;
  }

  private hydrateTask(data: Record<string, string>): TaskItem {
    const base: TaskItem = {
      id: data.id ?? '',
      kind: (data.kind ?? 'work') as TaskKind,
      threadId: data.threadId ?? '',
      subjectKey: data.subjectKey || null,
      title: data.title ?? '',
      ownerCatId: (data.ownerCatId || null) as CatId | null,
      status: (data.status ?? 'todo') as TaskItem['status'],
      why: data.why ?? '',
      createdBy: (data.createdBy ?? 'user') as TaskItem['createdBy'],
      createdAt: parseInt(data.createdAt ?? '0', 10),
      updatedAt: parseInt(data.updatedAt ?? '0', 10),
      userId: data.userId || undefined,
    };
    if (data.automationState) {
      try {
        return { ...base, automationState: JSON.parse(data.automationState) };
      } catch {
        return base;
      }
    }
    return base;
  }
}
