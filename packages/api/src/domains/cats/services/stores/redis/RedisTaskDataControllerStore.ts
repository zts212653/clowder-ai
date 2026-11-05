import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type EntrustedTaskDataControllerTransition,
  type EntrustedTaskDataControllerTransitionResult,
  transitionEntrustedTaskDataController,
} from '../ports/TaskDataControllerTransition.js';
import type { TaskMutationWriteFence } from '../ports/TaskStoreContract.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask, serializeTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

const MAX_RETRIES = 8;

/** Co-locates the controller binding and every receipt in the canonical Task hash CAS. */
export class RedisTaskDataControllerStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly applyTtl: (task: TaskItem) => Promise<void>,
    private readonly waitForInFlightTaskWrite: () => Promise<void>,
  ) {}

  async transition(
    input: EntrustedTaskDataControllerTransition,
    writeFence?: TaskMutationWriteFence,
  ): Promise<EntrustedTaskDataControllerTransitionResult> {
    const key = TaskKeys.detail(input.taskId);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const result = await runWithExclusiveRedisWatchSession<EntrustedTaskDataControllerTransitionResult | undefined>(
        this.redis,
        key,
        async (session) => {
          const data = await session.hgetall(key);
          const prepared = transitionEntrustedTaskDataController(data?.id ? hydrateTask(data) : null, input);
          if (prepared.kind !== 'bound' && prepared.kind !== 'revoked') return prepared;
          const pipeline = session.multi();
          pipeline.hset(key, serializeTask(prepared.task));
          // Controller receipts are permanent owner state. Clear a pre-existing
          // ordinary Task TTL in the same transaction as the binding/receipt CAS.
          pipeline.persist(key);
          await writeFence?.assertCurrent();
          return (await pipeline.exec()) ? prepared : undefined;
        },
      );
      if (result !== undefined) {
        if (result.kind === 'bound' || result.kind === 'revoked') await this.applyTtl(result.task);
        return result;
      }
      await this.waitForInFlightTaskWrite();
    }
    throw new Error(`Redis Task data-controller CAS exhausted for ${input.taskId}`);
  }
}
