/** Atomic Redis transitions for the callback-auth lifecycle cell. */

export const CREATE_AUTH_INVOCATION_LUA = `
local currentLatest = redis.call('GET', KEYS[2]) or ''
if currentLatest ~= ARGV[1] then return {'retry', currentLatest} end
if ARGV[1] ~= '' and ARGV[1] ~= ARGV[2] and redis.call('EXISTS', KEYS[3]) == 1 then
  local oldState = redis.call('HGET', KEYS[3], 'state') or 'active'
  if oldState == 'active' then
    redis.call('HSET', KEYS[3], 'state', 'replaced', 'endedAt', ARGV[3],
      'endReason', 'preempt_by:' .. ARGV[2], 'terminalRef', ARGV[2], 'expiresAt', ARGV[4])
    redis.call('PEXPIREAT', KEYS[3], tonumber(ARGV[4]))
    if redis.call('EXISTS', KEYS[4]) == 1 then redis.call('PEXPIREAT', KEYS[4], tonumber(ARGV[4])) end
  end
end
local hashFields = {}
for i = 5, #ARGV do hashFields[#hashFields + 1] = ARGV[i] end
redis.call('HSET', KEYS[1], unpack(hashFields))
redis.call('PERSIST', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('PERSIST', KEYS[2])
return {'ok', ARGV[2]}
`;

export const MIGRATE_AUTH_SLOT_LUA = `
local currentLatest = redis.call('GET', KEYS[1]) or ''
if currentLatest ~= ARGV[1] then return {'retry', currentLatest, '0', '0'} end
local count = tonumber(ARGV[4])
local latestId = currentLatest
local latestActive = currentLatest ~= '' and redis.call('EXISTS', KEYS[2]) == 1
  and (redis.call('HGET', KEYS[2], 'state') or 'active') == 'active'
  and redis.call('HGET', KEYS[2], 'threadId') == ARGV[5]
  and redis.call('HGET', KEYS[2], 'catId') == ARGV[6]
if not latestActive then
  latestId = ''
  for i = count, 1, -1 do
    local invKey = KEYS[2 * i + 1]
    if redis.call('EXISTS', invKey) == 1 and (redis.call('HGET', invKey, 'state') or 'active') == 'active' then
      latestId = ARGV[6 + i]
      break
    end
  end
end
local rebuiltLatest = latestId ~= currentLatest and 1 or 0
local replaced = 0
for i = 1, count do
  local invKey = KEYS[2 * i + 1]
  local msgsKey = KEYS[2 * i + 2]
  local invocationId = ARGV[6 + i]
  if redis.call('EXISTS', invKey) == 1 then
    local state = redis.call('HGET', invKey, 'state') or 'active'
    if state == 'active' and invocationId == latestId then
      redis.call('HDEL', invKey, 'expiresAt')
      redis.call('PERSIST', invKey)
      if redis.call('EXISTS', msgsKey) == 1 then redis.call('PERSIST', msgsKey) end
    elseif state == 'active' then
      redis.call('HSET', invKey, 'state', 'replaced', 'endedAt', ARGV[2],
        'endReason', 'legacy_non_latest:' .. latestId, 'terminalRef', latestId, 'expiresAt', ARGV[3])
      redis.call('PEXPIREAT', invKey, tonumber(ARGV[3]))
      if redis.call('EXISTS', msgsKey) == 1 then redis.call('PEXPIREAT', msgsKey, tonumber(ARGV[3])) end
      replaced = replaced + 1
    end
  end
end
if latestId ~= '' then
  redis.call('SET', KEYS[1], latestId)
  redis.call('PERSIST', KEYS[1])
end
return {'ok', latestId, tostring(replaced), tostring(rebuiltLatest)}
`;

export const VERIFY_AUTH_INVOCATION_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'fail', 'unknown_invocation'} end
if redis.call('HGET', KEYS[1], 'callbackToken') ~= ARGV[1] then return {'fail', 'invalid_token'} end
local state = redis.call('HGET', KEYS[1], 'state') or 'active'
if state ~= 'active' then return {'fail', state} end
if ARGV[3] == '1' and redis.call('GET', KEYS[3]) ~= ARGV[2] then return {'fail', 'stale_invocation'} end
redis.call('PERSIST', KEYS[1])
redis.call('HDEL', KEYS[1], 'expiresAt')
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('PERSIST', KEYS[2]) end
if redis.call('GET', KEYS[3]) == ARGV[2] then redis.call('PERSIST', KEYS[3]) end
return {'ok', redis.call('HGETALL', KEYS[1])}
`;

export const COMMIT_AUTH_TERMINAL_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'not_found', {}} end
local state = redis.call('HGET', KEYS[1], 'state') or 'active'
if state ~= 'active' then return {'already_terminal', redis.call('HGETALL', KEYS[1])} end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'endedAt', ARGV[3], 'endReason', ARGV[4], 'expiresAt', ARGV[6])
if ARGV[5] ~= '' then redis.call('HSET', KEYS[1], 'terminalRef', ARGV[5]) end
redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[6]))
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('PEXPIREAT', KEYS[2], tonumber(ARGV[6])) end
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('PEXPIREAT', KEYS[3], tonumber(ARGV[6])) end
return {'committed', redis.call('HGETALL', KEYS[1])}
`;

export const CLAIM_AUTH_MESSAGE_ID_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local state = redis.call('HGET', KEYS[1], 'state') or 'active'
if state ~= 'active' then return 0 end
local added = redis.call('SADD', KEYS[2], ARGV[1])
if added == 0 then return 0 end
redis.call('PERSIST', KEYS[2])
if redis.call('SCARD', KEYS[2]) > tonumber(ARGV[2]) then redis.call('SPOP', KEYS[2]) end
return 1
`;
