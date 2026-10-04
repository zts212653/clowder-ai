import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createEntrustedWorkTerminalActionRequiredError } from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { serializeTask } from './RedisTaskCodec.js';

export type AtomicSubjectCreateResult = 'created' | 'subject_exists' | 'task_id_exists';

const ATOMIC_OWNED_WRITE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if redis.call('HEXISTS', KEYS[2], 'entrustedWork') == 1 then return -1 end
if redis.call('HGET', KEYS[2], 'updatedAt') ~= ARGV[3] then return -2 end
if (redis.call('HGET', KEYS[2], 'deploymentWait') or '') ~= ARGV[4] then return -2 end
redis.call('HSET', KEYS[2], unpack(ARGV, 5, #ARGV))
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
    ...args.slice(6),
  );
  if (result === -1) throw createEntrustedWorkTerminalActionRequiredError(task.id);
  if (result === 1) return 'written';
  return result === -2 ? 'stale' : 'subject_mismatch';
}
