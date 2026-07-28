/**
 * Lua scripts for the #1200 visibility index.
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.2, §8.6
 *
 * Key convention: same as redis-message-delivery-lua-scripts.ts — keyPrefix
 * passed via ARGV for building keys inside Lua. ioredis auto-prefixes KEYS[].
 *
 * Scripts:
 *   APPEND_WITH_VISIBILITY_LUA — shape (a) atomic append (replaces MULTI pipeline)
 *   ALLOC_VISIBILITY_SEQ_FRAGMENT — inlinable allocator (used by DELIVER extension)
 *   DELIVER_WITH_VISIBILITY_LUA — DELIVER + visibilitySeq allocation
 *   CANCEL_WITH_VISIBILITY_LUA — CANCEL + visibility ZREM
 *   BACKFILL_VISIBILITY_LUA — one-shot rank-normalize backfill for legacy threads
 *   ENSURE_VISIBILITY_MIGRATED_LUA — read-side migration guard (§8.2 rev 6)
 */

/**
 * Maximum number of members the one-shot backfill will process.
 * Threads larger than this ABORT with a distinct error (fail-visible ops event).
 * See §8.2: single-Lua atomicity is non-negotiable.
 */
export const MAX_BACKFILL_MEMBERS = 50_000;

/**
 * APPEND_WITH_VISIBILITY: shape (a) atomic append — replaces MULTI pipeline.
 *
 * All data writes (hash, ZSETs) and visibility writes (visibilitySeq allocation,
 * visibility index ZADD, meta hwm update) execute in a single Lua linearization
 * point. This is the §8.6 shape (a) guarantee: no partial-write failure window
 * where a message exists in the thread ZSET but not the visibility index.
 *
 * Queued messages get NO visibilitySeq and NO visibility ZADD. Their visibility
 * allocation is deferred to DELIVER_WITH_VISIBILITY_LUA.
 *
 * KEYS[1] = hash key (auto-prefixed by ioredis)
 *
 * ARGV layout (1-indexed):
 *   [1]  keyPrefix
 *   [2]  msgId
 *   [3]  threadId
 *   [4]  score (timestamp string number)
 *   [5]  userId
 *   [6]  isQueued ('1' if deliveryStatus=queued, '' otherwise)
 *   [7]  ttlSeconds ('0' = no TTL)
 *   [8]  mentionCount (string number)
 *   [9 .. 8+N]  mention catIds (N = mentionCount)
 *   [9+N]  hashFieldPairCount (string number, M pairs = 2*M values)
 *   [10+N .. 10+N+2*M-1]  hash fields as key1, val1, key2, val2, ...
 *
 * Returns: allocated visibilitySeq (number), or 0 for queued messages.
 */
export const APPEND_WITH_VISIBILITY_LUA = `
local hash = KEYS[1]
local kp = ARGV[1]
local msgId = ARGV[2]
local threadId = ARGV[3]
local score = tonumber(ARGV[4])
local userId = ARGV[5]
local isQueued = ARGV[6] == '1'
local ttlSec = tonumber(ARGV[7])
local mentionCount = tonumber(ARGV[8])

-- Collect mention catIds
local mentions = {}
for i = 1, mentionCount do
  mentions[i] = ARGV[8 + i]
end

-- Collect hash field pairs (variable-length tail of ARGV)
local hfCountIdx = 9 + mentionCount
local hfPairCount = tonumber(ARGV[hfCountIdx])
local hfStart = hfCountIdx + 1
local hsetArgs = {}
for i = 0, hfPairCount * 2 - 1 do
  hsetArgs[i + 1] = ARGV[hfStart + i]
end

-- 1. Write message hash (all fields at once)
redis.call('HSET', hash, unpack(hsetArgs))

-- 2. ZADDs: timeline, user, thread
redis.call('ZADD', kp .. 'msg:timeline', score, msgId)
redis.call('ZADD', kp .. 'msg:user:' .. userId, score, msgId)
redis.call('ZADD', kp .. 'msg:thread:' .. threadId, score, msgId)

-- 3. Mention ZADDs
for i = 1, mentionCount do
  redis.call('ZADD', kp .. 'msg:mentions:' .. mentions[i], score, msgId)
end

-- 4. Visibility: non-queued messages get immediate visibilitySeq
--    seq = max(hwm+1, serverTimeMs) — uses Redis server TIME(), NOT the payload
--    timestamp. This prevents far-future timestamps from corrupting the hwm and
--    eating 96% of the safe-integer headroom. (#1200 P1-A fix)
local seq = 0
if not isQueued then
  local metaKey = kp .. 'msg:visibility-meta:' .. threadId
  local visKey = kp .. 'msg:visibility:' .. threadId

  local hwmRaw = redis.call('HGET', metaKey, 'hwm')
  local hwm = tonumber(hwmRaw) or 0

  local t = redis.call('TIME')
  local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  seq = math.max(hwm + 1, now_ms)

  -- Fail-closed: seq must be a safe integer (< 2^53 - 10000 headroom)
  if seq > 9007199254730991 then
    return redis.error_reply('VISIBILITY_SEQ_EXHAUSTED: seq=' .. tostring(seq))
  end

  redis.call('ZADD', visKey, seq, msgId)
  redis.call('HSET', metaKey, 'hwm', tostring(seq))
  redis.call('HSETNX', metaKey, 'migrated', '1')
  redis.call('HSET', hash, 'visibilitySeq', tostring(seq))
end

-- 5. TTL management (does NOT apply to visibility index or meta)
if ttlSec > 0 then
  -- EXPIRE on hash
  redis.call('EXPIRE', hash, ttlSec)

  -- Server time for TTL cutoff (visibility uses message timestamp, TTL uses server time)
  local timeArr = redis.call('TIME')
  local nowMs = tonumber(timeArr[1]) * 1000 + math.floor(tonumber(timeArr[2]) / 1000)
  local cutoff = nowMs - ttlSec * 1000
  redis.call('ZREMRANGEBYSCORE', kp .. 'msg:timeline', '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', kp .. 'msg:user:' .. userId, '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', kp .. 'msg:thread:' .. threadId, '-inf', cutoff)
  for i = 1, mentionCount do
    redis.call('ZREMRANGEBYSCORE', kp .. 'msg:mentions:' .. mentions[i], '-inf', cutoff)
  end

  -- EXPIRE on index zsets
  redis.call('EXPIRE', kp .. 'msg:timeline', ttlSec)
  redis.call('EXPIRE', kp .. 'msg:user:' .. userId, ttlSec)
  redis.call('EXPIRE', kp .. 'msg:thread:' .. threadId, ttlSec)
  for i = 1, mentionCount do
    redis.call('EXPIRE', kp .. 'msg:mentions:' .. mentions[i], ttlSec)
  end
end

return seq
`;

/**
 * ALLOC_VISIBILITY_SEQ: inlinable Lua fragment (NOT standalone).
 * Requires locals: kp, threadId, msgId. Allocates seq = max(hwm+1, serverTimeMs),
 * writes ZADD visibility + HSET meta hwm + HSET hash visibilitySeq.
 * Used only by DELIVER_WITH_VISIBILITY_LUA (inlined via template literal).
 * The append Lua has its own inline copy to avoid duplicate variable declarations.
 */
export const ALLOC_VISIBILITY_SEQ_FRAGMENT = `
-- ALLOC_VISIBILITY_SEQ: allocate seq for msgId in threadId
-- Requires: kp, threadId, msgId as local variables
local metaKey = kp .. 'msg:visibility-meta:' .. threadId
local visKey = kp .. 'msg:visibility:' .. threadId
local hashKey = kp .. 'msg:' .. msgId

local hwmRaw = redis.call('HGET', metaKey, 'hwm')
local hwm = tonumber(hwmRaw) or 0

-- Server time in ms (Redis TIME returns [seconds, microseconds])
local timeArr = redis.call('TIME')
local nowMs = tonumber(timeArr[1]) * 1000 + math.floor(tonumber(timeArr[2]) / 1000)

local seq = math.max(hwm + 1, nowMs)

-- Fail-closed: seq must be a safe integer (< 2^53 - 10000 headroom)
if seq > 9007199254730991 then
  return redis.error_reply('VISIBILITY_SEQ_EXHAUSTED: seq=' .. tostring(seq))
end

-- Atomic: ZADD + meta update + hash field
redis.call('ZADD', visKey, seq, msgId)
redis.call('HSET', metaKey, 'hwm', tostring(seq))
-- Set migrated if not already (first append to a new thread)
redis.call('HSETNX', metaKey, 'migrated', '1')
redis.call('HSET', hashKey, 'visibilitySeq', tostring(seq))
`;

/**
 * DELIVER_LUA extension: extends the existing DELIVER_LUA to allocate
 * visibilitySeq on delivery of a queued message.
 *
 * This is the FULL replacement DELIVER_LUA — not a fragment.
 * Uses deliveredAt (not server TIME()) as the time input so relative ordering
 * is correct even when operations execute within 1ms (parity with Memory mirror).
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 * ARGV[1] = message id
 * ARGV[2] = deliveredAt (string number)
 * ARGV[3] = keyPrefix
 *
 * Returns: 0 on CAS no-op, or HGETALL flat array on CAS win.
 */
export const DELIVER_WITH_VISIBILITY_LUA = `
local hash = KEYS[1]
local msgId = ARGV[1]
local deliveredAt = ARGV[2]
local kp = ARGV[3]

local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  return 0
end

local userId = redis.call('HGET', hash, 'userId')
local threadId = redis.call('HGET', hash, 'threadId')

-- Original delivery writes
redis.call('HSET', hash, 'deliveredAt', deliveredAt, 'deliveryStatus', 'delivered')
redis.call('ZADD', kp .. 'msg:thread:' .. threadId, tonumber(deliveredAt), msgId)
redis.call('ZADD', kp .. 'msg:timeline', tonumber(deliveredAt), msgId)
redis.call('ZADD', kp .. 'msg:user:' .. userId, tonumber(deliveredAt), msgId)

-- #1200: Allocate visibilitySeq using Redis server TIME(), NOT deliveredAt.
-- deliveredAt is server-controlled but using Redis TIME() keeps the allocator
-- immune to any upstream caller passing a wrong value. (#1200 P1-A fix)
local metaKey = kp .. 'msg:visibility-meta:' .. threadId
local visKey = kp .. 'msg:visibility:' .. threadId

local hwmRaw = redis.call('HGET', metaKey, 'hwm')
local hwm = tonumber(hwmRaw) or 0

local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local seq = math.max(hwm + 1, now_ms)

if seq > 9007199254730991 then
  return redis.error_reply('VISIBILITY_SEQ_EXHAUSTED: seq=' .. tostring(seq))
end

redis.call('ZADD', visKey, seq, msgId)
redis.call('HSET', metaKey, 'hwm', tostring(seq))
redis.call('HSETNX', metaKey, 'migrated', '1')
redis.call('HSET', hash, 'visibilitySeq', tostring(seq))

return redis.call('HGETALL', hash)
`;

/**
 * CANCEL_LUA extension: extends CANCEL_LUA to ZREM from visibility index
 * if the message was backfilled (legacy queued that got into the index via
 * rank-normalize backfill).
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 * ARGV[1] = keyPrefix
 *
 * Returns: 0 on CAS no-op, or HGETALL flat array on CAS win.
 */
export const CANCEL_WITH_VISIBILITY_LUA = `
local hash = KEYS[1]
local kp = ARGV[1]

local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  return 0
end

local threadId = redis.call('HGET', hash, 'threadId')
local msgId = redis.call('HGET', hash, 'id')

redis.call('HSET', hash, 'deliveryStatus', 'canceled')

-- #1200: Remove from visibility index if present (backfilled legacy queued)
if threadId and msgId then
  local visKey = kp .. 'msg:visibility:' .. threadId
  redis.call('ZREM', visKey, msgId)
end

return redis.call('HGETALL', hash)
`;

/**
 * BACKFILL_VISIBILITY: one-shot atomic rank-normalize backfill for a legacy thread.
 *
 * KEYS[1] = thread ZSET key (auto-prefixed by ioredis)
 * ARGV[1] = keyPrefix
 * ARGV[2] = threadId
 * ARGV[3] = max backfill members (string number)
 *
 * Guard: HGET meta migrated → set → no-op (returns 0).
 * If thread ZSET is empty → marks migrated, returns 0.
 * If member count > max → ABORTS (returns error).
 *
 * Process: ZRANGE 0 -1 (rank order preserves legacy (score, id) order,
 * with ±inf correctly at extremes) → ZADD visibility (BASE + i) member
 * → HSET meta migrated 1, hwm BASE+N-1.
 *
 * Returns: number of members backfilled, or 0 for no-op.
 */
export const BACKFILL_VISIBILITY_LUA = `
local threadKey = KEYS[1]
local kp = ARGV[1]
local threadId = ARGV[2]
local maxMembers = tonumber(ARGV[3])

local metaKey = kp .. 'msg:visibility-meta:' .. threadId
local visKey = kp .. 'msg:visibility:' .. threadId

-- Guard: already migrated → no-op
local migrated = redis.call('HGET', metaKey, 'migrated')
if migrated then
  return 0
end

-- Get all members in rank order (legacy (score, id) total order)
local members = redis.call('ZRANGE', threadKey, 0, -1)
local count = #members

-- Empty thread → mark migrated, no backfill needed
if count == 0 then
  redis.call('HSET', metaKey, 'migrated', '1', 'hwm', '0')
  return 0
end

-- Bound check: fail-visible if too large
if count > maxMembers then
  return redis.error_reply(
    'VISIBILITY_BACKFILL_TOO_LARGE: threadId=' .. threadId ..
    ' members=' .. tostring(count) ..
    ' max=' .. tostring(maxMembers)
  )
end

-- Rank-normalize: assign seq = BASE + rank_index
-- BASE = 1 (smallest positive integer, leaves 0 as sentinel)
local BASE = 1
for i = 1, count do
  redis.call('ZADD', visKey, BASE + i - 1, members[i])
end

-- Set meta atomically: migrated + hwm = last assigned seq
local hwm = BASE + count - 1
redis.call('HSET', metaKey, 'migrated', '1', 'hwm', tostring(hwm))

-- Log-friendly return: count of backfilled members
return count
`;

/**
 * ENSURE_VISIBILITY_MIGRATED: read-side migration guard (§8.2 rev 6).
 * Same body as BACKFILL — separate export for read-path call sites.
 * Cheap no-op when already migrated (single HGET). Triggers backfill when not.
 * Same KEYS/ARGV contract as BACKFILL_VISIBILITY_LUA.
 */
export const ENSURE_VISIBILITY_MIGRATED_LUA = BACKFILL_VISIBILITY_LUA;
