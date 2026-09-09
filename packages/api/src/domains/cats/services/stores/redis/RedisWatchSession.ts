import type { RedisClient } from '@cat-cafe/shared/utils';

export async function runWithExclusiveRedisWatchSession<T>(
  redis: RedisClient,
  key: string | readonly string[],
  operation: (session: RedisClient) => Promise<T>,
): Promise<T> {
  const session = redis.duplicate();
  let watched = false;
  try {
    await session.watch(...(Array.isArray(key) ? key : [key]));
    watched = true;
    return await operation(session);
  } finally {
    if (watched) {
      await session.unwatch().catch(() => undefined);
    }
    session.disconnect();
  }
}
