import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertTypedWaitRegistrationInstallation,
  parseTypedWaitRegistration,
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
import { commitTaskTransaction, publishTaskRecovery } from './publish-task-recovery.js';
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
  if (input.waitRegistration)
    assertTypedWaitRegistrationInstallation(
      updated,
      input.waitRegistration,
      parseTypedWaitRegistration(data[TYPED_WAIT_REGISTRATION_FIELD]),
    );
  const fields = serializeTask(updated);
  const removed: string[] = [];
  if (input.waitRegistration) fields[TYPED_WAIT_REGISTRATION_FIELD] = JSON.stringify(input.waitRegistration);
  else if (deploymentWaitGeneration(existing.deploymentWait) !== deploymentWaitGeneration(updated.deploymentWait))
    removed.push(TYPED_WAIT_REGISTRATION_FIELD);
  const pipeline = session.multi();
  publishTaskRecovery(pipeline, key, fields, removed);
  return (await commitTaskTransaction(pipeline)) ? updated : undefined;
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
      const tx = session.multi();
      publishTaskRecovery(tx, key, serializeTask(updated));
      return (await commitTaskTransaction(tx)) ? updated : undefined;
    });
    if (result !== undefined) return result;
  }
  return null;
}
