/** CAS current claim pointer + append new version + retain idempotent receipt. */
export const CORRECT_CLAIM_LUA = `
local prior = redis.call('GET', KEYS[5])
if prior then return 'REPLAYED:' .. prior end
if redis.call('EXISTS', KEYS[7]) == 1 then return 'NOT_AVAILABLE' end
local current = redis.call('GET', KEYS[1])
if not current then return 'NOT_AVAILABLE' end
if current ~= ARGV[1] then return 'CONFLICT' end
if redis.call('EXISTS', KEYS[2]) == 0 then return 'NOT_AVAILABLE' end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
redis.call('SET', KEYS[1], ARGV[4])
redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), ARGV[4])
redis.call('SET', KEYS[5], ARGV[3])
redis.call('SADD', KEYS[6], KEYS[3], KEYS[5], KEYS[1])
return 'APPLIED:' .. ARGV[3]
`;

export const RETIRE_CLAIM_LUA = `
local prior = redis.call('GET', KEYS[5])
if prior then return 'REPLAYED:' .. prior end
if redis.call('EXISTS', KEYS[7]) == 1 then return 'NOT_AVAILABLE' end
local current = redis.call('GET', KEYS[1])
if not current then return 'NOT_AVAILABLE' end
if current ~= ARGV[1] then return 'CONFLICT' end
if redis.call('EXISTS', KEYS[2]) == 0 then return 'NOT_AVAILABLE' end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
redis.call('DEL', KEYS[1])
redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), ARGV[4])
redis.call('SET', KEYS[5], ARGV[3])
redis.call('SADD', KEYS[6], KEYS[3], KEYS[5], KEYS[1])
return 'APPLIED:' .. ARGV[3]
`;

export const AMEND_EVENT_LUA = `
local prior = redis.call('GET', KEYS[5])
if prior then return 'REPLAYED:' .. prior end
if redis.call('EXISTS', KEYS[7]) == 1 then return 'NOT_AVAILABLE' end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'NOT_AVAILABLE' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'CONFLICT' end
redis.call('SET', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], tonumber(ARGV[2]), ARGV[3])
redis.call('ZADD', KEYS[4], tonumber(ARGV[2]), ARGV[3])
redis.call('SET', KEYS[5], ARGV[1])
redis.call('SADD', KEYS[6], KEYS[2], KEYS[5])
return 'APPLIED:' .. ARGV[1]
`;

export const REDACT_ITEM_LUA = `
local prior = redis.call('GET', KEYS[2])
if prior then return 'REPLAYED:' .. prior end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'NOT_AVAILABLE' end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'NOT_AVAILABLE' end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[3] == 'clear_current' and redis.call('GET', KEYS[5]) == ARGV[4] then
  redis.call('DEL', KEYS[5])
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], KEYS[1], KEYS[2])
return 'APPLIED:' .. ARGV[2]
`;
