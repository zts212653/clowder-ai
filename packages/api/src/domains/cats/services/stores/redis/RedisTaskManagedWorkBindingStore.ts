import type { ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createManagedWorkBindingConflict } from '../ports/TaskManagedWorkBinding.js';
import { TaskKeys } from '../redis-keys/task-keys.js';

export type AnchorLifetimeApplyResult = 'applied' | 'missing' | 'stale';

/** Bind a complete private identity only while the live anchor is a PR tracking task. */
const BIND_MANAGED_WORK_LUA = `
-- F275_BIND_MANAGED_WORK
if redis.call('HGET', KEYS[1], 'kind') ~= 'pr_tracking' then
  redis.call('DEL', KEYS[2])
  return 0
end
local anchorTtl = redis.call('PTTL', KEYS[1])
if anchorTtl == 0 or anchorTtl == -2 then
  redis.call('DEL', KEYS[2])
  return 0
end
local existing = redis.call('GET', KEYS[2])
local result = 2
if not existing then
  redis.call('SET', KEYS[2], ARGV[1])
  result = 1
elseif existing ~= ARGV[1] then
  result = -1
end
if anchorTtl == -1 then
  redis.call('PERSIST', KEYS[2])
else
  redis.call('PEXPIRE', KEYS[2], anchorTtl)
end
return result
`;

/** Move the public anchor and its private binding between persistent/expiring lifetimes together. */
const APPLY_TASK_BINDING_TTL_LUA = `
-- F275_APPLY_TASK_BINDING_TTL
if redis.call('HGET', KEYS[1], 'id') == false then
  redis.call('DEL', KEYS[2])
  return 0
end
if redis.call('HGET', KEYS[1], 'updatedAt') ~= ARGV[3]
  or redis.call('HGET', KEYS[1], 'status') ~= ARGV[4] then
  return -1
end
if ARGV[1] == 'persist' then
  redis.call('PERSIST', KEYS[1])
  redis.call('PERSIST', KEYS[2])
else
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
return 1
`;

export class RedisTaskManagedWorkBindingStore {
  constructor(private readonly redis: RedisClient) {}

  async bind(taskId: string, binding: ManagedWorkBinding): Promise<ManagedWorkBinding | null> {
    const encoded = this.serialize(binding);
    const result = await this.redis.eval(
      BIND_MANAGED_WORK_LUA,
      2,
      TaskKeys.detail(taskId),
      TaskKeys.managedWorkBinding(taskId),
      encoded,
    );
    if (result === 0) return null;
    if (result === -1) throw createManagedWorkBindingConflict(taskId);
    if (result !== 1 && result !== 2) {
      throw new Error(`RedisTaskStore bindManagedWorkBinding: unexpected result for ${taskId}`);
    }
    return this.parse(encoded, taskId);
  }

  async get(taskId: string): Promise<ManagedWorkBinding | null> {
    const encoded = await this.redis.get(TaskKeys.managedWorkBinding(taskId));
    return encoded ? this.parse(encoded, taskId) : null;
  }

  async applyAnchorLifetime(
    taskId: string,
    mode: 'persist' | 'expire',
    ttlSeconds: number,
    expected: Pick<TaskItem, 'updatedAt' | 'status'>,
  ): Promise<AnchorLifetimeApplyResult> {
    const result = await this.redis.eval(
      APPLY_TASK_BINDING_TTL_LUA,
      2,
      TaskKeys.detail(taskId),
      TaskKeys.managedWorkBinding(taskId),
      mode,
      String(ttlSeconds),
      String(expected.updatedAt),
      expected.status,
    );
    if (result !== -1 && result !== 0 && result !== 1) {
      throw new Error(`RedisTaskStore applyAnchorLifetime: unexpected result for ${taskId}`);
    }
    if (result === 0) return 'missing';
    if (result === -1) return 'stale';
    return 'applied';
  }

  private serialize(binding: ManagedWorkBinding): string {
    if (!binding.workId || !binding.attemptId) {
      throw new Error('RedisTaskStore bindManagedWorkBinding: workId and attemptId are required');
    }
    return JSON.stringify({ workId: binding.workId, attemptId: binding.attemptId });
  }

  private parse(encoded: string, taskId: string): ManagedWorkBinding {
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('workId' in parsed) ||
        !('attemptId' in parsed) ||
        typeof parsed.workId !== 'string' ||
        parsed.workId.length === 0 ||
        typeof parsed.attemptId !== 'string' ||
        parsed.attemptId.length === 0
      ) {
        throw new Error('shape mismatch');
      }
      return Object.freeze({ workId: parsed.workId, attemptId: parsed.attemptId });
    } catch (cause) {
      throw new Error(`RedisTaskStore invalid private binding for ${taskId}`, { cause });
    }
  }
}
