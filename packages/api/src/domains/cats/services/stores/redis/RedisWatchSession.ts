import type { RedisClient } from '@cat-cafe/shared/utils';
import { recoveryRedis } from '../../../../../infrastructure/recovery/recovery-redis.js';

export async function runWithExclusiveRedisWatchSession<T>(
  redis: RedisClient,
  key: string,
  operation: (session: RedisClient) => Promise<T>,
): Promise<T> {
  const session = recoveryRedis(redis).duplicate();
  let watched = false;
  try {
    await session.watch(key);
    watched = true;
    return await operation(session);
  } finally {
    if (watched) {
      await session.unwatch().catch(() => undefined);
    }
    session.disconnect();
  }
}
