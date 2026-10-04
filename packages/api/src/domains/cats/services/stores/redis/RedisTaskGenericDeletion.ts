import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { assertEntrustedWorkGenericDeletionAllowed } from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

async function readGenericTasks(session: RedisClient, ids: readonly string[]): Promise<TaskItem[]> {
  const tasks: TaskItem[] = [];
  for (const id of ids) {
    await session.watch(TaskKeys.detail(id));
    const raw = await session.hgetall(TaskKeys.detail(id));
    if (!raw.id) continue;
    const task = hydrateTask(raw);
    assertEntrustedWorkGenericDeletionAllowed(task);
    tasks.push(task);
  }
  return tasks;
}

async function ownedSubjectKeys(session: RedisClient, tasks: readonly TaskItem[]): Promise<string[]> {
  const ownedSubjects: string[] = [];
  for (const task of tasks) {
    if (!task.subjectKey) continue;
    const key = TaskKeys.subject(task.subjectKey);
    await session.watch(key);
    if ((await session.get(key)) === task.id) ownedSubjects.push(key);
  }
  return ownedSubjects;
}

async function deleteInSession(
  session: RedisClient,
  target: { taskId: string } | { threadId: string },
  watchKey: string,
): Promise<number | null> {
  const ids = 'taskId' in target ? [target.taskId] : await session.zrange(watchKey, 0, -1);
  const tasks = await readGenericTasks(session, ids);
  const ownedSubjects = await ownedSubjectKeys(session, tasks);
  const tx = session.multi();
  for (const id of ids) {
    tx.del(TaskKeys.detail(id));
    tx.del(TaskKeys.managedWorkBinding(id));
  }
  for (const task of tasks) {
    tx.zrem(TaskKeys.kind(task.kind), task.id);
    tx.zrem(TaskKeys.thread(task.threadId), task.id);
  }
  for (const key of ownedSubjects) tx.del(key);
  if ('threadId' in target) tx.del(watchKey);
  return (await tx.exec()) ? ('threadId' in target ? ids.length : tasks.length) : null;
}

/** Generic deletion must not race a typed adoption after reading its old snapshot. */
export async function deleteGenericTasks(
  redis: RedisClient,
  target: { taskId: string } | { threadId: string },
): Promise<number> {
  const watchKey = 'taskId' in target ? TaskKeys.detail(target.taskId) : TaskKeys.thread(target.threadId);
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await runWithExclusiveRedisWatchSession(redis, watchKey, async (session) => {
      return deleteInSession(session, target, watchKey);
    });
    if (result !== null) return result;
  }
  throw new Error('Task deletion contention; retry from current owner facts');
}
