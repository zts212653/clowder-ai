export const STORAGE_INDEX_PREFLIGHT = `
for i, expected in ipairs({'hash', 'hash', 'zset'}) do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('invalid_plugin_storage_index') end
end`;
export const PUBLISH_STORAGE_INDEX = `${STORAGE_INDEX_PREFLIGHT}
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if (raw or '') ~= ARGV[2] then return -1 end
local revision = raw and tonumber(string.match(raw, '^(%d+):[vi]:')) or nil
local expected = ARGV[3] ~= '' and tonumber(ARGV[3]) or nil
if ARGV[3] ~= '*' and revision ~= expected then return 0 end
local stateRaw = redis.call('HGET', KEYS[2], ARGV[5])
local state = stateRaw and cjson.decode(stateRaw) or nil
if state and state.token ~= ARGV[6] then return -1 end
if not state and ARGV[8] == 'delete' then return redis.error_reply('plugin_storage_index_not_ready') end
if not state and redis.call('HLEN', KEYS[2]) >= 8 then return redis.error_reply('plugin_storage_index_limit') end
if state and state.count > 0 and redis.call('EXISTS', KEYS[3]) == 0 then return redis.error_reply('plugin_storage_index_not_ready') end
if ARGV[7] ~= '' and not tonumber(ARGV[7]) then return redis.error_reply('invalid_plugin_storage_index_score') end
local counter = redis.call('HGET', KEYS[1], '')
if counter and (not string.match(counter, '^%d+$') or tonumber(counter) >= 9007199254740991) then return redis.error_reply('invalid_plugin_storage_revision') end
state = state or {token=ARGV[6], status='not_ready', count=0, cursor='0'}
local nextRevision = redis.call('HINCRBY', KEYS[1], '', 1)
if ARGV[8] == 'delete' then redis.call('HDEL', KEYS[1], ARGV[1])
else redis.call('HSET', KEYS[1], ARGV[1], tostring(nextRevision) .. ':i:' .. ARGV[4]) end
if ARGV[8] == 'delete' or ARGV[7] == '' then redis.call('ZREM', KEYS[3], ARGV[1])
else redis.call('ZADD', KEYS[3], ARGV[7], ARGV[1]) end
state.count = redis.call('ZCARD', KEYS[3])
redis.call('HSET', KEYS[2], ARGV[5], cjson.encode(state))
return nextRevision`;
export const READ_STORAGE_DUE = `${STORAGE_INDEX_PREFLIGHT}
local rawState = redis.call('HGET', KEYS[2], ARGV[1])
if not rawState then return {0} end
local state = cjson.decode(rawState)
if state.token ~= ARGV[2] or state.status ~= 'ready' then return {0} end
if redis.call('ZCARD', KEYS[3]) ~= state.count then return {0} end
local keys = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[3], 'LIMIT', 0, ARGV[4])
local result = {1, state.token}
for _, key in ipairs(keys) do
  local raw = redis.call('HGET', KEYS[1], key)
  if not raw then return {0} end
  local body = string.match(raw, '^%d+:i:(.*)$')
  if not body then return {0} end
  local row = cjson.decode(body)
  if row.projection.index ~= ARGV[1] or row.projection.score == cjson.null or row.projection.score > tonumber(ARGV[3]) then return {0} end
  table.insert(result, key); table.insert(result, raw)
end
return result`;
