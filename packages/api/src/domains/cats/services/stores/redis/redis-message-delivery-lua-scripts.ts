/**
 * Lua scripts for atomic delivery-order transitions (PR #1193).
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
