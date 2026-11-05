import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  mutateOrdinaryTask,
  type OrdinaryTaskMutation,
  type OrdinaryTaskMutationResult,
} from '../ports/OrdinaryTaskMutation.js';
import type { TaskMutationWriteFence } from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

/** Uses the same Task hash/WATCH boundary as all other Task aggregate mutations. */
export async function mutateOrdinaryRedisTask(
  redis: RedisClient,
  command: OrdinaryTaskMutation,
  writeFence?: TaskMutationWriteFence,
): Promise<OrdinaryTaskMutationResult> {
  const key = TaskKeys.detail(command.taskId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await runWithExclusiveRedisWatchSession<OrdinaryTaskMutationResult | undefined>(
      redis,
      key,
      async (session) => {
        if (writeFence?.watchKeys?.length) await session.watch(...writeFence.watchKeys);
        const raw = await session.hgetall(key);
        const before = raw.id ? hydrateTask(raw) : null;
        const decision = mutateOrdinaryTask(before, command, Date.now());
        if (decision.kind !== 'updated') return decision;
        // Repeated on every WATCH attempt. A retired callback/source cannot use a stale authorization.
        await writeFence?.assertCurrent();
        const transaction = session.multi();
        transaction.hset(key, serializeTask(decision.task));
        const committed = await transaction.exec();
        return committed ? decision : undefined;
      },
    );
    if (result) return result;
  }
  throw new Error(`Ordinary Task ${command.taskId} conditional write exhausted`);
}
