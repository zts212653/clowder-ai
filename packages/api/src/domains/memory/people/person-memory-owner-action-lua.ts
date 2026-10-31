import { PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA } from './person-memory-disposition-lua-preflight.js';

/**
 * Apply one preflighted owner action plan and its target-bound receipt in one
 * Redis commit. KEYS[1] is the idempotency receipt. Every other key is
 * referenced by the serialized plan's one-based key indexes.
 */
export const EXECUTE_OWNER_MEMORY_ACTION_LUA = `
${PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA}
if #KEYS < 2 or #ARGV ~= 3 then return 'INVALID_PLAN' end
if not allowed_type(KEYS[1], 'string') then return 'TYPE_CONFLICT' end
local prior = redis.call('GET', KEYS[1])
if prior then
  local priorOk, priorReceipt = pcall(cjson.decode, prior)
  if not priorOk or type(priorReceipt) ~= 'table' or priorReceipt.requestDigest ~= ARGV[1] then
    return 'IDEMPOTENCY_CONFLICT'
  end
  return 'REPLAYED:' .. prior
end

local ok, plan = pcall(cjson.decode, ARGV[3])
if not ok or type(plan) ~= 'table'
  or type(plan.fenceKeyIndexes) ~= 'table'
  or type(plan.expectedTypes) ~= 'table'
  or type(plan.preconditions) ~= 'table'
  or type(plan.mutations) ~= 'table' then
  return 'INVALID_PLAN'
end
local fieldCount = 0
for field, _ in pairs(plan) do
  if field ~= 'fenceKeyIndexes' and field ~= 'expectedTypes'
    and field ~= 'preconditions' and field ~= 'mutations' then
    return 'INVALID_PLAN'
  end
  fieldCount = fieldCount + 1
end
if fieldCount ~= 4 then return 'INVALID_PLAN' end

local typeByIndex = {}
for _, expectation in ipairs(plan.expectedTypes) do
  local index = expectation.keyIndex
  if type(index) ~= 'number' or index ~= math.floor(index) or index < 1 or index > #KEYS
    or type(expectation.type) ~= 'string' or type(expectation.allowNone) ~= 'boolean'
    or typeByIndex[index] ~= nil then
    return 'INVALID_PLAN'
  end
  local expectedType = expectation.type
  if expectedType ~= 'string' and expectedType ~= 'set'
    and expectedType ~= 'zset' and expectedType ~= 'hash' and expectedType ~= 'list'
    and expectedType ~= 'stream' then
    return 'INVALID_PLAN'
  end
  typeByIndex[index] = { name = expectedType, allowNone = expectation.allowNone }
  local actualType = redis_type_name(KEYS[index])
  if actualType ~= expectedType and not (expectation.allowNone and actualType == 'none') then
    return 'CONFLICT'
  end
end

local seenFenceIndexes = {}
for _, index in ipairs(plan.fenceKeyIndexes) do
  if type(index) ~= 'number' or index ~= math.floor(index) or index < 1 or index > #KEYS
    or seenFenceIndexes[index] then
    return 'INVALID_PLAN'
  end
  seenFenceIndexes[index] = true
  if redis.call('EXISTS', KEYS[index]) == 1 then return 'NOT_AVAILABLE' end
end

local function valid_string_array(values)
  if type(values) ~= 'table' then return false end
  for _, value in ipairs(values) do
    if type(value) ~= 'string' then return false end
  end
  return true
end
local function sorted(values)
  table.sort(values)
  return values
end
for _, precondition in ipairs(plan.preconditions) do
  local index = precondition.keyIndex
  if type(index) ~= 'number' or index ~= math.floor(index) or index < 1 or index > #KEYS
    or type(precondition.kind) ~= 'string' or typeByIndex[index] == nil then
    return 'INVALID_PLAN'
  end
  if precondition.kind == 'zrange' then
    if typeByIndex[index].name ~= 'zset' or not valid_string_array(precondition.expected) then
      return 'INVALID_PLAN'
    end
    local actual = redis.call('ZRANGE', KEYS[index], 0, -1)
    if cjson.encode(actual) ~= cjson.encode(precondition.expected) then return 'CONFLICT' end
  elseif precondition.kind == 'smembers' then
    if typeByIndex[index].name ~= 'set' or not valid_string_array(precondition.expected) then
      return 'INVALID_PLAN'
    end
    local actual = sorted(redis.call('SMEMBERS', KEYS[index]))
    local expected = sorted(precondition.expected)
    if cjson.encode(actual) ~= cjson.encode(expected) then return 'CONFLICT' end
  elseif precondition.kind == 'string' then
    if typeByIndex[index].name ~= 'string' or type(precondition.expected) ~= 'string' then
      return 'INVALID_PLAN'
    end
    local actual = redis.call('GET', KEYS[index])
    if not actual then actual = '' end
    if actual ~= precondition.expected then return 'CONFLICT' end
  elseif precondition.kind == 'hash_field' then
    if typeByIndex[index].name ~= 'hash'
      or type(precondition.member) ~= 'string' or precondition.member == ''
      or type(precondition.expected) ~= 'string' then return 'INVALID_PLAN' end
    local actual = redis.call('HGET', KEYS[index], precondition.member)
    if not actual then actual = '' end
    if actual ~= precondition.expected then return 'CONFLICT' end
  elseif precondition.kind == 'zscore' then
    if typeByIndex[index].name ~= 'zset'
      or type(precondition.member) ~= 'string' or precondition.member == ''
      or type(precondition.expected) ~= 'string' then return 'INVALID_PLAN' end
    local actual = redis.call('ZSCORE', KEYS[index], precondition.member)
    if not actual then actual = '' end
    if actual ~= precondition.expected then return 'CONFLICT' end
  else
    return 'INVALID_PLAN'
  end
end

for _, mutation in ipairs(plan.mutations) do
  local index = mutation.keyIndex
  if type(index) ~= 'number' or index ~= math.floor(index) or index < 1 or index > #KEYS
    or typeByIndex[index] == nil or type(mutation.op) ~= 'string' then
    return 'INVALID_PLAN'
  end
  local canonicalType = typeByIndex[index].name
  if mutation.op == 'set' then
    if canonicalType ~= 'string' or type(mutation.value) ~= 'string' then return 'INVALID_PLAN' end
  elseif mutation.op == 'sadd' or mutation.op == 'srem' then
    if canonicalType ~= 'set' or type(mutation.member) ~= 'string' or mutation.member == '' then
      return 'INVALID_PLAN'
    end
  elseif mutation.op == 'zadd' then
    if canonicalType ~= 'zset' or type(mutation.member) ~= 'string' or mutation.member == ''
      or type(mutation.score) ~= 'number' then return 'INVALID_PLAN' end
  elseif mutation.op == 'zrem' then
    if canonicalType ~= 'zset' or type(mutation.member) ~= 'string' or mutation.member == '' then
      return 'INVALID_PLAN'
    end
  elseif mutation.op == 'hset' then
    if canonicalType ~= 'hash' or type(mutation.member) ~= 'string' or mutation.member == ''
      or type(mutation.value) ~= 'string' then return 'INVALID_PLAN' end
  elseif mutation.op == 'hdel' then
    if canonicalType ~= 'hash' or type(mutation.member) ~= 'string' or mutation.member == '' then
      return 'INVALID_PLAN'
    end
  elseif mutation.op ~= 'del' then
    return 'INVALID_PLAN'
  end
end

for _, mutation in ipairs(plan.mutations) do
  local key = KEYS[mutation.keyIndex]
  if mutation.op == 'set' then redis.call('SET', key, mutation.value)
  elseif mutation.op == 'sadd' then redis.call('SADD', key, mutation.member)
  elseif mutation.op == 'srem' then redis.call('SREM', key, mutation.member)
  elseif mutation.op == 'zadd' then redis.call('ZADD', key, mutation.score, mutation.member)
  elseif mutation.op == 'zrem' then redis.call('ZREM', key, mutation.member)
  elseif mutation.op == 'hset' then redis.call('HSET', key, mutation.member, mutation.value)
  elseif mutation.op == 'hdel' then redis.call('HDEL', key, mutation.member)
  elseif mutation.op == 'del' then redis.call('DEL', key)
  end
end
redis.call('SET', KEYS[1], ARGV[2])
return 'APPLIED:' .. ARGV[2]
`;
