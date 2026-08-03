import { PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA } from './person-memory-disposition-lua-preflight.js';

export const BEGIN_HARD_FORGET_LUA = `
local receipt = redis.call('GET', KEYS[2])
if receipt then return 'RECEIPT:' .. receipt end
if redis.call('EXISTS', KEYS[3]) == 0 and redis.call('EXISTS', KEYS[4]) == 0 then return 'ABSENT' end
local fence = redis.call('GET', KEYS[1])
if fence and fence ~= ARGV[1] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 'FENCED'
`;

export const BEGIN_EXACT_PROPOSAL_FORGET_LUA = `
local receipt = redis.call('GET', KEYS[2])
if receipt then return 'RECEIPT:' .. receipt end
if redis.call('EXISTS', KEYS[3]) == 0 then return 'ABSENT' end
local fence = redis.call('GET', KEYS[1])
if fence and fence ~= ARGV[1] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 'FENCED'
`;

/** Two-pass exact owner-private purge. Only the fence may survive a failed preflight. */
export const FINISH_HARD_FORGET_LUA = `
${PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA}
if #KEYS < 2 or #ARGV ~= 3 then return 'INVALID_PLAN' end
if not allowed_type(KEYS[1], 'string') or not allowed_type(KEYS[2], 'string') then
  return 'TYPE_CONFLICT'
end
local prior = redis.call('GET', KEYS[2])
if prior then return 'RECEIPT:' .. prior end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'CONFLICT' end
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
    or typeByIndex[index] == nil then
    return 'INVALID_PLAN'
  end
  if mutation.op ~= 'del'
    and (type(mutation.member) ~= 'string' or mutation.member == '') then
    return 'INVALID_PLAN'
  end
  if mutation.op ~= 'del' and mutation.op ~= 'srem'
    and mutation.op ~= 'zrem' and mutation.op ~= 'hdel' then
    return 'INVALID_PLAN'
  end
  local canonicalType = typeByIndex[index].name
  if (mutation.op == 'srem' and canonicalType ~= 'set')
    or (mutation.op == 'zrem' and canonicalType ~= 'zset')
    or (mutation.op == 'hdel' and canonicalType ~= 'hash') then
    return 'INVALID_PLAN'
  end
end

for _, mutation in ipairs(plan.mutations) do
  local key = KEYS[mutation.keyIndex]
  if mutation.op == 'del' then redis.call('DEL', key)
  elseif mutation.op == 'srem' then redis.call('SREM', key, mutation.member)
  elseif mutation.op == 'zrem' then redis.call('ZREM', key, mutation.member)
  elseif mutation.op == 'hdel' then redis.call('HDEL', key, mutation.member)
  end
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
return 'PURGED:' .. ARGV[2]
`;
