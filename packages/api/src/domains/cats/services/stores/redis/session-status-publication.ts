import { PROJECT_SEALING_LUA, SEALING_INDEX_PREFLIGHT } from './session-sealing-index.js';

/** Original session owner publishes fields, pointers and derived sealing work in one atomic boundary. */
export const PUBLISH_SESSION_STATUS = `${SEALING_INDEX_PREFLIGHT}${PROJECT_SEALING_LUA}
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local previousStatus = redis.call('HGET', KEYS[1], 'status')
local fields = cjson.decode(ARGV[2])
local deleted = cjson.decode(ARGV[3])
local oldCliKey = nil
if ARGV[4] == '1' and ARGV[5] == '1' then
  for _, key in ipairs({KEYS[2], KEYS[3]}) do
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= 'string' then return redis.error_reply('invalid_session_active_pointer') end
  end
end
if ARGV[6] == '1' then
  local kind = redis.call('TYPE', KEYS[4]).ok
  if kind ~= 'none' and kind ~= 'string' then return redis.error_reply('invalid_session_cli_pointer') end
  local oldCli = redis.call('HGET', KEYS[1], 'cliSessionId')
  if oldCli and oldCli ~= '' then
    oldCliKey = string.sub(KEYS[4], 1, #KEYS[4] - #ARGV[7]) .. oldCli
    local oldKind = redis.call('TYPE', oldCliKey).ok
    if oldKind ~= 'none' and oldKind ~= 'string' then return redis.error_reply('invalid_session_cli_pointer') end
  end
end
redis.call('HSET', KEYS[1], unpack(fields))
if #deleted > 0 then redis.call('HDEL', KEYS[1], unpack(deleted)) end
if previousStatus ~= redis.call('HGET', KEYS[1], 'status') then
  redis.call('HDEL', KEYS[1], '_sealingRecoveryDisposition', '_sealingRecoveryReason', '_sealingRecoveryFailures')
end
if ARGV[6] == '1' then
  if oldCliKey and redis.call('GET', oldCliKey) == ARGV[1] then redis.call('DEL', oldCliKey) end
  redis.call('SET', KEYS[4], ARGV[1])
end
if ARGV[4] == '1' and ARGV[5] == '1' then
  if redis.call('HGET', KEYS[1], 'status') == 'active'
    and redis.call('HEXISTS', KEYS[1], 'scopedInvocation') == 0
    and redis.call('HGET', KEYS[1], 'sessionPurpose') ~= 'watcher' then
    redis.call('SET', KEYS[2], ARGV[1]); redis.call('SET', KEYS[3], ARGV[1])
  else
    if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
    if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
  end
end
projectSealing(KEYS[1], ARGV[1], KEYS[5])
return 1`;
