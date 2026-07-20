/**
 * Lua scripts for atomic delivery-order transitions (F258).
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
 * Returns: [applied (0|1), status, userId, deliveredAt]
 * - applied=0 → status was not 'queued', no change made
 * - applied=1 → transitioned to 'delivered', zsets updated
 */
export const DELIVER_LUA = `
local hash = KEYS[1]
local msgId = ARGV[1]
local deliveredAt = ARGV[2]
local kp = ARGV[3]

local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  local curUserId = redis.call('HGET', hash, 'userId') or ''
  local curDeliveredAt = redis.call('HGET', hash, 'deliveredAt') or ''
  return {0, status or '', curUserId, curDeliveredAt}
end

local userId = redis.call('HGET', hash, 'userId')
local threadId = redis.call('HGET', hash, 'threadId')

redis.call('HSET', hash, 'deliveredAt', deliveredAt, 'deliveryStatus', 'delivered')

local score = deliveredAt
redis.call('ZADD', kp .. 'msg:thread:' .. threadId, score, msgId)
redis.call('ZADD', kp .. 'msg:timeline', score, msgId)
redis.call('ZADD', kp .. 'msg:user:' .. userId, score, msgId)

return {1, 'delivered', userId, deliveredAt}
`;

/**
 * CANCEL: CAS transition queued → canceled.
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 *
 * Returns: [applied (0|1), status]
 * - applied=0 → status was not 'queued', no change (protects delivered state)
 * - applied=1 → transitioned to 'canceled', no zset change (score stays at timestamp)
 */
export const CANCEL_LUA = `
local hash = KEYS[1]
local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  return {0, status or ''}
end
redis.call('HSET', hash, 'deliveryStatus', 'canceled')
return {1, 'canceled'}
`;

/**
 * REASSIGN: move message ownership atomically.
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 * ARGV[1] = message id
 * ARGV[2] = nextUserId
 * ARGV[3] = keyPrefix (e.g. "cat-cafe:") — for constructing user zset keys inside Lua
 *
 * Derives currentUserId and effectiveOrder (deliveredAt ?? timestamp) from
 * the hash INSIDE the script — never from a stale JS snapshot.
 *
 * Returns: [applied (0|1), userId, effectiveOrder]
 * - applied=-1 → message not found
 * - applied=0 → currentUserId already equals nextUserId
 * - applied=1 → ownership transferred, user zset membership moved
 */
export const REASSIGN_LUA = `
local hash = KEYS[1]
local msgId = ARGV[1]
local nextUserId = ARGV[2]
local kp = ARGV[3]

local curUserId = redis.call('HGET', hash, 'userId')
if not curUserId then
  return {-1, '', ''}
end
if curUserId == nextUserId then
  local eff = redis.call('HGET', hash, 'deliveredAt') or redis.call('HGET', hash, 'timestamp')
  return {0, curUserId, eff or ''}
end

local eff = redis.call('HGET', hash, 'deliveredAt')
if not eff or eff == '' then
  eff = redis.call('HGET', hash, 'timestamp')
end

redis.call('HSET', hash, 'userId', nextUserId)
redis.call('ZREM', kp .. 'msg:user:' .. curUserId, msgId)
redis.call('ZADD', kp .. 'msg:user:' .. nextUserId, tonumber(eff), msgId)

return {1, nextUserId, eff}
`;
