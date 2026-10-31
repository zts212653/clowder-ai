/** Redis owner-token mutex for plugin message element appends. */

import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { AppendLease, AppendLock } from './ports.js';
import { MessagingKeys } from './redis-keys.js';

const LOCK_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 0
`;

export class RedisAppendLock implements AppendLock {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async acquire(messageId: string, ttlMs: number): Promise<AppendLease | null> {
    const token = randomUUID();
    const result = await this.redis.set(MessagingKeys.appendLock(messageId), token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { messageId, token } : null;
  }

  async release(messageId: string, lease: AppendLease): Promise<void> {
    if (lease.messageId !== messageId) return;
    await this.redis.eval(LOCK_RELEASE_LUA, 1, MessagingKeys.appendLock(messageId), lease.token);
  }
}
