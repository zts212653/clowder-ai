/** All index writes accompany the exact lifecycle CAS; no index value authorizes a retry. */
export const APPEND_INDEX_LUA = `
local function checkAppendIndex(indexKey, threadsKey)
  for _, key in ipairs({indexKey, threadsKey}) do
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= 'set' then error('APPEND_INDEX_WRONG_KEY_TYPE') end
  end
end
local function syncAppendIndex(indexKey, threadsKey, threadId, messageId, pending)
  if pending == '1' then
    redis.call('SADD', indexKey, messageId)
    redis.call('SADD', threadsKey, threadId)
  else
    redis.call('SREM', indexKey, messageId)
    if redis.call('SCARD', indexKey) == 0 then redis.call('SREM', threadsKey, threadId) end
  end
end
`;
