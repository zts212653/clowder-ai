/**
 * F167 #1449 Slice 2: Redis-backed shared hold quota authority.
 *
 * Primary implementation — shared across all API nodes via a single Redis
 * instance. Admission is atomic: a Lua script serializes check+insert within
 * Redis's single-threaded Lua executor (no WATCH/OCC needed).
 *
 * Data model: Redis Sorted Set per (threadId, catId) pair.
 *   Key:    hold-quota:{threadId}:{catId}
 *   Score:  held_at timestamp (ms)
 *   Member: eventId (crypto.randomUUID — unique reservation identifier)
 *
 * Pair fence is structural: the key includes both threadId and catId,
 * so ZREM on a wrong key cannot delete another pair's reservation.
 *
 * Scope: shared across all API nodes using the same Redis namespace.
 * Process replacement or restart does not reset quota — the authority lives
 * in Redis, not in the API process.
 */

import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { AdmissionResult, IHoldQuotaStore } from './hold-quota-store.js';

/**
 * Lua script: atomic admission check-and-insert with authority clock.
 *
 * KEYS[1] = hold-quota:{threadId}:{catId}
 * ARGV[1] = maxHolds (number)
 * ARGV[2] = windowMs (number)
 * ARGV[3] = now override ('0' = Redis TIME as authority clock, positive ms = caller-provided)
 * ARGV[4] = eventId (pre-generated UUID)
 *
 * Returns: [admitted (0|1), count, retryAtMs (0 if admitted), eventId ('' if rejected), retryAfterMs (0 if admitted)]
 *
 * Clock source: When ARGV[3]='0', uses `redis.call('TIME')` as the single
 * authority clock — all API nodes share the same time reference, preventing
 * clock-skew-induced window divergence across nodes.
 * Non-zero ARGV[3] enables deterministic time control in tests.
 *
 * TTL: Sets PEXPIRE = windowMs × 2 on the key after every operation, preventing
 * unbounded growth from inactive (threadId, catId) pairs.
 *
 * Atomicity: Redis executes Lua scripts in a single-threaded context.
 * Two concurrent tryAdmit() calls are serialized — no TOCTOU race.
 */
const TRY_ADMIT_LUA = `
local maxHolds = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local nowArg = ARGV[3]
local eventId = ARGV[4]

-- Authority clock: '0' = Redis TIME (production), positive ms = caller-provided (tests)
local now
if nowArg == '0' then
  local time = redis.call('TIME')
  now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
else
  now = tonumber(nowArg)
end

local cutoff = now - windowMs

-- Prune expired entries (score <= cutoff, i.e. held_at <= now - windowMs)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

-- Count current entries within window (all remaining after prune)
local count = redis.call('ZCARD', KEYS[1])

if count >= maxHolds then
  -- Rejected: compute retryAtMs from the (count - maxHolds)th oldest entry
  local offset = count - maxHolds
  local entries = redis.call('ZRANGE', KEYS[1], offset, offset, 'WITHSCORES')
  local retryAtMs = now
  if #entries >= 2 then
    retryAtMs = tonumber(entries[2]) + windowMs
  end
  -- TTL: prevent unbounded key growth from inactive pairs
  if count > 0 then
    redis.call('PEXPIRE', KEYS[1], windowMs * 2)
  end
  -- retryAfterMs from same authority clock — route must NOT recompute with Date.now()
  local retryAfterMs = math.max(0, retryAtMs - now)
  return {0, count, retryAtMs, '', retryAfterMs}
end

-- Admitted: add new entry with score=now, member=eventId
redis.call('ZADD', KEYS[1], now, eventId)
-- TTL: aligned with window to prevent unbounded key growth from inactive pairs
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
return {1, count + 1, 0, eventId, 0}
`;

/**
 * Lua script: window-aware count using authority clock.
 *
 * KEYS[1] = hold-quota:{threadId}:{catId}
 * ARGV[1] = windowMs (number)
 * ARGV[2] = now override ('0' = Redis TIME, positive ms = caller-provided)
 *
 * Returns: count of entries within the sliding window
 */
const GET_COUNT_LUA = `
local windowMs = tonumber(ARGV[1])
local nowArg = ARGV[2]

local now
if nowArg == '0' then
  local time = redis.call('TIME')
  now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
else
  now = tonumber(nowArg)
end

local cutoff = now - windowMs
return redis.call('ZCOUNT', KEYS[1], '(' .. tostring(cutoff), '+inf')
`;

function quotaKey(threadId: string, catId: string): string {
  return `hold-quota:${threadId}:${catId}`;
}

export class RedisHoldQuotaStore implements IHoldQuotaStore {
  constructor(private readonly redis: RedisClient) {}

  async tryAdmit(
    threadId: string,
    catId: string,
    maxHolds: number,
    windowMs: number,
    now?: number,
  ): Promise<AdmissionResult> {
    const eventId = randomUUID();
    const key = quotaKey(threadId, catId);

    // '0' tells Lua to use redis.call('TIME') as authority clock (production).
    // Non-zero enables deterministic time control in tests.
    const result = (await this.redis.eval(
      TRY_ADMIT_LUA,
      1,
      key,
      String(maxHolds),
      String(windowMs),
      now !== undefined ? String(now) : '0',
      eventId,
    )) as [number, number, number, string | Buffer | null, number];

    const admitted = Number(result[0]) === 1;
    const count = Number(result[1]);

    if (!admitted) {
      const retryAtMs = Number(result[2]);
      const retryAfterMs = Number(result[4]);
      return { admitted: false, count, retryAtMs, retryAfterMs };
    }

    const returnedEventId = typeof result[3] === 'string' ? result[3] : String(result[3]);
    return { admitted: true, count, eventId: returnedEventId };
  }

  async releaseByEventId(eventId: string, threadId: string, catId: string): Promise<boolean> {
    // Pair fence is structural: the key includes threadId + catId.
    // ZREM on the wrong key (different thread/cat) cannot delete another pair's entry.
    const key = quotaKey(threadId, catId);
    const removed = await this.redis.zrem(key, eventId);
    return removed > 0;
  }

  async getCount(threadId: string, catId: string, windowMs: number, now?: number): Promise<number> {
    const key = quotaKey(threadId, catId);
    // Authority clock: omit `now` → Lua uses Redis TIME; pass explicit ms for tests.
    const result = await this.redis.eval(
      GET_COUNT_LUA,
      1,
      key,
      String(windowMs),
      now !== undefined ? String(now) : '0',
    );
    return Number(result);
  }

  async close(): Promise<void> {
    // Redis client lifecycle is managed by the caller (index.ts), not by the store.
  }
}
