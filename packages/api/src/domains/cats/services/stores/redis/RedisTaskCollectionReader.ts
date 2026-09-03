import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask } from './RedisTaskCodec.js';

async function cleanupStaleTaskIndexes(redis: RedisClient, cleanupKey: string, staleIds: string[]): Promise<void> {
  if (staleIds.length === 0) return;
  const cleanup = redis.multi();
  for (const staleId of staleIds) {
    if (!staleId) continue;
    cleanup.zrem(cleanupKey, staleId);
    cleanup.del(TaskKeys.managedWorkBinding(staleId));
  }
  await cleanup.exec();
}

export async function fetchRedisTasksByIds(
  redis: RedisClient,
  ids: string[],
  options?: { cleanupKey?: string },
): Promise<TaskItem[]> {
  const pipeline = redis.multi();
  for (const id of ids) pipeline.hgetall(TaskKeys.detail(id));
  const results = await pipeline.exec();
  if (!results) return [];

  const tasks: TaskItem[] = [];
  const staleIds: string[] = [];
  for (const [index, [err, data]] of results.entries()) {
    if (err || !data || typeof data !== 'object') continue;
    const detail = data as Record<string, string>;
    if (!detail.id) {
      staleIds.push(ids[index] ?? '');
      continue;
    }
    tasks.push(hydrateTask(detail));
  }

  if (options?.cleanupKey) await cleanupStaleTaskIndexes(redis, options.cleanupKey, staleIds);

  return tasks;
}
