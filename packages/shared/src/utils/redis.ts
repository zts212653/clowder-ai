/**
 * Redis 连接和 Session 存储
 * 用于管理三只猫猫的 Session 状态
 */

import { Redis } from 'ioredis';

export type RedisClient = Redis;

export interface RedisConfig {
  url: string;
  keyPrefix?: string;
}

export function getDefaultRedisConfig(): RedisConfig {
  return {
    url: process.env['REDIS_URL'] ?? 'redis://localhost:6399',
    keyPrefix: process.env['REDIS_KEY_PREFIX'] ?? 'cat-cafe:',
  };
}

export function createRedisClient(config?: Partial<RedisConfig>): RedisClient {
  const finalConfig = { ...getDefaultRedisConfig(), ...config };
  const keyPrefix = finalConfig.keyPrefix ?? 'cat-cafe:';

  const client = new Redis(finalConfig.url, {
    keyPrefix,
    retryStrategy: (times: number) => {
      if (times > 3) {
        console.error('[Redis] Max retry attempts reached');
        return null;
      }
      return Math.min(times * 200, 2000);
    },
    maxRetriesPerRequest: 3,
  });

  client.on('connect', () => console.log('[Redis] Connected'));
  client.on('error', (err: Error) => console.error('[Redis] Error:', err.message));
  client.on('close', () => console.log('[Redis] Connection closed'));

  return client;
}

export const SessionKeys = {
  /** Session key now includes threadId for isolation (茶话会夺魂 bug fix #38) */
  session: (userId: string, catId: string, threadId: string) => `sessions:${userId}:${catId}:${threadId}`,
  /** Per-cat delivery cursor for exact incremental context transport */
  deliveryCursor: (userId: string, catId: string, threadId: string) => `delivery-cursor:${userId}:${catId}:${threadId}`,
  /** Per-cat mention ack cursor — tracks last acknowledged @mention (#77) */
  mentionAck: (userId: string, catId: string, threadId: string) => `mention-ack:${userId}:${catId}:${threadId}`,
  catState: (catId: string) => `state:${catId}`,
  taskQueue: (catId: string) => `tasks:${catId}`,
  messageChannel: () => 'chat:messages',
} as const;

/**
 * Lua script: atomic compare-and-set for monotonic cursor advancement.
 * SET key to value only if value > current (lexicographic). Sets TTL on success.
 * KEYS[1] = cursor key, ARGV[1] = new value, ARGV[2] = TTL seconds.
 * Returns 1 if set, 0 if noop.
 */
const SET_IF_GREATER_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur and ARGV[1] <= cur then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return 1
`;

export class SessionStore {
  constructor(private redis: RedisClient) {}

  async getSessionId(userId: string, catId: string, threadId: string): Promise<string | null> {
    return this.redis.get(SessionKeys.session(userId, catId, threadId));
  }

  async setSessionId(
    userId: string,
    catId: string,
    threadId: string,
    sessionId: string,
    ttlSeconds = 86400,
  ): Promise<void> {
    await this.redis.set(SessionKeys.session(userId, catId, threadId), sessionId, 'EX', ttlSeconds);
  }

  async deleteSession(userId: string, catId: string, threadId: string): Promise<void> {
    await this.redis.del(SessionKeys.session(userId, catId, threadId));
  }

  async getDeliveryCursor(userId: string, catId: string, threadId: string): Promise<string | null> {
    return this.redis.get(SessionKeys.deliveryCursor(userId, catId, threadId));
  }

  /**
   * Atomically set delivery cursor only if messageId > current value.
   * Uses Lua script for atomic compare-and-set to prevent concurrent regression.
   * Returns true if cursor was advanced, false if noop.
   */
  async setDeliveryCursor(
    userId: string,
    catId: string,
    threadId: string,
    messageId: string,
    ttlSeconds = 604800, // 7 days (#40)
  ): Promise<boolean> {
    const key = SessionKeys.deliveryCursor(userId, catId, threadId);
    const result = (await this.redis.eval(SET_IF_GREATER_LUA, 1, key, messageId, String(ttlSeconds))) as number;
    return result === 1;
  }

  async deleteDeliveryCursor(userId: string, catId: string, threadId: string): Promise<number> {
    return this.redis.del(SessionKeys.deliveryCursor(userId, catId, threadId));
  }

  /** Get the last acknowledged mention message ID for a cat in a thread (#77) */
  async getMentionAckCursor(userId: string, catId: string, threadId: string): Promise<string | null> {
    return this.redis.get(SessionKeys.mentionAck(userId, catId, threadId));
  }

  /**
   * Atomically set mention ack cursor only if messageId > current value.
   * Uses Lua script for atomic compare-and-set to prevent concurrent regression.
   * Returns true if cursor was advanced, false if noop (already at or past messageId).
   */
  async setMentionAckCursor(
    userId: string,
    catId: string,
    threadId: string,
    messageId: string,
    ttlSeconds = 604800, // 7 days, same as delivery cursor
  ): Promise<boolean> {
    const key = SessionKeys.mentionAck(userId, catId, threadId);
    const result = (await this.redis.eval(SET_IF_GREATER_LUA, 1, key, messageId, String(ttlSeconds))) as number;
    return result === 1;
  }

  /** Delete a mention ack cursor (#77) */
  async deleteMentionAckCursor(userId: string, catId: string, threadId: string): Promise<number> {
    return this.redis.del(SessionKeys.mentionAck(userId, catId, threadId));
  }

  async getCatState(catId: string): Promise<Record<string, unknown> | null> {
    const state = await this.redis.get(SessionKeys.catState(catId));
    if (!state) {
      return null;
    }
    try {
      return JSON.parse(state) as Record<string, unknown>;
    } catch (err) {
      console.error(`[SessionStore] Invalid JSON for key ${SessionKeys.catState(catId)}:`, err);
      return null;
    }
  }

  async setCatState(catId: string, state: Record<string, unknown>): Promise<void> {
    await this.redis.set(SessionKeys.catState(catId), JSON.stringify(state));
  }
}
