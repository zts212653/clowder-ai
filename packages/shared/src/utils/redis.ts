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
 * #1200: Atomic exact cursor replacement.
 * CAS on the expected value, preserving TTL. Callers decide whether the
 * replacement is a same-position format reconciliation or accepted evidence
 * repairing a fully pruned slot; this primitive performs no ordering claim.
 *
 * Sol R6 P1-1: Uses PTTL (milliseconds) + PX to preserve sub-second TTLs.
 * TTL (seconds) returns 0 for keys with <1s remaining, which would
 * incorrectly permanentize opt-in expiring cursors (Iron Law 5 violation).
 * PTTL returns -1 (persistent), -2 (missing), or positive ms remaining.
 */
const REPLACE_CURSOR_IF_EQUAL_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  local pttl = redis.call('PTTL', KEYS[1])
  if pttl > 0 then
    redis.call('SET', KEYS[1], ARGV[2], 'PX', pttl)
  else
    redis.call('SET', KEYS[1], ARGV[2])
  end
  return 1
end
return 0
`;

/**
 * Lua script: atomic compare-and-set for monotonic cursor advancement.
 * Compares in the visibility-seq domain (NOT raw message ID or lex order).
 *
 * KEYS[1] = cursor key
 * ARGV[1] = new cursor value (v1 raw ID or v2 token)
 * ARGV[2] = TTL seconds (0 = persistent)
 * ARGV[3] = key prefix for message hash lookup (e.g. 'cat-cafe:')
 *
 * Returns 1 if set, 0 if noop.
 *
 * #1200 §8.7 cursor TTL flip (Iron Law 5 compliance):
 * - ttl > 0 → SET with EX (expiring cursor)
 * - ttl = 0 → SET without EX + PERSIST-before-compare (persistent cursor).
 *
 * #1200 Sol R2 P2-4: Pair-domain comparison.
 * Raw ID or lex comparison conflates creation order with visibility order.
 * Late-delivered Q (created early, high visibilitySeq) must advance past
 * stored cursor of B (created later, lower visibilitySeq). Only (seq, id)
 * pair comparison is correct. Lua resolves v1 cursors via message hash
 * HGET visibilitySeq, then the visibility ZSET (#3444 root-1 fix: lazy
 * backfill leaves legacy hashes without visibilitySeq, so the ZSET is the
 * canonical fallback); v2 cursors carry seq in the token. A one-sided
 * unresolvable v1 after both lookups stays fail-closed. When both sides are
 * unresolvable pre-migration values, compatibility retains raw lex ordering;
 * that residual cannot prove visibility inversions.
 */
/**
 * Shared Lua fragment: resolve a cursor token to a (seq, id) pair in the
 * visibility domain. Single source of truth for every durable-slot CAS
 * (delivery / mention / seen via SET_IF_GREATER_LUA, read-state via
 * RedisThreadReadStateStore's ACK_CAS_LUA).
 *
 * Contract: every host passes key prefix in ARGV[3] and threadId in ARGV[4].
 * The fragment owns those locals so a future host cannot compile yet fail at
 * runtime merely because it forgot an implicit declaration.
 *
 * #3444 root-1 fix: v1 resolution order is message hash first (cheap),
 * then the visibility ZSET. Lazy backfill writes the ZSET WITHOUT
 * backfilling legacy message hashes, so hash-miss ≠ pruned — the ZSET is
 * the canonical visibility truth. Hidden queued messages are absent from
 * the ZSET by design, so the fallback can never resolve a not-yet-visible
 * message (negative invariant: hidden queued must not enter cursor slots).
 */
export const VISIBILITY_RESOLVE_SEQ_LUA = `
-- Resolve a cursor to (seq, id). Returns seq (number|nil), id (string).
local visibilityCursorKeyPrefix = ARGV[3] or ''
local visibilityCursorThreadId = ARGV[4] or ''
local function resolveSeq(cursor)
  if string.sub(cursor, 1, 3) == 'v2:' then
    local sep = string.find(cursor, ':', 4)
    if sep then
      return tonumber(string.sub(cursor, 4, sep - 1)), string.sub(cursor, sep + 1)
    end
    return nil, cursor
  end
  -- v1: look up visibilitySeq from message hash (cheap, post-migration shape)
  local seqRaw = redis.call('HGET', visibilityCursorKeyPrefix .. 'msg:' .. cursor, 'visibilitySeq')
  if seqRaw then
    local s = tonumber(seqRaw)
    if s then return s, cursor end
  end
  -- v1 fallback: visibility ZSET position (legacy message whose hash was
  -- never backfilled by the lazy migration — #3444 root 1)
  if visibilityCursorThreadId ~= '' then
    local score = redis.call(
      'ZSCORE',
      visibilityCursorKeyPrefix .. 'msg:visibility:' .. visibilityCursorThreadId,
      cursor
    )
    if score then
      local s = tonumber(score)
      if s then return s, cursor end
    end
  end
  return nil, cursor
end
`;

const SET_IF_GREATER_LUA = `
local ttl = tonumber(ARGV[2])
local cur = redis.call('GET', KEYS[1])
${VISIBILITY_RESOLVE_SEQ_LUA}

if cur then
  local curSeq, curId = resolveSeq(cur)
  local newSeq, newId = resolveSeq(ARGV[1])

  if curSeq and newSeq then
    -- Both resolved to (seq, id): pair-domain compare
    if newSeq < curSeq or (newSeq == curSeq and newId <= curId) then
      if ttl == 0 then redis.call('PERSIST', KEYS[1]) end
      return 0
    end
  elseif curSeq and not newSeq then
    -- Stored resolvable, incoming unresolvable: reject (can't prove advancement)
    if ttl == 0 then redis.call('PERSIST', KEYS[1]) end
    return 0
  elseif not curSeq and newSeq then
    -- Stored v1 unresolvable (message hash fully pruned), incoming v2 resolvable.
    -- FAIL-CLOSED: cannot determine stored position → cannot prove advancement.
    -- ID lex comparison is WRONG here: late-delivered Q has old ID but high seq,
    -- so ID order ≠ visibility order (#1200 core disease).
    -- App layer (DeliveryCursorStore) pre-reconciles stored v1→v2 via
    -- RECONCILE_CURSOR_FORMAT before reaching this branch. Fully-pruned is
    -- the residual case where no resolver can help → freeze until migration.
    if ttl == 0 then redis.call('PERSIST', KEYS[1]) end
    return 0
  else
    -- Both unresolvable: lex comparison fallback (best-effort for pruned v1-vs-v1)
    if ARGV[1] <= cur then
      if ttl == 0 then redis.call('PERSIST', KEYS[1]) end
      return 0
    end
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
  private readonly keyPrefix: string;
  constructor(private redis: RedisClient) {
    // Read ioredis keyPrefix for Lua scripts that need to construct keys manually
    this.keyPrefix = ((redis.options as Record<string, unknown>).keyPrefix as string) ?? '';
  }

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
    const result = (await this.redis.eval(
      SET_IF_GREATER_LUA,
      1,
      key,
      messageId,
      String(ttlSeconds),
      this.keyPrefix,
      threadId,
    )) as number;
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
    const result = (await this.redis.eval(
      SET_IF_GREATER_LUA,
      1,
      key,
      messageId,
      String(ttlSeconds),
      this.keyPrefix,
      threadId,
    )) as number;
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
    const result = (await this.redis.eval(
      SET_IF_GREATER_LUA,
      1,
      key,
      messageId,
      String(ttlSeconds),
      this.keyPrefix,
      threadId,
    )) as number;
    return result === 1;
  }

  /** Delete a seen cursor (F254) */
  async deleteSeenCursor(userId: string, catId: string, threadId: string): Promise<number> {
    return this.redis.del(SessionKeys.seenCursor(userId, catId, threadId));
  }

  // ---- Cursor Format Reconciliation (#1200 Sol R5) ----
  // Atomically upgrades stored v1 cursor to v2 format without advancing position.
  // Used by DeliveryCursorStore before CAS to ensure same-format comparison.

  async reconcileDeliveryCursorFormat(
    userId: string,
    catId: string,
    threadId: string,
    oldValue: string,
    newValue: string,
  ): Promise<boolean> {
    return this.replaceCursorIfEqual(SessionKeys.deliveryCursor(userId, catId, threadId), oldValue, newValue);
  }

  async reconcileMentionAckCursorFormat(
    userId: string,
    catId: string,
    threadId: string,
    oldValue: string,
    newValue: string,
  ): Promise<boolean> {
    return this.replaceCursorIfEqual(SessionKeys.mentionAck(userId, catId, threadId), oldValue, newValue);
  }

  async reconcileSeenCursorFormat(
    userId: string,
    catId: string,
    threadId: string,
    oldValue: string,
    newValue: string,
  ): Promise<boolean> {
    return this.replaceCursorIfEqual(SessionKeys.seenCursor(userId, catId, threadId), oldValue, newValue);
  }

  /**
   * Replace an exact stale delivery value with newly accepted canonical evidence.
   * Unlike the monotonic CAS, this operation makes no ordering claim about the
   * old value: the caller has already proved that the old cursor is unresolvable.
   */
  async replaceDeliveryCursorIfEqual(
    userId: string,
    catId: string,
    threadId: string,
    expectedValue: string,
    newValue: string,
  ): Promise<boolean> {
    return this.replaceCursorIfEqual(SessionKeys.deliveryCursor(userId, catId, threadId), expectedValue, newValue);
  }

  async replaceMentionAckCursorIfEqual(
    userId: string,
    catId: string,
    threadId: string,
    expectedValue: string,
    newValue: string,
  ): Promise<boolean> {
    return this.replaceCursorIfEqual(SessionKeys.mentionAck(userId, catId, threadId), expectedValue, newValue);
  }

  async replaceSeenCursorIfEqual(
    userId: string,
    catId: string,
    threadId: string,
    expectedValue: string,
    newValue: string,
  ): Promise<boolean> {
    return this.replaceCursorIfEqual(SessionKeys.seenCursor(userId, catId, threadId), expectedValue, newValue);
  }

  /** Atomic exact replacement. Preserves TTL and performs no comparison. */
  private async replaceCursorIfEqual(key: string, oldValue: string, newValue: string): Promise<boolean> {
    const result = (await this.redis.eval(REPLACE_CURSOR_IF_EQUAL_LUA, 1, key, oldValue, newValue)) as number;
    return result === 1;
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
