import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { TaskPageCursorExpiredError } from '../ports/TaskStoreContract.js';
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
  options?: { cleanupKey?: string; strict?: boolean },
): Promise<TaskItem[]> {
  const pipeline = redis.multi();
  for (const id of ids) pipeline.hgetall(TaskKeys.detail(id));
  const results = await pipeline.exec();
  if (!results) {
    if (options?.strict) throw new Error('Task page hydration unavailable');
    return [];
  }
  if (options?.strict && results.length !== ids.length) throw new Error('Task page hydration incomplete');

  const tasks: TaskItem[] = [];
  const staleIds: string[] = [];
  for (const [index, [err, data]] of results.entries()) {
    if (err || !data || typeof data !== 'object') {
      if (options?.strict) throw new Error('Task page hydration failed');
      continue;
    }
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

export async function readRedisTaskThreadPage(
  redis: RedisClient,
  threadId: string,
  limit: number,
  afterId?: string,
): Promise<{ tasks: TaskItem[]; scannedCount: number; nextCursor?: string }> {
  const key = TaskKeys.thread(threadId);
  const rank = afterId ? await redis.zrank(key, afterId) : -1;
  if (rank === null) throw new TaskPageCursorExpiredError('Works task cursor expired');
  const ids = await redis.zrange(key, rank + 1, rank + Math.min(64, Math.max(1, limit)) + 1);
  const page = ids.slice(0, limit);
  const tasks = page.length ? await fetchRedisTasksByIds(redis, page, { strict: true }) : [];
  return { tasks, scannedCount: page.length, ...(ids.length > page.length ? { nextCursor: page.at(-1) } : {}) };
}
