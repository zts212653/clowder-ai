/**
 * Lua scripts for atomic delivery-order transitions and append (PR #1193 + #1200).
 *
 * Bug: reassignUserId / markDelivered / markCanceled each read a JS snapshot
 * then write via independent MULTI — no shared atomic boundary. Two concurrent
 * writers interleave and leave hash vs zset state inconsistent.
 *
 * Fix: each transition is a single Lua script that reads AND writes inside
 * Redis's single-threaded Lua executor. No OCC / WATCH / retry needed —
 * Lua atomicity guarantees linearizability.
 *
 * Key convention: all keys are derived INSIDE the Lua script from the hash
 * (except the hash key itself which is KEYS[1]). This eliminates stale-key
 * bugs — the script always reads the canonical state.
 *
 * ioredis keyPrefix caveat: ioredis auto-prepends keyPrefix to KEYS[] args
 * in eval(), but NOT to keys constructed dynamically inside Lua. We pass the
 * keyPrefix via ARGV so scripts can build fully-qualified keys internally.
 * (See redis-pitfalls.md for background.)
 *
 * Note: cat-cafe runs single-instance Redis (no Cluster). Lua scripts access
 * keys across slots freely. If Cluster is adopted, these scripts must be
 * restructured with hash tags.
 */

/**
 * DELIVER: transition queued → delivered.
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 * ARGV[1] = message id
 * ARGV[2] = deliveredAt (string number)
 * ARGV[3] = keyPrefix (e.g. "cat-cafe:") — for constructing zset keys inside Lua
 *
 * Returns: 0 on CAS no-op (not queued / missing), or HGETALL flat array on CAS win.
 * Returning HGETALL eliminates the separate getById round-trip — the winning caller
 * receives the post-mutation hash atomically, with no gap where a transient Redis
 * failure could lose the CAS receipt.
 */
export const DELIVER_LUA = `
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

redis.call('HSET', hash, 'deliveredAt', deliveredAt, 'deliveryStatus', 'delivered')

redis.call('ZADD', kp .. 'msg:thread:' .. threadId, tonumber(deliveredAt), msgId)
redis.call('ZADD', kp .. 'msg:timeline', tonumber(deliveredAt), msgId)
redis.call('ZADD', kp .. 'msg:user:' .. userId, tonumber(deliveredAt), msgId)

return redis.call('HGETALL', hash)
`;

/**
 * CANCEL: CAS transition queued → canceled.
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 *
 * Returns: 0 on CAS no-op (not queued / missing), or HGETALL flat array on CAS win.
 */
export const CANCEL_LUA = `
local hash = KEYS[1]
local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  return 0
end
redis.call('HSET', hash, 'deliveryStatus', 'canceled')
return redis.call('HGETALL', hash)
`;

/**
 * REASSIGN: move message ownership atomically.
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 * ARGV[1] = message id
 * ARGV[2] = nextUserId
 * ARGV[3] = keyPrefix (e.g. "cat-cafe:") — for constructing user zset keys inside Lua
 * ARGV[4] = ttlSeconds (string number, "0" = no expiry) — applied atomically to the
 *           new user zset key, eliminating the crash window between ownership transfer
 *           and TTL application (codex P2 fix)
 *
 * Derives currentUserId and effectiveOrder (deliveredAt ?? timestamp) from
 * the hash INSIDE the script — never from a stale JS snapshot.
 *
 * Returns: -1 (not found), 0 (same user / no-op), or HGETALL flat array on CAS win.
 */
export const REASSIGN_LUA = `
local hash = KEYS[1]
local msgId = ARGV[1]
local nextUserId = ARGV[2]
local kp = ARGV[3]
local ttl = tonumber(ARGV[4])

local curUserId = redis.call('HGET', hash, 'userId')
if not curUserId then
  return -1
end
if curUserId == nextUserId then
  return 0
end

local eff = redis.call('HGET', hash, 'deliveredAt')
if not eff or eff == '' then
  eff = redis.call('HGET', hash, 'timestamp')
end

redis.call('HSET', hash, 'userId', nextUserId)
redis.call('ZREM', kp .. 'msg:user:' .. curUserId, msgId)
local newUserKey = kp .. 'msg:user:' .. nextUserId
redis.call('ZADD', newUserKey, tonumber(eff), msgId)

if ttl > 0 then
  redis.call('EXPIRE', newUserKey, ttl)
end

return redis.call('HGETALL', hash)
`;

/**
 * APPEND: atomic idempotency claim + hash + all indexes + TTL cleanup.
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 * ARGV[1] = message id
 * ARGV[2] = JSON object of hash fields (id, threadId, userId, timestamp, content, ...)
 * ARGV[3] = JSON array of mention catIds
 * ARGV[4] = timeline/user/mentions/thread score (stringified message timestamp)
 * ARGV[5] = idempotency key raw suffix (empty string if none)
 * ARGV[6] = keyPrefix (e.g. "cat-cafe:")
 * ARGV[7] = ttlSeconds as string ("0" = no expiry)
 *
 * Returns: existing message id on idempotency replay, otherwise the new message id.
 */
export const APPEND_LUA = `
redis.replicate_commands()

local hash = KEYS[1]
local msgId = ARGV[1]
local hashFields = cjson.decode(ARGV[2])
local mentions = cjson.decode(ARGV[3])
local score = tonumber(ARGV[4])
local idemKeyRaw = ARGV[5]
local kp = ARGV[6]
local ttl = tonumber(ARGV[7])

local idemKey = idemKeyRaw ~= '' and (kp .. idemKeyRaw) or nil

-- Idempotency: if key points to a live hash, replay.
if idemKey then
  local existingId = redis.call('GET', idemKey)
  if existingId then
    if redis.call('EXISTS', kp .. 'msg:' .. existingId) == 1 then
      return existingId
    end
    -- stale reference: fall through to reclaim
  end
end

-- Write hash.
local flat = {}
for k, v in pairs(hashFields) do
  table.insert(flat, k)
  table.insert(flat, v)
end
redis.call('HSET', hash, unpack(flat))

-- Write time-semantic indexes.
local threadId = hashFields.threadId
local threadKey = kp .. 'msg:thread:' .. threadId
local userKey = kp .. 'msg:user:' .. hashFields.userId
local timelineKey = kp .. 'msg:timeline'
redis.call('ZADD', timelineKey, score, msgId)
redis.call('ZADD', userKey, score, msgId)
redis.call('ZADD', threadKey, score, msgId)
for _, catId in ipairs(mentions) do
  redis.call('ZADD', kp .. 'msg:mentions:' .. catId, score, msgId)
end

-- Claim idempotency key and apply TTLs.
if idemKey then
  -- Overwrite stale mappings (e.g., after deleteByThread deleted the hash but
  -- left the idempotency key behind) as well as claiming a fresh key. At this
  -- point the key either does not exist or points to a missing hash, so
  -- unconditional SET is safe and prevents duplicate creation on retries.
  redis.call('SET', idemKey, msgId)
  if ttl > 0 then
    redis.call('EXPIRE', idemKey, ttl)
  end
end

if ttl > 0 then
  redis.call('EXPIRE', hash, ttl)
  redis.call('EXPIRE', timelineKey, ttl)
  redis.call('EXPIRE', userKey, ttl)
  redis.call('EXPIRE', threadKey, ttl)
  for _, catId in ipairs(mentions) do
    redis.call('EXPIRE', kp .. 'msg:mentions:' .. catId, ttl)
  end

  local timeArr = redis.call('TIME')
  local timeMs = tonumber(timeArr[1]) * 1000 + math.floor(tonumber(timeArr[2]) / 1000)
  local cutoff = timeMs - ttl * 1000
  redis.call('ZREMRANGEBYSCORE', timelineKey, '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', userKey, '-inf', cutoff)
  for _, catId in ipairs(mentions) do
    redis.call('ZREMRANGEBYSCORE', kp .. 'msg:mentions:' .. catId, '-inf', cutoff)
  end
  -- Thread ZSET is scored by timestamp (queued) or deliveredAt. Prune members
  -- whose score is older than the TTL window so active threads do not accumulate
  -- unhydratable IDs indefinitely. Whole-key EXPIRE remains as a backstop for
  -- idle threads.
  redis.call('ZREMRANGEBYSCORE', threadKey, '-inf', cutoff)
end

return msgId
`;
