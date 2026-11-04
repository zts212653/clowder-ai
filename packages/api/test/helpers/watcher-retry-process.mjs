import { parseWatcherSessionState } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisSessionChainStore } from '../../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { reserveWatcherRecovery } from '../../dist/domains/concierge/watcher/watcher-retry.js';
import { assertRedisIsolationOrThrow } from './redis-test-helpers.js';

assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F335 retry process reconstruction');
const [namespace, sessionId, at] = process.argv.slice(2);
const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
try {
  const sessions = new RedisSessionChainStore(redis);
  const session = await sessions.get(sessionId);
  const state = parseWatcherSessionState(session.watcherState);
  const admitted = await reserveWatcherRecovery({ sessions }, session, state, Number(at));
  process.stdout.write(
    `WATCHER_RETRY_PROCESS:${JSON.stringify({ admitted, attempts: state.attempt.recoveryAttempts })}\n`,
  );
} finally {
  await redis.quit();
}
