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
  /** F254: Per-cat seen cursor — tracks what the cat actually READ mid-turn (independent from delivery cursor) */
  seenCursor: (userId: string, catId: string, threadId: string) => `seen-cursor:${userId}:${catId}:${threadId}`,
  catState: (catId: string) => `state:${catId}`,
  taskQueue: (catId: string) => `tasks:${catId}`,
  messageChannel: () => 'chat:messages',
} as const;

/**
 * Lua script: atomic compare-and-set for monotonic cursor advancement.
 * SET key to value only if value > current.
 * KEYS[1] = cursor key, ARGV[1] = new value, ARGV[2] = TTL seconds (0 = persistent).
 * Returns 1 if set, 0 if noop.
 *
 * #1200 §8.7 cursor TTL flip (Iron Law 5 compliance):
 * - ttl > 0 → SET with EX (expiring cursor)
 * - ttl = 0 → SET without EX + PERSIST-before-compare (persistent cursor).
 *   PERSIST-before-compare: on noop path, PERSIST the existing key to heal
 *   any accidental TTL left by a prior ttl>0 write (cutover migration).
 *   On advance path, SET without EX is already persistent.
 *
 * #1200 P2-4: Cross-format v1↔v2 comparison.
 * Pure lex comparison is correct within same format but WRONG across formats:
 *   'v' (0x76) > any digit → ALL v2 tokens lex-exceed ALL v1 raw IDs.
 *   stored v1("msgB-later") + incoming v2("v2:...:msgA-earlier") → false advance.
 * Fix: detect format mismatch, extract messageId from v2, compare raw IDs.
 * Raw sortable IDs (generateSortableId) are timestamp-prefixed → lex ≡ time order.
 *   - Same format → lex compare (correct)
 *   - stored v2 + incoming v1 → always reject (v2→v1 regression never valid)
 *   - stored v1 + incoming v2 → extract v2 messageId, compare vs stored v1
 */
const SET_IF_GREATER_LUA = `
local ttl = tonumber(ARGV[2])
local cur = redis.call('GET', KEYS[1])
if cur then
  local curIsV2 = (string.sub(cur, 1, 3) == 'v2:')
  local newIsV2 = (string.sub(ARGV[1], 1, 3) == 'v2:')

  if curIsV2 == newIsV2 then
    -- Same format: lex compare is correct (v2 lex = seq order; v1 lex = sortable-ID time)
    if ARGV[1] <= cur then
      if ttl == 0 then redis.call('PERSIST', KEYS[1]) end
      return 0
    end
  elseif curIsV2 then
    -- stored v2, incoming v1: v2->v1 regression is never valid
    if ttl == 0 then redis.call('PERSIST', KEYS[1]) end
    return 0
  else
    -- stored v1, incoming v2: extract messageId from v2 token for raw ID comparison.
    -- v2 format: "v2:<seq16>:<messageId>" — find second ':' after pos 4
    local sep = string.find(ARGV[1], ':', 4)
    if sep then
      local newId = string.sub(ARGV[1], sep + 1)
      if #newId > 0 and newId <= cur then
        -- v2 cursor's underlying message was created at-or-before stored v1 cursor
        if ttl == 0 then redis.call('PERSIST', KEYS[1]) end
        return 0
      end
    end
    -- newId > cur OR malformed: advance (upgrade to v2 format)
  end
end

if ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[1])
end
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
   *
   * #1200 Iron Law 5: default persistent (ttl=0). Pass ttl>0 only for
   * explicitly TTL-enabled threads.
   */
  async setDeliveryCursor(
    userId: string,
    catId: string,
    threadId: string,
    messageId: string,
    ttlSeconds = 0, // #1200: persistent by default (Iron Law 5)
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
   *
   * #1200 Iron Law 5: default persistent (ttl=0).
   */
  async setMentionAckCursor(
    userId: string,
    catId: string,
    threadId: string,
    messageId: string,
    ttlSeconds = 0, // #1200: persistent by default (Iron Law 5)
  ): Promise<boolean> {
    const key = SessionKeys.mentionAck(userId, catId, threadId);
    const result = (await this.redis.eval(SET_IF_GREATER_LUA, 1, key, messageId, String(ttlSeconds))) as number;
    return result === 1;
  }

  /** Delete a mention ack cursor (#77) */
  async deleteMentionAckCursor(userId: string, catId: string, threadId: string): Promise<number> {
    return this.redis.del(SessionKeys.mentionAck(userId, catId, threadId));
  }

  // ---- F254 Seen Cursor ----
  // Independent namespace from delivery cursor. Tracks what the cat actually
  // READ mid-turn (via list_recent/get_thread_context/get_message).
  // MUST NOT affect delivery cursor or incremental injection (AC-A9).

  /** Get the last seen message ID for a cat in a thread (F254) */
  async getSeenCursor(userId: string, catId: string, threadId: string): Promise<string | null> {
    return this.redis.get(SessionKeys.seenCursor(userId, catId, threadId));
  }

  /**
   * Atomically set seen cursor only if messageId > current value (F254).
   * Uses same Lua CAS script as delivery/mention cursors.
   * Returns true if cursor was advanced, false if noop.
   *
   * #1200 Iron Law 5: default persistent (ttl=0).
   */
  async setSeenCursor(
    userId: string,
    catId: string,
    threadId: string,
    messageId: string,
    ttlSeconds = 0, // #1200: persistent by default (Iron Law 5)
  ): Promise<boolean> {
    const key = SessionKeys.seenCursor(userId, catId, threadId);
    const result = (await this.redis.eval(SET_IF_GREATER_LUA, 1, key, messageId, String(ttlSeconds))) as number;
    return result === 1;
  }

  /** Delete a seen cursor (F254) */
  async deleteSeenCursor(userId: string, catId: string, threadId: string): Promise<number> {
    return this.redis.del(SessionKeys.seenCursor(userId, catId, threadId));
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
