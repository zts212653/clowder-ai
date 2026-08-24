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
 * Returns: {-1, {}} when missing, {0, HGETALL} on a state/custody no-op, or
 * {1, HGETALL} on a CAS win. Returning the canonical hash with the outcome
 * preserves Clowder AI's deliveryTransitioned receipt without a post-EVAL read gap.
 */
export const DELIVER_LUA = `
local hash = KEYS[1]
local msgId = ARGV[1]
local deliveredAt = ARGV[2]
local kp = ARGV[3]

if redis.call('EXISTS', hash) == 0 then
  return {-1, {}}
end

local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  return {0, redis.call('HGETALL', hash)}
end

-- A durable pre-CAS fan-out intent is active Queue work, not legacy speech
-- whose visibility can be repaired by marking it delivered.
local admission = redis.call('HGET', hash, 'queueCustodyAdmission')
if admission and admission ~= '' then
  return {0, redis.call('HGETALL', hash)}
end

-- F254: legacy markDelivered must not bypass active execution custody.
local custody = redis.call('HGET', hash, 'queueCustody')
if custody and custody ~= '' then
  local custodyProjection = cjson.decode(custody)
  if custodyProjection.status ~= 'terminal' then
    return {0, redis.call('HGETALL', hash)}
  end
end

local userId = redis.call('HGET', hash, 'userId')
local threadId = redis.call('HGET', hash, 'threadId')
local timestamp = redis.call('HGET', hash, 'timestamp')
local catId = redis.call('HGET', hash, 'catId')
local origin = redis.call('HGET', hash, 'origin')
local source = redis.call('HGET', hash, 'source')

-- Preserve Clowder AI publication order: already-published real-cat speech and
-- owner-visible queued user receipts keep their authored timestamp; private
-- queued work enters the timeline at delivery.
local isRealCatSpeech = catId and catId ~= '' and catId ~= 'system'
  and userId ~= 'system' and userId ~= 'scheduler' and origin ~= 'briefing'
local isQueuedUserReceipt = (not catId or catId == '') and (not source or source == '')
  and userId ~= 'system' and userId ~= 'scheduler' and origin ~= 'briefing'
  and custody and custody ~= ''
local timelineScore = deliveredAt
if isRealCatSpeech or isQueuedUserReceipt then
  timelineScore = timestamp
end

redis.call('HSET', hash, 'deliveredAt', deliveredAt, 'timelineOrderAt', timelineScore, 'deliveryStatus', 'delivered')

redis.call('ZADD', kp .. 'msg:thread:' .. threadId, tonumber(timelineScore), msgId)
redis.call('ZADD', kp .. 'msg:timeline', tonumber(timelineScore), msgId)
redis.call('ZADD', kp .. 'msg:user:' .. userId, tonumber(timelineScore), msgId)

return {1, redis.call('HGETALL', hash)}
`;

/**
 * CANCEL: CAS transition queued → canceled.
 *
 * KEYS[1] = detail hash key (auto-prefixed by ioredis)
 *
 * Returns: {-1, {}} when missing, {0, HGETALL} on a state no-op, or
 * {1, HGETALL} on a CAS win.
 */
export const CANCEL_LUA = `
local hash = KEYS[1]
if redis.call('EXISTS', hash) == 0 then
  return {-1, {}}
end
local status = redis.call('HGET', hash, 'deliveryStatus')
if status ~= 'queued' then
  return {0, redis.call('HGETALL', hash)}
end
redis.call('HSET', hash, 'deliveryStatus', 'canceled')
redis.call('HDEL', hash, 'queueCustody', 'queueCustodyRevision', 'queueCustodyAdmission')
return {1, redis.call('HGETALL', hash)}
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
 *           and TTL application
 *
 * Derives currentUserId and effectiveOrder inside the script — first from the
 * source user zset (the existing ordering authority), then from hash fields for
 * legacy rows without that membership. No value comes from a stale JS snapshot.
 *
 * Returns: {-1, {}} when missing, {0, HGETALL} for same-user no-op, or
 * {1, HGETALL} on a transfer.
 */
export const REASSIGN_LUA = `
local hash = KEYS[1]
local msgId = ARGV[1]
local nextUserId = ARGV[2]
local kp = ARGV[3]
local ttl = tonumber(ARGV[4])

local curUserId = redis.call('HGET', hash, 'userId')
if not curUserId then
  return {-1, {}}
end
if curUserId == nextUserId then
  return {0, redis.call('HGETALL', hash)}
end

local oldUserKey = kp .. 'msg:user:' .. curUserId
local eff = redis.call('ZSCORE', oldUserKey, msgId)
if not eff or eff == '' then
  eff = redis.call('HGET', hash, 'timelineOrderAt')
end
if not eff or eff == '' then
  eff = redis.call('HGET', hash, 'deliveredAt')
end
if not eff or eff == '' then
  eff = redis.call('HGET', hash, 'timestamp')
end

redis.call('HSET', hash, 'userId', nextUserId)
redis.call('ZREM', oldUserKey, msgId)
local newUserKey = kp .. 'msg:user:' .. nextUserId
redis.call('ZADD', newUserKey, tonumber(eff), msgId)

if ttl > 0 then
  redis.call('EXPIRE', newUserKey, ttl)
end

return {1, redis.call('HGETALL', hash)}
`;
