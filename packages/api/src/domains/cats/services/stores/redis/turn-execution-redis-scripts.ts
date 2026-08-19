export const CREATE_TURN_EXECUTION_LUA = `
local recordExists = redis.call('EXISTS', KEYS[1])
local currentIdentity = redis.call('HGET', KEYS[1], 'immutableIdentity')
if currentIdentity then
  if currentIdentity == ARGV[1] then return 2 end
  return 0
end
if recordExists == 1 then return -1 end

redis.call('HSET', KEYS[1],
  'immutableIdentity', ARGV[1],
  'invocationId', ARGV[2],
  'parentInvocationId', ARGV[3],
  'threadId', ARGV[4],
  'userId', ARGV[5],
  'catId', ARGV[6],
  'executionKind', ARGV[7],
  'startedAt', ARGV[8],
  'causal', ARGV[9],
  'status', 'running',
  'endedAt', '',
  'terminalReason', '')
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[2])
return 1
`;

export const TERMINALIZE_TURN_EXECUTION_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return -1 end
if current ~= 'running' then return 0 end

redis.call('HSET', KEYS[1],
  'status', ARGV[1],
  'endedAt', ARGV[2],
  'terminalReason', ARGV[3])
redis.call('SREM', KEYS[2], ARGV[4])
return 1
`;
