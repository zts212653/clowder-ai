import { PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA } from './person-memory-disposition-lua-preflight.js';

/** Root anchor with an owner-scoped one-to-one opaque lineage binding. */
export const COMMIT_DISPOSITION_ROOT_ENVELOPE_LUA = `
${PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA}
if #KEYS ~= 7 or #ARGV ~= 8 then return 'INVALID_ARGUMENTS' end
if not allowed_type(KEYS[1], 'string')
  or not allowed_type(KEYS[2], 'zset')
  or not allowed_type(KEYS[3], 'string')
  or not allowed_type(KEYS[4], 'string')
  or not allowed_type(KEYS[5], 'string')
  or not allowed_type(KEYS[6], 'set')
  or not allowed_type(KEYS[7], 'set') then
  return 'TYPE_CONFLICT'
end
if redis.call('EXISTS', KEYS[3]) == 1 then return 'NOT_AVAILABLE' end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'BINDING_CONFLICT' end
if redis.call('EXISTS', KEYS[5]) == 1 then return 'LINEAGE_HANDLE_COLLISION' end
local score = finite_number(ARGV[3])
if not score or not valid_json(ARGV[2]) or not valid_json(ARGV[5]) or not valid_json(ARGV[6]) then
  return 'INVALID_ARGUMENTS'
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
if raw ~= ARGV[1] then return 'SNAPSHOT_CONFLICT' end
local current = cjson.decode(raw)
local anchored = cjson.decode(ARGV[2])
local binding = cjson.decode(ARGV[5])
local locator = cjson.decode(ARGV[6])
if current.state ~= 'staged'
  or anchored.state ~= 'pending_approval'
  or anchored.dispositionLineageBindingKey ~= ARGV[7]
  or binding.rootCandidateId ~= ARGV[4]
  or binding.currentCandidateId ~= ARGV[4]
  or locator.bindingKey ~= ARGV[7] then
  return 'CONFLICT'
end
if redis.call('SISMEMBER', KEYS[6], KEYS[1]) ~= 1
  or redis.call('SISMEMBER', KEYS[7], ARGV[4]) ~= 1 then
  return 'CLOSURE_CONFLICT'
end

redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], score, ARGV[4])
redis.call('SET', KEYS[4], ARGV[5])
redis.call('SET', KEYS[5], ARGV[6])
redis.call('SADD', KEYS[6], KEYS[4], KEYS[5])
return 'ANCHORED'
`;

/** Same-closure replacement rotates current opaque pointers without minting another root. */
export const COMMIT_DISPOSITION_REPLACEMENT_ENVELOPE_LUA = `
${PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA}
if #KEYS ~= 8 or #ARGV ~= 10 then return 'INVALID_ARGUMENTS' end
if not allowed_type(KEYS[1], 'string')
  or not allowed_type(KEYS[2], 'zset')
  or not allowed_type(KEYS[3], 'string')
  or not allowed_type(KEYS[4], 'string')
  or not allowed_type(KEYS[5], 'string')
  or not allowed_type(KEYS[6], 'string')
  or not allowed_type(KEYS[7], 'set')
  or not allowed_type(KEYS[8], 'set') then
  return 'TYPE_CONFLICT'
end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'NOT_AVAILABLE' end
local score = finite_number(ARGV[5])
if not score or not valid_json(ARGV[3]) or not valid_json(ARGV[4])
  or not valid_json(ARGV[8]) or not valid_json(ARGV[9]) or not valid_json(ARGV[10]) then
  return 'INVALID_ARGUMENTS'
end
local newRaw = redis.call('GET', KEYS[1])
local oldRaw = redis.call('GET', KEYS[3])
if not newRaw or not oldRaw then return 'NOT_AVAILABLE' end
if newRaw ~= ARGV[1] or oldRaw ~= ARGV[2] then return 'SNAPSHOT_CONFLICT' end
if redis.call('GET', KEYS[5]) ~= ARGV[8] or redis.call('GET', KEYS[6]) ~= ARGV[10] then
  return 'BINDING_CONFLICT'
end
local newCandidate = cjson.decode(newRaw)
local oldCandidate = cjson.decode(oldRaw)
local anchored = cjson.decode(ARGV[3])
local binding = cjson.decode(ARGV[8])
local updatedBinding = cjson.decode(ARGV[9])
local locator = cjson.decode(ARGV[10])
if newCandidate.state ~= 'staged'
  or (oldCandidate.state ~= 'pending_approval' and oldCandidate.state ~= 'not_now')
  or anchored.dispositionLineageBindingKey ~= locator.bindingKey
  or binding.opaqueLineageHandle ~= updatedBinding.opaqueLineageHandle
  or binding.rootCandidateId ~= updatedBinding.rootCandidateId
  or updatedBinding.currentCandidateId ~= ARGV[6] then
  return 'CONFLICT'
end
if redis.call('SISMEMBER', KEYS[7], KEYS[1]) ~= 1
  or redis.call('SISMEMBER', KEYS[7], KEYS[5]) ~= 1
  or redis.call('SISMEMBER', KEYS[7], KEYS[6]) ~= 1
  or redis.call('SISMEMBER', KEYS[8], ARGV[6]) ~= 1 then
  return 'CLOSURE_CONFLICT'
end

redis.call('SET', KEYS[1], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('ZREM', KEYS[2], ARGV[7])
redis.call('ZADD', KEYS[2], score, ARGV[6])
redis.call('SET', KEYS[5], ARGV[9])
return 'ANCHORED'
`;
