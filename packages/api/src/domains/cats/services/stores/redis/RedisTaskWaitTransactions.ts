import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertTypedWaitRegistrationInstallation,
  TYPED_WAIT_REGISTRATION_FIELD,
} from '../../../../ball-custody/TypedWaitRegistration.js';
import {
  buildTaskDeploymentWaitReplacement,
  deploymentWaitGeneration,
  deploymentWaitReplacementMatches,
} from '../ports/TaskDeploymentWaitState.js';
import { replaceTaskPluginWait } from '../ports/TaskPluginWait.js';
import type { ReplaceDeploymentWaitIfGenerationInput, ReplacePluginWaitInput } from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { DEPLOYMENT_WAIT_INDEX } from './deployment-wait-index.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

const MAX_CONDITIONAL_TASK_UPDATE_RETRIES = 5;

export async function replaceDeploymentWaitInSession(
  session: RedisClient,
  key: string,
  input: ReplaceDeploymentWaitIfGenerationInput,
): Promise<TaskItem | null | undefined> {
  const data = await session.hgetall(key);
  if (!data?.id) return null;
  const existing = hydrateTask(data);
  if (!deploymentWaitReplacementMatches(existing, input)) return null;

  const updated = buildTaskDeploymentWaitReplacement(existing, input);
  if (input.waitRegistration) assertTypedWaitRegistrationInstallation(updated, input.waitRegistration);
  const pipeline = session.multi();
  pipeline.hset(key, serializeTask(updated));
  pipeline.sadd(DEPLOYMENT_WAIT_INDEX, updated.id);
  if (input.waitRegistration) {
    pipeline.hset(key, TYPED_WAIT_REGISTRATION_FIELD, JSON.stringify(input.waitRegistration));
  } else if (deploymentWaitGeneration(existing.deploymentWait) !== deploymentWaitGeneration(updated.deploymentWait)) {
    pipeline.hdel(key, TYPED_WAIT_REGISTRATION_FIELD);
  }
  return (await pipeline.exec()) ? updated : undefined;
}

export async function replacePluginWait(
  redis: RedisClient,
  taskId: string,
  input: ReplacePluginWaitInput,
): Promise<TaskItem | null> {
  const key = TaskKeys.detail(taskId);
  for (let attempt = 0; attempt < MAX_CONDITIONAL_TASK_UPDATE_RETRIES; attempt++) {
    const result = await runWithExclusiveRedisWatchSession<TaskItem | null | undefined>(redis, key, async (session) => {
      const raw = await session.hgetall(key);
      if (!raw.id) return null;
      const updated = replaceTaskPluginWait(hydrateTask(raw), input);
      if (!updated) return null;
      return (await session.multi().hset(key, serializeTask(updated)).exec()) ? updated : undefined;
    });
    if (result !== undefined) return result;
  }
  return null;
}
