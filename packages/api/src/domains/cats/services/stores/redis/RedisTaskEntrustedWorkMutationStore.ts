import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { developmentScopeKey } from '../ports/DevelopmentWorkTransition.js';
import {
  type AttachEntrustedWorkArtifactInput,
  captureEntrustedWorkArtifactInput,
  prepareEntrustedWorkArtifactEvidence,
} from '../ports/EntrustedWorkArtifactEvidence.js';
import { prepareEntrustedWorkUpdate } from '../ports/EntrustedWorkContractUpdate.js';
import { advanceEntrustedWorkRevision } from '../ports/EntrustedWorkRevision.js';
import { reconcileDeploymentWaitTaskMutation } from '../ports/TaskDeploymentWaitState.js';
import type {
  CloseEntrustedWorkStoreInput,
  CloseEntrustedWorkStoreResult,
  UpdateEntrustedWorkStoreInput,
  UpdateEntrustedWorkStoreResult,
} from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';

const MAX_CONDITIONAL_TASK_UPDATE_RETRIES = 5;

const ATTACH_ARTIFACT_EVIDENCE_LUA = `
-- TASK_ATTACH_ARTIFACT_EVIDENCE: compare the entire observed Task hash, not just refs.
local fields = cjson.decode(ARGV[1])
local count = 0
for field, value in pairs(fields) do
  count = count + 1
  if redis.call('HGET', KEYS[1], field) ~= value then return 0 end
end
if redis.call('HLEN', KEYS[1]) ~= count then return 0 end
redis.call('HSET', KEYS[1], 'entrustedWork', ARGV[2], 'updatedAt', ARGV[3])
return 1
`;

const CLOSE_ENTRUSTED_WORK_LUA = `
-- F310_CLOSE_ENTRUSTED_WORK
if ARGV[7] ~= '' and redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[7] then return 0 end
local current = redis.call('HGET', KEYS[1], 'entrustedWork')
if not current then
  return -1
end
if current ~= ARGV[1] then
  return 0
end
if (redis.call('HGET', KEYS[1], 'deploymentWait') or '') ~= ARGV[5] then
  return 0
end
redis.call('HSET', KEYS[1], 'status', 'done', 'entrustedWork', ARGV[2], 'updatedAt', ARGV[3])
if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'deploymentWait', ARGV[6]) end
if #KEYS > 1 and redis.call('GET', KEYS[2]) == ARGV[4] then redis.call('DEL', KEYS[2]) end
return 1
`;

const UPDATE_ENTRUSTED_WORK_LUA = `
-- F310_UPDATE_ENTRUSTED_WORK
if ARGV[5] ~= '' and redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[5] then return 0 end
local current = redis.call('HGET', KEYS[1], 'entrustedWork')
if not current then
  return -1
end
if current ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'entrustedWork', ARGV[2], 'updatedAt', ARGV[3], 'status', ARGV[4])
return 1
`;

/** Owns Redis CAS transitions for the entrusted Task aggregate. */
export class RedisTaskEntrustedWorkMutationStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly applyTtl: (task: TaskItem) => Promise<void>,
    private readonly waitForInFlightTaskWrite: () => Promise<void>,
  ) {}

  async attachArtifact(taskId: string, raw: AttachEntrustedWorkArtifactInput) {
    const input = captureEntrustedWorkArtifactInput(raw);
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_TASK_UPDATE_RETRIES; attempt++) {
      const data = await this.redis.hgetall(key);
      if (!data?.id) return { kind: 'not_found' as const };
      const prepared = prepareEntrustedWorkArtifactEvidence(hydrateTask(data), input);
      if (prepared.kind !== 'attached') return prepared;
      const serialized = serializeTask(prepared.task);
      const changed = await this.redis.eval(
        ATTACH_ARTIFACT_EVIDENCE_LUA,
        1,
        key,
        JSON.stringify(data),
        serialized.entrustedWork,
        serialized.updatedAt,
      );
      if (changed === 1) {
        await this.applyTtl(prepared.task);
        return prepared;
      }
      await this.waitForInFlightTaskWrite();
    }
    throw new Error(`RedisTaskStore attach artifact: CAS exhausted for ${taskId}`);
  }

  async close(taskId: string, input: CloseEntrustedWorkStoreInput): Promise<CloseEntrustedWorkStoreResult> {
    const key = TaskKeys.detail(taskId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_TASK_UPDATE_RETRIES; attempt += 1) {
      const data = await this.redis.hgetall(key);
      if (!data || !data.id) return { kind: 'not_found' };
      const existing = hydrateTask(data);
      if (input.expectedThreadId !== undefined && existing.threadId !== input.expectedThreadId)
        return { kind: 'thread_conflict', task: existing };
      if (!existing.entrustedWork) return { kind: 'not_entrusted', task: existing };
      if (existing.entrustedWork.closure.state !== 'open') return { kind: 'already_closed', task: existing };
      if (existing.entrustedWork.revision !== input.expectedRevision) {
        return { kind: 'revision_conflict', task: existing };
      }

      const { completion: _previousCompletion, ...openWork } = existing.entrustedWork;
      const updated: TaskItem = reconcileDeploymentWaitTaskMutation(existing, {
        ...existing,
        status: 'done',
        entrustedWork: {
          ...openWork,
          ...advanceEntrustedWorkRevision(existing.entrustedWork),
          closure: input.closure,
          ...(input.closure.state === 'satisfied'
            ? {
                completion: {
                  recordedAt: Date.now(),
                  ...(input.artifactSnapshot ? { artifactSnapshot: input.artifactSnapshot } : {}),
                },
              }
            : {}),
        },
        updatedAt: Date.now(),
      });
      const serialized = serializeTask(updated);
      const result = await this.redis.eval(
        CLOSE_ENTRUSTED_WORK_LUA,
        existing.entrustedWork.developmentScope && existing.userId ? 2 : 1,
        key,
        ...(existing.entrustedWork.developmentScope && existing.userId
          ? [TaskKeys.developmentScope(developmentScopeKey(existing.userId, existing.entrustedWork.developmentScope))]
          : []),
        data.entrustedWork,
        serialized.entrustedWork,
        serialized.updatedAt,
        existing.id,
        data.deploymentWait ?? '',
        serialized.deploymentWait ?? '',
        input.expectedThreadId ?? '',
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
      const updated: TaskItem = {
        ...existing,
        status: prepared.status,
        entrustedWork: prepared.entrustedWork,
        updatedAt: Date.now(),
      };
      const serialized = serializeTask(updated);
      const result = await this.redis.eval(
        UPDATE_ENTRUSTED_WORK_LUA,
        1,
        key,
        data.entrustedWork,
        serialized.entrustedWork,
        serialized.updatedAt,
        serialized.status,
        input.expectedThreadId ?? '',
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
