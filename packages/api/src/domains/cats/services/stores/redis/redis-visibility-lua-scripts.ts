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
 * All data writes (hash, ZSETs), visibility writes (visibilitySeq allocation,
 * visibility index ZADD, meta hwm update), and #1210 idempotency (claim/reclaim)
 * execute in a single Lua linearization point. This is the §8.6 shape (a)
 * guarantee: no partial-write failure window where a message exists in the
 * thread ZSET but not the visibility index, and no idempotency race.
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
 *   [8]  idemKeyRaw (idempotency key suffix, '' if none — #1210)
 *   [9]  mentionCount (string number)
 *   [10 .. 9+N]  mention catIds (N = mentionCount)
 *   [10+N]  hashFieldPairCount (string number, M pairs = 2*M values)
 *   [11+N .. 11+N+2*M-1]  hash fields as key1, val1, key2, val2, ...
 *
 * Returns:
 *   - string (existing msgId) → idempotency replay, concurrent winner
 *   - number (visibilitySeq) → new message, allocated seq (0 for queued)
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
local idemKeyRaw = ARGV[8]
local mentionCount = tonumber(ARGV[9])

-- Collect mention catIds
local mentions = {}
for i = 1, mentionCount do
  mentions[i] = ARGV[9 + i]
end

-- Collect hash field pairs (variable-length tail of ARGV)
local hfCountIdx = 10 + mentionCount
local hfPairCount = tonumber(ARGV[hfCountIdx])
local hfStart = hfCountIdx + 1
local hsetArgs = {}
for i = 0, hfPairCount * 2 - 1 do
  hsetArgs[i + 1] = ARGV[hfStart + i]
end

-- #1210 idempotency: if key points to a live hash, replay (return winner ID).
-- If key exists but hash vanished, fall through to reclaim atomically.
local idemKey = (idemKeyRaw ~= '' and idemKeyRaw ~= nil) and (kp .. idemKeyRaw) or nil
if idemKey then
  local existingId = redis.call('GET', idemKey)
  if existingId then
    if redis.call('EXISTS', kp .. 'msg:' .. existingId) == 1 then
      return existingId
    end
  end
end

-- 1. Pre-mutation guard: compute visibilitySeq and check exhaustion BEFORE
--    any writes. Redis Lua error_reply does NOT rollback prior mutations, so
--    all fail-closed checks must precede the first write. (#1200 P1-2 fix)
local seq = 0
local metaKey = kp .. 'msg:visibility-meta:' .. threadId
local visKey = kp .. 'msg:visibility:' .. threadId
if not isQueued then
  local hwmRaw = redis.call('HGET', metaKey, 'hwm')
  local hwm
  if hwmRaw == false then
    hwm = 0  -- field genuinely missing (fresh thread)
  else
    hwm = tonumber(hwmRaw)
    -- #1200 Sol R1+R2: fail-closed for ALL non-integer states, not just NaN.
    -- tonumber('garbage')→nil, tonumber('nan')→nan, tonumber('1.5')→1.5
    if hwm == nil then
      return redis.error_reply('VISIBILITY_HWM_UNPARSEABLE: raw=' .. tostring(hwmRaw) .. ' metaKey=' .. metaKey)
    end
    if hwm ~= hwm then
      return redis.error_reply('VISIBILITY_HWM_NAN: metaKey=' .. metaKey)
    end
    if hwm ~= math.floor(hwm) or hwm < 0 then
      return redis.error_reply('VISIBILITY_HWM_INVALID: hwm=' .. tostring(hwm) .. ' metaKey=' .. metaKey)
    end
  end

  local t = redis.call('TIME')
  local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  seq = math.max(hwm + 1, now_ms)

  if seq > 9007199254730991 then
    return redis.error_reply('VISIBILITY_SEQ_EXHAUSTED: seq=' .. tostring(seq))
  end
end

-- 2. Write message hash (all fields at once)
redis.call('HSET', hash, unpack(hsetArgs))

-- 3. ZADDs: timeline, user, thread
redis.call('ZADD', kp .. 'msg:timeline', score, msgId)
redis.call('ZADD', kp .. 'msg:user:' .. userId, score, msgId)
redis.call('ZADD', kp .. 'msg:thread:' .. threadId, score, msgId)

-- 4. Mention ZADDs
for i = 1, mentionCount do
  redis.call('ZADD', kp .. 'msg:mentions:' .. mentions[i], score, msgId)
end

-- 5. Visibility: write pre-validated seq (exhaustion already checked above)
if not isQueued then
  redis.call('ZADD', visKey, seq, msgId)
  redis.call('HSET', metaKey, 'hwm', tostring(seq))
  redis.call('HSETNX', metaKey, 'migrated', '1')
  redis.call('HSET', hash, 'visibilitySeq', tostring(seq))
end

-- 6. Idempotency claim (#1210): unconditional SET reclaims stale keys
--    and claims fresh ones. At this point idemKey either doesn't exist or
--    points to a missing hash, so SET is safe.
if idemKey then
  redis.call('SET', idemKey, msgId)
  if ttlSec > 0 then
    redis.call('EXPIRE', idemKey, ttlSec)
  end
end

-- 7. TTL management (does NOT apply to visibility index or meta)
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
 * DELIVER_LUA extension: allocates visibilitySeq on delivery of a queued message.
 *
 * This is the FULL replacement DELIVER_LUA — not a fragment. Integrates:
 *   - CAS guard (queued → delivered only)
 *   - F254 custody guard (non-terminal custody → no-op)
 *   - Publication-order preservation (real-cat speech / user receipts keep authored timestamp)
 *   - Visibility position guard: already-positioned messages (timeline-published at append)
 *     preserve their immutable canonical position — only allocate when no position exists
 *   - Uses Redis TIME() (not deliveredAt) for visibility hwm (#1200 P1-A fix)
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

-- CAS guard: only queued → delivered transition
local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  return 0
end


-- Pre-CAS fan-out admission is durable pending execution and must never be
-- converted into delivered-only visibility by legacy orphan recovery.
local admission = redis.call('HGET', hash, 'queueCustodyAdmission')
if admission and admission ~= '' then
  return 0
end

-- F254: custody guard — non-terminal custody blocks legacy markDelivered
local custody = redis.call('HGET', hash, 'queueCustody')
if custody and custody ~= '' then
  local custodyProjection = cjson.decode(custody)
  if custodyProjection.status ~= 'terminal' then
    return 0
  end
end

local userId = redis.call('HGET', hash, 'userId')
local threadId = redis.call('HGET', hash, 'threadId')
local timestamp = redis.call('HGET', hash, 'timestamp')
local catId = redis.call('HGET', hash, 'catId')
local origin = redis.call('HGET', hash, 'origin')
local source = redis.call('HGET', hash, 'source')

-- Publication order: already-published real-cat speech and owner-visible
-- queued user receipts keep their authored timestamp; private queued work
-- enters the timeline at delivery. (Ported from original DELIVER_LUA.)
local isRealCatSpeech = catId and catId ~= '' and catId ~= 'system'
  and userId ~= 'system' and userId ~= 'scheduler' and origin ~= 'briefing'
local isQueuedUserReceipt = (not catId or catId == '') and (not source or source == '')
  and userId ~= 'system' and userId ~= 'scheduler' and origin ~= 'briefing'
  and custody and custody ~= ''
local timelineScore = deliveredAt
if isRealCatSpeech or isQueuedUserReceipt then
  timelineScore = timestamp
end

-- #1269: Check if already positioned (timeline-published at append has visibilitySeq).
-- If so, preserve the immutable canonical position — only update delivery fields.
local existingVis = redis.call('HGET', hash, 'visibilitySeq')
if existingVis ~= false then
  redis.call('HSET', hash, 'deliveredAt', deliveredAt, 'timelineOrderAt', timelineScore, 'deliveryStatus', 'delivered')
  return redis.call('HGETALL', hash)
end

-- Not yet positioned: full visibility allocation (legacy/hidden queued work)
local metaKey = kp .. 'msg:visibility-meta:' .. threadId
local visKey = kp .. 'msg:visibility:' .. threadId

-- Pre-mutation guard: compute visibilitySeq and check exhaustion BEFORE
-- any writes. Redis Lua error_reply does NOT rollback prior mutations.
-- (#1200 P1-2 fix)
local hwmRaw = redis.call('HGET', metaKey, 'hwm')
local hwm
if hwmRaw == false then
  hwm = 0  -- field genuinely missing (fresh thread)
else
  hwm = tonumber(hwmRaw)
  if hwm == nil then
    return redis.error_reply('VISIBILITY_HWM_UNPARSEABLE: raw=' .. tostring(hwmRaw) .. ' metaKey=' .. metaKey)
  end
  if hwm ~= hwm then
    return redis.error_reply('VISIBILITY_HWM_NAN: metaKey=' .. metaKey)
  end
  if hwm ~= math.floor(hwm) or hwm < 0 then
    return redis.error_reply('VISIBILITY_HWM_INVALID: hwm=' .. tostring(hwm) .. ' metaKey=' .. metaKey)
  end
end

local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local seq = math.max(hwm + 1, now_ms)

if seq > 9007199254730991 then
  return redis.error_reply('VISIBILITY_SEQ_EXHAUSTED: seq=' .. tostring(seq))
end

-- All guards passed — write delivery + timeline + visibility atomically
redis.call('HSET', hash, 'deliveredAt', deliveredAt, 'timelineOrderAt', timelineScore, 'deliveryStatus', 'delivered')
redis.call('ZADD', kp .. 'msg:thread:' .. threadId, tonumber(timelineScore), msgId)
redis.call('ZADD', kp .. 'msg:timeline', tonumber(timelineScore), msgId)
redis.call('ZADD', kp .. 'msg:user:' .. userId, tonumber(timelineScore), msgId)

-- Visibility: write pre-validated seq
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
-- #1269 R8 P1-2: clear custody fields so restart/reconciliation cannot treat
-- canceled work as still owned. Parity with CANCEL_LUA in delivery scripts.
redis.call('HDEL', hash, 'queueCustody', 'queueCustodyRevision', 'queueCustodyAdmission')

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

-- #1200 Sol R1 P2: ZCARD first to avoid materializing huge thread in Lua memory
local count = redis.call('ZCARD', threadKey)

-- Empty thread → mark migrated, no backfill needed
if count == 0 then
  redis.call('HSET', metaKey, 'migrated', '1', 'hwm', '0')
  return 0
end

-- Bound check: fail-visible BEFORE materializing members
if count > maxMembers then
  return redis.error_reply(
    'VISIBILITY_BACKFILL_TOO_LARGE: threadId=' .. threadId ..
    ' members=' .. tostring(count) ..
    ' max=' .. tostring(maxMembers)
  )
end

-- Get all members in rank order (legacy (score, id) total order)
local members = redis.call('ZRANGE', threadKey, 0, -1)

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
