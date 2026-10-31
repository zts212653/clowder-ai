import type { CreateTaskInput, TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { prepareEntrustedTaskCreate } from '../ports/TaskEntrustedAdmission.js';
import { createGenericTaskItem } from '../ports/TaskItemFactory.js';
import type { AdmitEntrustedWorkStoreInput, AdmitEntrustedWorkStoreResult } from '../ports/TaskStoreContract.js';
import {
  createEntrustedWorkTerminalActionRequiredError,
  createTaskSubjectSnapshotConflictError,
  type TaskSubjectUpsertCondition,
} from '../ports/TaskStoreContract.js';
import { assertTaskSubjectSnapshot, buildSubjectTaskUpdate } from '../ports/TaskSubjectUpsert.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

/** The caller authorized this aggregate; never retry a different aggregate inside the store. */
export async function upsertTaskWithSubjectSnapshot(
  redis: RedisClient,
  input: CreateTaskInput,
  condition: TaskSubjectUpsertCondition,
): Promise<TaskItem> {
  const subjectKey = input.subjectKey;
  if (!subjectKey) throw new Error('Conditional subject upsert requires a subject key');
  const key = TaskKeys.subject(subjectKey);
  return runWithExclusiveRedisWatchSession(redis, key, async (session) => {
    const existingId = await session.get(key);
    if (existingId !== (condition.expected?.id ?? null)) throw createTaskSubjectSnapshotConflictError(subjectKey);
    let existing: TaskItem | null = null;
    if (existingId) {
      await session.watch(TaskKeys.detail(existingId));
      const data = await session.hgetall(TaskKeys.detail(existingId));
      existing = data.id ? hydrateTask(data) : null;
    }
    assertTaskSubjectSnapshot(subjectKey, existing, condition);
    const updated = existing ? buildSubjectTaskUpdate(subjectKey, existing, input) : createGenericTaskItem(input);
    const detail = TaskKeys.detail(updated.id);
    if (!existing) {
      await session.watch(detail);
      if (await session.exists(detail)) throw createTaskSubjectSnapshotConflictError(subjectKey);
    }
    const tx = session.multi();
    if (!existing) tx.set(key, updated.id);
    tx.hset(detail, serializeTask(updated));
    tx.zadd(TaskKeys.thread(updated.threadId), updated.createdAt, updated.id);
    tx.zadd(TaskKeys.kind(updated.kind), updated.createdAt, updated.id);
    if (existing && existing.threadId !== updated.threadId) {
      tx.zrem(TaskKeys.thread(existing.threadId), existing.id);
    }
    const committed = await tx.exec();
    if (!committed) throw createTaskSubjectSnapshotConflictError(subjectKey);
    for (const [error] of committed) if (error) throw error;
    return updated;
  });
}

export type AtomicSubjectCreateResult = 'created' | 'subject_exists' | 'task_id_exists';

const ATOMIC_OWNED_WRITE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if redis.call('HEXISTS', KEYS[2], 'entrustedWork') == 1 then return -1 end
if redis.call('HGET', KEYS[2], 'updatedAt') ~= ARGV[3] then return -2 end
if (redis.call('HGET', KEYS[2], 'deploymentWait') or '') ~= ARGV[4] then return -2 end
if (redis.call('HGET', KEYS[2], 'pluginWait') or '') ~= ARGV[5] then return -2 end
redis.call('HSET', KEYS[2], unpack(ARGV, 6, #ARGV))
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
return 1
`;

const ATOMIC_CREATE_WITH_SUBJECT_LUA = `
-- F310_ATOMIC_CREATE_WITH_SUBJECT
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -1
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], unpack(ARGV, 3, #ARGV))
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
return 1
`;

function subjectTransactionArguments(task: TaskItem): [string, string, string, string, string, string, ...string[]] {
  const subjectKey = task.subjectKey;
  if (!subjectKey) throw new Error('Atomic Task subject transaction requires a subject key');
  return [
    TaskKeys.subject(subjectKey),
    TaskKeys.detail(task.id),
    TaskKeys.thread(task.threadId),
    TaskKeys.kind(task.kind),
    task.id,
    String(task.createdAt),
    ...Object.entries(serializeTask(task)).flat(),
  ];
}

export async function tryCreateTaskWithAtomicSubject(
  redis: RedisClient,
  task: TaskItem,
): Promise<AtomicSubjectCreateResult> {
  const result = await redis.eval(ATOMIC_CREATE_WITH_SUBJECT_LUA, 4, ...subjectTransactionArguments(task));
  if (result === 1) return 'created';
  return result === -1 ? 'task_id_exists' : 'subject_exists';
}

export async function writeTaskForSubjectOwner(
  redis: RedisClient,
  existing: TaskItem,
  task: TaskItem,
): Promise<'written' | 'subject_mismatch' | 'stale'> {
  const args = subjectTransactionArguments(task);
  const expectedDeploymentWait = serializeTask(existing).deploymentWait ?? '';
  const result = await redis.eval(
    ATOMIC_OWNED_WRITE_LUA,
    4,
    ...args.slice(0, 6),
    String(existing.updatedAt),
    expectedDeploymentWait,
    serializeTask(existing).pluginWait ?? '',
    ...args.slice(6),
  );
  if (result === -1) throw createEntrustedWorkTerminalActionRequiredError(task.id);
  if (result === 1) return 'written';
  return result === -2 ? 'stale' : 'subject_mismatch';
}

/** Subject and complete Task snapshot stay watched until create/update commits. */
export async function createEntrustedTaskWithPolicy(
  redis: RedisClient,
  input: AdmitEntrustedWorkStoreInput,
): Promise<AdmitEntrustedWorkStoreResult> {
  const subject = TaskKeys.subject(input.subjectKey);
  return runWithExclusiveRedisWatchSession(redis, subject, async (session) => {
    const existingId = await session.get(subject);
    let existing: TaskItem | null = null;
    if (existingId) {
      await session.watch(TaskKeys.detail(existingId));
      const raw = await session.hgetall(TaskKeys.detail(existingId));
      existing = raw.id ? hydrateTask(raw) : null;
      if (!existing) throw createTaskSubjectSnapshotConflictError(input.subjectKey);
    }
    const result = prepareEntrustedTaskCreate(existing, input);
    const detail = TaskKeys.detail(result.task.id);
    if (!existing) {
      await session.watch(detail);
      if (await session.exists(detail)) throw createTaskSubjectSnapshotConflictError(input.subjectKey);
    }
    const tx = session.multi();
    if (!existing) tx.set(subject, result.task.id);
    tx.hset(detail, serializeTask(result.task));
    tx.zadd(TaskKeys.thread(result.task.threadId), result.task.createdAt, result.task.id);
    tx.zadd(TaskKeys.kind(result.task.kind), result.task.createdAt, result.task.id);
    const committed = await tx.exec();
    if (!committed) throw createTaskSubjectSnapshotConflictError(input.subjectKey);
    for (const [error] of committed) if (error) throw error;
    return result;
  });
}
