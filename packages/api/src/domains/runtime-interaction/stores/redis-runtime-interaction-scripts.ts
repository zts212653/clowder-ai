export const CREATE_STAGED_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if ARGV[5] == '1' and redis.call('SCARD', KEYS[3]) > 0 then return -1 end
redis.call('HSET', KEYS[1],
  'request', ARGV[1],
  'status', 'staged',
  'hostEpoch', ARGV[2],
  'updatedAt', ARGV[3],
  'revision', '1',
  'source', ARGV[6],
  'returnBinding', ARGV[7])
redis.call('SADD', KEYS[2], ARGV[4])
if ARGV[5] == '1' then redis.call('SADD', KEYS[3], ARGV[4]) end
return 1
`;

export const ANCHOR_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
local hostEpoch = redis.call('HGET', KEYS[1], 'hostEpoch')
if status ~= 'staged' then return 0 end
local binding = cjson.decode(redis.call('HGET', KEYS[1], 'returnBinding') or '{"kind":"provider_waiter"}')
if hostEpoch ~= ARGV[1] and binding.kind ~= 'conversation_turn' then return 0 end
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '1')
if ARGV[6] ~= '' and revision ~= tonumber(ARGV[6]) then return 0 end
redis.call('HSET', KEYS[1], 'status', 'pending', 'hostEpoch', ARGV[1], 'cardRef', ARGV[2], 'updatedAt', ARGV[3], 'revision', revision + 1)
redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[5])
return 1
`;

export const SETTLE_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
local hostEpoch = redis.call('HGET', KEYS[1], 'hostEpoch')
if status ~= 'pending' or hostEpoch ~= ARGV[1] then return 0 end
local binding = cjson.decode(redis.call('HGET', KEYS[1], 'returnBinding') or '{"kind":"provider_waiter"}')
if binding.kind ~= 'provider_waiter' then return 0 end
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '1')
if ARGV[6] ~= '' and revision ~= tonumber(ARGV[6]) then return 0 end
local indexType = redis.call('TYPE', KEYS[5]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('runtime history index type conflict') end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'terminal', ARGV[3], 'updatedAt', ARGV[4], 'revision', revision + 1)
redis.call('HDEL', KEYS[1], 'submission')
redis.call('ZREM', KEYS[2], ARGV[5])
redis.call('SREM', KEYS[3], ARGV[5])
redis.call('SREM', KEYS[4], ARGV[5])
if redis.call('HEXISTS', KEYS[1], 'cardRef') == 1 then
  redis.call('ZADD', KEYS[5], tonumber(cjson.decode(ARGV[3]).settledAt), ARGV[5])
end
return 1
`;

export const INVALIDATE_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'staged' and status ~= 'pending' then return 0 end
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '1')
if ARGV[4] ~= '' and revision ~= tonumber(ARGV[4]) then return 0 end
local indexType = redis.call('TYPE', KEYS[5]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('runtime history index type conflict') end
redis.call('HSET', KEYS[1], 'status', 'invalidated', 'terminal', ARGV[1], 'updatedAt', ARGV[2], 'revision', revision + 1)
redis.call('HDEL', KEYS[1], 'submission')
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('SREM', KEYS[3], ARGV[3])
redis.call('SREM', KEYS[4], ARGV[3])
if redis.call('HEXISTS', KEYS[1], 'cardRef') == 1 then
  redis.call('ZADD', KEYS[5], tonumber(cjson.decode(ARGV[1]).settledAt), ARGV[3])
end
return 1
`;

export const CLAIM_SUBMISSION_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'pending' or redis.call('HEXISTS', KEYS[1], 'submission') == 1 then return 0 end
local source = cjson.decode(redis.call('HGET', KEYS[1], 'source') or '{}')
local binding = cjson.decode(redis.call('HGET', KEYS[1], 'returnBinding') or '{}')
if source.kind ~= 'conversation_decision' or binding.kind ~= 'conversation_turn' then return 0 end
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '1')
if revision ~= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'submission', ARGV[2], 'updatedAt', ARGV[3], 'revision', revision + 1)
return 1
`;

export const COMPLETE_SUBMISSION_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'pending' then return 0 end
local source = cjson.decode(redis.call('HGET', KEYS[1], 'source') or '{}')
local binding = cjson.decode(redis.call('HGET', KEYS[1], 'returnBinding') or '{}')
if source.kind ~= 'conversation_decision' or binding.kind ~= 'conversation_turn' then return 0 end
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '1')
if revision ~= tonumber(ARGV[1]) then return 0 end
local rawSubmission = redis.call('HGET', KEYS[1], 'submission')
if not rawSubmission or cjson.decode(rawSubmission).operationId ~= ARGV[2] then return 0 end
local indexType = redis.call('TYPE', KEYS[5]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('runtime history index type conflict') end
redis.call('HSET', KEYS[1], 'status', ARGV[3], 'terminal', ARGV[4], 'updatedAt', ARGV[5], 'revision', revision + 1)
redis.call('HDEL', KEYS[1], 'submission')
redis.call('ZREM', KEYS[2], ARGV[6])
redis.call('SREM', KEYS[3], ARGV[6])
redis.call('SREM', KEYS[4], ARGV[6])
if redis.call('HEXISTS', KEYS[1], 'cardRef') == 1 then
  redis.call('ZADD', KEYS[5], tonumber(cjson.decode(ARGV[4]).settledAt), ARGV[6])
end
return 1
`;

export const SETTLE_CONVERSATION_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'pending' or redis.call('HEXISTS', KEYS[1], 'submission') == 1 then return 0 end
local source = cjson.decode(redis.call('HGET', KEYS[1], 'source') or '{}')
local binding = cjson.decode(redis.call('HGET', KEYS[1], 'returnBinding') or '{}')
if source.kind ~= 'conversation_decision' or binding.kind ~= 'conversation_turn' then return 0 end
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '1')
if revision ~= tonumber(ARGV[1]) then return 0 end
local indexType = redis.call('TYPE', KEYS[5]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('runtime history index type conflict') end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'terminal', ARGV[3], 'updatedAt', ARGV[4], 'revision', revision + 1)
redis.call('ZREM', KEYS[2], ARGV[5])
redis.call('SREM', KEYS[3], ARGV[5])
redis.call('SREM', KEYS[4], ARGV[5])
if redis.call('HEXISTS', KEYS[1], 'cardRef') == 1 then
  redis.call('ZADD', KEYS[5], tonumber(cjson.decode(ARGV[3]).settledAt), ARGV[5])
end
return 1
`;
