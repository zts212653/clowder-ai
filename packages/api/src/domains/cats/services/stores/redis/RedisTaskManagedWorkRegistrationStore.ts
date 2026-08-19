import type { AutomationState, CreateTaskInput, ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { generateSortableId } from '../ports/MessageStore.js';
import { createManagedWorkBindingConflict } from '../ports/TaskManagedWorkBinding.js';
import { assertSubjectUpdateOwnership, createSubjectOwnershipConflict } from '../ports/TaskSubjectOwnership.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';

const MAX_MANAGED_PR_UPSERT_RETRIES = 5;

/**
 * Atomically validate subject ownership + bind-once identity before mutating the live PR anchor.
 * A conflict returns before HSET/ZADD/SET, so the losing registration has zero public/private effect.
 */
const ATOMIC_MANAGED_PR_UPSERT_LUA = `
-- F275_ATOMIC_MANAGED_PR_UPSERT
local expectedId = ARGV[1]
local targetId = ARGV[2]
local currentId = redis.call('GET', KEYS[1])
local isCreate = expectedId == ''

if isCreate then
  if currentId then return 0 end
  if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
else
  if currentId ~= expectedId then return 0 end
  if redis.call('HGET', KEYS[2], 'id') ~= expectedId then return 0 end
  if redis.call('HGET', KEYS[2], 'updatedAt') ~= ARGV[3] then return 0 end
  if redis.call('HGET', KEYS[2], 'kind') ~= 'pr_tracking' then return -3 end

  local ownerUserId = redis.call('HGET', KEYS[2], 'userId') or ''
  local ownerThreadId = redis.call('HGET', KEYS[2], 'threadId') or ''
  local requestedUserId = ARGV[4]
  local requestedThreadId = ARGV[5]
  local ownershipOk = false
  if ownerUserId ~= '' and requestedUserId ~= '' and ownerUserId == requestedUserId then
    ownershipOk = true
  elseif ownerUserId == '' and requestedUserId ~= '' and ownerThreadId == requestedThreadId then
    ownershipOk = true
  elseif ownerUserId == '' and requestedUserId == '' then
    ownershipOk = true
  end
  if not ownershipOk then return -2 end
end

local existingBinding = redis.call('GET', KEYS[5])
if existingBinding and existingBinding ~= ARGV[6] then return -1 end

if isCreate then redis.call('SET', KEYS[1], targetId) end
redis.call('HSET', KEYS[2], unpack(ARGV, 8, #ARGV))
if KEYS[6] ~= KEYS[3] then redis.call('ZREM', KEYS[6], targetId) end
redis.call('ZADD', KEYS[3], ARGV[7], targetId)
redis.call('ZADD', KEYS[4], ARGV[7], targetId)
if not existingBinding then redis.call('SET', KEYS[5], ARGV[6]) end
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[5])
if isCreate then return 1 end
return 2
`;

type ManagedPrUpsertCandidate = {
  subjectKey: string;
  subjectIndexKey: string;
  task: TaskItem;
  existing: TaskItem | null;
  expectedId: string;
  expectedUpdatedAt: string;
  oldThreadId: string;
  retry: number;
};

type RedisTaskManagedWorkRegistrationHost = {
  mergeAutomationState(
    existing: AutomationState | undefined,
    patch: Partial<AutomationState>,
  ): AutomationState | undefined;
  applyThreadTtl(threadId: string): Promise<void>;
  compareAndDeleteSubject(subjectKey: string, staleTaskId: string): Promise<void>;
  waitForInFlightTaskWrite(): Promise<void>;
};

/** Focused Redis aggregate for atomic managed PR registration. */
export class RedisTaskManagedWorkRegistrationStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly host: RedisTaskManagedWorkRegistrationHost,
  ) {}

  async upsert(input: CreateTaskInput, binding: ManagedWorkBinding): Promise<TaskItem> {
    if (!input.subjectKey || input.kind !== 'pr_tracking') {
      throw new Error('Managed-work registration requires a pr_tracking subject anchor');
    }
    if (!binding.workId || !binding.attemptId) {
      throw new Error('Managed-work registration requires complete workId and attemptId');
    }
    return this.upsertInternal(input, binding, 0);
  }

  private async upsertInternal(input: CreateTaskInput, binding: ManagedWorkBinding, retry: number): Promise<TaskItem> {
    const candidate = await this.loadCandidate(input, retry);
    const result = await this.commit(candidate, input, binding);
    if (result === 0) {
      if (candidate.retry >= MAX_MANAGED_PR_UPSERT_RETRIES) {
        throw new Error(`RedisTaskStore managed PR upsert kept racing for ${candidate.subjectKey}`);
      }
      await this.host.waitForInFlightTaskWrite();
      return this.upsertInternal(input, binding, candidate.retry + 1);
    }
    this.assertCommitResult(result, candidate, input);

    if (candidate.oldThreadId !== candidate.task.threadId) await this.host.applyThreadTtl(candidate.oldThreadId);
    await this.host.applyThreadTtl(candidate.task.threadId);
    return candidate.task;
  }

  private async loadCandidate(input: CreateTaskInput, retry: number): Promise<ManagedPrUpsertCandidate> {
    const subjectKey = input.subjectKey;
    if (!subjectKey) throw new Error('Managed-work registration requires a subject anchor');
    const subjectIndexKey = TaskKeys.subject(subjectKey);
    const currentId = await this.redis.get(subjectIndexKey);
    const now = Date.now();
    if (!currentId) {
      return {
        subjectKey,
        subjectIndexKey,
        task: this.buildNewTask(input, subjectKey, now),
        existing: null,
        expectedId: '',
        expectedUpdatedAt: '',
        oldThreadId: input.threadId,
        retry,
      };
    }

    const data = await this.redis.hgetall(TaskKeys.detail(currentId));
    if (!data?.id) {
      if (retry < MAX_MANAGED_PR_UPSERT_RETRIES) {
        await this.host.waitForInFlightTaskWrite();
        return this.loadCandidate(input, retry + 1);
      }
      await this.host.compareAndDeleteSubject(subjectKey, currentId);
      await this.redis.del(TaskKeys.managedWorkBinding(currentId));
      return this.loadCandidate(input, 0);
    }

    const existing = hydrateTask(data);
    assertSubjectUpdateOwnership(subjectKey, existing, input);
    if (existing.kind !== 'pr_tracking') {
      throw new Error('Managed-work PR tracking binding failed closed: live anchor unavailable');
    }
    return {
      subjectKey,
      subjectIndexKey,
      task: this.buildUpdatedTask(existing, input, now),
      existing,
      expectedId: existing.id,
      expectedUpdatedAt: String(existing.updatedAt),
      oldThreadId: existing.threadId,
      retry,
    };
  }

  private buildNewTask(input: CreateTaskInput, subjectKey: string, now: number): TaskItem {
    return {
      id: generateSortableId(now),
      kind: 'pr_tracking',
      threadId: input.threadId,
      subjectKey,
      title: input.title,
      ownerCatId: input.ownerCatId ?? null,
      status: 'todo',
      why: input.why,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      automationState: input.automationState,
      userId: input.userId,
      probe: input.probe,
      resolveMode: input.resolveMode,
    };
  }

  private buildUpdatedTask(existing: TaskItem, input: CreateTaskInput, now: number): TaskItem {
    return {
      ...existing,
      threadId: input.threadId,
      title: input.title,
      ownerCatId: input.ownerCatId ?? existing.ownerCatId,
      status: existing.status === 'done' ? 'todo' : existing.status,
      why: input.why,
      userId: input.userId ?? existing.userId,
      probe: input.probe !== undefined ? input.probe : existing.probe,
      resolveMode: input.resolveMode !== undefined ? input.resolveMode : existing.resolveMode,
      automationState: input.automationState
        ? this.host.mergeAutomationState(existing.automationState, input.automationState)
        : existing.automationState,
      updatedAt: now,
    };
  }

  private async commit(
    candidate: ManagedPrUpsertCandidate,
    input: CreateTaskInput,
    binding: ManagedWorkBinding,
  ): Promise<unknown> {
    const { task } = candidate;
    const flatFields = Object.entries(serializeTask(task)).flat();
    const encodedBinding = JSON.stringify({ workId: binding.workId, attemptId: binding.attemptId });
    return this.redis.eval(
      ATOMIC_MANAGED_PR_UPSERT_LUA,
      6,
      candidate.subjectIndexKey,
      TaskKeys.detail(task.id),
      TaskKeys.thread(task.threadId),
      TaskKeys.kind(task.kind),
      TaskKeys.managedWorkBinding(task.id),
      TaskKeys.thread(candidate.oldThreadId),
      candidate.expectedId,
      task.id,
      candidate.expectedUpdatedAt,
      input.userId ?? '',
      input.threadId,
      encodedBinding,
      String(task.createdAt),
      ...flatFields,
    );
  }

  private assertCommitResult(
    result: unknown,
    candidate: ManagedPrUpsertCandidate,
    input: CreateTaskInput,
  ): asserts result is 1 | 2 {
    if (result === -1) throw createManagedWorkBindingConflict(candidate.task.id);
    if (result === -2) {
      throw createSubjectOwnershipConflict(
        candidate.subjectKey,
        candidate.existing?.userId ?? `thread:${candidate.existing?.threadId ?? candidate.oldThreadId}`,
        input.userId ?? `thread:${input.threadId}`,
      );
    }
    if (result === -3) throw new Error('Managed-work PR tracking binding failed closed: live anchor unavailable');
    if (result !== 1 && result !== 2) {
      throw new Error(`RedisTaskStore managed PR upsert returned unexpected result for ${candidate.subjectKey}`);
    }
  }
}
