/** Atomic unpublished snapshot capture state transitions. */

export const SNAPSHOT_CAPTURE_BEGIN_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return '' end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return '' end
local active = redis.call('GET', KEYS[2])
if active then
  local decodedActive = cjson.decode(active)
  if decodedActive.status == 'active' then return active end
end
local staged = redis.call('GET', KEYS[3])
if staged then
  local decodedStaged = cjson.decode(staged)
  if tonumber(decodedStaged.expiresAt) > tonumber(ARGV[2]) then return 'busy' end
end
redis.call('DEL', KEYS[4])
redis.call('SET', KEYS[3], ARGV[1])
return 'started'
`;

export const SNAPSHOT_CAPTURE_APPEND_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return 0 end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return 0 end
local staged = redis.call('GET', KEYS[2])
if not staged then return 0 end
local capture = cjson.decode(staged)
if capture.snapshotId ~= ARGV[1] then return 0 end
if tonumber(capture.expiresAt) <= tonumber(ARGV[3]) then return 0 end
local expected = tonumber(ARGV[2])
if tonumber(capture.itemCount) ~= expected or redis.call('LLEN', KEYS[3]) ~= expected then return 0 end
for index = 4, #ARGV do redis.call('RPUSH', KEYS[3], ARGV[index]) end
capture.itemCount = expected + (#ARGV - 3)
redis.call('SET', KEYS[2], cjson.encode(capture))
return 1
`;

export const SNAPSHOT_CAPTURE_COMMIT_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return '' end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return '' end
local active = redis.call('GET', KEYS[2])
if active then
  local decodedActive = cjson.decode(active)
  if decodedActive.status == 'active' then return active end
end
local staged = redis.call('GET', KEYS[4])
if not staged then return '' end
local capture = cjson.decode(staged)
if capture.snapshotId ~= ARGV[1] or tonumber(capture.expiresAt) <= tonumber(ARGV[3]) then return '' end
local expected = tonumber(ARGV[2])
if tonumber(capture.itemCount) ~= expected or redis.call('LLEN', KEYS[5]) ~= expected then return '' end
local published = {
  status = 'active', snapshotId = capture.snapshotId, headSequence = capture.headSequence,
  itemCount = expected, createdAt = capture.createdAt, nextOffset = tonumber(ARGV[4]),
  traversalComplete = ARGV[5] == '1'
}
if expected == 0 then
  redis.call('DEL', KEYS[3])
  redis.call('DEL', KEYS[5])
else
  redis.call('DEL', KEYS[3])
  redis.call('RENAME', KEYS[5], KEYS[3])
end
local encoded = cjson.encode(published)
redis.call('SET', KEYS[2], encoded)
redis.call('DEL', KEYS[4])
return encoded
`;

export const SNAPSHOT_CAPTURE_ABORT_LUA = `
local staged = redis.call('GET', KEYS[1])
if not staged then return 0 end
local capture = cjson.decode(staged)
if capture.snapshotId ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

export const SNAPSHOT_PAGE_READ_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return nil end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return nil end
local raw = redis.call('GET', KEYS[2])
if not raw then return nil end
local state = cjson.decode(raw)
if state.status ~= 'active' or state.snapshotId ~= ARGV[1] then return nil end
local offset = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local itemCount = tonumber(state.itemCount)
if not offset or not limit or not itemCount or offset < 0 or limit < 0 or offset > itemCount then return nil end
if offset == itemCount or limit == 0 then return {} end
local last = math.min(offset + limit - 1, itemCount - 1)
return redis.call('LRANGE', KEYS[3], offset, last)
`;

export const SNAPSHOT_ACK_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return -1 end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return -1 end
local raw = redis.call('GET', KEYS[3])
if not raw then return -1 end
local state = cjson.decode(raw)
if state.snapshotId ~= ARGV[1] or tonumber(state.headSequence) ~= tonumber(ARGV[2]) then return -1 end
if state.status == 'completed' then return 0 end
if state.status ~= 'active' or state.traversalComplete ~= true then return -1 end
local acked = tonumber(redis.call('HGET', KEYS[2], 'acked') or '-1')
local delivered = tonumber(redis.call('HGET', KEYS[2], 'delivered') or '-1')
local head = tonumber(ARGV[2])
if head > acked then redis.call('HSET', KEYS[2], 'acked', head) end
if head > delivered then redis.call('HSET', KEYS[2], 'delivered', head) end
redis.call('SET', KEYS[3], ARGV[3])
redis.call('DEL', KEYS[4])
return 1
`;

export const SNAPSHOT_PAGE_CONSUME_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return 0 end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return 0 end
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local state = cjson.decode(raw)
if state.status ~= 'active' or state.snapshotId ~= ARGV[1] or state.traversalComplete == true then return 0 end
if tonumber(state.nextOffset) ~= tonumber(ARGV[2]) then return 0 end
local currentToken = state.nextPageTokenId or ''
if currentToken ~= ARGV[3] then return 0 end
state.lastPageOffset = tonumber(ARGV[2])
state.nextOffset = tonumber(ARGV[4])
if ARGV[5] == '' then state.nextPageTokenId = nil else state.nextPageTokenId = ARGV[5] end
state.traversalComplete = ARGV[6] == '1'
redis.call('SET', KEYS[2], cjson.encode(state))
return 1
`;
