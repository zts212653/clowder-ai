import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask } from './RedisTaskCodec.js';

export const DEPLOYMENT_WAIT_INDEX = 'tasks:deployment-wait:projection';
const ADD_IF_CURRENT = `
if (redis.call('HGET', KEYS[1], 'deploymentWait') or '') ~= ARGV[2] then return 0 end
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`;
const REMOVE_IF_CURRENT = `
if (redis.call('HGET', KEYS[1], 'deploymentWait') or '') ~= ARGV[2]
  or (redis.call('HGET', KEYS[1], 'status') or '') ~= ARGV[3]
  or (redis.call('HGET', KEYS[1], 'kind') or '') ~= ARGV[4] then return 0 end
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`;

export function isDeploymentWaitProjectionCandidate(task: TaskItem): boolean {
  return (
    task.kind === 'work' &&
    task.status !== 'done' &&
    Boolean(
      task.deploymentWait?.await ||
        (task.deploymentWait?.waitOutcome?.reason === 'matched' &&
          task.deploymentWait.waitOutcome.delivery === 'pending'),
    )
  );
}

// Readiness belongs to this client lifetime, never to durable lifecycle truth.
// Rebuild after restart so an old-writer rollback cannot leave missing members.
const rebuilds = new WeakMap<RedisClient, Promise<void>>();
function ensureIndex(redis: RedisClient): Promise<void> {
  const existing = rebuilds.get(redis);
  if (existing) return existing;
  const pending = rebuildIndex(redis).catch((error: unknown) => {
    rebuilds.delete(redis);
    throw error;
  });
  rebuilds.set(redis, pending);
  return pending;
}

async function rebuildIndex(redis: RedisClient): Promise<void> {
  const ids = await redis.zrange(TaskKeys.kind('work'), 0, -1);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const reads = redis.pipeline();
    for (const id of batch) reads.hget(TaskKeys.detail(id), 'deploymentWait');
    const replies = await reads.exec();
    const writes = redis.pipeline();
    for (let index = 0; index < batch.length; index++) {
      const reply = replies?.[index];
      if (!reply || reply[0]) throw reply?.[0] ?? new Error('Incomplete deployment wait backfill');
      if (typeof reply[1] === 'string' && reply[1]) {
        const id = batch[index]!;
        writes.eval(ADD_IF_CURRENT, 2, TaskKeys.detail(id), DEPLOYMENT_WAIT_INDEX, id, reply[1]);
      }
    }
    const written = await writes.exec();
    if (!written) throw new Error('Incomplete deployment wait backfill');
    for (const reply of written) if (reply[0]) throw reply[0];
  }
}

/** Disposable projection membership. Typed wait installation publishes membership
 * atomically; stale removals compare canonical state so re-arming cannot be lost. */
export async function listDeploymentWaitProjectionCandidates(redis: RedisClient): Promise<TaskItem[]> {
  await ensureIndex(redis);
  const ids = await redis.smembers(DEPLOYMENT_WAIT_INDEX);
  const tasks: TaskItem[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const reads = redis.pipeline();
    for (const id of batch) reads.hgetall(TaskKeys.detail(id));
    const replies = await reads.exec();
    const cleanup = redis.pipeline();
    for (let index = 0; index < batch.length; index++) {
      const reply = replies?.[index];
      if (!reply || reply[0]) throw reply?.[0] ?? new Error('Incomplete deployment wait projection');
      const data = reply[1] as Record<string, string>;
      // Unknown/corrupt lifecycle truth must not become a cached absence.
      if (data.deploymentWait) JSON.parse(data.deploymentWait);
      const task = hydrateTask(data);
      if (data.id && isDeploymentWaitProjectionCandidate(task)) tasks.push(task);
      else
        cleanup.eval(
          REMOVE_IF_CURRENT,
          2,
          TaskKeys.detail(batch[index]!),
          DEPLOYMENT_WAIT_INDEX,
          batch[index]!,
          data.deploymentWait ?? '',
          data.status ?? '',
          data.kind ?? '',
        );
    }
    for (const reply of (await cleanup.exec()) ?? []) if (reply[0]) throw reply[0];
  }
  return tasks;
}
