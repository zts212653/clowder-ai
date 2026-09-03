import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { prepareEntrustedWorkUpdate } from '../ports/EntrustedWorkContractUpdate.js';
import type {
  CloseEntrustedWorkStoreInput,
  CloseEntrustedWorkStoreResult,
  UpdateEntrustedWorkStoreInput,
  UpdateEntrustedWorkStoreResult,
} from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';

const MAX_CONDITIONAL_TASK_UPDATE_RETRIES = 5;

const CLOSE_ENTRUSTED_WORK_LUA = `
-- F310_CLOSE_ENTRUSTED_WORK
local current = redis.call('HGET', KEYS[1], 'entrustedWork')
if not current then
  return -1
end
if current ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'status', 'done', 'entrustedWork', ARGV[2], 'updatedAt', ARGV[3])
return 1
`;

const UPDATE_ENTRUSTED_WORK_LUA = `
-- F310_UPDATE_ENTRUSTED_WORK
local current = redis.call('HGET', KEYS[1], 'entrustedWork')
if not current then
  return -1
end
if current ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'entrustedWork', ARGV[2], 'updatedAt', ARGV[3])
return 1
`;

/** Owns Redis CAS transitions for the entrusted Task aggregate. */
export class RedisTaskEntrustedWorkMutationStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly applyTtl: (task: TaskItem) => Promise<void>,
    private readonly waitForInFlightTaskWrite: () => Promise<void>,
  ) {}

  async close(taskId: string, input: CloseEntrustedWorkStoreInput): Promise<CloseEntrustedWorkStoreResult> {
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_TASK_UPDATE_RETRIES; attempt += 1) {
      const data = await this.redis.hgetall(key);
      if (!data || !data.id) return { kind: 'not_found' };
      const existing = hydrateTask(data);
      if (!existing.entrustedWork) return { kind: 'not_entrusted', task: existing };
      if (existing.entrustedWork.closure.state !== 'open') return { kind: 'already_closed', task: existing };
      if (existing.entrustedWork.revision !== input.expectedRevision) {
        return { kind: 'revision_conflict', task: existing };
      }

      const updated: TaskItem = {
        ...existing,
        status: 'done',
        entrustedWork: {
          ...existing.entrustedWork,
          revision: existing.entrustedWork.revision + 1,
          closure: input.closure,
        },
        updatedAt: Date.now(),
      };
      const serialized = serializeTask(updated);
      const result = await this.redis.eval(
        CLOSE_ENTRUSTED_WORK_LUA,
        1,
        key,
        data.entrustedWork,
        serialized.entrustedWork,
        serialized.updatedAt,
      );
      if (result === 1) {
        await this.applyTtl(updated);
        return { kind: 'closed', task: updated };
      }
      if (result === -1) return { kind: 'not_entrusted', task: existing };
      await this.waitForInFlightTaskWrite();
    }
    throw new Error(`RedisTaskStore closeEntrustedWork: CAS exhausted for ${taskId}`);
  }

  async update(taskId: string, input: UpdateEntrustedWorkStoreInput): Promise<UpdateEntrustedWorkStoreResult> {
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_TASK_UPDATE_RETRIES; attempt += 1) {
      const data = await this.redis.hgetall(key);
      if (!data || !data.id) return { kind: 'not_found' };
      const existing = hydrateTask(data);
      const prepared = prepareEntrustedWorkUpdate(existing, input);
      if (prepared.kind !== 'ready') return prepared;
      const updated: TaskItem = { ...existing, entrustedWork: prepared.entrustedWork, updatedAt: Date.now() };
      const serialized = serializeTask(updated);
      const result = await this.redis.eval(
        UPDATE_ENTRUSTED_WORK_LUA,
        1,
        key,
        data.entrustedWork,
        serialized.entrustedWork,
        serialized.updatedAt,
      );
      if (result === 1) {
        await this.applyTtl(updated);
        return { kind: 'updated', task: updated };
      }
      if (result === -1) return { kind: 'not_entrusted', task: existing };
      await this.waitForInFlightTaskWrite();
    }
    throw new Error(`RedisTaskStore updateEntrustedWork: CAS exhausted for ${taskId}`);
  }
}
