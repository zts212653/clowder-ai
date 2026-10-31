/** Derived read index; message hashes and the existing publication predicates remain authoritative. */
const INDEX_LUA = `
local function uncertaintyIndex(hash)
  local id = redis.call('HGET', hash, 'id')
  local thread = redis.call('HGET', hash, 'threadId')
  if not id or not thread then return nil end
  return string.sub(hash, 1, #hash - #id - 4) .. 'msg:owner-uncertainty:' .. thread
end
local function checkIndex(index)
  if not index then return end
  local kind = redis.call('TYPE', index).ok
  if kind ~= 'none' and kind ~= 'zset' then error('OWNER_UNCERTAINTY_INDEX_INVALID') end
end
local function uncertaintyScore(hash)
  local row = redis.call('HMGET', hash, 'id', 'catId', 'deliveryStatus', 'recall', 'deletedAt')
  local score = nil
  if row[1] and row[2] == '' and not row[5] then
    if row[4] then
      local ok, recall = pcall(cjson.decode, row[4])
      if ok and type(recall) == 'table' and recall.exposure == 'seen' then
        score = tonumber(recall.recalledAt)
        if not score or score ~= score or score < 0 or score > 9007199254740991 or score ~= math.floor(score) then
          error('OWNER_UNCERTAINTY_RECALL_INVALID')
        end
      end
    end
    if row[3] == 'queued' then score = 9007199254740991 end
  end
  return score, row[1]
end
local function refreshUncertainty(hash, index, id)
  local score, canonicalId = uncertaintyScore(hash)
  if score then redis.call('ZADD', index, score, canonicalId)
  else redis.call('ZREM', index, id) end
end
`;

/** Keep the projection at the same Lua linearization point as its canonical write. */
export function withOwnerUncertaintyIndex(script: string, hashKey = 1, indexExpression?: string): string {
  return `${INDEX_LUA}
local index = ${indexExpression ?? `uncertaintyIndex(KEYS[${hashKey}])`}
checkIndex(index)
uncertaintyScore(KEYS[${hashKey}])
local result = (function()
${script}
end)()
if index then
  local id = redis.call('HGET', KEYS[${hashKey}], 'id')
  if id then refreshUncertainty(KEYS[${hashKey}], index, id) end
end
return result
`;
}

/** Legacy histories migrate once, atomically, with the same 50k bound as the visibility migration. */
export const READ_OWNER_UNCERTAINTY_LUA = `${INDEX_LUA}
checkIndex(KEYS[2])
local version = redis.call('GET', KEYS[3])
if version and version ~= '1' then return redis.error_reply('OWNER_UNCERTAINTY_VERSION_INVALID') end
if not version then
  if redis.call('ZCARD', KEYS[1]) > 50000 then return redis.error_reply('OWNER_UNCERTAINTY_MIGRATION_LIMIT') end
  local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
  redis.call('DEL', KEYS[2])
  for _, id in ipairs(ids) do refreshUncertainty(ARGV[1] .. 'msg:' .. id, KEYS[2], id) end
  redis.call('SET', KEYS[3], '1')
end
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], ARGV[2], '+inf', 'LIMIT', 0, 257)
-- Expired/deleted/canceled rows cannot accumulate as false candidates. Re-read
-- inside Lua so pruning cannot race a new queued transition on the same hash.
for _, id in ipairs(ids) do refreshUncertainty(ARGV[1] .. 'msg:' .. id, KEYS[2], id) end
return redis.call('ZRANGEBYSCORE', KEYS[2], ARGV[2], '+inf', 'LIMIT', 0, 257)
`;
